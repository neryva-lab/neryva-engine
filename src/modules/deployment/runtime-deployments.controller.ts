import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { EntitlementGuard, RequireEntitlement } from '../../common/policy/entitlement.guard';
import { ladderProgress } from './rollout';
import { DeploymentsService } from './deployments.service';
import { DeploymentWorkflow } from './deployment.workflow';
import { RolloutStrategy, ROLLOUT_STRATEGIES } from './schema';

/**
 * The deployment runtime plane (D-3/D-4): `POST /v1/deployments` + status —
 * the machine surface CI-style callers and runners drive with L2 API keys
 * carrying `deployment:operate`. The org resolves from the key's tenant
 * binding + the X-Neryva-Org header (the key must belong to that org).
 * Entitlement semantics match the console (403 entitlement_required /
 * 402 past_due) so product SDKs render upgrade prompts uniformly.
 *
 * Full CI lifecycle over HTTP: create → poll status/events → feed metrics →
 * promote → rollback.
 */
@Controller('v1/deployments')
@AuthLayer('l2')
@RequireScopes('deployment:operate')
@UseGuards(EntitlementGuard)
@RequireEntitlement('deployment')
export class RuntimeDeploymentsController {
  constructor(
    private readonly deploymentsService: DeploymentsService,
    private readonly workflow: DeploymentWorkflow,
  ) {}

  private orgId(principal: L2Principal, header: string | string[] | undefined): string {
    const requested = Array.isArray(header) ? header[0] : header;
    if (!requested) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    // A tenant-bound key may only act inside its tenant.
    if (principal.tenantId && principal.tenantId !== requested) {
      throw ApiError.forbidden('API key is not bound to this organization');
    }
    return requested;
  }

  @Post()
  @Idempotent()
  @RateLimit({ name: 'v1-deployments-create', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async create(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: {
      pipeline_id?: string;
      stage_id?: string;
      agent_version?: string;
      strategy?: string;
      git?: { commit?: string; branch?: string; message?: string };
      snapshot?: Record<string, unknown>;
    },
  ) {
    const orgId = this.orgId(principal, orgHeader);
    if (!body.pipeline_id || !body.agent_version) {
      throw ApiError.validation({ input: 'pipeline_id and agent_version are required' });
    }
    if (body.strategy !== undefined && !ROLLOUT_STRATEGIES.includes(body.strategy as RolloutStrategy)) {
      throw ApiError.validation({ strategy: `must be one of ${ROLLOUT_STRATEGIES.join(', ')}` });
    }
    const deployment = await this.deploymentsService.trigger({
      orgId,
      pipelineId: body.pipeline_id,
      stageId: body.stage_id,
      agentVersion: body.agent_version,
      strategy: body.strategy as RolloutStrategy | undefined,
      git: body.git,
      snapshot: body.snapshot,
      actorId: principal.id,
      actorLabel: principal.id,
      actorKind: 'api_key',
    });
    await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step: 'gates' });
    return { deployment };
  }

  @Get()
  @RateLimit({ name: 'v1-deployments-list', capacity: 60, refillPerSecond: 2, scope: 'principal' })
  async list(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Query('pipeline_id') pipelineId?: string,
    @Query('environment_id') environmentId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const orgId = this.orgId(principal, orgHeader);
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    const rows = await this.deploymentsService.list(orgId, { pipelineId, environmentId, limit });
    return {
      deployments: rows.map((d) => ({
        id: d.id,
        status: d.status,
        strategy: d.strategy,
        canary_percent: d.canaryPercent,
        agent_version: d.agentVersion,
        environment_id: d.environmentId,
        created_at: d.createdAt,
        completed_at: d.completedAt,
      })),
    };
  }

  @Get(':deploymentId')
  @RateLimit({ name: 'v1-deployments-status', capacity: 240, refillPerSecond: 10, scope: 'principal' })
  async status(@CurrentPrincipal() principal: L2Principal, @Headers('x-neryva-org') orgHeader: string | string[], @Param('deploymentId') deploymentId: string) {
    const orgId = this.orgId(principal, orgHeader);
    const { deployment, stage } = await this.deploymentsService.get(orgId, deploymentId);
    const events = await this.deploymentsService.events(orgId, deploymentId, 20);
    return {
      deployment: {
        id: deployment.id,
        status: deployment.status,
        strategy: deployment.strategy,
        canary_percent: deployment.canaryPercent,
        agent_version: deployment.agentVersion,
        environment_id: deployment.environmentId,
        stage_position: stage.position,
        last_error: deployment.lastError,
        started_at: deployment.startedAt,
        completed_at: deployment.completedAt,
        progress: ladderProgress(deployment.ladder, deployment.rolloutState, deployment.canaryPercent),
      },
      events,
    };
  }

  @Get(':deploymentId/events')
  @RateLimit({ name: 'v1-deployments-events', capacity: 120, refillPerSecond: 5, scope: 'principal' })
  async events(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[],
    @Param('deploymentId') deploymentId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const orgId = this.orgId(principal, orgHeader);
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50;
    return { events: await this.deploymentsService.events(orgId, deploymentId, limit) };
  }

  /** Runner metrics feed — the observability hand for canary evaluation. */
  @Post(':deploymentId/metrics')
  @RateLimit({ name: 'v1-deployments-metrics', capacity: 120, refillPerSecond: 5, scope: 'principal' })
  async reportMetrics(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { metrics?: Record<string, number | string | boolean> },
  ): Promise<{ ok: true }> {
    const orgId = this.orgId(principal, orgHeader);
    if (!body.metrics || typeof body.metrics !== 'object') {
      throw ApiError.validation({ metrics: 'metrics object required' });
    }
    await this.deploymentsService.reportMetrics({ orgId, deploymentId, metrics: body.metrics });
    return { ok: true };
  }

  /** CI-driven promote (approve gate / advance ladder). */
  @Post(':deploymentId/promote')
  @Idempotent()
  @RateLimit({ name: 'v1-deployments-promote', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async promote(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
  ) {
    const orgId = this.orgId(principal, orgHeader);
    const result = await this.deploymentsService.promote({ orgId, deploymentId, actorId: principal.id, actorLabel: principal.id });
    if (result.action === 'advanced') {
      await this.workflow.schedule({ orgId, deploymentId, step: 'rollout' });
    }
    return result;
  }

  /** CI-driven rollback (restores the environment's previous live version). */
  @Post(':deploymentId/rollback')
  @Idempotent()
  @RateLimit({ name: 'v1-deployments-rollback', capacity: 20, refillPerSecond: 0.5, scope: 'principal' })
  async rollback(
    @CurrentPrincipal() principal: L2Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { reason?: string },
  ) {
    const orgId = this.orgId(principal, orgHeader);
    const deployment = await this.deploymentsService.rollback({
      orgId,
      deploymentId,
      actorId: principal.id,
      actorLabel: principal.id,
      reason: body.reason,
    });
    return { deployment };
  }
}
