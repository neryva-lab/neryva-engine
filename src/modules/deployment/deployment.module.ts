import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { BillingModule } from '../billing/billing.module';
import { ConsoleModule } from '../console/console.module';
import { SummaryProviderRegistry } from '../console/summary-provider.registry';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DeploymentSummary } from './summary.service';
import { DeploymentController } from './deployment.controller';
import { DeploymentWorkflow } from './deployment.workflow';
import { DeploymentsService } from './deployments.service';
import { EnvironmentsService } from './environments.service';
import { PipelinesService } from './pipelines.service';
import { RuntimeDeploymentsController } from './runtime-deployments.controller';
import { SecretsService } from './secrets.service';

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
 * environments, gated rollouts, the secrets vault — an ENGINE module per
 * ADR-006 D4 (if its worker fleet outgrows the engine, it graduates to a
 * capability deployment via the standard contract — an ADR-level act).
 *
 * Registered when MODULES__DEPLOYMENT_ENABLED (requires console + billing +
 * organizations). Runtime plane: /v1/deployments (L2 deployment:operate).
 */
@Module({
  imports: [ConsoleModule, BillingModule, OrganizationsModule],
  controllers: [DeploymentController, RuntimeDeploymentsController],
  providers: [PipelinesService, EnvironmentsService, DeploymentsService, SecretsService, DeploymentWorkflow, DeploymentSummary, DeploymentBoot],
  exports: [DeploymentsService, DeploymentWorkflow, DeploymentSummary],
})
export class DeploymentModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('deployment', () => db.check());
  }
}
