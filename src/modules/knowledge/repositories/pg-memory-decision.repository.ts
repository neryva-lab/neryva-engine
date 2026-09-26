import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { memoryItems, type MemoryItem } from '../schema';
import { memoryProposals } from '../../conversations/mcp.schema';
import type { IMemoryDecisionRepository } from './memory-decision.repository';
import type { MemoryItemDraft, MemoryProposal } from './repository-types';

/**
 * PostgreSQL implementation of `IMemoryDecisionRepository` (P3).
 *
 * Mechanical move of the `MemoryService.decide` approval transition: one
 * `DbService.withOrg` transaction. No transaction handle leaks.
 *
 * DELIBERATE DOCUMENTED EXCEPTION — cross-module write: `memory_proposals`
 * is owned by the conversations module (`../../conversations/mcp.schema`).
 * This port touches it in the SAME transaction as `memory_items` because
 * splitting the atomic approval transition (decision flip + item insert)
 * across two transactions would let the item exist without its decision or
 * the decision flip without its item. Same database, same process.
 *
 * Known hazard, preserved — NOT fixed: the select-then-update on the
 * proposal has no `FOR UPDATE`, so two concurrent decisions on the same
 * proposal can both pass the PENDING guard (lost update). Documenting, not
 * fixing — behavior parity with the current code.
 *
 * INTERFACE GAP (reported 2026-09-26): the service needs to pre-read the
 * proposal (value/runId/provenance/confidence/visibility/expiresAt) BEFORE
 * calling `decideProposal` to build the draft, but the interface exposes
 * no proposal-read method. The service rewiring is blocked on this.
 *
 * What stays OUT (still the service's job, precomputed before the call):
 * - scrubbing (PII), embedding computation, the TTL default, audit writes.
 *   The audit deliberately moves OUT of the transaction, which removes the
 *   phantom-audit-on-rollback the old in-tx placement could produce.
 */
export class PgMemoryDecisionRepository implements IMemoryDecisionRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Advisory pre-read for `decide`: returns the proposal's draft-relevant
   * fields in the provider-neutral shape. Null when the proposal does not
   * exist (service maps to 404). `memory_proposals` has no `decided_at`
   * column — `decidedAt` is always null; the PENDING guard in
   * `decideProposal` is the source of truth for "already decided".
   */
  async getProposal(orgId: string, proposalId: string): Promise<MemoryProposal | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryProposals)
        .where(eq(memoryProposals.id, proposalId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        runId: row.runId,
        value: row.value,
        provenance: row.provenance,
        confidence: row.confidence,
        visibility: row.visibility,
        expiresAt: row.expiresAt,
        decision: row.decision,
        decidedAt: null,
      };
    });
  }

  async decideProposal(
    orgId: string,
    proposalId: string,
    decision: 'APPROVED' | 'REJECTED',
    itemDraft: MemoryItemDraft | null,
    embedding: { vector: number[]; model: string } | null,
  ): Promise<{ decision: string; memoryItem: MemoryItem | null }> {
    return this.db.withOrg(orgId, async (tx) => {
      // 1. Select the proposal (no FOR UPDATE — the lost-update hazard is
      // preserved, see the interface's documented exception).
      const rows = await tx
        .select()
        .from(memoryProposals)
        .where(eq(memoryProposals.id, proposalId))
        .limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('memory proposal');
      }
      const proposal = rows[0];
      // 2. PENDING guard.
      if (proposal.decision !== 'PENDING') {
        throw ApiError.conflict('memory proposal already decided', {
          decision: proposal.decision,
        });
      }
      // 3. Flip the decision.
      await tx
        .update(memoryProposals)
        .set({ decision })
        .where(eq(memoryProposals.id, proposal.id));
      // 4. Approval inserts the memory item; rejection inserts nothing.
      if (decision === 'REJECTED') {
        return { decision: 'REJECTED', memoryItem: null };
      }
      if (!itemDraft || !embedding) {
        throw ApiError.validation({
          itemDraft: 'an approved decision requires an item draft and a pre-computed embedding',
        });
      }
      const itemRows = await tx
        .insert(memoryItems)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          ...itemDraft,
          embedding: embedding.vector,
          embeddingModel: embedding.model,
        })
        .returning();
      return { decision: 'APPROVED', memoryItem: itemRows[0] };
    });
  }
}
