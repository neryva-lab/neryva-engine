import { Module } from '@nestjs/common';
import { ORG_ACCESS_PORT, SERVICE_ACCOUNT_DIRECTORY_PORT } from '../../common/auth/ports';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { CorporateModule } from '../corporate/corporate.module';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementsService } from './entitlements.service';
import { InvitesService } from './invites.service';
import { MembershipsService } from './memberships.service';
import { OrgAccessService } from './org-access.service';
import { OrgAuditController } from './org-audit.controller';
import { OrgAuditService } from './org-audit.service';
import { OrgController } from './org.controller';
import { OrgGroupsController } from './org-groups.controller';
import { OrgGroupsService } from './org-groups.service';
import { OrgLifecycleController } from './org-lifecycle.controller';
import { OrgLifecycleService } from './org-lifecycle.service';
import { OrgMembersController } from './org-members.controller';
import { OrgPurgeWorker } from './org-purge.worker';
import { OrgProjectsController } from './org-projects.controller';
import { OrgServiceAccountsController } from './org-service-accounts.controller';
import { OrgServiceAccountsService } from './org-service-accounts.service';
import { OrgSettingsService } from './org-settings.service';
import { ProjectsService } from './projects.service';

/**
 * The organizations module (O-1…O-4 + the dense pass eng-0009), registered
 * when MODULES__ORGANIZATIONS_ENABLED (requires identity). Binds the
 * kernel's ORG_ACCESS_PORT (Roles/Entitlement guards) and the
 * SERVICE_ACCOUNT_DIRECTORY_PORT (L2 `nrv_sa_` token resolution in the
 * auth guard) so both reach real state; both fail closed when this module
 * is disabled.
 *
 * CorporateModule is imported directly: the org services send email
 * (invites, role-change and removal notices, deletion receipts) through
 * the corporate EmailService — IdentityModule does not re-export it.
 */
@Module({
  imports: [CorporateModule, IdentityModule],
  controllers: [
    OrgController,
    OrgMembersController,
    OrgProjectsController,
    OrgGroupsController,
    OrgServiceAccountsController,
    OrgAuditController,
    OrgLifecycleController,
  ],
  providers: [
    MembershipsService,
    InvitesService,
    ProjectsService,
    EntitlementsService,
    OrgSettingsService,
    OrgGroupsService,
    OrgServiceAccountsService,
    OrgAuditService,
    OrgAccessService,
    OrgLifecycleService,
    OrgPurgeWorker,
    { provide: ORG_ACCESS_PORT, useExisting: OrgAccessService },
    { provide: SERVICE_ACCOUNT_DIRECTORY_PORT, useExisting: OrgServiceAccountsService },
  ],
  exports: [
    MembershipsService,
    InvitesService,
    ProjectsService,
    EntitlementsService,
    OrgSettingsService,
    OrgGroupsService,
    OrgServiceAccountsService,
    OrgAuditService,
    OrgAccessService,
    OrgLifecycleService,
    ORG_ACCESS_PORT,
    SERVICE_ACCOUNT_DIRECTORY_PORT,
  ],
})
export class OrganizationsModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('organizations', () => db.check());
  }
}
