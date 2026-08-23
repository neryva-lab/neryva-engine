import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { EntitlementGuard, RequireEntitlement } from '../../common/policy/entitlement.guard';
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
    @Body() body: { pipeline_id?: string; stage_id?: string; agent_version?: string; strategy?: string; snapshot?: Record<string, unknown> },
  ) {
    const orgId = this.orgId(principal, orgHeader);
    if (!body.pipeline_id || !body.agent_version) {
      throw ApiError.validation({ input: 'pipeline_id and agent_version are required' });
    }
    const strategy = ROLLOUT_STRATEGIES.includes(body.strategy as RolloutStrategy) ? (body.strategy as RolloutStrategy) : undefined;
    const deployment = await this.deploymentsService.trigger({
      orgId,
      pipelineId: body.pipeline_id,
      stageId: body.stage_id,
      agentVersion: body.agent_version,
      strategy,
      snapshot: body.snapshot,
      actorId: principal.id,
      actorLabel: principal.id,
      actorKind: 'api_key',
    });
    await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step: 'gates' });
    return { deployment };
  }

  @Get(':deploymentId')
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
      },
      events,
    };
  }
}
