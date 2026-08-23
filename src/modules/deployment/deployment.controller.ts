import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
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
import { ReleasesService } from './releases.service';
import { SecretsService } from './secrets.service';
import { SettingsService } from './settings.service';
import { ladderProgress } from './rollout';
import { deploymentPlanFor } from './plans';
import { DeploymentStatus, ROLLOUT_STRATEGIES, RolloutStrategy } from './schema';

/**
 * The deployment console APIs (D-3): pipelines, environments, deployments,
 * run controls (pause/promote/cancel/rollback), the releases timeline, the
 * ops surfaces (cost, secrets, activity, settings). All routes L1 +
 * membership; product routes carry the entitlement semantics (403
 * entitlement_required on none/expired; writes 402 past_due on
 * past_due/suspended). Manage-shaped routes are owner/admin/developer;
 * views are all-roles.
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
    private readonly settingsService: SettingsService,
    private readonly releasesService: ReleasesService,
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
  async summaryCard(@Headers('x-neryva-org') orgHeader?: string | string[]): Promise<unknown> {
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

  // ── settings ───────────────────────────────────────────────────────────────

  @Get('settings')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async settings(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    return { settings: await this.settingsService.get(this.orgId(orgHeader)) };
  }

  @Put('settings')
  @Roles('owner', 'admin')
  @RequireEntitlement('deployment')
  @Idempotent()
  async updateSettings(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: { default_strategy?: string; default_ladder?: unknown; auto_rollback?: boolean; default_canary_weight?: number },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (body.default_strategy === undefined && body.default_ladder === undefined && body.auto_rollback === undefined && body.default_canary_weight === undefined) {
      throw ApiError.validation({ input: 'nothing to update' });
    }
    const settings = await this.settingsService.update({
      orgId: this.orgId(orgHeader),
      defaultStrategy: body.default_strategy,
      defaultLadder: body.default_ladder,
      autoRollback: body.auto_rollback,
      defaultCanaryWeight: body.default_canary_weight,
      actorId: principal.id,
    });
    return { settings };
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
  async pipeline(@Headers('x-neryva-org') orgHeader: string | string[] | undefined, @Param('pipelineId') pipelineId: string) {
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

  @Patch('pipelines/:pipelineId')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async updatePipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { name?: string; description?: string; source_agent?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const pipeline = await this.pipelinesService.update({
      orgId: this.orgId(orgHeader),
      pipelineId,
      name: body.name,
      description: body.description,
      sourceAgent: body.source_agent,
      actorId: principal.id,
    });
    return { pipeline };
  }

  @Post('pipelines/:pipelineId/pause')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async pausePipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    return { pipeline: await this.pipelinesService.setStatus({ orgId: this.orgId(orgHeader), pipelineId, status: 'paused', actorId: principal.id }) };
  }

  @Post('pipelines/:pipelineId/resume')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async resumePipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    return { pipeline: await this.pipelinesService.setStatus({ orgId: this.orgId(orgHeader), pipelineId, status: 'active', actorId: principal.id }) };
  }

  @Post('pipelines/:pipelineId/stages')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async addStage(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @Body() body: { environment_id?: string; name?: string; gate_policy?: unknown; rollout_policy?: unknown; auto_promote?: boolean; rollback_on_failure?: boolean },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.environment_id) {
      throw ApiError.validation({ environment_id: 'environment_id is required' });
    }
    const settings = await this.settingsService.get(this.orgId(orgHeader));
    const stage = await this.pipelinesService.addStage({
      orgId: this.orgId(orgHeader),
      pipelineId,
      environmentId: body.environment_id,
      name: body.name,
      gatePolicy: body.gate_policy,
      rolloutPolicy: body.rollout_policy,
      autoPromote: body.auto_promote,
      rollbackOnFailure: body.rollback_on_failure,
      defaultRollbackOnFailure: settings.autoRollback,
      actorId: principal.id,
    });
    return { stage };
  }

  @Patch('pipelines/:pipelineId/stages/:stageId')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async updateStage(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @Param('stageId') stageId: string,
    @Body() body: { name?: string | null; gate_policy?: unknown; rollout_policy?: unknown | null; auto_promote?: boolean; rollback_on_failure?: boolean },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const stage = await this.pipelinesService.updateStage({
      orgId: this.orgId(orgHeader),
      pipelineId,
      stageId,
      name: body.name,
      gatePolicy: body.gate_policy,
      rolloutPolicy: body.rollout_policy,
      autoPromote: body.auto_promote,
      rollbackOnFailure: body.rollback_on_failure,
      actorId: principal.id,
    });
    return { stage };
  }

  @Delete('pipelines/:pipelineId/stages/:stageId')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async removeStage(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @Param('stageId') stageId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.pipelinesService.removeStage({ orgId: this.orgId(orgHeader), pipelineId, stageId, actorId: principal.id });
    return { ok: true };
  }

  @Post('pipelines/:pipelineId/promote')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @RateLimit({ name: 'deployment-pipeline-promote', capacity: 20, refillPerSecond: 0.2, scope: 'principal' })
  async promotePipeline(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('pipelineId') pipelineId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const deployment = await this.deploymentsService.promotePipeline({
      orgId: this.orgId(orgHeader),
      pipelineId,
      actorId: principal.id,
      actorLabel: principal.id,
    });
    await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step: 'gates' });
    return { deployment };
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
    @Body() body: {
      name?: string;
      tier?: string;
      region?: string;
      description?: string;
      project_id?: string;
      guardrail_profile?: string;
      quota_ref?: string;
      approval_mode?: string;
      auto_promote?: boolean;
      concurrency?: number;
    },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.name) {
      throw ApiError.validation({ name: 'name is required' });
    }
    const environment = await this.environmentsService.create({
      orgId: this.orgId(orgHeader),
      name: body.name,
      tier: body.tier,
      region: body.region ?? null,
      description: body.description ?? null,
      projectId: body.project_id ?? null,
      guardrailProfile: body.guardrail_profile ?? null,
      quotaRef: body.quota_ref ?? null,
      approvalMode: body.approval_mode,
      autoPromote: body.auto_promote,
      concurrency: body.concurrency,
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
    @Body() body: {
      pinned_agent_version?: string | null;
      guardrail_profile?: string | null;
      region?: string | null;
      description?: string | null;
      approval_mode?: string;
      auto_promote?: boolean;
      concurrency?: number;
      status?: string;
    },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const environment = await this.environmentsService.update({
      orgId: this.orgId(orgHeader),
      environmentId,
      pinnedAgentVersion: body.pinned_agent_version,
      guardrailProfile: body.guardrail_profile,
      region: body.region,
      description: body.description,
      approvalMode: body.approval_mode,
      autoPromote: body.auto_promote,
      concurrency: body.concurrency,
      status: body.status,
      actorId: principal.id,
    });
    return { environment };
  }

  @Delete('environments/:environmentId')
  @Roles('owner', 'admin')
  @RequireEntitlement('deployment')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  async removeEnvironment(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('environmentId') environmentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.environmentsService.remove({ orgId: this.orgId(orgHeader), environmentId, actorId: principal.id });
    return { ok: true };
  }

  // ── deployments ────────────────────────────────────────────────────────────

  @Get('deployments')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async listDeployments(
    @Headers('x-neryva-org') orgHeader?: string | string[],
    @Query('pipeline_id') pipelineId?: string,
    @Query('environment_id') environmentId?: string,
    @Query('environment') environmentName?: string,
    @Query('status') status?: DeploymentStatus,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    return {
      deployments: await this.deploymentsService.list(this.orgId(orgHeader), { pipelineId, environmentId, environment: environmentName, status, limit }),
    };
  }

  @Get('deployments/:deploymentId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async deployment(@Headers('x-neryva-org') orgHeader: string | string[] | undefined, @Param('deploymentId') deploymentId: string) {
    const orgId = this.orgId(orgHeader);
    const context = await this.deploymentsService.get(orgId, deploymentId);
    const [events, environment, gate] = await Promise.all([
      this.deploymentsService.events(orgId, deploymentId),
      this.environmentsService.get(orgId, context.deployment.environmentId),
      this.deploymentsService.evaluateStageGate(orgId, deploymentId),
    ]);
    return {
      ...context,
      environment,
      progress: ladderProgress(context.deployment.ladder, context.deployment.rolloutState, context.deployment.canaryPercent),
      gate,
      events,
    };
  }

  /** Trigger a run from the console. */
  @Post('deployments')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @Idempotent()
  @RateLimit({ name: 'deployment-trigger', capacity: 20, refillPerSecond: 0.2, scope: 'principal' })
  async trigger(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Body() body: {
      pipeline_id?: string;
      stage_id?: string;
      agent_version?: string;
      strategy?: string;
      git?: { commit?: string; branch?: string; message?: string };
      snapshot?: Record<string, unknown>;
    },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.pipeline_id || !body.agent_version) {
      throw ApiError.validation({ input: 'pipeline_id and agent_version are required' });
    }
    if (body.strategy !== undefined && !ROLLOUT_STRATEGIES.includes(body.strategy as RolloutStrategy)) {
      throw ApiError.validation({ strategy: `must be one of ${ROLLOUT_STRATEGIES.join(', ')}` });
    }
    const deployment = await this.deploymentsService.trigger({
      orgId: this.orgId(orgHeader),
      pipelineId: body.pipeline_id,
      stageId: body.stage_id,
      agentVersion: body.agent_version,
      strategy: body.strategy as RolloutStrategy | undefined,
      git: body.git,
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
  ) {
    const result = await this.deploymentsService.approve({ orgId: this.orgId(orgHeader), deploymentId, actorId: principal.id, actorLabel: principal.id });
    return { ok: true, ...result };
  }

  /** Gate rejection — a reviewed deny fails the run before traffic moves. */
  @Post('deployments/:deploymentId/reject')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async reject(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { reason?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const deployment = await this.deploymentsService.reject({
      orgId: this.orgId(orgHeader),
      deploymentId,
      actorId: principal.id,
      actorLabel: principal.id,
      reason: body.reason,
    });
    return { deployment };
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

  @Get('deployments/:deploymentId/metrics')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async getMetrics(@Headers('x-neryva-org') orgHeader: string | string[] | undefined, @Param('deploymentId') deploymentId: string) {
    return { metrics: await this.deploymentsService.metrics(this.orgId(orgHeader), deploymentId) };
  }

  /** Pause the rollout — traffic holds at the current weight. */
  @Post('deployments/:deploymentId/pause')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async pauseDeployment(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.deploymentsService.pause({ orgId: this.orgId(orgHeader), deploymentId, actorId: principal.id, actorLabel: principal.id });
    return { ok: true };
  }

  /** Resume a paused rollout (re-arms the workflow tick). */
  @Post('deployments/:deploymentId/resume')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async resumeDeployment(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.deploymentsService.resume({ orgId: this.orgId(orgHeader), deploymentId, actorId: principal.id, actorLabel: principal.id });
    await this.workflow.schedule({ orgId: this.orgId(orgHeader), deploymentId, step: 'rollout' });
    return { ok: true };
  }

  /** Manual promote: approve the gate, or skip the current ladder step. */
  @Post('deployments/:deploymentId/promote')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async promote(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.deploymentsService.promote({ orgId: this.orgId(orgHeader), deploymentId, actorId: principal.id, actorLabel: principal.id });
    if (result.action === 'advanced') {
      await this.workflow.schedule({ orgId: this.orgId(orgHeader), deploymentId, step: 'rollout' });
    }
    return result;
  }

  /** Redeploy a failed/rolled-back run with its exact inputs (new run row). */
  @Post('deployments/:deploymentId/retry')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  @Idempotent()
  @RateLimit({ name: 'deployment-retry', capacity: 20, refillPerSecond: 0.2, scope: 'principal' })
  async retry(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const deployment = await this.deploymentsService.retry({
      orgId: this.orgId(orgHeader),
      deploymentId,
      actorId: principal.id,
      actorLabel: principal.id,
    });
    await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step: 'gates' });
    return { deployment };
  }

  /** Cancel a run: pending/gated fail in place; rolling runs roll back. */
  @Post('deployments/:deploymentId/cancel')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async cancel(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { reason?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    return this.deploymentsService.cancel({
      orgId: this.orgId(orgHeader),
      deploymentId,
      actorId: principal.id,
      actorLabel: principal.id,
      reason: body.reason,
    });
  }

  /** Instant rollback of a rolling/live run (restores the env's previous live). */
  @Post('deployments/:deploymentId/rollback')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async rollback(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
    @Body() body: { reason?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const deployment = await this.deploymentsService.rollback({
      orgId: this.orgId(orgHeader),
      deploymentId,
      actorId: principal.id,
      actorLabel: principal.id,
      reason: body.reason,
    });
    return { deployment };
  }

  // ── releases + activity ────────────────────────────────────────────────────

  /** The releases timeline (frontend Releases view). */
  @Get('releases')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async releases(
    @Headers('x-neryva-org') orgHeader?: string | string[],
    @Query('status') status?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    return this.releasesService.list(this.orgId(orgHeader), { status, limit });
  }

  /** Org-wide activity feed (dashboard). */
  @Get('activity')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @RequireEntitlement('deployment')
  async activity(
    @Headers('x-neryva-org') orgHeader?: string | string[],
    @Query('limit') limitRaw?: string,
    @Query('kinds') kindsRaw?: string,
  ) {
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    const kinds = kindsRaw?.split(',').map((k) => k.trim()).filter(Boolean);
    return { activity: await this.deploymentsService.activity(this.orgId(orgHeader), { limit, kinds }) };
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

  @Get('secrets/stats')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async secretsStats(@Headers('x-neryva-org') orgHeader?: string | string[]) {
    return this.secretsService.stats(this.orgId(orgHeader));
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
    @Body() body: { environment_id?: string; key?: string; value?: string; kms_ref?: string; expires_at?: string | null; rotation_interval_days?: number | null },
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
      expiresAt: body.expires_at ?? null,
      rotationIntervalDays: body.rotation_interval_days ?? null,
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

  @Delete('secrets/:secretId')
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

  @Post('secrets/:secretId/remove')
  @Roles('owner', 'admin', 'developer')
  @RequireEntitlement('deployment')
  async removeSecretAlias(
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('secretId') secretId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.secretsService.remove({ orgId: this.orgId(orgHeader), secretId, actorId: principal.id });
    return { ok: true };
  }
}
