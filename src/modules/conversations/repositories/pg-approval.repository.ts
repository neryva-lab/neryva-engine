/**
 * PostgreSQL approval repository (P3) — the approval aggregate (ledger §5.7)
 * plus the conversation-side approval queue reads.
 *
 * Mechanical move of the `McpAuthorityService` approval units
 * (`createApprovalRequest`, `decideApproval`, `sweepExpiredApprovals`,
 * `getApprovalState`) and the `ConversationsService` queue reads
 * (`listApprovals`, `extendApproval` — DB units only; their input
 * validation stays in the service).
 *
 * Audit: the repository never calls the audit service. Methods that audit
 * from inside the transaction in the current implementation
 * (`decideApproval`, `sweepExpiredApprovals`) collect each event into a
 * local `auditTrail` in call order and return it; the service replays it
 * with `auditSafe` after the repository call resolves. Denials are returned
 * (never thrown); the service maps them to the HTTP error. Only genuine
 * preconditions (missing rows, stale versions, conflicts) throw typed
 * `ApiError`s.
 *
 * Post-commit side effects stay in the service: the advisory Redis
 * quota-hold releases (the repository reports `quotaHoldReleases` so the
 * service can perform them best-effort) and the `runKind` strip before the
 * HTTP response.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { runs, messages, type Run } from '../schema';
import { approvals } from '../mcp.schema';
import { assertRunTransition, isRunState, isTerminalRun } from '../state-machine';
import type { RepositoryAuditEvent } from './repository-types';
import type {
  DecideApprovalOutcome,
  IApprovalRepository,
  SweepExpiredApprovalsResult,
} from './approval.repository';

export class PgApprovalRepository implements IApprovalRepository {
  constructor(private readonly db: DbService) {}

  async createApprovalRequest(input: {
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
  }): Promise<{ approvalId: string; replay: boolean; run: Run }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, input.orgId),
            eq(approvals.approvalRef, input.approvalRef),
          ),
        )
        .limit(1);
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      let run = found[0];

      if (existing.length > 0) {
        if (existing[0].summary !== input.summary) {
          throw ApiError.conflict('approval_ref reuse with different payload', {
            approval_ref: input.approvalRef,
          });
        }
        return { approvalId: existing[0].id, replay: true, run };
      }
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; approval rejected', { state: run.state });
      }

      const approvalId = uuidv7();
      // REL-11.4: resolve author for approver≠author. Prefer explicit createdBy
      // (Studio may pass the end-user id), else fall back to the run's input
      // message author (the human who sent the message that triggered the run).
      let createdBy: string | null = input.createdBy ?? null;
      if (!createdBy) {
        const msgRows = await tx
          .select({ createdBy: messages.createdBy })
          .from(messages)
          .where(eq(messages.id, run.inputMessageId))
          .limit(1);
        createdBy = msgRows[0]?.createdBy ?? null;
      }
      const requiredApprovals = Math.min(5, Math.max(1, Math.floor(input.requiredApprovals ?? 1)));
      await tx.insert(approvals).values({
        id: approvalId,
        organizationId: input.orgId,
        runId: input.runId,
        approvalRef: input.approvalRef,
        summary: input.summary,
        actionType: input.actionType ?? null,
        policyVersion: input.policyVersion ?? null,
        expiresAt: input.expiresAt.toISOString(),
        createdBy,
        requiredApprovals,
        approvalsReceived: [],
      });

      // Persist WAITING_APPROVAL when the run is executing (contract doc: 172).
      // DISPATCHED is included: the worker may park for approval before the
      // run row transitions to RUNNING (approval must not leave the run stuck).
      if (run.state === 'RUNNING' || run.state === 'DISPATCHED') {
        assertRunTransition(run.state, 'WAITING_APPROVAL');
        const updated = await tx
          .update(runs)
          .set({
            state: 'WAITING_APPROVAL',
            version: run.version + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(runs.id, run.id))
          .returning();
        run = updated[0];
      }

      await recordOutboxEvent(tx, {
        aggregateType: 'approval',
        aggregateId: approvalId,
        organizationId: input.orgId,
        eventType: 'approval.requested',
        partitionKey: run.conversationId,
        payload: { run_id: input.runId, approval_ref: input.approvalRef, summary: input.summary },
      });
      return { approvalId, replay: false, run };
    });
  }

  /**
   * decideApproval — console decision API closing the park/resume loop.
   * APPROVED: approval row → APPROVED, run WAITING_APPROVAL → RUNNING, and a
   * `run.resume_requested` outbox event re-drives the run on Studio. DENIED:
   * approval row → DENIED, run → CANCELED (WAITING_APPROVAL → CANCELED is the
   * only non-resume transition) with the standard `run.canceled` event. Both
   * paths are one transaction; the outbox row rides the same TX (invariant 7).
   */
  async decideApproval(input: {
    orgId: string;
    runId: string;
    approvalId: string;
    decision: 'APPROVED' | 'DENIED';
    actor: string;
    reason?: string;
  }): Promise<DecideApprovalOutcome> {
    const auditTrail: RepositoryAuditEvent[] = [];
    const outcome = await this.db.withOrg(input.orgId, async (tx) => {
      const foundApproval = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.organizationId, input.orgId), eq(approvals.id, input.approvalId)))
        .for('update')
        .limit(1);
      const approval = foundApproval[0];
      if (!approval || approval.runId !== input.runId) {
        throw ApiError.notFound('approval');
      }
      // REL-11.4: approver≠author — the author who triggered the run (via the
      // input message) may not approve its own side effect. This was opt-in
      // (TPL-6.5) and is now enforced when `createdBy` is set. Self-approval
      // is a 403, not a 422, because the caller is authenticated but not
      // authorized for this action.
      if (approval.createdBy && approval.createdBy === input.actor) {
        throw ApiError.forbidden('approver must differ from author', {
          approval_id: approval.id,
          author: approval.createdBy,
        });
      }

      // REL-11.4: multi-approver chain — when `requiredApprovals` > 1 we
      // collect individual approvals in `approvalsReceived` and only transition
      // the approval/run when the threshold is reached. Any DENIED short-circuits
      // to DENIED/CANCELED. Duplicate actor votes are conflicts.
      const required = Math.min(5, Math.max(1, approval.requiredApprovals ?? 1));
      const received = Array.isArray(approval.approvalsReceived)
        ? (approval.approvalsReceived as Array<{ actor: string; decision: string }>)
        : [];
      if (required > 1) {
        if (received.some((r) => r.actor === input.actor)) {
          throw ApiError.conflict('actor has already voted on this approval', {
            approval_id: approval.id,
            actor: input.actor,
          });
        }
      }

      if (approval.state !== 'PENDING') {
        // Replay of an already-decided approval with the SAME decision is
        // idempotent; a conflicting decision is a loud conflict.
        if (
          (approval.state === 'APPROVED' && input.decision === 'APPROVED') ||
          (approval.state === 'DENIED' && input.decision === 'DENIED')
        ) {
          const runRows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
          return {
            approvalId: approval.id,
            state: approval.state as 'APPROVED' | 'DENIED',
            runState: runRows[0]?.state ?? 'UNKNOWN',
            replay: true,
            runKind: runRows[0]?.runKind ?? 'standard',
          };
        }
        throw ApiError.conflict('approval already decided', {
          approval_id: approval.id,
          state: approval.state,
        });
      }

      // Wave 4 GAP 1: a still-PENDING approval whose expires_at has passed
      // must fail closed — it can no longer be decided. The sweep worker
      // will terminalize it; the decision API refuses loudly here.
      if (approval.expiresAt && new Date(approval.expiresAt) <= new Date()) {
        throw ApiError.conflict('approval expired', {
          approval_id: approval.id,
          expires_at: approval.expiresAt,
        });
      }

      const foundRun = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (foundRun.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = foundRun[0];
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      const decisionId = uuidv7();
      const now = new Date().toISOString();

      if (input.decision === 'APPROVED') {
        if (required > 1) {
          const nextReceived = [
            ...received,
            { actor: input.actor, decision: 'APPROVED', decided_at: now },
          ];
          // Not yet at threshold — record the vote, stay PENDING, do not resume run.
          if (nextReceived.filter((r) => r.decision === 'APPROVED').length < required) {
            await tx
              .update(approvals)
              .set({
                approvalsReceived:
                  nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived,
                decisionActorId: input.actor,
                decidedAt: now,
              } as never)
              .where(eq(approvals.id, approval.id));
            auditTrail.push({
              action: 'mcp.approval_voted',
              resourceType: 'approval',
              resourceId: approval.id,
              tenantId: input.orgId,
              details: {
                run_id: run.id,
                decision: 'APPROVED',
                actor: input.actor,
                received: nextReceived.length,
                required,
              },
            });
            return {
              approvalId: approval.id,
              state: 'PENDING' as const,
              runState: run.state,
              replay: false,
              runKind: run.runKind,
            };
          }
          // Threshold reached — fall through to the single-approver transition below,
          // but persist the final accumulated votes first.
          await tx
            .update(approvals)
            .set({
              state: 'APPROVED',
              decisionActorId: input.actor,
              decisionId,
              decidedAt: now,
              approvalsReceived:
                nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived,
            } as never)
            .where(eq(approvals.id, approval.id));
        } else {
          await tx
            .update(approvals)
            .set({ state: 'APPROVED', decisionActorId: input.actor, decisionId, decidedAt: now })
            .where(eq(approvals.id, approval.id));
        }
        // WAITING_APPROVAL → RUNNING; the resume outbox event re-drives Studio.
        assertRunTransition(run.state, 'RUNNING');
        await tx
          .update(runs)
          .set({ state: 'RUNNING', version: run.version + 1, updatedAt: now })
          .where(eq(runs.id, run.id));
        await recordOutboxEvent(tx, {
          aggregateType: 'run',
          aggregateId: run.id,
          organizationId: input.orgId,
          eventType: 'run.resume_requested',
          partitionKey: run.conversationId,
          payload: {
            run_id: run.id,
            conversation_id: run.conversationId,
            message_id: run.inputMessageId,
            assistant_version_id: run.assistantVersionId,
            approval_id: approval.id,
          },
        });
        auditTrail.push({
          action: 'mcp.approval_decided',
          resourceType: 'approval',
          resourceId: approval.id,
          tenantId: input.orgId,
          details: {
            run_id: run.id,
            decision: 'APPROVED',
            actor: input.actor,
            required,
            received: required > 1 ? required : 1,
            // P5-A1: the UI copies call the reason "audited" — record it.
            reason: input.reason ?? null,
          },
        });
        return {
          approvalId: approval.id,
          state: 'APPROVED' as const,
          runState: 'RUNNING',
          replay: false,
          runKind: run.runKind,
        };
      }

      // DENIED — any DENIED short-circuits the chain (even for multi-approver).
      if (required > 1) {
        const nextReceived = [
          ...received,
          { actor: input.actor, decision: 'DENIED', decided_at: now },
        ];
        await tx
          .update(approvals)
          .set({
            state: 'DENIED',
            decisionActorId: input.actor,
            decisionId,
            decidedAt: now,
            approvalsReceived:
              nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived,
          } as never)
          .where(eq(approvals.id, approval.id));
      } else {
        await tx
          .update(approvals)
          .set({ state: 'DENIED', decisionActorId: input.actor, decisionId, decidedAt: now })
          .where(eq(approvals.id, approval.id));
      }
      assertRunTransition(run.state, 'CANCELED');
      await tx
        .update(runs)
        .set({
          state: 'CANCELED',
          terminalReason: input.reason ?? 'approval_denied',
          finishedAt: now,
          version: run.version + 1,
          updatedAt: now,
        })
        .where(eq(runs.id, run.id));
      // W2.4 — a denied run never runs: release its durable quota reservation
      // in the SAME transaction (the wall must not count it). The advisory
      // hold release happens after commit, in the service.
      if (run.runKind === 'standard') {
        await tx.execute(sql`
          update quota_reservations
          set state = 'RELEASED', released_at = now()
          where run_id = ${run.id}::uuid and state = 'RESERVED'
        `);
      }
      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversationId,
        payload: {
          run_id: run.id,
          conversation_id: run.conversationId,
          reason: input.reason ?? 'approval_denied',
        },
      });
      auditTrail.push({
        action: 'mcp.approval_decided',
        resourceType: 'approval',
        resourceId: approval.id,
        tenantId: input.orgId,
        // Compliance shape parity with the APPROVED branch (P2-COMP-43): a
        // reviewer must see the quorum requirement on denials too.
        // P5-A2: the UI copies call the reason "audited" — record it.
        details: {
          run_id: run.id,
          decision: 'DENIED',
          actor: input.actor,
          required,
          reason: input.reason ?? null,
        },
      });
      return {
        approvalId: approval.id,
        state: 'DENIED' as const,
        runState: 'CANCELED',
        replay: false,
        runKind: run.runKind,
      };
    });
    return {
      approvalId: outcome.approvalId,
      state: outcome.state,
      runState: outcome.runState,
      replay: outcome.replay,
      runKind: outcome.runKind,
      auditTrail,
    };
  }

  /**
   * sweepExpiredApprovals — Wave 4 workstream 3 (GAP 1).
   *
   * Approvals have a 15-minute expiry but nothing transitioned stale PENDING
   * approvals to EXPIRED — they sat PENDING forever, the run stayed parked,
   * and the quota hold was stranded. This sweep fails closed:
   *
   * - Claims overdue PENDING approvals (expires_at <= now) with
   *   FOR UPDATE SKIP LOCKED (safe under concurrent sweep replicas).
   * - Each claimed approval → EXPIRED (audited).
   * - The run → CANCELED with terminal_reason = 'approval_expired' (only if
   *   still non-terminal; already-terminal runs are left alone).
   * - Durable RESERVED quota for the run → RELEASED; the Redis advisory hold
   *   release happens after commit, in the service (see `quotaHoldReleases`).
   * - One transactional `run.canceled` outbox event per terminalized run.
   * - Sibling PENDING approvals on a terminalized run also expire.
   *
   * Idempotent: re-running on an already-swept org is a no-op (claims only
   * fire on still-PENDING rows).
   */
  async sweepExpiredApprovals(
    orgId: string,
    batchSize?: number,
  ): Promise<SweepExpiredApprovalsResult> {
    const limit = Math.min(1000, Math.max(1, batchSize ?? 200));
    const auditTrail: RepositoryAuditEvent[] = [];
    const sweptApprovals: Array<{
      approvalId: string;
      runId: string;
      runTerminalized: boolean;
    }> = [];
    const canceledRuns: Array<{ runId: string }> = [];
    const canceledRunIds = new Set<string>();

    // Claim overdue PENDING approvals. FOR UPDATE SKIP LOCKED makes
    // concurrent sweep replicas safe — a row claimed by one is skipped by
    // the other. The claim uses the bypass lane with an explicit org filter.
    const claimed = await this.db.withBypass((tx) =>
      tx.execute(sql`
        select id, run_id
        from approvals
        where organization_id = ${orgId}::uuid
          and state = 'PENDING'
          and expires_at <= now()
        order by expires_at asc
        limit ${limit}
        for update skip locked
      `),
    );

    for (const row of claimed.rows as Array<{ id: string; run_id: string }>) {
      const approvalId = row.id;
      const runId = row.run_id;
      const decisionId = `sweep-${approvalId.slice(0, 8)}`;

      await this.db.withBypass(async (tx) => {
        // Re-check still-PENDING inside the TX (a decision may have landed
        // between claim and here).
        const stillPending = await tx.execute(sql`
          select id from approvals
          where id = ${approvalId}::uuid and state = 'PENDING'
          for update
        `);
        if (stillPending.rows.length === 0) return;

        // Approval → EXPIRED.
        await tx.execute(sql`
          update approvals
          set state = 'EXPIRED',
              decided_at = now(),
              decision_actor_id = 'system:approval-expiry-sweep'
          where id = ${approvalId}::uuid
        `);
        auditTrail.push({
          action: 'approval.expired',
          resourceType: 'approval',
          resourceId: approvalId,
          tenantId: orgId,
          details: {
            run_id: runId,
            decision_id: decisionId,
            reason: 'approval past expires_at with no decision',
            actor: 'system:approval-expiry-sweep',
          },
        });
        let runTerminalized = false;
        sweptApprovals.push({ approvalId, runId, runTerminalized });

        // Run → CANCELED only if still non-terminal. Already-terminal runs
        // (completed/failed/canceled by another path) are left alone, but
        // their sibling PENDING approvals still expire below.
        const runRows = (await tx.execute(sql`
          select id, state, conversation_id from runs where id = ${runId}::uuid for update
        `)).rows as Array<{ id: string; state: string; conversation_id: string }>;
        const run = runRows[0];
        const terminalStates = ['COMPLETED', 'FAILED', 'CANCELED'];
        if (run && !terminalStates.includes(run.state)) {
          await tx.execute(sql`
            update runs
            set state = 'CANCELED',
                terminal_reason = 'approval_expired',
                finished_at = now()
            where id = ${runId}::uuid
          `);
          // Durable quota: RESERVED → RELEASED.
          await tx.execute(sql`
            update quota_reservations
            set state = 'RELEASED'
            where run_id = ${runId}::uuid and state = 'RESERVED'
          `);
          // Transactional outbox event (invariant 7).
          // partitionKey: the run's conversation (matches run.failed above).
          const runRow = runRows[0] as unknown as { conversation_id: string };
          await recordOutboxEvent(tx, {
            aggregateType: 'run',
            aggregateId: runId,
            organizationId: orgId,
            eventType: 'run.canceled',
            partitionKey: runRow.conversation_id ?? runId,
            payload: {
              run_id: runId,
              conversation_id: runRow.conversation_id,
              reason: 'approval_expired',
              approval_id: approvalId,
            },
          });
          auditTrail.push({
            action: 'run.canceled',
            resourceType: 'run',
            resourceId: runId,
            tenantId: orgId,
            details: {
              approval_id: approvalId,
              reason: 'approval expired with no decision',
              actor: 'system:approval-expiry-sweep',
            },
          });
          runTerminalized = true;
          // Update the already-pushed entry.
          sweptApprovals[sweptApprovals.length - 1].runTerminalized = true;
          if (!canceledRunIds.has(runId)) {
            canceledRunIds.add(runId);
            canceledRuns.push({ runId });
          }
        }

        // Sibling PENDING approvals on this run also expire (they can never
        // be decided once the run is terminal).
        const siblings = (await tx.execute(sql`
          select id from approvals
          where run_id = ${runId}::uuid
            and state = 'PENDING'
            and id != ${approvalId}::uuid
          for update
        `)).rows as Array<{ id: string }>;
        for (const sib of siblings) {
          await tx.execute(sql`
            update approvals
            set state = 'EXPIRED',
                decided_at = now(),
                decision_actor_id = 'system:approval-expiry-sweep'
            where id = ${sib.id}::uuid
          `);
          auditTrail.push({
            action: 'approval.expired',
            resourceType: 'approval',
            resourceId: sib.id,
            tenantId: orgId,
            details: {
              run_id: runId,
              decision_id: `sweep-${sib.id.slice(0, 8)}`,
              reason: 'sibling approval on terminalized run',
              actor: 'system:approval-expiry-sweep',
            },
          });
          sweptApprovals.push({ approvalId: sib.id, runId, runTerminalized });
        }
      });

      // The Redis advisory hold release happens after commit in the service
      // (best-effort; the durable reservation is already RELEASED above).
      // One release per claimed approval, exactly as before.
    }

    return {
      sweptApprovals,
      canceledRuns,
      quotaHoldReleases: claimed.rows.length,
      auditTrail,
    };
  }

  /**
   * GetApprovalState (contract v1.2) — Studio observes the durable decision
   * for an approval it proposed. Run-bound safe read: the approval row must
   * belong to the ctx run, otherwise NOT_FOUND (never leaks other runs').
   */
  async getApprovalState(input: { orgId: string; runId: string; approvalRef: string }): Promise<{
    found: boolean;
    approvalId?: string;
    state: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'NOT_FOUND';
    decisionId?: string;
    decidedBy?: string;
    decidedAt?: string;
  }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, input.orgId),
            eq(approvals.approvalRef, input.approvalRef),
          ),
        )
        .limit(1);
      const approval = rows[0];
      if (!approval || approval.runId !== input.runId) {
        return { found: false, state: 'NOT_FOUND' as const };
      }
      return {
        found: true,
        approvalId: approval.id,
        state: (approval.state as 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED') ?? 'PENDING',
        decisionId: approval.decisionId ?? undefined,
        decidedBy: approval.decisionActorId ?? undefined,
        decidedAt: approval.decidedAt ?? undefined,
      };
    });
  }

  /**
   * REL-5.1 — the pending-work surface: org-scoped approval list with a
   * computed `expired` flag (expiry evaluated at READ time; the
   * approval-expiry-sweep worker terminalizes overdue PENDING approvals to
   * EXPIRED on its tick — the decision path fail-closes on lapsed windows
   * regardless, same philosophy as control blocks).
   */
  async listApprovals(input: {
    orgId: string;
    state?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const stateFilter = input.state !== undefined;
    const state = input.state ?? '';
    return this.db.withOrg(input.orgId, async (tx) => {
      const base = tx
        .select({
          id: approvals.id,
          runId: approvals.runId,
          approvalRef: approvals.approvalRef,
          summary: approvals.summary,
          actionType: approvals.actionType,
          policyVersion: approvals.policyVersion,
          state: approvals.state,
          expiresAt: approvals.expiresAt,
          decidedAt: approvals.decidedAt,
          decisionActorId: approvals.decisionActorId,
          createdAt: approvals.createdAt,
        })
        .from(approvals);
      const rows = stateFilter
        ? await base.where(eq(approvals.state, state)).orderBy(desc(approvals.createdAt)).limit(200)
        : await base.orderBy(desc(approvals.createdAt)).limit(200);
      const nowMs = Date.now();
      return rows.map((r) => ({
        ...r,
        expired:
          r.state === 'PENDING' && r.expiresAt !== null && new Date(r.expiresAt).getTime() < nowMs,
      }));
    });
  }

  /**
   * REL-5.3 — re-target a pending approval's decision window (the
   * reassignment semantics that exist until approver-topology lands as
   * REL-11.4: any owner/admin may decide; extending the window is the
   * operator action that keeps work discoverable and SLA-honest).
   *
   * Input validation (UUID shape, future ISO timestamp) stays in the
   * service; the `approval.extended` audit stays in the service too (it ran
   * after the DB write in the current implementation — the service keeps it
   * after this call, actorType 'account').
   */
  async extendApproval(input: {
    orgId: string;
    approvalId: string;
    /** Already validated: ISO timestamp in the future. */
    expiresAt: string;
    actor: string;
  }): Promise<Record<string, unknown>> {
    const parsed = new Date(input.expiresAt);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(approvals)
        .set({ expiresAt: parsed.toISOString() })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.organizationId, input.orgId),
            eq(approvals.state, 'PENDING'),
          ),
        )
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.conflict(
        'approval is not pending (or does not exist) — expired/decided approvals cannot be extended',
      );
    }
    return { ...rows[0], expired: false };
  }
}
