import { Module } from '@nestjs/common';
import { ORG_ACCESS_PORT, SERVICE_ACCOUNT_DIRECTORY_PORT } from '../../common/auth/ports';
import { env } from '../../common/config/env';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { MongoDbService } from '../../common/infra/db/mongo/mongo.service';
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
import {
  ENTITLEMENT_REPOSITORY,
  GROUP_REPOSITORY,
  INVITE_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  ORG_ACCESS_REPOSITORY,
  ORG_AUDIT_REPOSITORY,
  ORG_INFO_REPOSITORY,
  ORG_LIFECYCLE_REPOSITORY,
  ORG_SETTINGS_REPOSITORY,
  PROJECT_REPOSITORY,
  SERVICE_ACCOUNT_REPOSITORY,
} from './repositories/repository-tokens';
import { PgEntitlementRepository } from './repositories/pg-entitlement.repository';
import { MongoEntitlementRepository } from './repositories/mongo-entitlement.repository';
import { PgProjectRepository } from './repositories/pg-project.repository';
import { MongoProjectRepository } from './repositories/mongo-project.repository';
import { PgGroupRepository } from './repositories/pg-group.repository';
import { MongoGroupRepository } from './repositories/mongo-group.repository';
import { PgServiceAccountRepository } from './repositories/pg-service-account.repository';
import { MongoServiceAccountRepository } from './repositories/mongo-service-account.repository';
import { PgOrgSettingsRepository } from './repositories/pg-org-settings.repository';
import { MongoOrgSettingsRepository } from './repositories/mongo-org-settings.repository';
import { PgOrgAuditRepository } from './repositories/pg-org-audit.repository';
import { MongoOrgAuditRepository } from './repositories/mongo-org-audit.repository';
import { PgMembershipRepository } from './repositories/pg-membership.repository';
import { MongoMembershipRepository } from './repositories/mongo-membership.repository';
import { PgInviteRepository } from './repositories/pg-invite.repository';
import { MongoInviteRepository } from './repositories/mongo-invite.repository';
import { PgOrgInfoRepository } from './repositories/pg-org-info.repository';
import { MongoOrgInfoRepository } from './repositories/mongo-org-info.repository';
import { PgOrgLifecycleRepository } from './repositories/pg-org-lifecycle.repository';
import { MongoOrgLifecycleRepository } from './repositories/mongo-org-lifecycle.repository';
import { PgOrgAccessRepository } from './repositories/pg-org-access.repository';
import { MongoOrgAccessRepository } from './repositories/mongo-org-access.repository';

/**
 * Provider selection for the organizations persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

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
    repositoryProvider(MEMBERSHIP_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoMembershipRepository(mongo) : new PgMembershipRepository(db),
    ),
    repositoryProvider(INVITE_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoInviteRepository(mongo) : new PgInviteRepository(db),
    ),
    repositoryProvider(ENTITLEMENT_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoEntitlementRepository(mongo) : new PgEntitlementRepository(db),
    ),
    repositoryProvider(PROJECT_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoProjectRepository(mongo) : new PgProjectRepository(db),
    ),
    repositoryProvider(GROUP_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoGroupRepository(mongo) : new PgGroupRepository(db),
    ),
    repositoryProvider(SERVICE_ACCOUNT_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoServiceAccountRepository(mongo) : new PgServiceAccountRepository(db),
    ),
    repositoryProvider(ORG_SETTINGS_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoOrgSettingsRepository(mongo) : new PgOrgSettingsRepository(db),
    ),
    repositoryProvider(ORG_AUDIT_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoOrgAuditRepository(mongo) : new PgOrgAuditRepository(db),
    ),
    repositoryProvider(ORG_INFO_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoOrgInfoRepository(mongo) : new PgOrgInfoRepository(db),
    ),
    repositoryProvider(ORG_LIFECYCLE_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoOrgLifecycleRepository(mongo) : new PgOrgLifecycleRepository(db),
    ),
    repositoryProvider(ORG_ACCESS_REPOSITORY, (db, mongo) =>
      isMongo() ? new MongoOrgAccessRepository(mongo) : new PgOrgAccessRepository(db),
    ),
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
  constructor(
    db: DbService,
    mongo: MongoDbService,
    healthRegistry: HealthRegistry,
  ) {
    // Provider-aware liveness: probe the lane that actually serves reads.
    // MongoDbService.check resolves void on success (throws on failure),
    // so normalize it to the boolean shape the registry expects.
    healthRegistry.register('organizations', async () => {
      if (isMongo()) {
        await mongo.check();
        return true;
      }
      return db.check();
    });
  }
}
