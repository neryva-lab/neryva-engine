import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { env } from '../../common/config/env';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { EntitlementGuard, RequireEntitlement } from '../../common/policy/entitlement.guard';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { QuotaService } from '../billing/quota.service';
import { UsageQueryService } from '../billing/usage-query.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { ProjectsService } from '../organizations/projects.service';
import { AgentStudioSummary } from './summary.service';
import { StudioKeysService } from './keys.service';
import { planFor } from './plans';

/**
 * The studio product console APIs (S-2â€¦S-4): the surfaces the web app's
 * `/studio` area calls. Org context resolves from X-Neryva-Org (the org
 * picker header) via the guards. Every route is L1 + membership; product
 * routes additionally require the entitlement (403 entitlement_required /
 * 402 past_due per the access-model). Trial start is a purchase-adjacent
 * act: owner/billing + a fresh MFA proof.
 */
@Controller('console/studio-furniture')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard, EntitlementGuard)
export class StudioController {
  constructor(
    private readonly summary: AgentStudioSummary,
    private readonly keys: StudioKeysService,
    private readonly projects: ProjectsService,
    private readonly usage: UsageQueryService,
    private readonly quota: QuotaService,
    private readonly entitlements: EntitlementsService,
    private readonly manifests: ManifestRegistryService,
  ) {}

  private orgId(header: string | string[] | undefined): string {
    const orgId = Array.isArray(header) ? header[0] : header;
    if (!orgId) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    return orgId;
  }

  /** The manifest's declared summary route (S-3) â€” same payload the card renders. */
  @Get('summary')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('agent_studio')
  async summaryCard(@Headers('x-neryva-org') orgHeader?: string | string[]): Promise<unknown> {
    const orgId = this.orgId(orgHeader);
    const state = await this.entitlements.getState(orgId, 'agent_studio');
    return {
      product: 'agent_studio',
      entitlement_state: state,
      ...(await this.summary.summarize(orgId) as object),
    };
  }

  /** Start a trial (S-2): none â†’ trial on the default plan, limits flow into quotas. */
  @Post('trial')
  @Roles('owner', 'billing')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'studio-trial-start', capacity: 5, refillPerSecond: 0.01, scope: 'principal' })
  async startTrial(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { plan?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ entitlement: unknown }> {
    const orgId = this.orgId(orgHeader);
    const current = await this.entitlements.getState(orgId, 'agent_studio');
    if (current !== 'none' && current !== 'expired') {
      throw ApiError.conflict(`organization already has an agent_studio entitlement (${current})`);
    }
    const plan = planFor(body.plan);
    if (plan.trialDays === null) {
      throw ApiError.validation({ plan: `plan "${plan.plan}" has no self-serve trial` });
    }
    const now = new Date();
    const periodEnd = new Date(now.getTime() + plan.trialDays * 86_400_000);
    const entitlement = await this.entitlements.transition({
      orgId,
      product: 'agent_studio',
      target: 'trial',
      plan: plan.plan,
      limits: plan.limits as unknown as Record<string, unknown>,
      period: { start: now.toISOString(), end: periodEnd.toISOString() },
      actorId: principal.id,
    });
    return { entitlement };
  }

  /** Projects with their studio usage slices + quota snapshot (S-4). */
  @Get('projects')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('agent_studio')
  async listProjects(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    const orgId = this.orgId(orgHeader);
    const [projectRows, slices, quota] = await Promise.all([
      this.projects.list(orgId, true),
      this.usage.overview(orgId, { product: 'agent_studio' }),
      this.quota.usageSnapshot(orgId, 'agent_studio'),
    ]);
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const sliceByProject = new Map(
      (slices.products[0]?.projects ?? []).map((slice) => [slice.project_id ?? '', slice]),
    );
    return {
      product: 'agent_studio',
      quota,
      projects: projectRows.map((project) => ({
        id: project.id,
        name: project.name,
        archived: project.archivedAt !== null,
        usage: sliceByProject.get(project.id) ?? { project_id: project.id, cost_usd: '0', events: 0, tokens_in: 0, tokens_out: 0 },
      })),
      unassigned_usage: sliceByProject.get('') ?? null,
    };
  }

  /** Org API keys with their project bindings (read: all roles; bind: manage roles). */
  @Get('keys')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('agent_studio')
  async listKeys(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    return this.keys.list(this.orgId(orgHeader));
  }

  @Post('keys/:keyId/bind')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('agent_studio')
  async bindKey(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('keyId') keyId: string,
    @Body() body: { project_id?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!body.project_id) {
      throw ApiError.validation({ project_id: 'project_id is required' });
    }
    await this.keys.bind({
      orgId: this.orgId(orgHeader),
      apiKeyId: keyId,
      projectId: body.project_id,
      actorId: principal.id,
    });
    return { ok: true };
  }

  @Post('keys/:keyId/unbind')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('agent_studio')
  async unbindKey(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('keyId') keyId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.keys.unbind({ orgId: this.orgId(orgHeader), apiKeyId: keyId, actorId: principal.id });
    return { ok: true };
  }

  /**
   * Deep links to runtime-served studio surfaces (S-4): evaluations and
   * policies homestead in the satellite until/unless they move into the
   * engine â€” the manifest's satellite route prefixes are the single source;
   * links resolve against the engine edge (the proxy routes /v1 + /surfaces
   * to the satellite).
   */
  @Get('pointers')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('agent_studio')
  async pointers(): Promise<{ runtime_route_prefixes: string[]; links: Array<{ name: string; url: string }> }> {
    const manifest = this.manifests.require('agent_studio');
    const prefixes = manifest.faces.runtime === 'external' ? manifest.satellite_runtime_routes : [];
    const base = env.ENGINE_BASE_URL.replace(/\/$/, '');
    return {
      runtime_route_prefixes: prefixes,
      links:
        prefixes.length > 0
          ? [
              { name: 'conversations', url: `${base}/v1/conversations` },
              { name: 'evaluations', url: `${base}/v1/evaluations` },
              { name: 'policies', url: `${base}/v1/policies` },
            ]
          : [],
    };
  }
}

