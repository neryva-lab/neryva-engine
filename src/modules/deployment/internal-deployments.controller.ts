import { Controller, Get, Headers, Param } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L3Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { EnvironmentsService } from './environments.service';
import { DeploymentsService } from './deployments.service';
import { SecretsService } from './secrets.service';

/**
 * The deployment internal plane: the serving runtime's config pull. The
 * agent-runtime (L3 service identity, scope `engine:config:pull` — the
 * connection contract's config-seam) resolves everything it needs to serve
 * a deployment in ONE call: the frozen agent-config snapshot, the target
 * environment, and the environment's decrypted secret bundle.
 *
 * This is the ONLY surface where secret plaintext exists outside the vault
 * — console callers can never reach it (L3 service scope required), every
 * resolve is audited, and last_used_at is bumped per secret.
 */
@Controller('internal/deployments')
@AuthLayer('l3')
@RequireScopes('engine:config:pull')
export class InternalDeploymentsController {
  constructor(
    private readonly deploymentsService: DeploymentsService,
    private readonly environmentsService: EnvironmentsService,
    private readonly secretsService: SecretsService,
  ) {}

  /**
   * The runtime bundle for a deployment: snapshot + environment + secrets.
   * The caller names the org via X-Neryva-Org; the RLS-scoped read is the
   * ownership check — a deployment row outside that org simply 404s.
   */
  @Get(':deploymentId/runtime-config')
  @RateLimit({ name: 'internal-deployments-config', capacity: 60, refillPerSecond: 2, scope: 'principal' })
  async runtimeConfig(
    @CurrentPrincipal() principal: L3Principal,
    @Headers('x-neryva-org') orgHeader: string | string[] | undefined,
    @Param('deploymentId') deploymentId: string,
  ) {
    const orgId = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;
    if (!orgId) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    const { deployment } = await this.deploymentsService.get(orgId, deploymentId);
    return this.bundle(orgId, deployment.environmentId, deployment, principal);
  }

  private async bundle(orgId: string, environmentId: string, deployment: { id: string; agentVersion: string; snapshot: unknown; strategy: string }, principal: L3Principal) {
    const environment = await this.environmentsService.get(orgId, environmentId);
    const secrets = await this.secretsService.resolveForEnvironment({ orgId, environmentId, actorId: principal.id });
    return {
      deployment: {
        id: deployment.id,
        agent_version: deployment.agentVersion,
        strategy: deployment.strategy,
        snapshot: deployment.snapshot,
      },
      environment: { id: environment.id, name: environment.name, region: environment.region, approval_mode: environment.approvalMode },
      secrets,
      resolved_at: new Date().toISOString(),
    };
  }
}
