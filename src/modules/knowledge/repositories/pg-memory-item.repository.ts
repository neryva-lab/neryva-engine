import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { orgSettings } from '../../organizations/schema';
import { legalHolds } from '../../lifecycle/lifecycle.schema';
import { memoryItems, type MemoryItem } from '../schema';
import type { IMemoryItemRepository } from './memory-item.repository';
import type {
  LegalHoldSummary,
  MemoryItemDraft,
  MemoryPolicySettings,
  MemoryScope,
} from './repository-types';

/**
 * PostgreSQL implementation of `IMemoryItemRepository` (P3).
 *
 * Mechanical move of the `memory_items` SQL from `MemoryService` (writes)
 * and `RetrievalService` (read-path queries). Each method owns its
 * transaction; no transaction handle leaks.
 *
 * One aggregate, one repo: ALL `memory_items` access goes through this
 * port, so the tombstone predicate, approval visibility and temporal
 * validity live in exactly one place.
 *
 * INTERFACE GAPS (reported 2026-09-26): `MemoryService.readMemoryPolicy`
 * reads `org_settings` and `MemoryService.purgeByContent` reads
 * `legal_holds`, but no interface method exposes those reads. The service
 * rewiring is blocked on this.
 *
 * What stays OUT (still the service's job): scrubbing (PII), embedding
 * computation, LIKE-escaping, audit writes, tracing spans.
 */
export class PgMemoryItemRepository implements IMemoryItemRepository {
  constructor(private readonly db: DbService) {}

  /**
   * CROSS-MODULE READ (documented): memory policy lives in the
   * organizations-owned `org_settings.preferences` JSON. Legacy fail-open
   * parsing, mirrored from the service: `scrub` must be one of
   * off|redact|block (anything else → 'off'); `memory_ttl_seconds` must
   * be a number in [3600, 315360000] (anything else → null). Null when
   * the settings row or the preferences object is absent.
   */
  async readMemoryPolicy(orgId: string): Promise<MemoryPolicySettings | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(orgSettings)
        .where(eq(orgSettings.orgId, orgId))
        .limit(1);
      const prefs = (rows[0]?.preferences ?? null) as Record<string, unknown> | null;
      if (!prefs || typeof prefs !== 'object') return null;
      // Legacy keys, byte-faithful: `memory_pii_scrubbing` / `memory_ttl_default_seconds`.
      const scrubRaw = prefs['memory_pii_scrubbing'];
      const scrub = scrubRaw === 'redact' || scrubRaw === 'block' ? scrubRaw : 'off';
      const ttlRaw = prefs['memory_ttl_default_seconds'];
      const ttlSeconds =
        typeof ttlRaw === 'number' &&
        Number.isInteger(ttlRaw) &&
        ttlRaw >= 3600 &&
        ttlRaw <= 315_360_000
          ? ttlRaw
          : null;
      return { scrub, ttlSeconds };
    });
  }

  /**
   * CROSS-MODULE READ (documented): active org-scope legal holds from
   * the lifecycle-owned `legal_holds`. An active hold blocks the DSR
   * purge — the service reports the first hold's id in its 409.
   */
  async listActiveLegalHolds(orgId: string): Promise<LegalHoldSummary[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: legalHolds.id })
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.organizationId, orgId),
            eq(legalHolds.scopeType, 'organization'),
            eq(legalHolds.status, 'active'),
            // Legacy expiry gate, byte-faithful: null expiry = no expiry.
            or(isNull(legalHolds.expiresAt), sql`${legalHolds.expiresAt} > now()`),
          ),
        );
      return rows.map((r: { id: string }) => ({ id: r.id }));
    });
  }

  async insertItem(orgId: string, draft: MemoryItemDraft): Promise<MemoryItem> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .insert(memoryItems)
        .values({ id: uuidv7(), organizationId: orgId, ...draft })
        .returning();
      return rows[0];
    });
  }

  async listItems(
    orgId: string,
    filter: { scopeType?: string; scopeId?: string; userCallerId?: string; limit: number },
  ): Promise<MemoryItem[]> {
    // A4-27: the service clamps the limit defensively before it reaches
    // here — a non-numeric ?limit= must not reach drizzle.
    const conditions = [eq(memoryItems.organizationId, orgId), isNull(memoryItems.deletedAt)];
    if (filter.scopeType) {
      conditions.push(eq(memoryItems.scopeType, filter.scopeType));
    }
    if (filter.scopeId) {
      conditions.push(eq(memoryItems.scopeId, filter.scopeId));
    }
    // A4-22: user-scoped rows are account-private by contract ("visible only
    // to that account"). The library read must not return another account's
    // user rows, so a user-scope read without an explicit scope_id is
    // constrained to the caller.
    if (filter.scopeType === 'user' && filter.userCallerId) {
      conditions.push(eq(memoryItems.scopeId, filter.userCallerId));
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(and(...conditions))
        .orderBy(desc(memoryItems.updatedAt))
        .limit(filter.limit),
    );
  }

  async updateItemContent(
    orgId: string,
    memoryId: string,
    input: { content: string; embedding: number[]; embeddingModel: string },
  ): Promise<MemoryItem> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(memoryItems)
        .set({
          content: input.content,
          embedding: input.embedding,
          embeddingModel: input.embeddingModel,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(memoryItems.id, memoryId),
            eq(memoryItems.organizationId, orgId),
            isNull(memoryItems.deletedAt),
          ),
        )
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('memory item');
    }
    return rows[0];
  }

  async softDeleteItem(orgId: string, memoryId: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(memoryItems)
        .set({
          deletedAt: new Date().toISOString(),
          invalidAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(memoryItems.id, memoryId),
            eq(memoryItems.organizationId, orgId),
            isNull(memoryItems.deletedAt),
          ),
        )
        .returning({ id: memoryItems.id }),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('memory item');
    }
  }

  async purgeByContent(orgId: string, escapedLikePattern: string): Promise<string[]> {
    // Single UPDATE…RETURNING (capped): exact count under concurrency, no
    // select-then-update race — a concurrent purge of the same rows just
    // finds them already tombstoned via the isNull(deletedAt) predicate.
    // LIKE-escaping of the raw query stays in the SERVICE; the pattern
    // arrives already escaped.
    return this.db.withOrg(orgId, async (tx) => {
      const now = new Date().toISOString();
      const updated = await tx.execute(sql`
        update memory_items set deleted_at = ${now}, invalid_at = ${now}, updated_at = ${now}
        where id in (
          select id from memory_items
          where organization_id = ${orgId}::uuid
            and deleted_at is null
            and content ilike ${`%${escapedLikePattern}%`} escape '\\'
          limit 1000
        )
        returning id
      `);
      return (updated.rows as Array<{ id: string }>).map((r) => String(r.id));
    });
  }

  async searchApprovedMemoriesVector(input: {
    orgId: string;
    vectorLiteral: string;
    queryModel: string;
    scopes: MemoryScope[];
    limit: number;
  }): Promise<MemoryItem[]> {
    const scopePredicates = input.scopes.map((s) =>
      s.scopeId
        ? sql`(scope_type = ${s.scopeType} and scope_id = ${s.scopeId}::uuid)`
        : sql`(scope_type = ${s.scopeType})`,
    );
    return this.db.withOrg(input.orgId, async (tx) => {
      // P0 (BUG-1): same model rule as the document leg. Legacy rows with
      // NULL embedding_model (pre-0064) still participate — they converge
      // out as memories are re-approved/rewritten with the model stamped.
      const rows = await tx.execute(sql`
        select id, scope_type, scope_id, content, source_ref, provenance, confidence, visibility,
               expires_at, valid_from, invalid_at, supersedes, created_at, updated_at, embedding_model
        from memory_items
        where organization_id = ${input.orgId}::uuid
          and deleted_at is null
          and embedding is not null
          and (embedding_model = ${input.queryModel} or embedding_model is null)
          and (expires_at is null or expires_at > now())
          and (${sql.join(scopePredicates, sql` or `)})
        order by embedding <=> ${input.vectorLiteral}::vector
        limit ${input.limit}
      `);
      return (rows.rows as Array<Record<string, unknown>>).map((r): MemoryItem => ({
        id: String(r.id),
        organizationId: input.orgId,
        scopeType: String(r.scope_type),
        scopeId: r.scope_id == null ? null : String(r.scope_id),
        content: String(r.content),
        sourceRef: r.source_ref ?? null,
        provenance: r.provenance == null ? null : String(r.provenance),
        confidence: r.confidence == null ? null : String(r.confidence),
        embeddingModel: r.embedding_model == null ? null : String(r.embedding_model),
        visibility: String(r.visibility),
        expiresAt: r.expires_at == null ? null : String(r.expires_at),
        deletedAt: null,
        embedding: null,
        validFrom: String(r.valid_from ?? r.created_at),
        invalidAt: r.invalid_at == null ? null : String(r.invalid_at),
        supersedes: r.supersedes == null ? null : String(r.supersedes),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      }));
    });
  }

  async listApprovedMemoriesForScopes(
    orgId: string,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<MemoryItem[]> {
    const scopePredicates = scopes.map((s) =>
      s.scopeId
        ? and(eq(memoryItems.scopeType, s.scopeType), eq(memoryItems.scopeId, s.scopeId))
        : eq(memoryItems.scopeType, s.scopeType),
    );
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.organizationId, orgId),
            isNull(memoryItems.deletedAt),
            or(...scopePredicates),
            or(isNull(memoryItems.expiresAt), sql`expires_at > now()`),
            or(isNull(memoryItems.invalidAt), sql`invalid_at > now()`),
          ),
        )
        .orderBy(desc(memoryItems.updatedAt))
        .limit(limit),
    );
  }

  async listApprovedMemories(input: {
    orgId: string;
    conversationId?: string;
    limit: number;
  }): Promise<MemoryItem[]> {
    return this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.organizationId, input.orgId),
            isNull(memoryItems.deletedAt),
            or(
              eq(memoryItems.scopeType, 'organization'),
              input.conversationId ? eq(memoryItems.scopeId, input.conversationId) : sql`false`,
            ),
            or(isNull(memoryItems.expiresAt), sql`expires_at > now()`),
            or(isNull(memoryItems.invalidAt), sql`invalid_at > now()`),
          ),
        )
        .orderBy(desc(memoryItems.updatedAt))
        .limit(input.limit),
    );
  }
}
