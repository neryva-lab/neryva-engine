/**
 * PostgreSQL lane for `IExportRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`
 * (`createExport` / `downloadExport` / `listExports`). Byte-identical
 * behavior, same transaction boundaries, same error semantics — the queries
 * moved here mechanically; no logic changed.
 *
 * The download-token hash is computed here (SHA-256 of the presented
 * token), exactly as the service did — the token itself is never stored.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { conversations, messages, runs } from '../../conversations/schema';
import { exportRequests } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IExportRepository } from './export.repository';

@Injectable()
export class PgExportRepository implements IExportRepository {
  constructor(private readonly db: DbService) {}

  async createExport(input: {
    orgId: string;
    actor: string;
    scope: { conversation_ids?: string[] };
  }): Promise<typeof exportRequests.$inferSelect> {
    assertUuid(input.orgId, 'orgId');
    const conversationIds = input.scope.conversation_ids ?? [];

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
    return request;
  }

  async downloadExport(input: {
    orgId: string;
    exportId: string;
    token: string;
    actor: string;
  }): Promise<typeof exportRequests.$inferSelect> {
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
    return request;
  }

  async listExports(orgId: string): Promise<Array<typeof exportRequests.$inferSelect>> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(exportRequests)
        .where(eq(exportRequests.organizationId, orgId))
        .orderBy(desc(exportRequests.createdAt))
        .limit(50),
    );
  }
}
