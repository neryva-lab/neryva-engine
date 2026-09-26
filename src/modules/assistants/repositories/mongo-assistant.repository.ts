/**
 * MongoDB `IAssistantRepository` — the assistant aggregate root on the
 * mongo lane.
 *
 * Tenant discipline: every tenant-scoped access goes through
 * `TenantScopedCollection` (explicit `organization_id` predicates — there
 * is no RLS on this lane). UUIDs are BSON Binary subtype 4
 * (`binUuid`/`uuidToBinary`); timestamps are ISO-8601 strings in
 * `Date.toISOString()` format, matching the pg lane's `mode: 'string'`
 * columns so lexicographic `$lt`/`$gt` comparisons stay correct.
 *
 * Conflict mapping: the required unique indexes (`uq_assistants_org_name`,
 * `uq_assistant_versions_assistant_version`) exist in the mongo migrator;
 * duplicate-key errors (11000) map to the exact `ApiError` shapes the pg
 * lane's `mapAssistantUniqueViolation` produces.
 *
 * The degraded-worker claim methods are intentionally cross-org: they run
 * in `withBypass` (no tenant predicate) with an atomic `findOneAndUpdate`
 * claim, so two workers never select the same row. The optional `orgId`
 * input is a test seam only.
 */
import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { ApiError } from '../../../common/http/api-error';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { Assistant } from '../schema';
import type { IAssistantRepository, VersionPayloadValues } from './assistant.repository';
import {
  assistantNameConflict,
  binToUuid,
  binUuid,
  isDuplicateKeyError,
  nowIsoString,
  toAssistant,
  uuidToBinary,
  type AssistantMongoDoc,
  type AssistantVersionMongoDoc,
} from './mongo-assistant-documents';

const LIST_CAP = 200;
const SWEEP_CAP = 100;

@Injectable()
export class MongoAssistantRepository implements IAssistantRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      assistants: new TenantScopedCollection<AssistantMongoDoc>(
        db.collection<AssistantMongoDoc>('assistants'),
      ),
      versions: new TenantScopedCollection<AssistantVersionMongoDoc>(
        db.collection<AssistantVersionMongoDoc>('assistant_versions'),
      ),
      conversations: new TenantScopedCollection<{ id: unknown }>(
        db.collection<{ id: unknown }>('conversations'),
      ),
      // Cross-org worker access — no tenant predicate by design.
      assistantsBypass: new PlatformCollection<AssistantMongoDoc>(
        db.collection<AssistantMongoDoc>('assistants'),
      ),
    };
  }

  private versionDoc(
    orgId: string,
    assistantId: string,
    values: VersionPayloadValues,
  ): AssistantVersionMongoDoc {
    const now = nowIsoString();
    return {
      id: uuidToBinary(uuidv7()),
      assistant_id: binUuid(assistantId, 'assistantId'),
      organization_id: binUuid(orgId, 'orgId'),
      version: 0, // sentinel for DRAFT — publish assigns the monotonic version
      schema_version: 1,
      status: 'DRAFT',
      model_policy: values.modelPolicy,
      context_policy: values.contextPolicy,
      tool_policy: values.toolPolicy,
      knowledge_policy: values.knowledgePolicy ?? null,
      guardrail_policy: values.guardrailPolicy,
      instructions: values.instructions ?? null,
      model_params: values.modelParams ?? null,
      budget_policy: values.budgetPolicy ?? null,
      brand: values.brand ?? null,
      rollback_of: null,
      parent_version_id: values.parentVersionId ? binUuid(values.parentVersionId, 'parentVersionId') : null,
      hash: values.hash,
      published_at: null,
      published_by: null,
      retention_class: 'business-history',
      created_at: now,
      updated_at: now,
    };
  }

  async createAssistant(input: {
    orgId: string;
    name: string;
    description?: string | null;
  }): Promise<Assistant> {
    const db = this.mongo.root;
    const { assistants } = this.collections(db);
    const now = nowIsoString();
    const doc: AssistantMongoDoc = {
      id: uuidToBinary(uuidv7()),
      organization_id: binUuid(input.orgId, 'orgId'),
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      active_version_id: null,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
      degraded_until: null,
      degraded_reason: null,
      degraded_alerted_at: null,
      retention_class: 'business-history',
      created_at: now,
      updated_at: now,
    };
    try {
      await assistants.insertOne(input.orgId, doc);
    } catch (err) {
      // The only realistically reachable unique index on this insert is
      // uq_assistants_org_name (the id is a fresh uuidv7).
      if (isDuplicateKeyError(err)) throw assistantNameConflict(input.name);
      throw err;
    }
    return toAssistant(doc);
  }

  async createAssistantWithDraftVersion(input: {
    orgId: string;
    name: string;
    description?: string | null;
    versionValues: VersionPayloadValues;
  }): Promise<{ assistant: Assistant; versionId: string }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const { assistants, versions } = this.collections(db);
      const session = { session: ctx.session };
      const now = nowIsoString();
      const assistantDoc: AssistantMongoDoc = {
        id: uuidToBinary(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        active_version_id: null,
        disabled_at: null,
        disabled_by: null,
        disabled_reason: null,
        degraded_until: null,
        degraded_reason: null,
        degraded_alerted_at: null,
        retention_class: 'business-history',
        created_at: now,
        updated_at: now,
      };
      try {
        await assistants.insertOne(input.orgId, assistantDoc, session);
      } catch (err) {
        if (isDuplicateKeyError(err)) throw assistantNameConflict(input.name);
        throw err;
      }
      const versionDoc = this.versionDoc(input.orgId, binToUuid(assistantDoc.id), input.versionValues);
      try {
        await versions.insertOne(input.orgId, versionDoc, session);
      } catch (err) {
        // Unreachable for a fresh assistant (the sentinel is per-assistant),
        // mapped defensively to the typed draft conflict.
        if (isDuplicateKeyError(err)) throw assistantNameConflict(input.name);
        throw err;
      }
      return { assistant: toAssistant(assistantDoc), versionId: binToUuid(versionDoc.id) };
    });
  }

  async getAssistant(orgId: string, assistantId: string): Promise<Assistant | null> {
    const db = this.mongo.root;
    const { assistants } = this.collections(db);
    const doc = await assistants.findOne(orgId, { id: binUuid(assistantId, 'assistantId') });
    return doc ? toAssistant(doc) : null;
  }

  async listAssistants(orgId: string): Promise<Assistant[]> {
    const db = this.mongo.root;
    const { assistants } = this.collections(db);
    const docs = await assistants
      .find(orgId, {}, { sort: { updated_at: -1 }, limit: LIST_CAP })
      .toArray();
    return docs.map(toAssistant);
  }

  async deleteAssistantWithRetiredConversations(
    orgId: string,
    assistantId: string,
  ): Promise<{ name: string; conversationsRemoved: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { assistants, conversations } = this.collections(db);
      const session = { session: ctx.session };
      const assistantBin = binUuid(assistantId, 'assistantId');
      // Active conversations block deletion; archived/deleted ones are
      // removed below. (Lane divergence, reported: the pg lane additionally
      // FK-guards the check-then-delete race — MongoDB's snapshot isolation
      // has no equivalent enforcement, so the check reads the TX snapshot.)
      const active = await conversations.findOne(
        orgId,
        { assistant_id: assistantBin, status: 'active' },
        session,
      );
      if (active) {
        throw ApiError.conflict('assistant has active conversations — archive them before deleting');
      }
      const retired = await conversations.deleteMany(
        orgId,
        { assistant_id: assistantBin, status: { $in: ['archived', 'deleted'] } },
        session,
      );
      // Lane divergence, reported: the pg lane cascades message /
      // participant / event rows via FK; the mongo lane has no cascades, so
      // rows under deleted conversations are left for the lifecycle purge.
      const deleted = await assistants.findOneAndDelete(orgId, { id: assistantBin }, session);
      if (!deleted) {
        throw ApiError.notFound('assistant');
      }
      return { name: deleted.name, conversationsRemoved: retired.deletedCount ?? 0 };
    });
  }

  async setDisabled(
    orgId: string,
    assistantId: string,
    disabled: boolean,
    opts: { reason?: string; actorId: string },
  ): Promise<Assistant> {
    const db = this.mongo.root;
    const { assistants } = this.collections(db);
    const now = nowIsoString();
    const updated = await assistants.findOneAndUpdate(
      orgId,
      { id: binUuid(assistantId, 'assistantId') },
      {
        $set: disabled
          ? {
              disabled_at: now,
              disabled_by: opts.actorId.slice(0, 128),
              disabled_reason: (opts.reason ?? 'operator kill switch').slice(0, 512),
              updated_at: now,
            }
          : {
              disabled_at: null,
              disabled_by: null,
              disabled_reason: null,
              updated_at: now,
            },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      throw ApiError.notFound('assistant');
    }
    return toAssistant(updated);
  }

  async claimOverdueDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { assistantsBypass } = this.collections(db);
      const session = { session: ctx.session };
      const now = nowIsoString();
      // TTL claim marker: a crashed worker's claims expire instead of
      // sticking forever (the pg lane's FOR UPDATE SKIP LOCKED releases on
      // TX commit — the TTL is this lane's equivalent release).
      const claimUntil = nowIsoString(new Date(Date.now() + 5 * 60_000));
      const base: Record<string, unknown> = {
        degraded_until: { $ne: null, $lt: now },
        disabled_at: null,
      };
      if (input.orgId !== undefined) {
        base['organization_id'] = binUuid(input.orgId, 'orgId');
      }
      // Atomic claim: the filter is the fence — a concurrent worker's
      // findOneAndUpdate cannot match a row this worker just claimed.
      const claimFilter: Record<string, unknown> = {
        ...base,
        $or: [{ degraded_claimed_until: null }, { degraded_claimed_until: { $lt: now } }],
      };
      const claimed: Array<{ orgId: string; assistantId: string; name: string }> = [];
      for (let i = 0; i < SWEEP_CAP; i++) {
        const row = await assistantsBypass.findOneAndUpdate(
          claimFilter,
          { $set: { degraded_claimed_until: claimUntil } },
          { ...session, returnDocument: 'after', sort: { degraded_until: 1 } },
        );
        if (!row) break;
        claimed.push({
          orgId: binToUuid(row.organization_id),
          assistantId: binToUuid(row.id),
          name: row.name,
        });
      }
      return claimed;
    });
  }

  async claimDueSoonDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { assistantsBypass } = this.collections(db);
      const session = { session: ctx.session };
      const now = nowIsoString();
      const soon = nowIsoString(new Date(Date.now() + 24 * 3_600_000));
      const claimUntil = nowIsoString(new Date(Date.now() + 5 * 60_000));
      const base: Record<string, unknown> = {
        degraded_until: { $ne: null, $gte: now, $lt: soon },
        degraded_alerted_at: null,
        disabled_at: null,
      };
      if (input.orgId !== undefined) {
        base['organization_id'] = binUuid(input.orgId, 'orgId');
      }
      const claimFilter: Record<string, unknown> = {
        ...base,
        $or: [{ degraded_claimed_until: null }, { degraded_claimed_until: { $lt: now } }],
      };
      const claimed: Array<{ orgId: string; assistantId: string; name: string }> = [];
      for (let i = 0; i < SWEEP_CAP; i++) {
        const row = await assistantsBypass.findOneAndUpdate(
          claimFilter,
          { $set: { degraded_claimed_until: claimUntil } },
          { ...session, returnDocument: 'after', sort: { degraded_until: 1 } },
        );
        if (!row) break;
        claimed.push({
          orgId: binToUuid(row.organization_id),
          assistantId: binToUuid(row.id),
          name: row.name,
        });
      }
      return claimed;
    });
  }

  async markDegradedAlerted(assistantId: string): Promise<void> {
    const db = this.mongo.root;
    // Cross-org by design (the interface takes no orgId): the conditional
    // update only fires when degraded_alerted_at is still null, so it is
    // idempotent and safe under concurrent workers. It also releases this
    // lane's TTL claim marker (the pg lane's row-lock claim needs no
    // equivalent — the lock is already released).
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { assistantsBypass } = this.collections(db);
      await assistantsBypass.updateOne(
        { id: binUuid(assistantId, 'assistantId'), degraded_alerted_at: null },
        {
          $set: {
            degraded_alerted_at: nowIsoString(),
            degraded_claimed_until: null,
          },
        },
        { session: ctx.session },
      );
    });
  }
}
