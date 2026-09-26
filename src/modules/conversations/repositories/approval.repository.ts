/**
 * Approval repository (P3) — the persistence port for the approval aggregate
 * (`McpAuthorityService` approval lifecycle, §5.7, plus the conversation-side
 * approval queue reads).
 *
 * Methods that audit from inside the transaction in the current
 * implementation (`decideApproval`, `sweepExpiredApprovals`) return their
 * audit trail in order; the service replays it with `auditSafe` after the
 * repository call resolves — including on denial paths, exactly as today.
 * Business denials are RETURNED (never thrown); the service maps them to
 * the HTTP error. Only genuine preconditions (missing rows, stale versions,
 * conflicts) throw typed `ApiError`s.
 */
import type { Run } from '../schema';
import type { RepositoryAuditEvent } from './repository-types';

export interface DecideApprovalOutcome {
  approvalId: string;
  state: 'APPROVED' | 'DENIED' | 'PENDING';
  runState: string;
  replay: boolean;
  /**
   * Internal quota-plane routing — the service strips it before returning
   * (the HTTP response carries exactly the declared shape).
   */
  runKind: string;
  auditTrail: RepositoryAuditEvent[];
}

export interface SweepExpiredApprovalsResult {
  sweptApprovals: Array<{ approvalId: string; runId: string; runTerminalized: boolean }>;
  canceledRuns: Array<{ runId: string }>;
  /**
   * How many advisory Redis quota-hold releases the service must perform
   * after the sweep (one per claimed approval, best-effort, exactly as today).
   */
  quotaHoldReleases: number;
  auditTrail: RepositoryAuditEvent[];
}

export interface IApprovalRepository {
  /**
   * Create an approval request: idempotent per approval_ref (same summary
   * replays, different summary conflicts), optional WAITING_APPROVAL park,
   * outbox. Returns the run row as currently.
   */
  createApprovalRequest(input: {
    orgId: string;
    runId: string;
    approvalRef: string;
    summary: string;
    actionType?: string;
    policyVersion?: string;
    expiresAt: Date;
    callerScope: string;
    createdBy?: string | null;
    requiredApprovals?: number;
  }): Promise<{ approvalId: string; replay: boolean; run: Run }>;

  /**
   * Console decision API: APPROVED (single or quorum) → run resumes with a
   * `run.resume_requested` outbox event; DENIED (short-circuits any chain) →
   * run CANCELED with the standard `run.canceled` event and the durable
   * quota reservation released in-TX. Already-decided approvals replay on
   * the same decision and conflict on a different one. Expired PENDING
   * approvals fail closed.
   */
  decideApproval(input: {
    orgId: string;
    runId: string;
    approvalId: string;
    decision: 'APPROVED' | 'DENIED';
    actor: string;
    reason?: string;
  }): Promise<DecideApprovalOutcome>;

  /**
   * Wave 4 W3 (GAP 1) — fail closed on stale PENDING approvals.
   *
   * The claim uses the bypass lane with an explicit org filter (pg:
   * FOR UPDATE SKIP LOCKED; mongo: candidate read + per-approval TX with a
   * still-PENDING re-check, where snapshot-isolation write conflicts make
   * concurrent sweep replicas safe). Each claimed approval terminalizes in
   * its own TX: approval → EXPIRED, run → CANCELED when still non-terminal,
   * durable RESERVED quota → RELEASED, one transactional `run.canceled`
   * outbox event per terminalized run, sibling PENDING approvals expired.
   */
  sweepExpiredApprovals(orgId: string, batchSize?: number): Promise<SweepExpiredApprovalsResult>;

  /** Run-bound safe read: the approval must belong to the ctx run. */
  getApprovalState(input: {
    orgId: string;
    runId: string;
    approvalRef: string;
  }): Promise<{
    found: boolean;
    approvalId?: string;
    state: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'NOT_FOUND';
    decisionId?: string;
    decidedBy?: string;
    decidedAt?: string;
  }>;

  /**
   * Approval queue read. Each row carries a computed `expired` boolean
   * (PENDING past expires_at), exactly as the current implementation.
   */
  listApprovals(input: {
    orgId: string;
    state?: string;
  }): Promise<Array<Record<string, unknown>>>;

  /** Extend a PENDING approval's expiry (validated ISO string in). */
  extendApproval(input: {
    orgId: string;
    approvalId: string;
    /** Already validated: ISO timestamp in the future. */
    expiresAt: string;
    actor: string;
  }): Promise<Record<string, unknown>>;
}
