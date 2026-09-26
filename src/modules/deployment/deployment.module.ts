import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { BillingModule } from '../billing/billing.module';
import { ConsoleModule } from '../console/console.module';
import { SummaryProviderRegistry } from '../console/summary-provider.registry';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DeploymentSummary } from './summary.service';
import { DeploymentController } from './deployment.controller';
import { DeploymentWorkflow } from './deployment.workflow';
import { DeploymentWorker } from './deployment.worker';
import { DeploymentsService } from './deployments.service';
import { EnvironmentsService } from './environments.service';
import { InternalDeploymentsController } from './internal-deployments.controller';
import { PipelinesService } from './pipelines.service';
import { ReleasesService } from './releases.service';
import { RuntimeDeploymentsController } from './runtime-deployments.controller';
import { SecretsService } from './secrets.service';
import { SettingsService } from './settings.service';
import { DeploymentRepositoriesModule } from './repositories/deployment-repositories.module';

/** The product registers its real summary provider over the console's stub. */
@Injectable()
export class DeploymentBoot implements OnModuleInit {
  constructor(
    private readonly summaries: SummaryProviderRegistry,
    private readonly summary: DeploymentSummary,
  ) {}

  onModuleInit(): void {
    this.summaries.register(this.summary);
  }
}

/**
 * The deployment product (ledger deployment-product D-1…D-5): pipelines,
 * environments, gated rollouts with configurable canary ladders, the
 * secrets vault — an ENGINE module per ADR-006 D4 (if its worker fleet
 * outgrows the engine, it graduates to a capability deployment via the
 * standard contract — an ADR-level act).
 *
 * Registered when MODULES__DEPLOYMENT_ENABLED (requires console + billing +
 * organizations). Planes:
 *   /console/deployment/**   L1 control surface
 *   /v1/deployments/**       L2 runtime surface (deployment:operate)
 *   /internal/deployments/** L3 service plane (engine:config:pull — the
 *                            serving runtime's config + secrets resolve)
 */
@Module({
  imports: [ConsoleModule, BillingModule, OrganizationsModule, NotificationsModule, DeploymentRepositoriesModule],
  controllers: [DeploymentController, RuntimeDeploymentsController, InternalDeploymentsController],
  providers: [
    PipelinesService,
    EnvironmentsService,
    DeploymentsService,
    SecretsService,
    SettingsService,
    ReleasesService,
    DeploymentWorkflow,
    DeploymentWorker,
    DeploymentSummary,
    DeploymentBoot,
  ],
  exports: [DeploymentsService, DeploymentWorkflow, DeploymentSummary],
})
export class DeploymentModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('deployment', () => db.check());
  }
}
