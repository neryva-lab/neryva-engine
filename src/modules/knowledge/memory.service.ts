import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { memoryItems, MemoryItem } from './schema';
import { legalHolds } from '../lifecycle/lifecycle.schema';
import { EmbeddingService } from './embedding.service';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { memoryProposals } from '../conversations/mcp.schema';
import { orgSettings } from '../organizations/schema';
import { redactPii } from '../../common/guardrails/pii';
import { hashedAttr } from '../../common/observability/spans';
import { assertUuid } from './assert';

/**
 * Memory — Phase 7.8 (pinned here). A memory proposal (MCP
 * `SubmitMemoryProposal`) is NOT durable truth: it becomes a `memory_item`
 * only through an explicit Engine decision (`decide`), with provenance
 * preserved. Retrieval is scope-authorized in RetrievalService; items
 * expire and soft-delete — never hard-deleted from the API path.
 */
@Injectable()
export class MemoryService {
  private static readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  /**
   * P0 (ai-native-review.md BUG-1) — the vector-space label for a freshly
   * embedded memory: the org's `knowledge_config.embedding_model` when set,
   * else the embedding service default. This is the SAME `effective` rule the
   * re-embed worker and the retrieval query path use — write and read must
   * agree on the label or fresh memories become invisible to search.
   * Config-read failure stamps the service default (legacy behavior).
   */
  private async resolveWriteEmbeddingModel(orgId: string): Promise<string> {
    try {
      const latest = await this.configPublish.latest(orgId, 'knowledge_config', null);
      const configured = String(
        (latest?.payload as { embedding_model?: string } | undefined)?.embedding_model ?? '',
      ).trim();
      if (configured.length > 0) {
        return configured;
      }
    } catch (err) {
      MemoryService.logger.warn(
        `memory embedding model fell back to service default for org ${orgId}: ${(err as Error).message}`,
      );
    }
    return this.embedding.model;
  }

  /**
   * P3 (memory governance) — org memory policy from org_settings.preferences.
   * Absent row/keys = legacy posture (scrub off, no default TTL). Malformed
   * values fail OPEN to legacy (settings are validator-written; a corrupt
   * row must never block memory writes — the settings surface owns repair).
   */
  private async readMemoryPolicy(
    orgId: string,
  ): Promise<{ scrub: 'off' | 'redact' | 'block'; ttlSeconds: number | null }> {
    const fallback = { scrub: 'off' as const, ttlSeconds: null as number | null };
    try {
      const rows = await this.db.withOrg(orgId, (tx) =>
        tx
          .select({ preferences: orgSettings.preferences })
          .from(orgSettings)
          .where(eq(orgSettings.orgId, orgId))
          .limit(1),
      );
      const prefs = (rows[0]?.preferences ?? {}) as Record<string, unknown>;
      const scrubRaw = prefs.memory_pii_scrubbing;
      const scrub = scrubRaw === 'redact' || scrubRaw === 'block' ? scrubRaw : 'off';
      const ttlRaw = prefs.memory_ttl_default_seconds;
      const ttlSeconds =
        typeof ttlRaw === 'number' &&
        Number.isInteger(ttlRaw) &&
        ttlRaw >= 3600 &&
        ttlRaw <= 315_360_000
          ? ttlRaw
          : null;
      return { scrub, ttlSeconds };
    } catch {
      return fallback;
    }
  }

  /**
   * P3 — apply the scrub policy to candidate content. Returns the storable
   * text plus scrub metadata; the CALLER audits post-insert with the real
   * item id (match count only — never content, the PII module's own law).
   * `block` refuses with 422 naming the rule, never the matched text.
   */
  private async applyScrubPolicy(
    orgId: string,
    content: string,
  ): Promise<{ text: string; redacted: boolean; matchCount: number }> {
    const policy = await this.readMemoryPolicy(orgId);
    if (policy.scrub === 'off') {
      return { text: content, redacted: false, matchCount: 0 };
    }
    const { redacted, matchCount } = redactPii(content);
    if (matchCount === 0) {
      return { text: content, redacted: false, matchCount: 0 };
    }
    if (policy.scrub === 'block') {
      throw ApiError.validation({
        content:
          'memory content appears to contain personal data — remove it or ask an owner to relax the memory scrub policy',
      });
    }
    return { text: redacted, redacted: true, matchCount };
  }

  /** P3 — default TTL from policy when the caller sets no expiry. */
  private ttlOrDefault(
    policy: { ttlSeconds: number | null },
    explicit: string | null | undefined,
  ): string | null {
    if (explicit) {
      return explicit;
    }
    if (policy.ttlSeconds === null) {
      return null;
    }
    return new Date(Date.now() + policy.ttlSeconds * 1000).toISOString();
  }

  /** Approve or reject a memory proposal; approval materializes a memory item. */
  async decide(input: {
    orgId: string;
    proposalId: string;
    decision: 'APPROVED' | 'REJECTED';
    actor: string;
    scopeType?: 'organization' | 'conversation' | 'assistant' | 'user';
    scopeId?: string;
    expiresAt?: Date;
  }): Promise<{ proposalDecision: string; memoryItem: MemoryItem | null }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.proposalId, 'proposalId');
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryProposals)
        .where(eq(memoryProposals.id, input.proposalId))
        .limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('memory proposal');
      }
      const proposal = rows[0];
      if (proposal.decision !== 'PENDING') {
        throw ApiError.conflict('memory proposal already decided', { decision: proposal.decision });
      }
      await tx
        .update(memoryProposals)
        .set({ decision: input.decision })
        .where(eq(memoryProposals.id, proposal.id));

      if (input.decision === 'REJECTED') {
        await this.audit.add({
          action: 'memory.proposal_rejected',
          resourceType: 'memory_proposal',
          resourceId: proposal.id,
          actorType: 'account',
          actorId: input.actor,
          tenantId: input.orgId,
          details: { run_id: proposal.runId },
        });
        return { proposalDecision: 'REJECTED', memoryItem: null };
      }

      const scopeType = input.scopeType ?? 'organization';
      // A4-21: a user-scoped item with no explicit scope_id is bound to the
      // deciding actor's account — run-time retrieval keys user memories on
      // scope_id = the run actor's account id, so a NULL scope_id would be a
      // write-void (stored, listed, never served to any run).
      const scopeId =
        scopeType === 'user' && !input.scopeId ? input.actor : (input.scopeId ?? null);
      // P3: scrub BEFORE embed (the vector must match the STORED text, never
      // the pre-redaction original) and before the TTL default resolves.
      const scrubbed = await this.applyScrubPolicy(input.orgId, proposal.value);
      const policy = await this.readMemoryPolicy(input.orgId);
      // FL-2.4 — embed at approval: the semantic-memory index is filled the
      // moment an item becomes durable truth (never at query time).
      // P0: stamp the producing model (see resolveWriteEmbeddingModel).
      const [embedding] = await this.embedding.embed([scrubbed.text]);
      const embeddingModel = await this.resolveWriteEmbeddingModel(input.orgId);
      const itemRows = await tx
        .insert(memoryItems)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType,
          scopeId,
          content: scrubbed.text,
          sourceRef: { proposal_id: proposal.id, run_id: proposal.runId },
          provenance: proposal.provenance ?? 'memory_proposal',
          confidence: proposal.confidence,
          visibility: proposal.visibility === 'private' ? 'private' : 'organization',
          expiresAt: this.ttlOrDefault(
            policy,
            input.expiresAt?.toISOString() ?? proposal.expiresAt,
          ),
          embedding,
          embeddingModel,
        })
        .returning();
      await this.audit.add({
        action: 'memory.proposal_approved',
        resourceType: 'memory_item',
        resourceId: itemRows[0].id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { proposal_id: proposal.id, run_id: proposal.runId, scope_type: scopeType },
      });
      if (scrubbed.redacted) {
        await this.audit.add({
          action: 'memory.pii_redacted',
          resourceType: 'memory_item',
          resourceId: itemRows[0].id,
          actorType: 'account',
          actorId: input.actor,
          tenantId: input.orgId,
          details: { match_count: scrubbed.matchCount },
        });
      }
      MemoryService.logger.log(`memory proposal ${proposal.id} approved for org ${input.orgId}`);
      return { proposalDecision: 'APPROVED', memoryItem: itemRows[0] };
    });
  }

  async list(
    orgId: string,
    opts?: { scopeType?: string; scopeId?: string; limit?: number; callerId?: string },
  ): Promise<MemoryItem[]> {
    assertUuid(orgId, 'orgId');
    // A4-27: clamp defensively — a non-numeric ?limit= must not reach drizzle.
    const rawLimit = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? opts.limit : 50;
    const limit = Math.min(Math.max(1, rawLimit), 100);
    const conditions = [eq(memoryItems.organizationId, orgId), isNull(memoryItems.deletedAt)];
    if (opts?.scopeType) {
      conditions.push(eq(memoryItems.scopeType, opts.scopeType));
    }
    if (opts?.scopeId) {
      assertUuid(opts.scopeId, 'scopeId');
      conditions.push(eq(memoryItems.scopeId, opts.scopeId));
    }
    // A4-22: user-scoped rows are account-private by contract ("visible only
    // to that account"). The library read must not return another account's
    // user rows, so a user-scope read without an explicit scope_id is
    // constrained to the caller.
    if (opts?.scopeType === 'user' && opts?.callerId) {
      conditions.push(eq(memoryItems.scopeId, opts.callerId));
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(and(...conditions))
        .orderBy(desc(memoryItems.updatedAt))
        .limit(limit),
    );
  }

  /** FL-2.28 — user-authored memory (GDPR-friendly "what do you remember"). */
  async create(input: {
    orgId: string;
    content: string;
    scopeType: 'organization' | 'conversation' | 'user';
    scopeId?: string;
    actor: string;
  }): Promise<MemoryItem> {
    assertUuid(input.orgId, 'orgId');
    // A4-21: a user-scoped item with no explicit scope_id is bound to the
    // author's account — run-time retrieval keys user memories on
    // scope_id = the run actor's account id, so a NULL scope_id would be a
    // write-void (stored, listed, never served to any run).
    const scopeId =
      input.scopeType === 'user' && !input.scopeId ? input.actor : (input.scopeId ?? null);
    // P3: scrub-then-embed (same ordering law as the approval path).
    const scrubbed = await this.applyScrubPolicy(input.orgId, input.content.trim());
    const policy = await this.readMemoryPolicy(input.orgId);
    const [embedding] = await this.embedding.embed([scrubbed.text]);
    // P0: stamp the producing model (see resolveWriteEmbeddingModel).
    const embeddingModel = await this.resolveWriteEmbeddingModel(input.orgId);
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(memoryItems)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType: input.scopeType,
          scopeId,
          content: scrubbed.text.slice(0, 8192),
          sourceRef: { actor: input.actor },
          provenance: 'user_authored',
          visibility: input.scopeType === 'organization' ? 'organization' : 'private',
          expiresAt: this.ttlOrDefault(policy, null),
          embedding,
          embeddingModel,
        })
        .returning();
      await this.audit.add({
        action: 'memory.created',
        resourceType: 'memory_item',
        resourceId: rows[0].id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { scope_type: input.scopeType },
      });
      if (scrubbed.redacted) {
        await this.audit.add({
          action: 'memory.pii_redacted',
          resourceType: 'memory_item',
          resourceId: rows[0].id,
          actorType: 'account',
          actorId: input.actor,
          tenantId: input.orgId,
          details: { match_count: scrubbed.matchCount },
        });
      }
      return rows[0];
    });
  }

  /**
   * A4-20 — in-place edit of a memory entry's content. The UI previously
   * offered no correction path (delete + re-create); this is the honest
   * alternative to silent immutability. Scope, TTL, provenance and visibility
   * are NOT editable (scope changes would silently re-home the row; TTL is a
   * lifecycle concern). The scrub-then-embed ordering law of create applies:
   * the stored vector must match the STORED text, so the embedding and its
   * model stamp are recomputed. Tombstoned rows are not resurrectable here —
   * editing a deleted row 404s (recovery is a Phase 9 workflow).
   */
  async updateMemory(input: {
    orgId: string;
    memoryId: string;
    content: string;
    actor: string;
  }): Promise<MemoryItem> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.memoryId, 'memoryId');
    const text = input.content.trim();
    if (!text) {
      throw ApiError.validation({ content: 'must be a non-empty string' });
    }
    const scrubbed = await this.applyScrubPolicy(input.orgId, text);
    const [embedding] = await this.embedding.embed([scrubbed.text]);
    const embeddingModel = await this.resolveWriteEmbeddingModel(input.orgId);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(memoryItems)
        .set({
          content: scrubbed.text.slice(0, 8192),
          embedding,
          embeddingModel,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(memoryItems.id, input.memoryId),
            eq(memoryItems.organizationId, input.orgId),
            isNull(memoryItems.deletedAt),
          ),
        )
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('memory item');
    }
    await this.audit.add({
      action: 'memory.updated',
      resourceType: 'memory_item',
      resourceId: input.memoryId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {},
    });
    if (scrubbed.redacted) {
      await this.audit.add({
        action: 'memory.pii_redacted',
        resourceType: 'memory_item',
        resourceId: input.memoryId,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { match_count: scrubbed.matchCount },
      });
    }
    return rows[0];
  }

  /**
   * P3 (DSR "forget my X") — content-addressed purge: tombstone every
   * non-deleted item whose content contains `substring` (case-insensitive).
   * Same tombstone semantics as softDelete (deletedAt + invalidAt — history
   * stays answerable, retrieval stops seeing them). The query fingerprint in
   * audit is a HASH: the substring itself may carry the very PII being
   * purged and must never land in the audit trail. Bounded: refuses
   * substrings under 3 chars (a 1-2 char purge would nuke the corpus by
   * accident) and reports (never returns) matched ids, capped for the audit
   * row.
   */
  async purgeByContent(input: {
    orgId: string;
    substring: string;
    actor: string;
  }): Promise<{ purged: number; truncated: boolean }> {
    assertUuid(input.orgId, 'orgId');
    const needle = input.substring.trim();
    if (needle.length < 3 || needle.length > 128) {
      throw ApiError.validation({
        substring: 'must be 3..128 chars — shorter queries would match the corpus by accident',
      });
    }
    // A4-24: an active org-scope legal hold blocks the DSR purge, mirroring
    // the retention workflow's check_holds gate (retention-purge.service.ts).
    const holds = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ id: legalHolds.id })
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.organizationId, input.orgId),
            eq(legalHolds.status, 'active'),
            or(isNull(legalHolds.expiresAt), sql`${legalHolds.expiresAt} > now()`),
            eq(legalHolds.scopeType, 'organization'),
          ),
        )
        .limit(1),
    );
    if (holds.length > 0) {
      throw ApiError.conflict('an active legal hold blocks memory purge', {
        legal_hold_id: holds[0].id,
      });
    }
    // Escape LIKE wildcards so the match is literal, not a pattern. Single
    // UPDATE...RETURNING (capped): exact count under concurrency, no
    // select-then-update race — a concurrent purge of the same rows just
    // finds them already tombstoned via the isNull(deletedAt) predicate.
    const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
    const matched = await this.db.withOrg(input.orgId, async (tx) => {
      const now = new Date().toISOString();
      const updated = await tx.execute(sql`
        update memory_items set deleted_at = ${now}, invalid_at = ${now}, updated_at = ${now}
        where id in (
          select id from memory_items
          where organization_id = ${input.orgId}::uuid
            and deleted_at is null
            and content ilike ${`%${escaped}%`} escape '\\'
          limit 1000
        )
        returning id
      `);
      return (updated.rows as Array<{ id: string }>).map((r) => ({ id: String(r.id) }));
    });
    await this.audit.add({
      action: 'memory.purged',
      resourceType: 'memory_item',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        query_hash: hashedAttr(`memory-purge:${needle}`),
        purged_count: matched.length,
        purged_ids: matched.slice(0, 100).map((r) => r.id),
      },
    });
    // A4-25: the subquery caps at 1000 — report it so the caller never
    // claims "nothing matched stays retrievable" when the cap was hit.
    return { purged: matched.length, truncated: matched.length === 1000 };
  }

  /** Soft delete — tombstone stays for provenance; purge is a Phase 9 workflow. */
  async softDelete(input: { orgId: string; memoryId: string; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.memoryId, 'memoryId');
    await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(memoryItems)
        .set({
          deletedAt: new Date().toISOString(),
          invalidAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(memoryItems.id, input.memoryId),
            eq(memoryItems.organizationId, input.orgId),
            isNull(memoryItems.deletedAt),
          ),
        )
        .returning({ id: memoryItems.id });
      if (rows.length === 0) {
        throw ApiError.notFound('memory item');
      }
    });
    await this.audit.add({
      action: 'memory.deleted',
      resourceType: 'memory_item',
      resourceId: input.memoryId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {},
    });
  }
}
