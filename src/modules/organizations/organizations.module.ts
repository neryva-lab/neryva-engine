import { Module } from '@nestjs/common';
import { ORG_ACCESS_PORT } from '../../common/auth/ports';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementsService } from './entitlements.service';
import { InvitesService } from './invites.service';
import { MembershipsService } from './memberships.service';
import { OrgAccessService } from './org-access.service';
import { OrgController } from './org.controller';
import { ProjectsService } from './projects.service';

/**
 * The organizations module (O-1…O-4), registered when
 * MODULES__ORGANIZATIONS_ENABLED (requires identity). Binds the kernel's
 * ORG_ACCESS_PORT so the Roles/Entitlement guards reach real state.
 */
@Module({
  imports: [IdentityModule],
  controllers: [OrgController],
  providers: [
    MembershipsService,
    InvitesService,
    ProjectsService,
    EntitlementsService,
    OrgAccessService,
    { provide: ORG_ACCESS_PORT, useExisting: OrgAccessService },
  ],
  exports: [MembershipsService, InvitesService, ProjectsService, EntitlementsService, OrgAccessService, ORG_ACCESS_PORT],
})
export class OrganizationsModule {}
