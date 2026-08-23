import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ConsoleHomeController } from './console-home.controller';
import { ConsoleHomeService } from './console-home.service';
import { ManifestRegistryService } from './manifest-registry.service';
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
 * The console/control-plane module (ledger console.md C-1…C-4), registered
 * when MODULES__CONSOLE_ENABLED (requires organizations).
 *
 * The manifest registry and summary-provider registry are the platform's
 * integration seam: product modules (agent-studio furniture at P5,
 * deployment at P7) and satellites register through them — the shell never
 * gains product-specific code.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [ConsoleHomeController],
  providers: [
    ManifestRegistryService,
    SummaryProviderRegistry,
    AgentStudioSummaryProvider,
    DeploymentSummaryProvider,
    ConsoleHomeService,
    ConsoleBoot,
  ],
  exports: [ManifestRegistryService, SummaryProviderRegistry],
})
export class ConsoleModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('console', () => db.check());
  }
}
