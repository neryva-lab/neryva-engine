/**
 * Memory-decision repository (P3) — the persistence port for the proposal
 * approval transition (`MemoryService.decideProposal`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * DELIBERATE DOCUMENTED EXCEPTION — cross-module write: `memory_proposals`
 * is owned by the conversations module (`../conversations/mcp.schema`).
 * This port touches it in the SAME transaction as `memory_items` because
 * splitting the atomic approval transition (decision flip + item insert)
 * across two transactions would let the item exist without its decision or
 * the decision flip without its item. Same database, same process; the
 * PostgreSQL implementation imports the table type from the conversations
 * schema (precedent: `eval.schema.ts` imports `runs` from
 * `../conversations/schema`). This is the only knowledge port that writes
 * outside its module, and it is intentional.
 *
 * Known hazard, preserved — NOT fixed by this migration: the
 * select-then-update on the proposal has no `FOR UPDATE` today, so two
 * concurrent decisions on the same proposal can both pass the PENDING guard
 * (lost update). Documenting, not fixing — behavior parity with the current
 * code.
 *
 * What stays OUT of the repository (still the service's job):
 * - computing the approval-time embedding (arrives pre-computed; the
 *   repository never embeds)
 * - audit writes — the service calls `audit.add` AFTER the repo op returns.
 *   This deliberately moves the audit out of the transaction, which removes
 *   the phantom-audit-on-rollback the old in-tx placement could produce
 *   (audit row surviving a rolled-back decision). Audit is replayed from
 *   inputs + results, never re-read from the DB.
 */
import type { MemoryItem } from '../schema';
import type { MemoryItemDraft, MemoryProposal } from './repository-types';

export interface IMemoryDecisionRepository {
  /**
   * Advisory pre-read: the proposal the service needs (value/runId/
   * provenance/confidence/visibility/expiresAt/decision) to build the
   * item draft BEFORE calling `decideProposal`. Null when the proposal
   * does not exist — the service maps this to 404, mirroring the old
   * in-transaction notFound.
   */
  getProposal(orgId: string, proposalId: string): Promise<MemoryProposal | null>;

  /**
   * ATOMIC proposal decision, one tx:
   * 1. Select the proposal by id.
   * 2. PENDING guard — conflict when already decided (see the documented
   *    lost-update hazard above: no `FOR UPDATE` today, preserving the
   *    current behavior).
   * 3. Flip the decision.
   * 4. When `decision` is APPROVED: insert the memory item from
   *    `itemDraft` with the pre-computed `embedding` (vector + model).
   *    When REJECTED, both must be null.
   *
   * Returns the final decision string and the inserted memory item (null on
   * REJECTED).
   */
  decideProposal(
    orgId: string,
    proposalId: string,
    decision: 'APPROVED' | 'REJECTED',
    itemDraft: MemoryItemDraft | null,
    embedding: { vector: number[]; model: string } | null,
  ): Promise<{ decision: string; memoryItem: MemoryItem | null }>;
}
