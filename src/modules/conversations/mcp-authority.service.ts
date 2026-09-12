import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { artifacts } from '../knowledge/schema';
import { uuidv7 } from '../../common/ids/uuidv7';
import { runEvents, runs, messages, conversations, conversationSummaries, Run } from './schema';
import { policySnapshots } from '../assistants/schema';
import { toolCatalog } from '../assistants/tool-catalog.schema';
import { RetrievalService } from '../knowledge/retrieval.service';
import { UsageLedgerService } from '../billing/usage-ledger.service';
import { spotlight, redactPii } from '../../common/guardrails';
import { memoryItems } from '../knowledge/schema';
import { approvals, checkpoints, memoryProposals, toolEffects, runIdempotency } from './mcp.schema';
import { assertRunTransition, isRunState, isTerminalRun } from './state-machine';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import { issueCapability } from '../../common/auth/capability-token';

/**
 * Engine authority side of neryva.mcp.v1 — Phase 5 (imp/ledger.md 5.4-5.11).
 * All SQL lives in this module (transport handlers never touch the DB).
 *
 * Fencing: lease state lives on the `runs` row (pinned decision); renew is a
 * CAS on lease_epoch — a stale epoch is rejected as ABORTED-equivalent.
 * Terminal states are immutable except via administrative reconciliation.
 */
@Injectable()
export class McpAuthorityService {
  private static readonly logger = new Logger(McpAuthorityService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly purge: RetentionPurgeService,
    private readonly retrieval: RetrievalService,
    private readonly usageLedger: UsageLedgerService,
  ) {}

  // ── Lease fencing (5.4) ─────────────────────────────────────────────────

  async acquireOrRenewRunLease(input: {
    orgId: string;
    runId: string;
    callerScope: string;
    expectedOwner: string | null;
    expectedEpoch: number;
    renewUntil: Date;
  }): Promise<{ run: Run; acquired: boolean; leaseEpoch: number }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; lease cannot be acquired', { state: run.state });
      }
      // CAS: caller's epoch must match; first acquire matches the NULL owner.
      const epochMatches = run.leaseEpoch === input.expectedEpoch;
      const ownerMatches = run.leaseOwner === null || run.leaseOwner === input.expectedOwner;
      if (!epochMatches || !ownerMatches) {
        throw ApiError.conflict('stale lease epoch', {
          expected_epoch: input.expectedEpoch,
          actual_epoch: run.leaseEpoch,
          lease_owner: run.leaseOwner ?? null,
        });
      }
      const newEpoch = run.leaseEpoch + 1;
      // Lease state is FENCING, not business state — `runs.version` (the
      // expected_version CAS domain) is deliberately NOT bumped here; the
      // epoch increment is the fencing counter (state-machine.ts pinned note).
      const updated = await tx
        .update(runs)
        .set({
          leaseOwner: input.callerScope,
          leaseEpoch: newEpoch,
          leaseExpiresAt: input.renewUntil.toISOString(),
          heartbeatAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();
      return { run: updated[0], acquired: run.leaseOwner === null, leaseEpoch: newEpoch };
    });
  }

  async releaseRunLease(input: { orgId: string; runId: string; leaseEpoch: number }): Promise<Run> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.leaseEpoch !== input.leaseEpoch) {
        throw ApiError.conflict('stale lease epoch on release', { expected: input.leaseEpoch, actual: run.leaseEpoch });
      }
      const updated = await tx
        .update(runs)
        .set({ leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: new Date().toISOString() })
        .where(eq(runs.id, run.id))
        .returning();
      return updated[0];
    });
  }

  async getRun(orgId: string, runId: string): Promise<Run> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(runs).where(eq(runs.id, runId)).limit(1));
    if (rows.length === 0) {
      // Distinguish a purged conversation from an unknown run (typed 410,
      // ledger 9.8 — CommitRunResult/GetRunContext fail closed on purged IDs).
      await this.purge.assertNotTombstoned('conversation', runId);
      await this.purge.assertNotTombstoned('run', runId);
      throw ApiError.notFound('run');
    }
    return rows[0];
  }

  // ── Terminal transitions (5.11) — reuse the Phase 4 atomic paths ────────

  /**
   * Pre-flight CAS for CommitRunResult/FailRun `expected_version`. The atomic
   * core is delegated to ConversationsService (its own transaction); callers
   * re-read the run afterwards for the authoritative projection.
   */
  async assertExpectedVersion(orgId: string, runId: string, expectedVersion?: number): Promise<Run> {
    const run = await this.getRun(orgId, runId);
    if (expectedVersion !== undefined && run.state !== 'COMPLETED' && expectedVersion !== run.version) {
      throw ApiError.conflict('stale run version', { expected: expectedVersion, actual: run.version });
    }
    return run;
  }

  /**
   * Lease-epoch fencing (ledger 5.11 "validates capability + lease epoch").
   * A token that CARRIES a lease_epoch claim must present the run's CURRENT
   * epoch — a deposed or expired holder is rejected with ABORTED-equivalent.
   * Tokens without the claim (dispatch-issued, pre-lease) are fenced by the
   * acquire/renew CAS + the expected_version CAS instead — the frozen
   * neryva.mcp.v1 contract has no lease-renewal re-mint field, so this is the
   * strongest enforcement the wire supports.
   */
  private assertLeaseFencing(run: Run, claimsLeaseEpoch?: number): void {
    if (claimsLeaseEpoch !== undefined && claimsLeaseEpoch !== run.leaseEpoch) {
      throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
        token_epoch: claimsLeaseEpoch,
        run_epoch: run.leaseEpoch,
      });
    }
  }

  /** FailRun (5.11 analogue): CAS to FAILED + terminal event + outbox in one TX. */
  async failRun(input: {
    orgId: string;
    runId: string;
    errorCode: string;
    errorMessage: string;
    expectedVersion?: number;
    leaseEpoch?: number;
  }): Promise<Run> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.state === 'FAILED') {
        return run; // idempotent replay
      }
      this.assertLeaseFencing(run, input.leaseEpoch);
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw ApiError.conflict('stale run version', { expected: input.expectedVersion, actual: run.version });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'FAILED');

      const insertedEvent = await tx
        .insert(runEvents)
        .values((() => {
          const rowId = uuidv7();
          return {
            id: rowId,
            eventId: rowId,
            runId: run.id,
            organizationId: input.orgId,
            eventType: 'run.failed',
            payload: { case: 'terminal', value: { code: input.errorCode, message: input.errorMessage } },
            producerIdentity: 'engine:mcp-authority',
          };
        })())
        .returning({ engineSequence: runEvents.engineSequence });

      const updated = await tx
        .update(runs)
        .set({
          state: 'FAILED',
          terminalReason: input.errorCode.slice(0, 64),
          finishedAt: new Date().toISOString(),
          lastEventSequence: Math.max(run.lastEventSequence, insertedEvent[0].engineSequence),
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.failed',
        partitionKey: run.conversationId,
        payload: { run_id: run.id, conversation_id: run.conversationId, error_code: input.errorCode },
      });
      return updated[0];
    });
  }

  // ── AppendRunEvents (5.6) ───────────────────────────────────────────────

  async appendRunEvents(input: {
    orgId: string;
    runId: string;
    producerIdentity: string;
    events: Array<{
      eventId: string;
      eventType: string;
      schemaVersion: number;
      producerSequence?: number;
      payload: { case: string; value: unknown } | null;
      artifactId?: string;
    }>;
    /** Batch-level CAS (proto expected_run_version) — re-checked under the row lock. */
    expectedRunVersion?: number;
    /** Required ctx.idempotency_key — deduped via run_idempotency before inserts (ledger 5.6). */
    idempotency?: { callerScope: string; idempotencyKey: string; requestHash: string };
    leaseEpoch?: number;
  }): Promise<{ accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }>; duplicateCount: number }> {
    if (input.events.length === 0 || input.events.length > 32) {
      throw ApiError.validation({ events: 'batch must contain 1..32 events' });
    }
    for (const event of input.events) {
      if (typeof event.eventId !== 'string' || event.eventId.length < 1 || event.eventId.length > 64) {
        throw ApiError.validation({ events: 'event_id must be 1..64 chars' });
      }
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; events rejected', { state: run.state });
      }
      this.assertLeaseFencing(run, input.leaseEpoch);
      if (input.expectedRunVersion !== undefined && input.expectedRunVersion !== run.version) {
        throw ApiError.conflict('stale run version for event batch', { expected: input.expectedRunVersion, actual: run.version });
      }
      // Request-level idempotency BEFORE any insert: same key + same digest
      // replays, same key + different digest is a typed conflict (ledger 5.6
      // failure case; common.proto RequestContext.idempotency_key contract).
      if (input.idempotency) {
        const claim = await this.claimRunIdempotency(tx, {
          orgId: input.orgId,
          runId: input.runId,
          callerScope: input.idempotency.callerScope,
          idempotencyKey: input.idempotency.idempotencyKey,
          requestHash: input.idempotency.requestHash,
        });
        if (claim === 'duplicate') {
          // Exact retry of an already-applied batch: echo the stored rows.
          const stored = await tx
            .select({ eventId: runEvents.eventId, engineSequence: runEvents.engineSequence })
            .from(runEvents)
            .where(and(eq(runEvents.runId, input.runId), inArray(runEvents.eventId, input.events.map((e) => e.eventId))));
          const seqById = new Map(stored.map((s) => [s.eventId, s.engineSequence]));
          return {
            accepted: input.events.map((e) => ({ eventId: e.eventId, engineSequence: seqById.get(e.eventId) ?? 0, duplicate: true })),
            duplicateCount: input.events.length,
          };
        }
      }

      const accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }> = [];
      let duplicateCount = 0;
      for (const event of input.events) {
        const inserted = await tx
          .insert(runEvents)
          .values({
            id: uuidv7(),
            eventId: event.eventId,
            runId: input.runId,
            organizationId: input.orgId,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            producerIdentity: input.producerIdentity,
            producerSequence: event.producerSequence ?? null,
            payload: event.payload as never,
            artifactId: event.artifactId ?? null,
          })
          .onConflictDoNothing({ target: [runEvents.runId, runEvents.eventId] })
          .returning({ engineSequence: runEvents.engineSequence });
        if (inserted.length === 0) {
          // (run_id, event_id) already exists — echo the ORIGINAL engine
          // sequence so the response reflects stored reality, not a
          // fabricated zero. The same event_id on a DIFFERENT run is a
          // separate row, never swallowed.
          duplicateCount += 1;
          const existing = await tx
            .select({ engineSequence: runEvents.engineSequence })
            .from(runEvents)
            .where(and(eq(runEvents.runId, input.runId), eq(runEvents.eventId, event.eventId)))
            .limit(1);
          accepted.push({ eventId: event.eventId, engineSequence: existing[0]?.engineSequence ?? 0, duplicate: true });
          continue;
        }
        accepted.push({ eventId: event.eventId, engineSequence: inserted[0].engineSequence, duplicate: false });
      }

      if (accepted.some((a) => !a.duplicate)) {
        const maxSeq = Math.max(...accepted.filter((a) => !a.duplicate).map((a) => a.engineSequence));
        await tx
          .update(runs)
          .set({ lastEventSequence: Math.max(run.lastEventSequence, maxSeq), updatedAt: new Date().toISOString() })
          .where(eq(runs.id, input.runId));
      }
      return { accepted, duplicateCount };
    });
  }

  async listRunEvents(orgId: string, runId: string, opts?: { afterSequence?: number; limit?: number }) {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 100);
    const after = opts?.afterSequence ?? 0;
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, after)))
        .orderBy(asc(runEvents.engineSequence))
        .limit(limit),
    );
  }

  // ── Approvals (5.7) ─────────────────────────────────────────────────────

  async createApprovalRequest(input: {
    orgId: string;
    runId: string;
    approvalRef: string;
    summary: string;
    actionType?: string;
    policyVersion?: string;
    expiresAt: Date;
    callerScope: string;
  }): Promise<{ approvalId: string; replay: boolean; run: Run }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.organizationId, input.orgId), eq(approvals.approvalRef, input.approvalRef)))
        .limit(1);
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      let run = found[0];

      if (existing.length > 0) {
        if (existing[0].summary !== input.summary) {
          throw ApiError.conflict('approval_ref reuse with different payload', { approval_ref: input.approvalRef });
        }
        return { approvalId: existing[0].id, replay: true, run };
      }
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; approval rejected', { state: run.state });
      }

      const approvalId = uuidv7();
      await tx.insert(approvals).values({
        id: approvalId,
        organizationId: input.orgId,
        runId: input.runId,
        approvalRef: input.approvalRef,
        summary: input.summary,
        actionType: input.actionType ?? null,
        policyVersion: input.policyVersion ?? null,
        expiresAt: input.expiresAt.toISOString(),
      });

      // Persist WAITING_APPROVAL when the run is executing (contract doc: 172).
      if (run.state === 'RUNNING') {
        assertRunTransition(run.state, 'WAITING_APPROVAL');
        const updated = await tx
          .update(runs)
          .set({ state: 'WAITING_APPROVAL', version: run.version + 1, updatedAt: new Date().toISOString() })
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

  // ── Memory proposals (5.9) — proposals are NOT truth ────────────────────

  async submitMemoryProposal(input: {
    orgId: string;
    runId: string;
    proposalRef: string;
    scope: string;
    value: string;
    provenance?: string;
    confidence?: number;
    visibility?: string;
    expiresAt?: Date;
  }): Promise<{ storedId: string; accepted: boolean; replay: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(memoryProposals)
        .where(and(eq(memoryProposals.organizationId, input.orgId), eq(memoryProposals.proposalRef, input.proposalRef)))
        .limit(1);
      if (existing.length > 0) {
        if (existing[0].value !== input.value) {
          throw ApiError.conflict('proposal_ref reuse with different value', { proposal_ref: input.proposalRef });
        }
        return { storedId: existing[0].id, accepted: true, replay: true };
      }
      const storedId = uuidv7();
      await tx.insert(memoryProposals).values({
        id: storedId,
        organizationId: input.orgId,
        runId: input.runId,
        proposalRef: input.proposalRef,
        scope: input.scope,
        value: input.value,
        provenance: input.provenance ?? null,
        confidence: input.confidence != null ? String(Math.min(1, Math.max(0, input.confidence))) : null,
        visibility: input.visibility ?? null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      });
      return { storedId, accepted: true, replay: false };
    });
  }

  // ── Tool calls (5.10) ───────────────────────────────────────────────────

  async authorizeToolCall(input: {
    orgId: string;
    runId: string;
    stepId?: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    argumentDigest: Buffer;
  }): Promise<{ allowed: boolean; reason?: string; toolCapability?: string; approvalRequired: boolean; duplicate: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; tool calls rejected', { state: run.state });
      }

      const duplicate = await tx
        .select()
        .from(toolEffects)
        .where(and(eq(toolEffects.organizationId, input.orgId), eq(toolEffects.toolCallId, input.toolCallId)))
        .limit(1);
      if (duplicate.length > 0) {
        const same = duplicate[0].argumentDigest && Buffer.from(duplicate[0].argumentDigest).equals(input.argumentDigest);
        if (!same) {
          throw ApiError.conflict('tool_call_id reuse with different arguments', { tool_call_id: input.toolCallId });
        }
        return { allowed: true, toolCapability: undefined, approvalRequired: false, duplicate: true };
      }

      // Policy check against the pinned snapshot's tool_policy.
      const snapshot = await tx.select().from(policySnapshots).where(eq(policySnapshots.id, run.policySnapshotId)).limit(1);
      if (snapshot.length === 0) {
        throw ApiError.internal();
      }
      const toolPolicy = snapshot[0].toolPolicy as { tools?: Array<{ name: string; approval?: string }> };
      const descriptor = toolPolicy?.tools?.find((t) => t.name === input.toolName);
      if (!descriptor) {
        return { allowed: false, reason: `tool ${input.toolName} is not in the pinned tool policy`, approvalRequired: false, duplicate: false };
      }

      const effectId = uuidv7();
      await tx.insert(toolEffects).values({
        id: effectId,
        organizationId: input.orgId,
        runId: input.runId,
        stepId: input.stepId ?? null,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolVersion: input.toolVersion ?? null,
        argumentDigest: input.argumentDigest,
      });

      const approvalRequired = descriptor.approval === 'required';
      const toolCapability = issueCapability({
        organizationId: input.orgId,
        conversationId: run.conversationId,
        runId: input.runId,
        assistantVersionId: run.assistantVersionId,
        policyVersion: run.policySnapshotId,
        allowedOps: ['tool'],
        subject: 'agent-studio-tool',
      }).token;

      await this.auditSafe({
        action: 'mcp.tool_authorized',
        resourceType: 'tool_effect',
        resourceId: effectId,
        tenantId: input.orgId,
        details: { run_id: input.runId, tool: input.toolName, approval_required: approvalRequired },
      });
      return { allowed: true, toolCapability, approvalRequired, duplicate: false };
    });
  }

  async recordToolOutcome(input: {
    orgId: string;
    toolCallId: string;
    resultDigest?: Buffer;
    status: string;
    resultArtifactId?: string;
  }): Promise<{ accepted: boolean; wasDuplicate: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(toolEffects)
        .where(and(eq(toolEffects.organizationId, input.orgId), eq(toolEffects.toolCallId, input.toolCallId)))
        .limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('tool call authorization');
      }
      const effect = rows[0];
      if (effect.recordedAt) {
        const same = input.resultDigest && effect.resultDigest && Buffer.from(effect.resultDigest).equals(input.resultDigest);
        if (!same) {
          throw ApiError.conflict('tool outcome replay with different digest', { tool_call_id: input.toolCallId });
        }
        return { accepted: true, wasDuplicate: true };
      }
      await tx
        .update(toolEffects)
        .set({ resultDigest: input.resultDigest ?? null, status: input.status, resultArtifactId: input.resultArtifactId ?? null, recordedAt: new Date().toISOString() })
        .where(eq(toolEffects.id, effect.id));
      return { accepted: true, wasDuplicate: false };
    });
  }

  // ── Checkpoints (5.8) — claim-check pointers only ───────────────────────

  async saveCheckpointRef(input: {
    orgId: string;
    runId: string;
    checkpointRef: string;
    checkpointVersion: number;
    artifactId?: string;
    digest: Buffer;
    producer: string;
  }): Promise<{ accepted: boolean; replay: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.runId, input.runId),
            eq(checkpoints.checkpointRef, input.checkpointRef),
            eq(checkpoints.checkpointVersion, input.checkpointVersion),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const same = Buffer.from(existing[0].digest).equals(input.digest);
        if (!same) {
          throw ApiError.conflict('checkpoint version reuse with different digest', { checkpoint_ref: input.checkpointRef });
        }
        return { accepted: true, replay: true };
      }
      await tx.insert(checkpoints).values({
        id: uuidv7(),
        organizationId: input.orgId,
        runId: input.runId,
        checkpointRef: input.checkpointRef,
        checkpointVersion: input.checkpointVersion,
        artifactId: input.artifactId ?? null,
        digest: input.digest,
        producer: input.producer,
      });
      return { accepted: true, replay: false };
    });
  }

  /**
   * Artifact facade for GetRunArtifact (5.12 + Phase 7.9): the checks run
   * fresh on every dereference — (1) existence, (2) org scope, (3) RUN scope
   * binding (a run's capability never reads another conversation's artifact:
   * the artifact must be referenced by this run's checkpoints, tool effects,
   * or run_events), (4) purpose allowlist for MCP reads, (5) expiry, (6)
   * checksum present (32 bytes) + byte bounds, (7) deletion/scan state. The
   * access URL is a short-TTL presigned GET, never a stable link.
   */
  async getRunArtifact(input: { orgId: string; runId: string; artifactId: string }): Promise<{
    accessUrl: string;
    expiresIn: number;
    ref: { artifactId: string; uri: string; mediaType: string; byteLength: number; sha256: Buffer; purpose: string; encryptionKeyId: string; expiresAt: string };
  }> {
    const MCP_READ_PURPOSES = new Set(['checkpoint', 'tool_result', 'source_document']);
    const run = await this.getRun(input.orgId, input.runId);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(artifacts).where(and(eq(artifacts.id, input.artifactId), eq(artifacts.organizationId, input.orgId))).limit(1),
    );
    const artifact = rows[0];
    if (!artifact) {
      throw ApiError.notFound('artifact');
    }
    // Run-scope binding: checkpoints / tool_effects / run_events of THIS run.
    const binding = await this.db.withOrg(input.orgId, async (tx) => {
      const cp = await tx.execute(sql`
        select 1 from checkpoints where run_id = ${run.id}::uuid and artifact_id = ${artifact.id}::uuid
        union all
        select 1 from tool_effects where run_id = ${run.id}::uuid and result_artifact_id = ${artifact.id}::uuid
        union all
        select 1 from run_events where run_id = ${run.id}::uuid and artifact_id = ${artifact.id}::uuid
        limit 1
      `);
      return cp.rows.length > 0;
    });
    if (!binding) {
      throw ApiError.forbidden('artifact is not bound to this run');
    }
    if (!MCP_READ_PURPOSES.has(artifact.purpose)) {
      throw ApiError.forbidden(`artifact purpose ${artifact.purpose} is not readable over MCP`);
    }
    if (artifact.expiresAt && Date.parse(artifact.expiresAt) < Date.now()) {
      throw ApiError.forbidden('artifact expired');
    }
    if (!artifact.sha256 || Buffer.from(artifact.sha256).length !== 32) {
      throw ApiError.internal();
    }
    if (artifact.byteLength <= 0 || artifact.byteLength > 1_073_741_824) {
      throw ApiError.forbidden('artifact byte length out of bounds');
    }
    if (artifact.state !== 'active' || artifact.scanStatus === 'infected') {
      throw ApiError.forbidden('artifact is not readable');
    }
    const download = this.storage.presignDownload({ key: artifact.objectKey, expiresIn: 300 });
    return {
      accessUrl: download.url,
      expiresIn: download.expiresIn,
      ref: {
        artifactId: artifact.id,
        // Opaque capability URI — names the claim-check ref, never a bearer link.
        uri: `neryva://org/${input.orgId}/artifact/${artifact.id}`,
        mediaType: artifact.contentTypeDetected ?? artifact.contentTypeDeclared,
        byteLength: artifact.byteLength,
        sha256: Buffer.from(artifact.sha256),
        purpose: artifact.purpose,
        encryptionKeyId: artifact.encryptionKeyRef ?? 'engine-default',
        // The ref expires with the access window — the presigned GET outlives it never.
        expiresAt: new Date(Date.now() + download.expiresIn * 1000).toISOString(),
      },
    };
  }

  // ── Capability issuance (5.3) ───────────────────────────────────────────

  /**
   * Mint a run-scoped capability token after the caller's org-level
   * authorization (console roles guard). The token is what the Studio caller
   * presents on MCP authority RPCs; all ops allow-listed for the run.
   */
  async mintRunCapability(input: { orgId: string; runId: string; actor: string }): Promise<{ token: string; capabilityId: string; expiresAt: Date }> {
    const run = await this.getRun(input.orgId, input.runId);
    const issued = issueCapability({
      organizationId: input.orgId,
      conversationId: run.conversationId,
      runId: run.id,
      assistantVersionId: run.assistantVersionId,
      policyVersion: run.policySnapshotId,
      allowedOps: ['lease', 'context', 'search_knowledge', 'append_events', 'approval', 'memory_proposal', 'tool', 'checkpoint', 'commit', 'observe'],
      subject: 'agent-studio-runtime',
      // Fencing claim: the token is bound to the lease epoch current at mint
      // time — terminal ops reject it if the run is re-leased meanwhile.
      leaseEpoch: run.leaseEpoch,
    });
    await this.audit.add({
      action: 'mcp.capability_issued',
      resourceType: 'run',
      resourceId: run.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { capability_id: issued.capabilityId, expires_at: issued.expiresAt.toISOString() },
    });
    return issued;
  }

  // ── Authorized run context (5.5 + harness H0.3) — the context supply chain ──

  /**
   * Assemble the bounded ContextManifest (contract v1.1): instructions +
   * model params (pinned snapshot), recent history, newest compaction
   * summary, approved memory CONTENT, knowledge retrieval on the trigger
   * message (ACL-before-scoring), tool descriptors with JSON Schemas from the
   * org tool catalog, and budgets. Every untrusted surface (knowledge,
   * memory) is spotlighted and — when the pinned guardrail policy asks for it
   * — PII-redacted before it leaves the Engine.
   */
  async getAuthorizedRunContext(input: { orgId: string; runId: string }): Promise<{
    assistantVersionId: string;
    policyVersion: string;
    conversationSummary: string;
    recentMessages: Array<{ messageId: string; role: string; text: string }>;
    memories: Array<{ memoryId: string; scope: string; provenance: string; content?: string; contentMediaType?: string }>;
    knowledgeRefs: Array<{
      documentId: string;
      chunkId: string;
      snippet?: string;
      title?: string;
      score?: number;
      sourceRangeStart?: number;
      sourceRangeEnd?: number;
    }>;
    tools: Array<{
      name: string;
      effectClass: string;
      approvalRequirement: string;
      description?: string;
      inputSchemaJson?: string;
      annotations?: { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };
    }>;
    artifactRefs: unknown[];
    instructions?: string;
    allowedModels: string[];
    modelParams?: {
      temperature?: number;
      maxOutputTokens?: number;
      topP?: number;
      reasoningEffort?: string;
    };
    budgets: {
      maxToolCalls: number;
      maxModelCalls: number;
      maxOutputBytes: bigint;
      maxTotalTokens: bigint;
      maxCostMicros: bigint;
      wallClockSeconds: number;
    };
  }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];

      const snapshotRows = await tx.select().from(policySnapshots).where(eq(policySnapshots.id, run.policySnapshotId)).limit(1);
      const snapshot = snapshotRows[0] ?? null;
      const toolPolicy = (snapshot?.toolPolicy as { tools?: Array<{ name: string; access?: string; approval?: string }> } | null) ?? { tools: [] };
      const pinnedTools = toolPolicy.tools ?? [];
      const contextPolicy = (snapshot?.contextPolicy as { history_limit?: number; knowledge_sources?: string[] } | null) ?? {};
      const knowledgePolicy = (snapshot?.knowledgePolicy as { retrieval_enabled?: boolean; max_results?: number } | null) ?? {};
      const guardrailPolicy = (snapshot?.guardrailPolicy as { pii_redaction?: boolean } | null) ?? {};
      const piiOff = guardrailPolicy.pii_redaction === false;
      const modelParams = (snapshot?.modelParams as { temperature?: number; max_output_tokens?: number; top_p?: number; reasoning_effort?: string } | null) ?? null;
      const modelPolicy = (snapshot?.modelPolicy as { allowed_models?: string[] } | null) ?? {};
      const allowedModels = Array.isArray(modelPolicy.allowed_models) ? modelPolicy.allowed_models.slice(0, 16) : [];

      // History — bounded by the pinned context policy (contract caps 20).
      const historyLimit = Math.min(Math.max(1, contextPolicy.history_limit ?? 20), 20);
      const recent = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content, sequence: messages.sequence })
        .from(messages)
        .where(and(eq(messages.conversationId, run.conversationId), eq(messages.organizationId, input.orgId)))
        .orderBy(sql`sequence desc`)
        .limit(historyLimit);
      const orderedRecent = recent.reverse();
      const oldestIncludedSequence = orderedRecent.length > 0 ? orderedRecent[0].sequence : Number.MAX_SAFE_INTEGER;

      // Compaction — newest summary that covers material OUTSIDE the included
      // history window (source_sequence < oldest included message).
      let summaryText = '';
      if (orderedRecent.length > 0) {
        const summaryRows = await tx
          .select({ summary: conversationSummaries.summary })
          .from(conversationSummaries)
          .where(
            and(
              eq(conversationSummaries.organizationId, input.orgId),
              eq(conversationSummaries.conversationId, run.conversationId),
              sql`${conversationSummaries.sourceSequence} <= ${oldestIncludedSequence - 1}`,
            ),
          )
          .orderBy(desc(conversationSummaries.sourceSequence))
          .limit(1);
        summaryText = summaryRows[0]?.summary ?? '';
      }

      // Approved memories — scoped rows WITH content. Proposals never surface
      // here (Phase 7.8). Content is untrusted → spotlight (+PII redact).
      const memoryRows = await tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.organizationId, input.orgId),
            isNull(memoryItems.deletedAt),
            or(eq(memoryItems.scopeType, 'organization'), eq(memoryItems.scopeId, run.conversationId)),
          ),
        )
        .orderBy(desc(memoryItems.updatedAt))
        .limit(20);

      // Knowledge — retrieval over the newest user message when the pinned
      // policy enables it. ACL-before-scoring happens inside RetrievalService
      // (the authorization predicates live in the retrieval query itself).
      let knowledgeRefs: Array<{
        documentId: string;
        chunkId: string;
        snippet?: string;
        title?: string;
        score?: number;
        sourceRangeStart?: number;
        sourceRangeEnd?: number;
      }> = [];
      const triggerText = [...orderedRecent].reverse().find((m) => m.role === 'user');
      if (knowledgePolicy.retrieval_enabled && triggerText) {
        const query = String((triggerText.content as { text?: unknown }).text ?? '').slice(0, 512);
        if (query.trim().length > 0) {
          const hits = await this.retrieval.searchKnowledge({
            orgId: input.orgId,
            query,
            limit: Math.min(Math.max(1, knowledgePolicy.max_results ?? 5), 20),
          });
          knowledgeRefs = hits.map((h) => {
            const snippet = piiOff ? h.text : redactPii(h.text).redacted;
            return {
              documentId: h.documentId,
              chunkId: h.chunkId,
              snippet: spotlight({ source: 'knowledge', content: snippet.slice(0, 4096) }),
              title: h.title ?? undefined,
              score: h.score,
              sourceRangeStart: h.sourceRange.byteStart,
              sourceRangeEnd: h.sourceRange.byteEnd,
            };
          });
        }
      }

      // Tools — resolve pinned tool policy entries against the org catalog;
      // entries missing from the catalog degrade to name-only descriptors so
      // a legacy definition still runs (the model sees no schema for them and
      // AuthorizeToolCall still gates execution).
      const catalogRows = pinnedTools.length
        ? await tx
            .select()
            .from(toolCatalog)
            .where(eq(toolCatalog.organizationId, input.orgId))
        : [];
      const catalogByName = new Map(catalogRows.map((r) => [r.name, r]));
      const tools = pinnedTools.map((t) => {
        const entry = catalogByName.get(t.name);
        const annotations = (entry?.annotations ?? {}) as { read_only?: boolean; destructive?: boolean; idempotent?: boolean; open_world?: boolean };
        return {
          name: t.name,
          effectClass: entry?.effectClass ?? (t.access === 'read' ? 'READ_ONLY' : 'MUTATING'),
          approvalRequirement: entry?.approvalRequirement ?? (t.approval === 'required' ? 'REQUIRED' : 'NONE'),
          description: entry?.description ?? undefined,
          inputSchemaJson: entry ? JSON.stringify(entry.inputSchema) : undefined,
          annotations: entry
            ? {
                readOnly: annotations.read_only ?? entry.effectClass === 'READ_ONLY',
                destructive: annotations.destructive ?? entry.effectClass === 'DESTRUCTIVE',
                idempotent: annotations.idempotent ?? false,
                openWorld: annotations.open_world ?? false,
              }
            : undefined,
        };
      });

      return {
        assistantVersionId: run.assistantVersionId,
        policyVersion: run.policySnapshotId,
        conversationSummary: summaryText,
        recentMessages: orderedRecent.map((m) => ({
          messageId: m.id,
          role: m.role,
          text: String((m.content as { text?: unknown }).text ?? '').slice(0, 8192),
        })),
        memories: memoryRows.map((m) => {
          const content = piiOff ? m.content : redactPii(m.content).redacted;
          return {
            memoryId: m.id,
            scope: m.scopeType,
            provenance: m.provenance ?? '',
            content: spotlight({ source: 'memory', content: content.slice(0, 2048) }),
            contentMediaType: 'text/plain',
          };
        }),
        knowledgeRefs,
        tools,
        artifactRefs: [],
        instructions: snapshot?.instructions ?? undefined,
        allowedModels,
        modelParams: modelParams
          ? {
              temperature: modelParams.temperature,
              maxOutputTokens: modelParams.max_output_tokens,
              topP: modelParams.top_p,
              reasoningEffort: modelParams.reasoning_effort,
            }
          : undefined,
        budgets: {
          maxToolCalls: 8,
          maxModelCalls: 16,
          maxOutputBytes: 262144n,
          maxTotalTokens: 200000n,
          maxCostMicros: 0n,
          wallClockSeconds: 0,
        },
      };
    });
  }

  /**
   * Agentic mid-run retrieval (contract v1.1 SearchKnowledge). Same
   * authorization path as manifest assembly: RetrievalService applies
   * ACL-before-scoring in the query. Results are spotlighted + bounded.
   */
  async searchKnowledge(input: { orgId: string; runId: string; query: string; maxResults: number }): Promise<
    Array<{ documentId: string; chunkId: string; snippet: string; title?: string; score: number; sourceRangeStart: number; sourceRangeEnd: number }>
  > {
    const query = input.query.trim().slice(0, 512);
    if (!query) {
      throw ApiError.validation({ query: 'must not be empty' });
    }
    const limit = Math.min(Math.max(1, input.maxResults), 20);
    const hits = await this.retrieval.searchKnowledge({ orgId: input.orgId, query, limit });
    return hits.map((h) => ({
      documentId: h.documentId,
      chunkId: h.chunkId,
      snippet: spotlight({ source: 'knowledge', content: h.text.slice(0, 4096) }),
      title: h.title ?? undefined,
      score: h.score,
      sourceRangeStart: h.sourceRange.byteStart,
      sourceRangeEnd: h.sourceRange.byteEnd,
    }));
  }

  /**
   * Conversation compaction (contract v1.1 SaveConversationSummary). Studio
   * produces the summary with its own model credentials; Engine validates
   * scope + bounds and stores it as immutable business truth. Idempotent per
   * (conversation_id, source_sequence); a different digest under the same key
   * is a conflict, not an overwrite.
   */
  async saveConversationSummary(input: {
    orgId: string;
    conversationId: string;
    sourceSequence: number;
    summary: string;
    tokenCount: number;
    modelId?: string;
    callerScope: string;
    idempotencyKey: string;
  }): Promise<{ summaryId: string; duplicate: boolean }> {
    if (!Number.isInteger(input.sourceSequence) || input.sourceSequence < 0) {
      throw ApiError.validation({ source_sequence: 'must be a non-negative integer' });
    }
    const summary = input.summary.slice(0, 8192);
    return this.db.withOrg(input.orgId, async (tx) => {
      const conv = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.orgId)))
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      // Idempotency anchor: same caller key + same digest → replay; different
      // digest → conflict. The conversation row is the natural scope here.
      const claimed = await tx
        .insert(conversationSummaries)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          sourceSequence: input.sourceSequence,
          summary,
          tokenCount: Math.max(0, Math.floor(input.tokenCount)),
          modelId: input.modelId?.slice(0, 128) ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (claimed.length > 0) {
        return { summaryId: claimed[0].id, duplicate: false };
      }
      const existing = await tx
        .select({ id: conversationSummaries.id, summary: conversationSummaries.summary })
        .from(conversationSummaries)
        .where(
          and(
            eq(conversationSummaries.conversationId, input.conversationId),
            eq(conversationSummaries.sourceSequence, input.sourceSequence),
          ),
        )
        .limit(1);
      if (existing.length > 0 && existing[0].summary === summary) {
        return { summaryId: existing[0].id, duplicate: true };
      }
      throw ApiError.conflict('summary already exists for this source sequence with different content');
    });
  }

  // ── Run idempotency (run-scoped helper for callers that need it) ────────

  async claimRunIdempotency(tx: NodePgDatabase, input: { orgId: string; runId: string; callerScope: string; idempotencyKey: string; requestHash: string }): Promise<'claimed' | 'duplicate'> {
    const inserted = await tx
      .insert(runIdempotency)
      .values({
        id: uuidv7(),
        organizationId: input.orgId,
        runId: input.runId,
        callerScope: input.callerScope,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: runIdempotency.id });
    if (inserted.length > 0) {
      return 'claimed';
    }
    const existing = await tx
      .select({ requestHash: runIdempotency.requestHash })
      .from(runIdempotency)
      .where(
        and(
          eq(runIdempotency.organizationId, input.orgId),
          eq(runIdempotency.callerScope, input.callerScope),
          eq(runIdempotency.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing.length > 0 && existing[0].requestHash !== input.requestHash) {
      throw ApiError.conflict('idempotency key reuse with different payload');
    }
    return 'duplicate';
  }

  private async auditSafe(event: { action: string; resourceType: string; resourceId: string; tenantId: string; details: Record<string, unknown> }): Promise<void> {
    try {
      await this.audit.add({
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        actorType: 'service',
        actorId: 'agent-studio-runtime',
        tenantId: event.tenantId,
        details: event.details,
      });
    } catch (err) {
      McpAuthorityService.logger.warn(`audit write failed for ${event.action}: ${(err as Error).message}`);
    }
  }
}
