import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { SummaryProviderRegistry } from '../console/summary-provider.registry';
import { ConsoleModule } from '../console/console.module';
import { BillingModule } from '../billing/billing.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AgentStudioSummary } from './summary.service';
import { StudioController } from './studio.controller';
import { StudioKeysService } from './keys.service';

/**
 * Boot hook: the product registers its REAL summary provider over the
 * console's interim built-in (module init order guarantees the product
 * registers after the console — NestJS initializes dependencies first).
 * This is the product-registration contract in miniature: the product
 * arrives, registers, and the shell never changed.
 */
@Injectable()
export class AgentStudioBoot implements OnModuleInit {
  constructor(
    private readonly summaries: SummaryProviderRegistry,
    private readonly summary: AgentStudioSummary,
  ) {}

  onModuleInit(): void {
    this.summaries.register(this.summary);
  }
}

/**
 * The Agent Studio product furniture (ledger agent-studio S-1…S-4): the
 * studio product registration inside the engine. The RUNTIME (sessions,
 * threads, gateway, guardrails) stays in the agent-runtime satellite per
 * ADR-006 — this module is thin product furniture: entitlement, summary,
 * org-level views, key bindings, metering tag.
 *
 * Registered when MODULES__AGENT_STUDIO_ENABLED (requires console + billing
 * + organizations).
 */
@Module({
  imports: [ConsoleModule, BillingModule, OrganizationsModule],
  controllers: [StudioController],
  providers: [AgentStudioSummary, StudioKeysService, AgentStudioBoot],
  exports: [AgentStudioSummary, StudioKeysService],
})
export class AgentStudioModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('agent-studio', () => db.check());
  }
}
