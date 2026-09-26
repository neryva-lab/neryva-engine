/**
 * MongoDB approval repository (P3) — the persistence port for the approval
 * aggregate (`McpAuthorityService` approval lifecycle, §5.7, plus the
 * conversation-side approval queue reads).
 *
 * Mechanical port of the `DbService.withOrg` units in
 * `mcp-authority.service.ts` (`createApprovalRequest`, `decideApproval`,
 * `sweepExpiredApprovals`, `getApprovalState`) and `conversations.service.ts`
 * (`listApprovals`, `extendApproval`):
 * - one `MongoDbService.withOrg` transaction per unit (`withBypass` + an
 *   explicit `organization_id` filter for the sweep claim, exactly like the
 *   pg lane's `withBypass`);
 * - UUIDs as BSON Binary subtype 4, timestamps as canonical ISO-8601
 *   strings, JSONB as subdocuments;
 * - `decideApproval` / `sweepExpiredApprovals` collect the in-TX audit
 *   events into `auditTrail` in call order and never call the audit service;
 * - policy denials are returned, never thrown; only genuine preconditions
 *   throw typed `ApiError`s with the service's codes.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, ClientSession, Db, Document, WithId } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import type { OutboxDoc, OutboxEventInput } from '../../../common/infra/db/ports/outbox';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { assertRunTransition, isRunState, isTerminalRun } from '../state-machine';
import type { Run } from '../schema';
import type { RepositoryAuditEvent } from './repository-types';
import type {
  DecideApprovalOutcome,
  IApprovalRepository,
  SweepExpiredApprovalsResult,
} from './approval.repository';

/** `approvals` document — relational shape per plan D4 (snake_case, Binary UUIDs). */
interface ApprovalDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  approval_ref: string;
  summary: string;
  action_type: string | null;
  policy_version: string | null;
  /** PENDING | APPROVED | DENIED | EXPIRED */
  state: string;
  /** Canonical ISO-8601 string (pg: timestamptz mode 'string'). */
  expires_at: string;
  decision_actor_id: string | null;
  decided_at: string | null;
  decision_id: string | null;
  created_by: string | null;
  required_approvals: number;
  approvals_received: Array<{ actor: string; decision: string; decided_at?: string }>;
  created_at: string;
}

/** `runs` document — only the fields this repository reads/writes. */
interface RunDoc extends Document {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  input_message_id: Binary;
  assistant_version_id: Binary;
  policy_snapshot_id: Binary;
  state: string;
  run_kind: string;
  version: number;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  accepted_at: string;
  started_at: string | null;
  finished_at: string | null;
  terminal_reason: string | null;
  result_message_id: Binary | null;
  regenerated_message_id: Binary | null;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
}

/** `quota_reservations` document — only the fields this repository reads/writes. */
interface QuotaReservationDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  state: string;
  released_at: string | null;
}

/** `messages` document — only the trigger-author lookup. */
interface MessageDoc extends Document {
  id: Binary;
  created_by: string | null;
}

function toRun(doc: WithId<RunDoc>): Run {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: doc.organization_id.toUUID().toString(),
    conversationId: doc.conversation_id.toUUID().toString(),
    inputMessageId: doc.input_message_id.toUUID().toString(),
    assistantVersionId: doc.assistant_version_id.toUUID().toString(),
    policySnapshotId: doc.policy_snapshot_id.toUUID().toString(),
    state: doc.state,
    runKind: doc.run_kind,
    version: doc.version,
    leaseOwner: doc.lease_owner ?? null,
    leaseEpoch: doc.lease_epoch,
    leaseExpiresAt: doc.lease_expires_at ?? null,
    heartbeatAt: doc.heartbeat_at ?? null,
    acceptedAt: doc.accepted_at,
    startedAt: doc.started_at ?? null,
    finishedAt: doc.finished_at ?? null,
    terminalReason: doc.terminal_reason ?? null,
    resultMessageId: doc.result_message_id ? doc.result_message_id.toUUID().toString() : null,
    regeneratedMessageId: doc.regenerated_message_id
      ? doc.regenerated_message_id.toUUID().toString()
      : null,
    lastEventSequence: doc.last_event_sequence,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/**
 * Outbox append for the bypass lane (the expiry sweep). Same document shape
 * as `MongoOutboxStore.append`; the bypass context carries no tenant, so the
 * organization travels explicitly — the same posture as the pg lane's
 * `recordOutboxEvent` under `db.withBypass` (org in the payload).
 */
async function appendOutboxEventBypass(
  db: Db,
  session: ClientSession,
  orgId: string,
  input: OutboxEventInput,
): Promise<void> {
  const outbox = new TenantScopedCollection<OutboxDoc>(db.collection<OutboxDoc>('outbox_events'));
  const now = new Date();
  // organization_id is injected by TenantScopedCollection.insertOne
  // (scopedDoc) — the cast reflects the runtime injection.
  const doc = {
    event_id: uuidToBinary(uuidv7()),
    aggregate_type: input.aggregateType,
    aggregate_id: uuidToBinary(input.aggregateId),
    event_type: input.eventType,
    event_version: input.eventVersion ?? 1,
    payload: input.payload ?? null,
    partition_key: input.partitionKey,
    status: 'PENDING' as const,
    attempt_count: 0,
    next_attempt_at: now,
    trace_id: input.traceId ?? null,
    correlation_id: input.correlationId ? uuidToBinary(input.correlationId) : null,
    created_at: now,
    created_at_us: nowIso(now),
    published_at: null,
    claimed_at: null,
    last_error: null,
  } as OutboxDoc;
  await outbox.insertOne(orgId, doc, { session });
}

export class MongoApprovalRepository implements IApprovalRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private sessionOpt(ctx: MongoTxContext): { session: ClientSession } {
    return { session: ctx.session };
  }

  private tenantOrgId(ctx: MongoTxContext): string {
    const orgId = ctx.orgId;
    if (!orgId) {
      throw new Error('MongoApprovalRepository: tenant context required (unreachable under withOrg)');
    }
    return orgId;
  }

  private auditInto(
    auditTrail: RepositoryAuditEvent[],
    event: Omit<RepositoryAuditEvent, 'actorType' | 'actorId'>,
  ): void {
    // The service's auditSafe stamps these two fields; the repository
    // collects them explicitly so the replayed record is byte-identical.
    auditTrail.push({ ...event, actorType: 'service', actorId: 'agent-studio-runtime' });
  }

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
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const approvals = new TenantScopedCollection<ApprovalDoc>(db.collection('approvals'));
      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));

      const existing = await approvals.findOne(orgId, { approval_ref: input.approvalRef }, s);
      const runDoc = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
      if (!runDoc) {
        throw ApiError.notFound('run');
      }
      let run = runDoc;

      if (existing) {
        if (existing.summary !== input.summary) {
          throw ApiError.conflict('approval_ref reuse with different payload', {
            approval_ref: input.approvalRef,
          });
        }
        return { approvalId: existing.id.toUUID().toString(), replay: true, run: toRun(run) };
      }
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; approval rejected', { state: run.state });
      }

      const approvalId = uuidv7();
      // REL-11.4: resolve author for approver≠author — prefer the explicit
      // createdBy, else the run's input message author.
      let createdBy: string | null = input.createdBy ?? null;
      if (!createdBy) {
        const messages = new TenantScopedCollection<MessageDoc>(db.collection('messages'));
        const msg = await messages.findOne(orgId, { id: run.input_message_id }, s);
        createdBy = msg?.created_by ?? null;
      }
      const requiredApprovals = Math.min(5, Math.max(1, Math.floor(input.requiredApprovals ?? 1)));
      const now = nowIso();
      const doc: ApprovalDoc = {
        id: uuidToBinary(approvalId),
        // Explicit for type-safety; TenantScopedCollection.insertOne
        // re-stamps the same value via scopedDoc.
        organization_id: uuidToBinary(orgId),
        run_id: uuidToBinary(input.runId),
        approval_ref: input.approvalRef,
        summary: input.summary,
        action_type: input.actionType ?? null,
        policy_version: input.policyVersion ?? null,
        state: 'PENDING',
        expires_at: nowIso(input.expiresAt),
        decision_actor_id: null,
        decided_at: null,
        decision_id: null,
        created_by: createdBy,
        required_approvals: requiredApprovals,
        approvals_received: [],
        created_at: now,
      };
      try {
        await approvals.insertOne(orgId, doc, s);
      } catch (err) {
        // Defensive backstop for the pg lane's uq_approvals_org_ref (not
        // provisioned on the mongo lane): a lost race replays or conflicts.
        if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
        const raced = await approvals.findOne(orgId, { approval_ref: input.approvalRef }, s);
        if (raced && raced.summary === input.summary) {
          return { approvalId: raced.id.toUUID().toString(), replay: true, run: toRun(run) };
        }
        throw ApiError.conflict('approval_ref reuse with different payload', {
          approval_ref: input.approvalRef,
        });
      }

      // Persist WAITING_APPROVAL when the run is executing (contract doc:
      // 172). DISPATCHED is included: the worker may park for approval
      // before the run row transitions to RUNNING.
      if (run.state === 'RUNNING' || run.state === 'DISPATCHED') {
        assertRunTransition(run.state, 'WAITING_APPROVAL');
        const updated = await runs.findOneAndUpdate(
          orgId,
          { id: run.id },
          { $set: { state: 'WAITING_APPROVAL', version: run.version + 1, updated_at: now } },
          { ...s, returnDocument: 'after' },
        );
        if (updated) {
          run = updated;
        }
      }

      await new MongoOutboxStore(db, ctx).append({
        aggregateType: 'approval',
        aggregateId: approvalId,
        organizationId: input.orgId,
        eventType: 'approval.requested',
        partitionKey: run.conversation_id.toUUID().toString(),
        payload: { run_id: input.runId, approval_ref: input.approvalRef, summary: input.summary },
      });
      return { approvalId, replay: false, run: toRun(run) };
    });
  }

  async decideApproval(input: {
    orgId: string;
    runId: string;
    approvalId: string;
    decision: 'APPROVED' | 'DENIED';
    actor: string;
    reason?: string;
  }): Promise<DecideApprovalOutcome> {
    const auditTrail: RepositoryAuditEvent[] = [];
    const outcome = await this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const approvals = new TenantScopedCollection<ApprovalDoc>(db.collection('approvals'));
      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));
      const approvalBin = uuidToBinary(input.approvalId);

      const approval = await approvals.findOne(orgId, { id: approvalBin }, s);
      if (!approval || approval.run_id.toUUID().toString() !== input.runId) {
        throw ApiError.notFound('approval');
      }
      // REL-11.4: approver≠author — self-approval is a 403.
      if (approval.created_by && approval.created_by === input.actor) {
        throw ApiError.forbidden('approver must differ from author', {
          approval_id: approval.id.toUUID().toString(),
          author: approval.created_by,
        });
      }

      // REL-11.4: multi-approver chain — collect votes in approvals_received;
      // any DENIED short-circuits; duplicate actor votes conflict.
      const required = Math.min(5, Math.max(1, approval.required_approvals ?? 1));
      const received = Array.isArray(approval.approvals_received)
        ? approval.approvals_received
        : [];
      if (required > 1) {
        if (received.some((r) => r.actor === input.actor)) {
          throw ApiError.conflict('actor has already voted on this approval', {
            approval_id: approval.id.toUUID().toString(),
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
          const runRows = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
          return {
            approvalId: approval.id.toUUID().toString(),
            state: approval.state as 'APPROVED' | 'DENIED',
            runState: runRows?.state ?? 'UNKNOWN',
            replay: true,
            runKind: runRows?.run_kind ?? 'standard',
          };
        }
        throw ApiError.conflict('approval already decided', {
          approval_id: approval.id.toUUID().toString(),
          state: approval.state,
        });
      }

      // Wave 4 GAP 1: a still-PENDING approval whose expires_at has passed
      // fails closed — the sweep worker terminalizes it; the decision API
      // refuses loudly here.
      if (approval.expires_at && new Date(approval.expires_at) <= new Date()) {
        throw ApiError.conflict('approval expired', {
          approval_id: approval.id.toUUID().toString(),
          expires_at: approval.expires_at,
        });
      }

      const run = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
      if (!run) {
        throw ApiError.notFound('run');
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      const decisionId = uuidv7();
      const now = nowIso();
      const approvalIdStr = approval.id.toUUID().toString();
      const outbox = new MongoOutboxStore(db, ctx);

      if (input.decision === 'APPROVED') {
        if (required > 1) {
          const nextReceived = [
            ...received,
            { actor: input.actor, decision: 'APPROVED', decided_at: now },
          ];
          // Not yet at threshold — record the vote, stay PENDING, do not resume run.
          if (nextReceived.filter((r) => r.decision === 'APPROVED').length < required) {
            await approvals.updateOne(
              orgId,
              { id: approvalBin },
              {
                $set: {
                  approvals_received: nextReceived,
                  decision_actor_id: input.actor,
                  decided_at: now,
                },
              },
              s,
            );
            this.auditInto(auditTrail, {
              action: 'mcp.approval_voted',
              resourceType: 'approval',
              resourceId: approvalIdStr,
              tenantId: input.orgId,
              details: {
                run_id: run.id.toUUID().toString(),
                decision: 'APPROVED',
                actor: input.actor,
                received: nextReceived.length,
                required,
              },
            });
            return {
              approvalId: approvalIdStr,
              state: 'PENDING' as const,
              runState: run.state,
              replay: false,
              runKind: run.run_kind,
            };
          }
          // Threshold reached — persist the final votes, then the
          // single-approver transition below.
          await approvals.updateOne(
            orgId,
            { id: approvalBin },
            {
              $set: {
                state: 'APPROVED',
                decision_actor_id: input.actor,
                decision_id: decisionId,
                decided_at: now,
                approvals_received: nextReceived,
              },
            },
            s,
          );
        } else {
          await approvals.updateOne(
            orgId,
            { id: approvalBin },
            {
              $set: {
                state: 'APPROVED',
                decision_actor_id: input.actor,
                decision_id: decisionId,
                decided_at: now,
              },
            },
            s,
          );
        }
        // WAITING_APPROVAL → RUNNING; the resume outbox event re-drives Studio.
        assertRunTransition(run.state, 'RUNNING');
        await runs.updateOne(
          orgId,
          { id: run.id },
          { $set: { state: 'RUNNING', version: run.version + 1, updated_at: now } },
          s,
        );
        await outbox.append({
          aggregateType: 'run',
          aggregateId: run.id.toUUID().toString(),
          organizationId: input.orgId,
          eventType: 'run.resume_requested',
          partitionKey: run.conversation_id.toUUID().toString(),
          payload: {
            run_id: run.id.toUUID().toString(),
            conversation_id: run.conversation_id.toUUID().toString(),
            message_id: run.input_message_id.toUUID().toString(),
            assistant_version_id: run.assistant_version_id.toUUID().toString(),
            approval_id: approvalIdStr,
          },
        });
        this.auditInto(auditTrail, {
          action: 'mcp.approval_decided',
          resourceType: 'approval',
          resourceId: approvalIdStr,
          tenantId: input.orgId,
          details: {
            run_id: run.id.toUUID().toString(),
            decision: 'APPROVED',
            actor: input.actor,
            required,
            received: required > 1 ? required : 1,
            // P5-A1: the UI copies call the reason "audited" — record it.
            reason: input.reason ?? null,
          },
        });
        return {
          approvalId: approvalIdStr,
          state: 'APPROVED' as const,
          runState: 'RUNNING',
          replay: false,
          runKind: run.run_kind,
        };
      }

      // DENIED — any DENIED short-circuits the chain (even multi-approver).
      if (required > 1) {
        const nextReceived = [
          ...received,
          { actor: input.actor, decision: 'DENIED', decided_at: now },
        ];
        await approvals.updateOne(
          orgId,
          { id: approvalBin },
          {
            $set: {
              state: 'DENIED',
              decision_actor_id: input.actor,
              decision_id: decisionId,
              decided_at: now,
              approvals_received: nextReceived,
            },
          },
          s,
        );
      } else {
        await approvals.updateOne(
          orgId,
          { id: approvalBin },
          {
            $set: {
              state: 'DENIED',
              decision_actor_id: input.actor,
              decision_id: decisionId,
              decided_at: now,
            },
          },
          s,
        );
      }
      assertRunTransition(run.state, 'CANCELED');
      await runs.updateOne(
        orgId,
        { id: run.id },
        {
          $set: {
            state: 'CANCELED',
            terminal_reason: input.reason ?? 'approval_denied',
            finished_at: now,
            version: run.version + 1,
            updated_at: now,
          },
        },
        s,
      );
      // W2.4 — a denied run never runs: release its durable quota reservation
      // in the SAME transaction. The advisory-hold release is the service's
      // job after commit (it keys on the returned runKind).
      if (run.run_kind === 'standard') {
        const quota = new TenantScopedCollection<QuotaReservationDoc>(
          db.collection('quota_reservations'),
        );
        await quota.updateMany(
          orgId,
          { run_id: run.id, state: 'RESERVED' },
          { $set: { state: 'RELEASED', released_at: now } },
          s,
        );
      }
      await outbox.append({
        aggregateType: 'run',
        aggregateId: run.id.toUUID().toString(),
        organizationId: input.orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversation_id.toUUID().toString(),
        payload: {
          run_id: run.id.toUUID().toString(),
          conversation_id: run.conversation_id.toUUID().toString(),
          reason: input.reason ?? 'approval_denied',
        },
      });
      this.auditInto(auditTrail, {
        action: 'mcp.approval_decided',
        resourceType: 'approval',
        resourceId: approvalIdStr,
        tenantId: input.orgId,
        // Compliance shape parity with the APPROVED branch (P2-COMP-43):
        // a reviewer must see the quorum requirement on denials too.
        // P5-A2: the UI copies call the reason "audited" — record it.
        details: {
          run_id: run.id.toUUID().toString(),
          decision: 'DENIED',
          actor: input.actor,
          required,
          reason: input.reason ?? null,
        },
      });
      return {
        approvalId: approvalIdStr,
        state: 'DENIED' as const,
        runState: 'CANCELED',
        replay: false,
        runKind: run.run_kind,
      };
    });
    // runKind is internal quota-plane routing — the service strips it before
    // returning (the HTTP response carries exactly the declared shape).
    return {
      approvalId: outcome.approvalId,
      state: outcome.state,
      runState: outcome.runState,
      replay: outcome.replay,
      runKind: outcome.runKind,
      auditTrail,
    };
  }

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
    const SWEEP_ACTOR = 'system:approval-expiry-sweep';
    const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELED'];

    // Claim overdue PENDING approvals on the bypass lane with an explicit
    // org filter (pg: FOR UPDATE SKIP LOCKED; mongo: candidate read +
    // per-approval TX with a still-PENDING re-check — snapshot-isolation
    // write conflicts make concurrent sweep replicas safe).
    const claimed = await this.mongo.withBypass(async (ctx) => {
      const approvals = this.mongo.root.collection<ApprovalDoc>('approvals');
      return approvals
        .find(
          {
            organization_id: uuidToBinary(orgId),
            state: 'PENDING',
            expires_at: { $lte: nowIso() },
          },
          { session: ctx.session, sort: { expires_at: 1 }, limit },
        )
        .project<{ id: Binary; run_id: Binary }>({ id: 1, run_id: 1 })
        .toArray();
    });

    for (const row of claimed) {
      const approvalId = row.id.toUUID().toString();
      const runId = row.run_id.toUUID().toString();
      const decisionId = `sweep-${approvalId.slice(0, 8)}`;

      await this.mongo.withBypass(async (ctx) => {
        const db = this.mongo.root;
        const s = { session: ctx.session };
        const approvals = new TenantScopedCollection<ApprovalDoc>(db.collection('approvals'));
        const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));

        // Re-check still-PENDING inside the TX (a decision may have landed
        // between claim and here). A concurrent sweeper's write wins via a
        // snapshot-isolation write conflict; the loser retries and no-ops here.
        const stillPending = await approvals.findOne(
          orgId,
          { id: uuidToBinary(approvalId), state: 'PENDING' },
          s,
        );
        if (!stillPending) return;

        // Approval → EXPIRED.
        const now = nowIso();
        await approvals.updateOne(
          orgId,
          { id: uuidToBinary(approvalId) },
          { $set: { state: 'EXPIRED', decided_at: now, decision_actor_id: SWEEP_ACTOR } },
          s,
        );
        this.auditInto(auditTrail, {
          action: 'approval.expired',
          resourceType: 'approval',
          resourceId: approvalId,
          tenantId: orgId,
          details: {
            run_id: runId,
            decision_id: decisionId,
            reason: 'approval past expires_at with no decision',
            actor: SWEEP_ACTOR,
          },
        });
        const entry = { approvalId, runId, runTerminalized: false };
        sweptApprovals.push(entry);

        // Run → CANCELED only if still non-terminal. Already-terminal runs
        // (completed/failed/canceled by another path) are left alone, but
        // their sibling PENDING approvals still expire below.
        const run = await runs.findOne(orgId, { id: uuidToBinary(runId) }, s);
        if (run && !TERMINAL_STATES.includes(run.state)) {
          const runNow = nowIso();
          await runs.updateOne(
            orgId,
            { id: uuidToBinary(runId) },
            {
              $set: {
                state: 'CANCELED',
                terminal_reason: 'approval_expired',
                finished_at: runNow,
              },
            },
            s,
          );
          // Durable quota: RESERVED → RELEASED (the sweep lane does not stamp
          // released_at — mirrors the pg lane exactly).
          const quota = new TenantScopedCollection<QuotaReservationDoc>(
            db.collection('quota_reservations'),
          );
          await quota.updateMany(
            orgId,
            { run_id: uuidToBinary(runId), state: 'RESERVED' },
            { $set: { state: 'RELEASED' } },
            s,
          );
          // Transactional outbox event (invariant 7). partitionKey: the run's
          // conversation.
          const conversationId = run.conversation_id.toUUID().toString();
          await appendOutboxEventBypass(db, ctx.session, orgId, {
            aggregateType: 'run',
            aggregateId: runId,
            organizationId: orgId,
            eventType: 'run.canceled',
            partitionKey: conversationId,
            payload: {
              run_id: runId,
              conversation_id: conversationId,
              reason: 'approval_expired',
              approval_id: approvalId,
            },
          });
          this.auditInto(auditTrail, {
            action: 'run.canceled',
            resourceType: 'run',
            resourceId: runId,
            tenantId: orgId,
            details: {
              approval_id: approvalId,
              reason: 'approval expired with no decision',
              actor: SWEEP_ACTOR,
            },
          });
          entry.runTerminalized = true;
          if (!canceledRunIds.has(runId)) {
            canceledRunIds.add(runId);
            canceledRuns.push({ runId });
          }
        }

        // Sibling PENDING approvals on this run also expire (they can never
        // be decided once the run is terminal).
        const siblings = await approvals
          .find(
            orgId,
            {
              run_id: uuidToBinary(runId),
              state: 'PENDING',
              id: { $ne: uuidToBinary(approvalId) },
            },
            s,
          )
          .toArray();
        for (const sib of siblings) {
          const sibId = sib.id.toUUID().toString();
          await approvals.updateOne(
            orgId,
            { id: sib.id },
            {
              $set: {
                state: 'EXPIRED',
                decided_at: nowIso(),
                decision_actor_id: SWEEP_ACTOR,
              },
            },
            s,
          );
          this.auditInto(auditTrail, {
            action: 'approval.expired',
            resourceType: 'approval',
            resourceId: sibId,
            tenantId: orgId,
            details: {
              run_id: runId,
              decision_id: `sweep-${sibId.slice(0, 8)}`,
              reason: 'sibling approval on terminalized run',
              actor: SWEEP_ACTOR,
            },
          });
          sweptApprovals.push({ approvalId: sibId, runId, runTerminalized: entry.runTerminalized });
        }
      });
    }

    return {
      sweptApprovals,
      canceledRuns,
      // One advisory Redis quota-hold release per claimed approval —
      // best-effort, performed by the service after the sweep (exactly as
      // the pg lane, which releases inside the per-claim loop).
      quotaHoldReleases: claimed.length,
      auditTrail,
    };
  }

  async getApprovalState(input: {
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
  }> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = this.tenantOrgId(ctx);
      const approvals = new TenantScopedCollection<ApprovalDoc>(
        this.mongo.root.collection('approvals'),
      );
      const approval = await approvals.findOne(
        orgId,
        { approval_ref: input.approvalRef },
        this.sessionOpt(ctx),
      );
      // Run-bound safe read: the approval must belong to the ctx run.
      if (!approval || approval.run_id.toUUID().toString() !== input.runId) {
        return { found: false, state: 'NOT_FOUND' as const };
      }
      return {
        found: true,
        approvalId: approval.id.toUUID().toString(),
        state:
          (approval.state as 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | undefined) ??
          'PENDING',
        decisionId: approval.decision_id ?? undefined,
        decidedBy: approval.decision_actor_id ?? undefined,
        decidedAt: approval.decided_at ?? undefined,
      };
    });
  }

  async listApprovals(input: {
    orgId: string;
    state?: string;
  }): Promise<Array<Record<string, unknown>>> {
    assertUuid(input.orgId, 'orgId');
    const stateFilter = input.state !== undefined;
    const state = input.state ?? '';
    if (stateFilter && !['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'].includes(state)) {
      throw ApiError.validation({ state: 'must be one of PENDING|APPROVED|DENIED|EXPIRED' });
    }
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = this.tenantOrgId(ctx);
      const approvals = new TenantScopedCollection<ApprovalDoc>(
        this.mongo.root.collection('approvals'),
      );
      const rows = await approvals
        .find(
          orgId,
          stateFilter ? { state } : {},
          {
            ...this.sessionOpt(ctx),
            sort: { created_at: -1 },
            limit: 200,
          },
        )
        .toArray();
      const nowMs = Date.now();
      return rows.map(
        (r): Record<string, unknown> => ({
          id: r.id.toUUID().toString(),
          runId: r.run_id.toUUID().toString(),
          approvalRef: r.approval_ref,
          summary: r.summary,
          actionType: r.action_type,
          policyVersion: r.policy_version,
          state: r.state,
          expiresAt: r.expires_at,
          decidedAt: r.decided_at,
          decisionActorId: r.decision_actor_id,
          createdAt: r.created_at,
          // Computed at read time: PENDING past expires_at.
          expired:
            r.state === 'PENDING' &&
            r.expires_at !== null &&
            new Date(r.expires_at).getTime() < nowMs,
        }),
      );
    });
  }

  async extendApproval(input: {
    orgId: string;
    approvalId: string;
    /** Already validated: ISO timestamp in the future. */
    expiresAt: string;
    actor: string;
  }): Promise<Record<string, unknown>> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.approvalId, 'approvalId');
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw ApiError.validation({ expires_at: 'must be an ISO timestamp in the future' });
    }
    const updated = await this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = this.tenantOrgId(ctx);
      const approvals = new TenantScopedCollection<ApprovalDoc>(
        this.mongo.root.collection('approvals'),
      );
      // Extend only PENDING approvals — the matched row comes back for the
      // response; zero matches means non-pending or missing (conflict, as
      // the pg lane's update-where-PENDING returning nothing).
      return approvals.findOneAndUpdate(
        orgId,
        { id: uuidToBinary(input.approvalId), state: 'PENDING' },
        { $set: { expires_at: parsed.toISOString() } },
        { ...this.sessionOpt(ctx), returnDocument: 'after' },
      );
    });
    if (!updated) {
      throw ApiError.conflict(
        'approval is not pending (or does not exist) — expired/decided approvals cannot be extended',
      );
    }
    // The service audits 'approval.extended' itself after this call; the
    // repository returns the row exactly as the pg lane does.
    const r: WithId<ApprovalDoc> = updated;
    return {
      id: r.id.toUUID().toString(),
      runId: r.run_id.toUUID().toString(),
      approvalRef: r.approval_ref,
      summary: r.summary,
      actionType: r.action_type,
      policyVersion: r.policy_version,
      state: r.state,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
      decisionActorId: r.decision_actor_id,
      decisionId: r.decision_id,
      createdBy: r.created_by,
      requiredApprovals: r.required_approvals,
      approvalsReceived: r.approvals_received,
      createdAt: r.created_at,
      expired: false,
    };
  }
}
