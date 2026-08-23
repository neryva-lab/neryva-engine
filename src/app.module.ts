import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { KernelModule, AuthGuard, RateLimitGuard } from './common/kernel.module';
import { ModuleFlags } from './common/config/feature-flags';
import { CorporateModule } from './modules/corporate/corporate.module';
import { IdentityModule } from './modules/identity/identity.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ConsoleModule } from './modules/console/console.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StaffModule } from './modules/staff/staff.module';
import { BillingModule } from './modules/billing/billing.module';
import { AgentStudioModule } from './modules/agent-studio/agent-studio.module';
import { DeploymentModule } from './modules/deployment/deployment.module';
import { KeysModule } from './modules/keys/keys.module';
import { ConfigPublishModule } from './modules/config-publish/config-publish.module';
import { SatellitesModule } from './modules/satellites/satellites.module';

/**
 * Assembly ONLY: imports module registries, no logic. Modules register
 * behind their flags (ADR-005) — a disabled module contributes zero routes
 * and zero behavior; the flag matrix (validated at kernel boot) refuses
 * combinations that would leave an enabled module without its dependency.
 *
 * The global guards are registered HERE — after the feature imports — so
 * the composite AuthGuard resolves the feature modules' port bindings
 * (session registry, service clients) when those modules are enabled, and
 * fails closed when they are not.
 *
 * Guard order: rate limits run before authentication so brute-force
 * traffic is rejected before any DB/JWKS work.
 */
const imports = [
  KernelModule,
  ...(ModuleFlags.corporate ? [CorporateModule] : []),
  ...(ModuleFlags.identity ? [IdentityModule] : []),
  ...(ModuleFlags.organizations ? [OrganizationsModule] : []),
  ...(ModuleFlags.console ? [ConsoleModule] : []),
  ...(ModuleFlags.billing ? [BillingModule] : []),
  ...(ModuleFlags.agentStudio ? [AgentStudioModule] : []),
  ...(ModuleFlags.deployment ? [DeploymentModule] : []),
  ...(ModuleFlags.webhooks ? [WebhooksModule] : []),
  ...(ModuleFlags.notifications ? [NotificationsModule] : []),
  ...(ModuleFlags.staff ? [StaffModule] : []),
  ...(ModuleFlags.keys ? [KeysModule] : []),
  ...(ModuleFlags.satellites ? [SatellitesModule] : []),
  ...(ModuleFlags.configPublish ? [ConfigPublishModule] : []),
];

@Module({
  imports,
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
