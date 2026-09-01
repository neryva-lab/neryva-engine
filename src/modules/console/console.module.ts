import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { BillingModule } from '../billing/billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SatellitesModule } from '../satellites/satellites.module';
import { ConsoleHomeController } from './console-home.controller';
import { ConsoleHomeService } from './console-home.service';
import { ConsolePlatformController } from './console-platform.controller';
import { ConsoleAuditQueryService } from './audit-query.service';
import { ConsoleOnboardingService } from './onboarding.service';
import { ConsoleStatusService } from './status.service';
import { ManifestRegistryService } from './manifest-registry.service';
import { RouteBijectionService } from './route-bijection.service';
import { SummaryProviderRegistry } from './summary-provider.registry';
import { AgentStudioSummaryProvider } from './summaries/agent-studio.summary';
import { DeploymentSummaryProvider } from './summaries/deployment.summary';

/** Wires the built-in providers at boot and refreshes cards on entitlement moves. */
@Injectable()
export class ConsoleBoot implements OnModuleInit {
  constructor(
    private readonly summaries: SummaryProviderRegistry,
    private readonly agentStudio: AgentStudioSummaryProvider,
    private readonly deployment: DeploymentSummaryProvider,
    private readonly events: EventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    this.summaries.register(this.agentStudio);
    this.summaries.register(this.deployment);
    this.events.on<{ orgId: string; product: string }>(EngineEvents.EntitlementTransitioned, async (event) => {
      await this.summaries.invalidate(event.orgId, event.product);
    });
  }
}

/**
 * The console/control-plane module (ledger console.md C-1…C-4 + the gap-C
 * completion: notification center, onboarding checklist, status center,
 * announcements, limits view, and the paginated/filterable audit surface).
 * Registered when MODULES__CONSOLE_ENABLED (requires organizations; the
 * status center reads satellite liveness, the limits view reads quotas).
 */
@Module({
  imports: [OrganizationsModule, SatellitesModule, BillingModule, NotificationsModule],
// (in-app notifications live in modules/notifications — eng-0011; the console
// platform controller proxies its read surface under /console for the shell)
  controllers: [ConsoleHomeController, ConsolePlatformController],
  providers: [
    ManifestRegistryService,
    RouteBijectionService,
    SummaryProviderRegistry,
    AgentStudioSummaryProvider,
    DeploymentSummaryProvider,
    ConsoleHomeService,
    ConsoleOnboardingService,
    ConsoleStatusService,
    ConsoleAuditQueryService,
    ConsoleBoot,
  ],
  exports: [ManifestRegistryService, RouteBijectionService, SummaryProviderRegistry],
})
export class ConsoleModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('console', () => db.check());
  }
}
