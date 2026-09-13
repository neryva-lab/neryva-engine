import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { memoryItems, MemoryItem } from './schema';
import { EmbeddingService } from './embedding.service';
import { memoryProposals } from '../conversations/mcp.schema';
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
  ) {}

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
      const rows = await tx.select().from(memoryProposals).where(eq(memoryProposals.id, input.proposalId)).limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('memory proposal');
      }
      const proposal = rows[0];
      if (proposal.decision !== 'PENDING') {
        throw ApiError.conflict('memory proposal already decided', { decision: proposal.decision });
      }
      await tx.update(memoryProposals).set({ decision: input.decision }).where(eq(memoryProposals.id, proposal.id));

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
      // FL-2.4 — embed at approval: the semantic-memory index is filled the
      // moment an item becomes durable truth (never at query time).
      const [embedding] = await this.embedding.embed([proposal.value]);
      const itemRows = await tx
        .insert(memoryItems)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType,
          scopeId: input.scopeId ?? null,
          content: proposal.value,
          sourceRef: { proposal_id: proposal.id, run_id: proposal.runId },
          provenance: proposal.provenance ?? 'memory_proposal',
          confidence: proposal.confidence,
          visibility: proposal.visibility === 'private' ? 'private' : 'organization',
          expiresAt: input.expiresAt?.toISOString() ?? proposal.expiresAt,
          embedding,
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
      MemoryService.logger.log(`memory proposal ${proposal.id} approved for org ${input.orgId}`);
      return { proposalDecision: 'APPROVED', memoryItem: itemRows[0] };
    });
  }

  async list(orgId: string, opts?: { scopeType?: string; scopeId?: string; limit?: number }): Promise<MemoryItem[]> {
    assertUuid(orgId, 'orgId');
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 100);
    const conditions = [eq(memoryItems.organizationId, orgId), isNull(memoryItems.deletedAt)];
    if (opts?.scopeType) {
      conditions.push(eq(memoryItems.scopeType, opts.scopeType));
    }
    if (opts?.scopeId) {
      assertUuid(opts.scopeId, 'scopeId');
      conditions.push(eq(memoryItems.scopeId, opts.scopeId));
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
    const [embedding] = await this.embedding.embed([input.content.trim()]);
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(memoryItems)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          content: input.content.trim().slice(0, 8192),
          sourceRef: { actor: input.actor },
          provenance: 'user_authored',
          visibility: input.scopeType === 'organization' ? 'organization' : 'private',
          embedding,
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
      return rows[0];
    });
  }

  /** Soft delete — tombstone stays for provenance; purge is a Phase 9 workflow. */
  async softDelete(input: { orgId: string; memoryId: string; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.memoryId, 'memoryId');
    await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(memoryItems)
        .set({ deletedAt: new Date().toISOString(), invalidAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(memoryItems.id, input.memoryId), eq(memoryItems.organizationId, input.orgId), isNull(memoryItems.deletedAt)))
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
