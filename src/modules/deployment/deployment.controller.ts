import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { EntitlementGuard, RequireEntitlement } from '../../common/policy/entitlement.guard';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { QuotaService } from '../billing/quota.service';
import { UsageQueryService } from '../billing/usage-query.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { DeploymentSummary } from './summary.service';
import { DeploymentsService } from './deployments.service';
import { DeploymentWorkflow } from './deployment.workflow';
import { EnvironmentsService } from './environments.service';
import { PipelinesService } from './pipelines.service';
import { SecretsService } from './secrets.service';
import { deploymentPlanFor } from './plans';
import { DeploymentStatus, ROLLOUT_STRATEGIES, RolloutStrategy } from './schema';

/**
 * The deployment console APIs (D-3): pipelines, environments, deployments,
 * the ops surfaces (cost, secrets). All routes L1 + membership; product
 * routes carry the entitlement semantics (403 entitlement_required on
 * none/expired; writes 402 past_due on past_due/suspended). Manage-shaped
 * routes are owner/admin/developer; views are all-roles.
 */
@Controller('console/deployment')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard, EntitlementGuard)
export class DeploymentController {
  constructor(
    private readonly summary: DeploymentSummary,
    private readonly pipelinesService: PipelinesService,
    private readonly environmentsService: EnvironmentsService,
    private readonly deploymentsService: DeploymentsService,
    private readonly secretsService: SecretsService,
    private readonly workflow: DeploymentWorkflow,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageQueryService,
    private readonly quota: QuotaService,
  ) {}

  private orgId(header: string | string[] | undefined): string {
    const orgId = Array.isArray(header) ? header[0] : header;
    if (!orgId) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    return orgId;
  }

  // ── card + trial ───────────────────────────────────────────────────────────

  @Get('summary')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async summary(@Headers('x-neryva-org') orgHeader?: string | string[]): Promise<unknown> {
    const orgId = this.orgId(orgHeader);
    const state = await this.entitlements.getState(orgId, 'deployment');
    return {
      product: 'deployment',
      entitlement_state: state,
      ...(await this.summary.summarize(orgId) as object),
    };
  }

  /** Start a trial (D-2): none → trial on deployment-usage (30 days per plan). */
  @Post('trial')
  @Roles('owner', 'billing')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'deployment-trial-start', capacity: 5, refillPerSecond: 0.01, scope: 'principal' })
  async startTrial(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { plan?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ entitlement: unknown }> {
    const orgId = this.orgId(orgHeader);
    const current = await this.entitlements.getState(orgId, 'deployment');
    if (current !== 'none' && current !== 'expired') {
      throw ApiError.conflict(`organization already has a deployment entitlement (${current})`);
    }
    const plan = deploymentPlanFor(body.plan);
    if (plan.trialDays === null) {
      throw ApiError.validation({ plan: `plan "${plan.plan}" has no self-serve trial` });
    }
    const now = new Date();
    const entitlement = await this.entitlements.transition({
      orgId,
      product: 'deployment',
      target: 'trial',
      plan: plan.plan,
      limits: plan.limits as unknown as Record<string, unknown>,
      period: { start: now.toISOString(), end: new Date(now.getTime() + plan.trialDays * 86_400_000).toISOString() },
      actorId: principal.id,
    });
    return { entitlement };
  }

  // ── pipelines + stages ─────────────────────────────────────────────────────

  @Get('pipelines')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async pipelines(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    return { pipelines: await this.pipelinesService.list(this.orgId(orgHeader)) };
  }

  @Get('pipelines/:pipelineId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async pipeline(@Headers('x-neryva-org') orgHeader: string | string[], @Param('pipelineId') pipelineId: string) {
    return this.pipelinesService.get(this.orgId(orgHeader), pipelineId);
  }

  @Post('pipelines')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @Idempotent()
  async createPipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { name?: string; source_agent?: string; description?: string; project_id?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.name || !body.source_agent) {
      throw ApiError.validation({ input: 'name and source_agent are required' });
    }
    const pipeline = await this.pipelinesService.create({
      orgId: this.orgId(orgHeader),
      name: body.name,
      sourceAgent: body.source_agent,
      description: body.description,
      projectId: body.project_id ?? null,
      actorId: principal.id,
    });
    return { pipeline };
  }

  @Post('pipelines/:pipelineId/stages')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async addStage(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { environment_id?: string; gate_policy?: unknown; auto_promote?: boolean; rollback_on_failure?: boolean },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.environment_id) {
      throw ApiError.validation({ environment_id: 'environment_id is required' });
    }
    const stage = await this.pipelinesService.addStage({
      orgId: this.orgId(orgHeader),
      pipelineId,
      environmentId: body.environment_id,
      gatePolicy: body.gate_policy,
      autoPromote: body.auto_promote,
      rollbackOnFailure: body.rollback_on_failure,
      actorId: principal.id,
    });
    return { stage };
  }

  @Post('pipelines/:pipelineId/archive')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async archivePipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.pipelinesService.archive({ orgId: this.orgId(orgHeader), pipelineId, actorId: principal.id });
    return { ok: true };
  }

  // ── environments ───────────────────────────────────────────────────────────

  @Get('environments')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async environments(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    return { environments: await this.environmentsService.list(this.orgId(orgHeader)) };
  }

  @Post('environments')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @Idempotent()
  async createEnvironment(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { name?: string; tier?: string; project_id?: string; guardrail_profile?: string; quota_ref?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.name) {
      throw ApiError.validation({ name: 'name is required' });
    }
    const environment = await this.environmentsService.create({
      orgId: this.orgId(orgHeader),
      name: body.name,
      tier: body.tier,
      projectId: body.project_id ?? null,
      guardrailProfile: body.guardrail_profile ?? null,
      quotaRef: body.quota_ref ?? null,
      actorId: principal.id,
    });
    return { environment };
  }

  @Post('environments/:environmentId')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async updateEnvironment(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('environmentId') environmentId: string,
    @Body() body: { pinned_agent_version?: string | null; guardrail_profile?: string | null },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const environment = await this.environmentsService.update({
      orgId: this.orgId(orgHeader),
      environmentId,
      pinnedAgentVersion: body.pinned_agent_version,
      guardrailProfile: body.guardrail_profile,
      actorId: principal.id,
    });
    return { environment };
  }

  // ── deployments ────────────────────────────────────────────────────────────

  @Get('deployments')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async listDeployments(
    @Headers('x-neryva-org') orgHeader?: string | string[],
    @Query('pipeline_id') pipelineId?: string,
    @Query('status') status?: DeploymentStatus,
  ) {
    return { deployments: await this.deploymentsService.list(this.orgId(orgHeader), { pipelineId, status }) };
  }

  @Get('deployments/:deploymentId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async deployment(@Headers('x-neryva-org') orgHeader: string | string[], @Param('deploymentId') deploymentId: string) {
    const orgId = this.orgId(orgHeader);
    const context = await this.deploymentsService.get(orgId, deploymentId);
    const events = await this.deploymentsService.events(orgId, deploymentId);
    return { ...context, events };
  }

  /** Trigger a run from the console. */
  @Post('deployments')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @Idempotent()
  @RateLimit({ name: 'deployment-trigger', capacity: 20, refillPerSecond: 0.2, scope: 'principal' })
  async trigger(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { pipeline_id?: string; stage_id?: string; agent_version?: string; strategy?: string; snapshot?: Record<string, unknown> },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.pipeline_id || !body.agent_version) {
      throw ApiError.validation({ input: 'pipeline_id and agent_version are required' });
    }
    const strategy = ROLLOUT_STRATEGIES.includes(body.strategy as RolloutStrategy) ? (body.strategy as RolloutStrategy) : undefined;
    const deployment = await this.deploymentsService.trigger({
      orgId: this.orgId(orgHeader),
      pipelineId: body.pipeline_id,
      stageId: body.stage_id,
      agentVersion: body.agent_version,
      strategy,
      snapshot: body.snapshot,
      actorId: principal.id,
      actorLabel: principal.id,
    });
    await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step: 'gates' });
    return { deployment };
  }

  /** Manual gate approval (counted once per actor). */
  @Post('deployments/:deploymentId/approve')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async approve(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.deploymentsService.approve({ orgId: this.orgId(orgHeader), deploymentId, actorId: principal.id, actorLabel: principal.id });
    return { ok: true };
  }

  /** Canary/rollout metrics feed (the observability hand connects here). */
  @Post('deployments/:deploymentId/metrics')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async reportMetrics(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { metrics?: Record<string, number | string | boolean> },
  ): Promise<{ ok: true }> {
    if (!body.metrics || typeof body.metrics !== 'object') {
      throw ApiError.validation({ metrics: 'metrics object required' });
    }
    await this.deploymentsService.reportMetrics({ orgId: this.orgId(orgHeader), deploymentId, metrics: body.metrics });
    return { ok: true };
  }

  /** Instant rollback of a rolling/live run. */
  @Post('deployments/:deploymentId/rollback')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async rollback(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const deployment = await this.deploymentsService.transition({
      orgId: this.orgId(orgHeader),
      deploymentId,
      target: 'rolled_back' as DeploymentStatus,
      eventKind: 'deployment.rolled_back',
      payload: { manual: true },
    });
    return { deployment };
  }

  // ── operations: cost + secrets ─────────────────────────────────────────────

  /** Per-environment cost posture from the metering plane (tag `deployment`). */
  @Get('cost')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async cost(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    const orgId = this.orgId(orgHeader);
    const [overview, quota] = await Promise.all([
      this.usage.overview(orgId, { product: 'deployment' }),
      this.quota.usageSnapshot(orgId, 'deployment'),
    ]);
    return { product: 'deployment', overview, quota };
  }

  @Get('secrets')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async secrets(@Headers('x-neryva-org') orgHeader?: string | string[], @Query('environment_id') environmentId?: string) {
    return { secrets: await this.secretsService.list(this.orgId(orgHeader), environmentId) };
  }

  @Post('secrets')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @RateLimit({ name: 'deployment-secret-set', capacity: 30, refillPerSecond: 0.5, scope: 'principal' })
  async setSecret(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { environment_id?: string; key?: string; value?: string; kms_ref?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!body.environment_id || !body.key || !body.value) {
      throw ApiError.validation({ input: 'environment_id, key, value are required' });
    }
    await this.secretsService.set({
      orgId: this.orgId(orgHeader),
      environmentId: body.environment_id,
      key: body.key,
      value: body.value,
      kmsRef: body.kms_ref ?? null,
      actorId: principal.id,
    });
    return { ok: true };
  }

  @Post('secrets/:secretId/rotate')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async rotateSecret(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('secretId') secretId: string,
    @Body() body: { value?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!body.value) {
      throw ApiError.validation({ value: 'value is required' });
    }
    await this.secretsService.rotate({ orgId: this.orgId(orgHeader), secretId, value: body.value, actorId: principal.id });
    return { ok: true };
  }

  @Post('secrets/:secretId/remove')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async removeSecret(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('secretId') secretId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.secretsService.remove({ orgId: this.orgId(orgHeader), secretId, actorId: principal.id });
    return { ok: true };
  }
}
