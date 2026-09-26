/**
 * MongoDB lane for `IExportRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`.
 * The one-time download token is consumed with the same CAS semantics as
 * pg: `findOneAndUpdate` with `download_token_hash: null` in the filter —
 * concurrent first downloads resolve to exactly one winner; the loser's
 * update matches nothing → `conflict('export download race — retry with a
 * fresh request')`.
 *
 * Manifest assembly reads the conversations/messages/runs collections with
 * the same caps (200 messages, 50 runs per conversation) and the same
 * missing-conversation skip policy.
 */
import { Injectable } from '@nestjs/common';
import type { Db, Filter } from 'mongodb';
import { createHash } from 'node:crypto';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ExportRequest } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IExportRepository } from './export.repository';
import {
  requireOrg,
  tenantCollection,
  toExportRequest,
  toManifestConversation,
  type ExportRequestMongoDoc,
  type LifecycleConversationMongoDoc,
  type LifecycleMessageRefMongoDoc,
  type LifecycleRunRefMongoDoc,
} from './mongo-lifecycle-documents';

@Injectable()
export class MongoExportRepository implements IExportRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async createExport(input: {
    orgId: string;
    actor: string;
    scope: { conversation_ids?: string[] };
  }): Promise<ExportRequest> {
    assertUuid(input.orgId, 'orgId');
    const conversationIds = input.scope.conversation_ids ?? [];
    const db = this.mongo.root;

    const manifest = await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const conversations = tenantCollection<LifecycleConversationMongoDoc>(db, 'conversations');
      const messages = tenantCollection<LifecycleMessageRefMongoDoc>(db, 'messages');
      const runs = tenantCollection<LifecycleRunRefMongoDoc>(db, 'runs');
      const items: Array<Record<string, unknown>> = [];
      for (const conversationId of conversationIds) {
        const conv = await conversations.findOne(orgId, { id: uuidToBinary(conversationId) }, sessionOpt);
        if (!conv) {
          continue; // authorized records only — missing IDs are omitted, not errors
        }
        const msgs = await messages
          .find(orgId, { conversation_id: uuidToBinary(conversationId) }, { ...sessionOpt, sort: { sequence: 1 }, limit: 200 })
          .toArray();
        const runRows = await runs
          .find(orgId, { conversation_id: uuidToBinary(conversationId) }, { ...sessionOpt, limit: 50 })
          .toArray();
        items.push({
          conversation: toManifestConversation(conv),
          messages: msgs.map((m) => ({
            id: m.id.toUUID().toString(),
            sequence: m.sequence,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
          })),
          runs: runRows.map((r) => ({
            id: r.id.toUUID().toString(),
            state: r.state,
            acceptedAt: r.accepted_at,
          })),
        });
      }
      return { generated_at: new Date().toISOString(), scope: input.scope, items };
    });

    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const exports = tenantCollection<ExportRequestMongoDoc>(db, 'export_requests');
      const id = uuidv7();
      const now = new Date().toISOString();
      await exports.insertOne(
        orgId,
        {
          id: uuidToBinary(id),
          organization_id: uuidToBinary(orgId),
          actor_id: input.actor,
          scope: input.scope,
          manifest,
          state: 'ready',
          artifact_id: null,
          encryption_key_ref: null,
          download_token_hash: null,
          download_count: 0,
          expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          created_at: now,
          completed_at: now,
        },
        { session: ctx.session },
      );
      const saved = await exports.findOne(orgId, { id: uuidToBinary(id) }, { session: ctx.session });
      if (!saved) {
        throw ApiError.internal();
      }
      return toExportRequest(saved);
    });
  }

  async downloadExport(input: {
    orgId: string;
    exportId: string;
    token: string;
    actor: string;
  }): Promise<ExportRequest> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.exportId, 'exportId');
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const exports = tenantCollection<ExportRequestMongoDoc>(db, 'export_requests');
      const exportIdBin = uuidToBinary(input.exportId);

      const doc = await exports.findOne(orgId, { id: exportIdBin }, sessionOpt);
      if (!doc) {
        throw ApiError.notFound('export request');
      }
      if (doc.state === 'expired' || Date.parse(doc.expires_at) < Date.now()) {
        throw ApiError.forbidden('export expired');
      }
      if (doc.download_token_hash === null) {
        // First download: bind the presented token (CAS on the null hash —
        // exactly one concurrent first-download wins).
        const filter: Filter<ExportRequestMongoDoc> = {
          id: exportIdBin,
          download_token_hash: null,
        };
        const updated = await exports.findOneAndUpdate(
          orgId,
          filter,
          { $set: { download_token_hash: tokenHash, download_count: doc.download_count + 1 } },
          { ...sessionOpt, returnDocument: 'after' },
        );
        if (!updated) {
          throw ApiError.conflict('export download race — retry with a fresh request');
        }
        return toExportRequest(updated);
      }
      if (doc.download_token_hash !== tokenHash) {
        throw ApiError.forbidden('export download token mismatch');
      }
      if (doc.download_count >= 1) {
        throw ApiError.forbidden('export already downloaded (one-time token)');
      }
      const updated = await exports.findOneAndUpdate(
        orgId,
        { id: exportIdBin },
        { $set: { download_count: doc.download_count + 1 } },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.internal();
      }
      return toExportRequest(updated);
    });
  }

  async listExports(orgId: string): Promise<ExportRequest[]> {
    assertUuid(orgId, 'orgId');
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const exports = tenantCollection<ExportRequestMongoDoc>(db, 'export_requests');
      const docs = await exports
        .find(tenantId, {}, { session: ctx.session, sort: { created_at: -1 }, limit: 50 })
        .toArray();
      return docs.map(toExportRequest);
    });
  }
}
