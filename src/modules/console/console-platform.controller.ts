import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal, L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { EntitlementsService } from '../organizations/entitlements.service';
import { QuotaService } from '../billing/quota.service';
import { ManifestRegistryService } from './manifest-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConsoleOnboardingService } from './onboarding.service';
import { ConsoleStatusService } from './status.service';
import { ConsoleAuditQueryService } from './audit-query.service';

/**
 * The console plane's platform surface (gap C-2/C-3 + the benchmark
 * consoles' furniture): notification center, onboarding checklist, limits
 * view, status center, announcements, and the upgraded audit query/export.
 *
 * Notification/onboarding/status are ACCOUNT-scoped (no org needed); the
 * limits/audit views are org-scoped via the standard role guards.
 */
@Controller('console')
@AuthLayer('l1')
export class ConsolePlatformController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly onboarding: ConsoleOnboardingService,
    private readonly status: ConsoleStatusService,
    private readonly auditQuery: ConsoleAuditQueryService,
    private readonly entitlements: EntitlementsService,
    private readonly quota: QuotaService,
    private readonly manifests: ManifestRegistryService,
  ) {}

  private orgId(header: string | string[] | undefined): string {
    const orgId = Array.isArray(header) ? header[0] : header;
    if (!orgId) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    return orgId;
  }

  // ── Notification center (account-scoped) ────────────────────────────────

  @Get('notifications')
  @RateLimit({ name: 'console-notifications', capacity: 120, refillPerSecond: 2, scope: 'principal' })
  async listNotifications(
    @CurrentPrincipal() principal: L1Principal,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const [items, unreadCount] = await Promise.all([
      this.notifications.list(principal.id, unread === 'true', limit ? Number.parseInt(limit, 10) : undefined),
      this.notifications.unreadCount(principal.id),
    ]);
    return { notifications: items, unread_count: unreadCount };
  }

  @Post('notifications/:id/read')
  async markRead(@Param('id') id: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.notifications.markRead(principal.id, id);
    return { ok: true };
  }

  @Post('notifications/read-all')
  async markAllRead(@CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.notifications.markAllRead(principal.id);
    return { ok: true };
  }

  // ── Onboarding checklist (org-scoped read) ──────────────────────────────

  @Get('onboarding')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async onboardingState(@Headers('x-neryva-org') orgHeader?: string | string[]): Promise<unknown> {
    return this.onboarding.state(this.orgId(orgHeader));
  }

  // ── Limits view (benchmark pattern #9: limits attach to the grouping unit) ──

  @Get('org/:orgId/limits')
  @Roles('owner', 'admin', 'billing', 'developer')
  @UseGuards(OrgRolesGuard)
  async limits(
    @Param('orgId') orgId: string,
  ): Promise<{ products: Array<{ product: string; entitlement_state: string; quota: unknown }> }> {
    const products = await Promise.all(
      this.manifests.list().map(async (manifest) => {
        const state = await this.entitlements.getState(orgId, manifest.key);
        return {
          product: manifest.key,
          entitlement_state: state,
          quota: state === 'none' ? null : await this.quota.usageSnapshot(orgId, manifest.key),
        };
      }),
    );
    return { products };
  }

  // ── Audit query + export (upgraded O-5/O-6 surface) ─────────────────────

  @Get('org/:orgId/audit')
  @Roles('owner', 'admin', 'billing', 'developer')
  @UseGuards(OrgRolesGuard)
  async audit(
    @Param('orgId') orgId: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.auditQuery.query(orgId, {
      actor,
      action,
      from,
      to,
      before,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get('org/:orgId/audit/export')
  @Roles('owner', 'admin', 'billing')
  @UseGuards(OrgRolesGuard)
  @RateLimit({ name: 'console-audit-export', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async auditExport(
    @Param('orgId') orgId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<string> {
    const body = await this.auditQuery.export(orgId, { actor, action, from, to });
    reply.header('content-type', 'application/x-ndjson');
    reply.header('content-disposition', `attachment; filename="neryva-audit-${orgId}.ndjson"`);
    return body;
  }

  @Get('org/:orgId/audit/verify')
  @Roles('owner', 'admin', 'billing')
  @UseGuards(OrgRolesGuard)
  async auditVerify(@Param('orgId') orgId: string): Promise<unknown> {
    void orgId;
    return this.auditQuery.verify();
  }

  // ── Status center + announcements ───────────────────────────────────────

  @Get('status')
  async statusOverview(): Promise<unknown> {
    return this.status.status();
  }

  @Post('announcements')
  @AuthLayer('l2')
  @RateLimit({ name: 'console-announcements', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async createAnnouncement(
    @CurrentPrincipal() principal: L2Principal,
    @Body() body: { kind?: string; severity?: string; title?: string; body?: string; link?: string; active_until?: string | null },
  ): Promise<{ announcement: unknown }> {
    if (principal.role !== 'super_admin' && principal.role !== 'operator') {
      throw ApiError.forbidden('Announcements are a platform-operator surface');
    }
    if (!body.title || !body.kind) {
      throw ApiError.validation({ input: 'kind and title are required' });
    }
    const announcement = await this.status.createAnnouncement({
      kind: body.kind as never,
      severity: body.severity as never,
      title: body.title,
      body: body.body,
      link: body.link,
      activeUntil: body.active_until ?? null,
      publishedBy: principal.id,
    });
    return { announcement };
  }

  @Post('announcements/:id/resolve')
  @AuthLayer('l2')
  async resolveAnnouncement(@Param('id') id: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    if (principal.role !== 'super_admin' && principal.role !== 'operator') {
      throw ApiError.forbidden('Announcements are a platform-operator surface');
    }
    if (!(await this.status.resolveAnnouncement(id))) {
      throw ApiError.notFound('announcement');
    }
    return { ok: true };
  }
}
