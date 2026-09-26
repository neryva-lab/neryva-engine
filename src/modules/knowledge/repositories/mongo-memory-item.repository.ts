/**
 * MongoDB implementation of the memory-item repository port (P3).
 *
 * ALL `memory_items` access — writes AND retrieval-time reads — flows
 * through here, so the tombstone predicate, approval visibility and temporal
 * validity live in exactly one place. Tenant discipline: `mongo.withOrg` +
 * explicit `organization_id` predicate on every access (plan D6).
 */
import type { Db } from 'mongodb';
import type { Binary } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MemoryItem } from '../schema';
import type { MemoryItemMongoDoc } from './mongo-documents';
import type {
  LegalHoldSummary,
  MemoryItemDraft,
  MemoryPolicySettings,
  MemoryScope,
} from './repository-types';
import type { IMemoryItemRepository } from './memory-item.repository';
import {
  binUuid,
  cosineDistance,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
  toIso,
  uuidOrNull,
} from './mongo-knowledge-shared';

const MEMORY_ITEMS = 'memory_items';

/** Bounded purge batch (mirrors the pg `limit 1000` subquery cap). */
const PURGE_BATCH_CAP = 1000;

function toMemoryItem(doc: MemoryItemMongoDoc, orgId: string, stripEmbedding: boolean): MemoryItem {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: orgId,
    scopeType: doc.scope_type,
    scopeId: uuidOrNull(doc.scope_id),
    content: doc.content,
    sourceRef: (doc.source_ref ?? null) as MemoryItem['sourceRef'],
    provenance: doc.provenance,
    confidence: doc.confidence,
    visibility: doc.visibility,
    expiresAt: doc.expires_at,
    deletedAt: doc.deleted_at,
    embedding: stripEmbedding ? null : (doc.embedding as MemoryItem['embedding']),
    embeddingModel: doc.embedding_model,
    validFrom: doc.valid_from,
    invalidAt: doc.invalid_at,
    supersedes: uuidOrNull(doc.supersedes),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/**
 * The temporal-validity predicate every approved read enforces: live
 * (`deleted_at` null), unexpired, and within its validity window.
 */
function validityClauses(now: string): Array<Record<string, unknown>> {
  return [
    { deleted_at: null },
    { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
    { $or: [{ invalid_at: null }, { invalid_at: { $gt: now } }] },
  ];
}

/** OR-ed scope predicates: a scope with an id matches type+id, else type. */
function scopeOr(scopes: MemoryScope[]): Record<string, unknown> {
  return {
    $or: scopes.map((s) =>
      s.scopeId
        ? { scope_type: s.scopeType, scope_id: binUuid(s.scopeId, 'scopeId') }
        : { scope_type: s.scopeType },
    ),
  };
}

/** Combine clause groups under $and (duplicate $or keys must not collide). */
function approvedFilter(
  now: string,
  extra: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { $and: [...validityClauses(now), ...extra] };
}

/**
 * Convert a SQL LIKE pattern (backslash escapes, `%`/`_` wildcards) to a
 * case-insensitive RegExp. The service escapes the raw query; this method
 * receives the already-escaped pattern including its `%` wrappers.
 */
function likeToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegExpChar(pattern[i + 1]);
      i += 1;
    } else if (c === '%') {
      out += '.*';
    } else if (c === '_') {
      out += '.';
    } else {
      out += escapeRegExpChar(c);
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function escapeRegExpChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a pg `vector` SQL literal into a number array (fail closed). */
function parseVectorLiteral(literal: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(literal);
  } catch {
    throw ApiError.validation({ vectorLiteral: 'must be a JSON array of numbers' });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw ApiError.validation({ vectorLiteral: 'must be a non-empty array of finite numbers' });
  }
  return parsed as number[];
}

export class MongoMemoryItemRepository implements IMemoryItemRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db): {
    items: TenantScopedCollection<MemoryItemMongoDoc>;
  } {
    return {
      items: new TenantScopedCollection<MemoryItemMongoDoc>(db.collection(MEMORY_ITEMS)),
    };
  }

  async insertItem(orgId: string, draft: MemoryItemDraft): Promise<MemoryItem> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      const now = nowIso();
      const doc: MemoryItemMongoDoc = {
        id: binUuid(newId()),
        organization_id: binUuid(orgId, 'orgId'),
        scope_type: draft.scopeType,
        scope_id: draft.scopeId == null ? null : binUuid(draft.scopeId, 'scopeId'),
        content: draft.content,
        source_ref: draft.sourceRef ?? null,
        provenance: draft.provenance ?? null,
        confidence: draft.confidence ?? null,
        visibility: draft.visibility ?? 'organization',
        expires_at: draft.expiresAt == null ? null : toIso(draft.expiresAt),
        deleted_at: null,
        embedding: (draft.embedding ?? null) as number[] | null,
        embedding_model: draft.embeddingModel ?? null,
        valid_from: draft.validFrom == null ? now : toIso(draft.validFrom),
        invalid_at: null,
        supersedes: draft.supersedes == null ? null : binUuid(draft.supersedes, 'supersedes'),
        created_at: now,
        updated_at: now,
      };
      await items.insertOne(orgId, doc, sessionOf(ctx));
      return toMemoryItem(doc, orgId, false);
    });
  }

  async listItems(
    orgId: string,
    filter: { scopeType?: string; scopeId?: string; userCallerId?: string; limit: number },
  ): Promise<MemoryItem[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      // A4-27: clamp defensively — a non-numeric ?limit= must not reach the driver.
      const limit = Math.min(Math.max(1, Math.floor(filter.limit) || 50), 100);
      const conditions: Record<string, unknown> = { deleted_at: null };
      if (filter.scopeType) conditions.scope_type = filter.scopeType;
      if (filter.scopeId) conditions.scope_id = binUuid(filter.scopeId, 'scopeId');
      // A4-22: user-scoped rows are account-private — a user-scope read
      // without an explicit scope_id is constrained to the caller.
      if (filter.scopeType === 'user' && filter.userCallerId) {
        conditions.scope_id = binUuid(filter.userCallerId, 'userCallerId');
      }
      const docs = await items
        .find(orgId, conditions, { ...sessionOf(ctx), sort: { updated_at: -1 }, limit })
        .toArray();
      return docs.map((d) => toMemoryItem(d, orgId, false));
    });
  }

  async updateItemContent(
    orgId: string,
    memoryId: string,
    input: { content: string; embedding: number[]; embeddingModel: string },
  ): Promise<MemoryItem> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      // The isNull(deletedAt) predicate is part of the update — a missing
      // or tombstoned row 404s (tombstones are not resurrectable here).
      const doc = await items.findOneAndUpdate(
        orgId,
        { id: binUuid(memoryId, 'memoryId'), deleted_at: null },
        {
          $set: {
            content: input.content,
            embedding: input.embedding,
            embedding_model: input.embeddingModel,
            updated_at: nowIso(),
          },
        },
        { ...sessionOf(ctx), returnDocument: 'after' },
      );
      if (!doc) throw ApiError.notFound('memory item');
      return toMemoryItem(doc, orgId, false);
    });
  }

  async softDeleteItem(orgId: string, memoryId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      const now = nowIso();
      const res = await items.updateOne(
        orgId,
        { id: binUuid(memoryId, 'memoryId'), deleted_at: null },
        { $set: { deleted_at: now, invalid_at: now, updated_at: now } },
        sessionOf(ctx),
      );
      if (res.matchedCount === 0) throw ApiError.notFound('memory item');
    });
  }

  async purgeByContent(orgId: string, escapedLikePattern: string): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      const s = sessionOf(ctx);
      const matcher = likeToRegExp(escapedLikePattern);
      const now = nowIso();
      const purged: string[] = [];
      // Atomic claim per row (findOneAndUpdate): concurrent purges cannot
      // double-count — a row claimed by one purge is invisible to the other
      // via the deleted_at predicate. This is the mongo equivalent of the
      // single UPDATE…RETURNING: exact count under concurrency, no
      // select-then-update race.
      for (let i = 0; i < PURGE_BATCH_CAP; i += 1) {
        const doc = await items.findOneAndUpdate(
          orgId,
          { deleted_at: null, content: { $regex: matcher } },
          { $set: { deleted_at: now, invalid_at: now, updated_at: now } },
          { ...s, returnDocument: 'after', projection: { id: 1 } },
        );
        if (!doc) break;
        purged.push(doc.id.toUUID().toString());
      }
      return purged;
    });
  }

  async searchApprovedMemoriesVector(input: {
    orgId: string;
    vectorLiteral: string;
    queryModel: string;
    scopes: MemoryScope[];
    limit: number;
  }): Promise<MemoryItem[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const { items } = this.collections(db);
      const query = parseVectorLiteral(input.vectorLiteral);
      const now = new Date().toISOString();
      const docs = await items
        .find(
          input.orgId,
          approvedFilter(now, [
            { embedding: { $ne: null } },
            { $or: [{ embedding_model: input.queryModel }, { embedding_model: null }] },
            scopeOr(input.scopes),
          ]),
          sessionOf(ctx),
        )
        .toArray();
      // The pg lane orders by `embedding <=> vector` (cosine distance).
      const ranked = docs
        .filter((d) => Array.isArray(d.embedding) && (d.embedding as number[]).length === query.length)
        .map((d) => ({ doc: d, distance: cosineDistance(query, d.embedding as number[]) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, Math.max(input.limit, 0));
      // The pg lane does not select the embedding column here.
      return ranked.map(({ doc }) => toMemoryItem(doc, input.orgId, true));
    });
  }

  async listApprovedMemoriesForScopes(
    orgId: string,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<MemoryItem[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const { items } = this.collections(db);
      const now = new Date().toISOString();
      const docs = await items
        .find(
          orgId,
          approvedFilter(now, [scopeOr(scopes)]),
          { ...sessionOf(ctx), sort: { updated_at: -1 }, limit: Math.max(limit, 0) },
        )
        .toArray();
      return docs.map((d) => toMemoryItem(d, orgId, false));
    });
  }

  async readMemoryPolicy(orgId: string): Promise<MemoryPolicySettings | null> {
    // Cross-module read (documented in the interface): the org memory
    // policy lives in the organizations module's `org_settings`.
    // `org_settings.org_id` is a varchar primary key (NOT a UUID) — the
    // predicate is the plain org string, exactly as the pg lane's
    // `eq(orgSettings.orgId, orgId)`. Legacy keys `memory_pii_scrubbing` /
    // `memory_ttl_default_seconds`, fail-open per-value (unknown scrub →
    // 'off'; TTL outside [3600, 315360000] or non-integer → null).
    // Null when the row is absent, preferences is not an object, or the
    // read errors — the service applies the legacy fallback.
    const db = this.mongo.root;
    try {
      return await this.mongo.withOrg(orgId, async (ctx) => {
        const row = await db
          .collection('org_settings')
          .findOne<{ preferences?: Record<string, unknown> }>(
            { org_id: orgId },
            sessionOf(ctx),
          );
        const prefs: unknown = row?.preferences ?? null;
        if (!prefs || typeof prefs !== 'object') return null;
        const typed = prefs as Record<string, unknown>;
        const scrubRaw = typed['memory_pii_scrubbing'];
        const scrub = scrubRaw === 'redact' || scrubRaw === 'block' ? scrubRaw : 'off';
        const ttlRaw = typed['memory_ttl_default_seconds'];
        const ttlSeconds =
          typeof ttlRaw === 'number' &&
          Number.isInteger(ttlRaw) &&
          ttlRaw >= 3600 &&
          ttlRaw <= 315_360_000
            ? ttlRaw
            : null;
        return { scrub, ttlSeconds };
      });
    } catch {
      return null;
    }
  }

  async listActiveLegalHolds(orgId: string): Promise<LegalHoldSummary[]> {
    // Cross-module read (documented in the interface): an active
    // org-scope legal hold blocks the DSR purge, mirroring the retention
    // workflow's check_holds gate in the lifecycle module. Legacy expiry
    // gate: null expiry = no expiry.
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const holds = new TenantScopedCollection<{ id: Binary }>(db.collection('legal_holds'));
      const now = nowIso();
      const rows = await holds
        .find(
          orgId,
          {
            status: 'active',
            scope_type: 'organization',
            $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
          },
          sessionOf(ctx),
        )
        .toArray();
      return rows.map((row) => ({ id: row.id.toUUID().toString() }));
    });
  }

  async listApprovedMemories(input: {
    orgId: string;
    conversationId?: string;
    limit: number;
  }): Promise<MemoryItem[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const { items } = this.collections(db);
      const now = new Date().toISOString();
      const limit = Math.min(Math.max(1, Math.floor(input.limit) || 20), 20);
      const scopeCondition: Record<string, unknown> =
        input.conversationId !== undefined
          ? {
              $or: [
                { scope_type: 'organization' },
                { scope_id: binUuid(input.conversationId, 'conversationId') },
              ],
            }
          : { scope_type: 'organization' };
      const docs = await items
        .find(
          input.orgId,
          approvedFilter(now, [scopeCondition]),
          { ...sessionOf(ctx), sort: { updated_at: -1 }, limit },
        )
        .toArray();
      return docs.map((d) => toMemoryItem(d, input.orgId, false));
    });
  }
}
