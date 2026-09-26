import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { BillingModule } from '../billing/billing.module';
import { IdentityModule } from '../identity/identity.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SatellitesModule } from '../satellites/satellites.module';
import { StaffController } from './staff.controller';
import { StaffImpersonationService } from './staff-impersonation.service';
import { PlatformStaffAdminService } from './platform-staff.admin';
import { StaffRepositoriesModule } from './repositories/staff-repositories.module';

/** Expired-impersonation session sweep on boot (crash-safe catch-up). */
@Injectable()
export class StaffBoot implements OnModuleInit {
  constructor(private readonly impersonation: StaffImpersonationService) {}

  async onModuleInit(): Promise<void> {
    const swept = await this.impersonation.sweepExpiredSessions();
    if (swept > 0) {
      console.log(`[staff] swept ${swept} expired impersonation session(s)`);
    }
  }
}

/**
 * The staff overlay (gap P-3): platform operators' console — org lookup and
 * support (impersonation is READ-ONLY by guard enforcement), audit query +
 * chain verification, tenant feature flags, platform overview.
 *
 * Flag: MODULES__STAFF_ENABLED (requires identity + organizations +
 * satellites + billing).
 */
@Module({
  imports: [IdentityModule, OrganizationsModule, SatellitesModule, BillingModule, StaffRepositoriesModule],
  controllers: [StaffController],
  providers: [StaffImpersonationService, PlatformStaffAdminService, StaffBoot],
  exports: [StaffImpersonationService],
})
export class StaffModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('staff', () => db.check());
  }
}
