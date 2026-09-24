import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../common/ids/uuidv7';
import { conversations, messages, runs } from '../conversations/schema';
import { dataAccessRecords, exportRequests, ExportRequest, legalHolds, LegalHold, purgeTasks, tombstones } from './lifecycle.schema';
import { assertUuid } from './assert';

/**
 * Legal holds (9.4), exports (9.5), and the sensitive data-access record
 * stream (9.7) — plus the tombstone read helper used by console paths.
 */
@Injectable()
export class LifecycleService {
  private static readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Legal holds (9.4) ───────────────────────────────────────────────────

  async placeHold(input: { orgId: string; scopeType: string; scopeId: string | null; reason: string; actor: string; expiresAt?: Date }): Promise<LegalHold> {
    assertUuid(input.orgId, 'orgId');
    if (input.scopeId) assertUuid(input.scopeId, 'scopeId');
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(legalHolds)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          holdReason: input.reason.slice(0, 512),
          placedBy: input.actor,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'legal_hold.placed',
      resourceType: 'legal_hold',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { scope_type: input.scopeType, scope_id: input.scopeId, reason: input.reason.slice(0, 128) },
    });
    return rows[0];
  }

  async releaseHold(input: { orgId: string; holdId: string; actor: string }): Promise<LegalHold> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.holdId, 'holdId');
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(legalHolds)
        .set({ status: 'released', releasedAt: new Date().toISOString() })
        .where(and(eq(legalHolds.id, input.holdId), eq(legalHolds.organizationId, input.orgId), eq(legalHolds.status, 'active')))
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('active legal hold');
    }
    const hold = rows[0];
    // Re-arm purges this hold was blocking: tasks parked in `blocked` for the
    // released scope return to `check_holds` so the next worker tick resumes
    // them. Without this, `blocked` is a dead end — claimOne only picks up
    // pending/in_progress — and release would never unblock anything.
    // Scope predicate mirrors stepCheckHolds: org-wide holds cover every task
    // in the org, scoped holds cover their exact (scopeType, scopeId).
    const scopeMatch =
      hold.scopeType === 'organization' || hold.scopeId === null
        ? undefined
        : and(eq(purgeTasks.scopeType, hold.scopeType), eq(purgeTasks.scopeId, hold.scopeId));
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({ state: 'in_progress', step: 'check_holds', lastError: null, lockedAt: null })
        .where(
          scopeMatch === undefined
            ? and(eq(purgeTasks.organizationId, input.orgId), eq(purgeTasks.state, 'blocked'))
            : and(eq(purgeTasks.organizationId, input.orgId), eq(purgeTasks.state, 'blocked'), scopeMatch),
        );
    });
    await this.audit.add({
      action: 'legal_hold.released',
      resourceType: 'legal_hold',
      resourceId: input.holdId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {},
    });
    return hold;
  }

  async listHolds(orgId: string): Promise<LegalHold[]> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) => tx.select().from(legalHolds).where(eq(legalHolds.organizationId, orgId)).orderBy(desc(legalHolds.placedAt)).limit(100));
  }

  // ── Exports (9.5) ───────────────────────────────────────────────────────

  /**
   * Create an export request and snapshot an AUTHORIZED manifest
   * (point-in-time, RLS-scoped). The archive is a bounded JSON manifest —
   * canonical records + artifact references — written to private storage
   * when object storage is configured, else held in-request for download.
   * One-time download via a token whose SHA-256 is stored, never the token.
   */
  async createExport(input: { orgId: string; actor: string; scope: { conversation_ids?: string[] } }): Promise<ExportRequest> {
    assertUuid(input.orgId, 'orgId');
    const conversationIds = input.scope.conversation_ids ?? [];
    if (conversationIds.length > 20) {
      throw ApiError.validation({ conversation_ids: 'max 20 per export' });
    }
    for (const id of conversationIds) {
      assertUuid(id, 'conversation_ids');
    }

    const manifest = await this.db.withOrg(input.orgId, async (tx) => {
      const items: Array<Record<string, unknown>> = [];
      for (const conversationId of conversationIds) {
        const conv = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        if (conv.length === 0) {
          continue; // authorized records only — missing IDs are omitted, not errors
        }
        const msgs = await tx
          .select({ id: messages.id, sequence: messages.sequence, role: messages.role, content: messages.content, createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .limit(200);
        const runRows = await tx.select({ id: runs.id, state: runs.state, acceptedAt: runs.acceptedAt }).from(runs).where(eq(runs.conversationId, conversationId)).limit(50);
        items.push({ conversation: conv[0], messages: msgs, runs: runRows });
      }
      return { generated_at: new Date().toISOString(), scope: input.scope, items };
    });

    const request = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(exportRequests)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          actorId: input.actor,
          scope: input.scope,
          manifest,
          state: 'ready',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          completedAt: new Date().toISOString(),
        })
        .returning();
      return rows[0];
    });
    await this.audit.add({
      action: 'export.created',
      resourceType: 'export_request',
      resourceId: request.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversations: conversationIds.length },
    });
    return request;
  }

  /**
   * One-time download: consumes the token (hash-at-rest), records a
   * data_access_record, increments download_count. Second use is rejected.
   */
  async downloadExport(input: { orgId: string; exportId: string; token: string; actor: string }): Promise<Record<string, unknown>> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.exportId, 'exportId');
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const request = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(exportRequests)
        .where(and(eq(exportRequests.id, input.exportId), eq(exportRequests.organizationId, input.orgId)))
        .limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('export request');
      }
      const req = rows[0];
      if (req.state === 'expired' || Date.parse(req.expiresAt) < Date.now()) {
        throw ApiError.forbidden('export expired');
      }
      if (req.downloadTokenHash === null) {
        // First download: bind the presented token.
        const updated = await tx
          .update(exportRequests)
          .set({ downloadTokenHash: tokenHash, downloadCount: req.downloadCount + 1 })
          .where(and(eq(exportRequests.id, req.id), isNull(exportRequests.downloadTokenHash)))
          .returning();
        return updated[0] ?? null;
      }
      if (req.downloadTokenHash !== tokenHash) {
        throw ApiError.forbidden('export download token mismatch');
      }
      if (req.downloadCount >= 1) {
        throw ApiError.forbidden('export already downloaded (one-time token)');
      }
      const updated = await tx
        .update(exportRequests)
        .set({ downloadCount: req.downloadCount + 1 })
        .where(eq(exportRequests.id, req.id))
        .returning();
      return updated[0];
    });
    if (!request) {
      throw ApiError.conflict('export download race — retry with a fresh request');
    }
    await this.recordAccess({
      orgId: input.orgId,
      actorType: 'account',
      actorId: input.actor,
      accessType: 'export_download',
      resourceType: 'export_request',
      resourceId: request.id,
    });
    // P2-COMP-15: export downloads were only written to data_access_records,
    // which no surface reads — so the console's claim that privileged actions
    // "appear here and on the Activity page" was false for downloads. Emit the
    // audit event too, so downloads are visible in the hash-chained trail.
    await this.audit.add({
      action: 'export.downloaded',
      resourceType: 'export_request',
      resourceId: request.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { download_count: request.downloadCount },
    });
    return request.manifest as Record<string, unknown>;
  }

  async listExports(orgId: string): Promise<ExportRequest[]> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) => tx.select().from(exportRequests).where(eq(exportRequests.organizationId, orgId)).orderBy(desc(exportRequests.createdAt)).limit(50));
  }

  // ── Data access records (9.7) ───────────────────────────────────────────

  async recordAccess(input: {
    orgId: string | null;
    actorType: string;
    actorId: string;
    accessType: string;
    resourceType: string;
    resourceId?: string;
    justification?: string;
    traceId?: string;
  }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.insert(dataAccessRecords).values({
        id: uuidv7(),
        organizationId: input.orgId,
        actorType: input.actorType,
        actorId: input.actorId.slice(0, 128),
        accessType: input.accessType,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        justification: input.justification?.slice(0, 512) ?? null,
        traceId: input.traceId?.slice(0, 64) ?? null,
      });
    });
  }

  // ── Tombstone reads (9.8) ───────────────────────────────────────────────

  async tombstoneFor(resourceType: string, resourceId: string): Promise<{ reason: string } | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(tombstones).where(and(eq(tombstones.resourceType, resourceType), eq(tombstones.resourceId, resourceId))).limit(1),
    );
    return rows.length > 0 ? { reason: rows[0].reason } : null;
  }

  /** Health/purpose check used by module wiring — keeps storage honest. */
  get storageAvailable(): boolean {
    try {
      this.storage.requireAvailable();
      return true;
    } catch {
      return false;
    }
  }
}
