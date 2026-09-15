import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
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
import { policySnapshots, assistants, assistantVersions, controlBlocks } from '../assistants/schema';
import { toolCatalog } from '../assistants/tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../assistants/tool-catalog.service';
import { providerCredentials, providerEnablements, isModelProvider } from '../assistants/provider-credentials.schema';
import { ControlBlocksService } from '../assistants/control-blocks.service';
import { RetrievalService } from '../knowledge/retrieval.service';
import { spotlight, redactPii } from '../../common/guardrails';
import { envelopeDecrypt } from '../../common/infra/crypto/envelope';
import { memoryItems } from '../knowledge/schema';
import { approvals, checkpoints, memoryProposals, toolEffects, runIdempotency } from './mcp.schema';
import { assertRunTransition, isRunState, isTerminalRun } from './state-machine';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import { EscalationsService } from './escalations.service';
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

  /** messages.created_by is a free varchar; scope_id is a uuid column. */
  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly purge: RetentionPurgeService,
    private readonly retrieval: RetrievalService,
    private readonly escalations: EscalationsService,
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

      // REL-4.4 — a failed run releases its durable quota reservation in the
      // SAME transaction (the wall must not count a run that never ran).
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
    /** REL-11.4: who triggered the approval (for approver≠author). Defaults to run's input message author. */
    createdBy?: string | null;
    /** REL-11.4: 1 = single approver (legacy), 2..5 = multi-approver chain. */
    requiredApprovals?: number;
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
      // REL-11.4: resolve author for approver≠author. Prefer explicit createdBy
      // (Studio may pass the end-user id), else fall back to the run's input
      // message author (the human who sent the message that triggered the run).
      let createdBy: string | null = input.createdBy ?? null;
      if (!createdBy) {
        const msgRows = await tx.select({ createdBy: messages.createdBy }).from(messages).where(eq(messages.id, run.inputMessageId)).limit(1);
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

  /**
   * RequestHumanHandoff (contract v1.2, FL-1.7c) — the built-in
   * `request_human_handoff` tool lands here. Delegates to the escalations
   * service: one TX opens the WAITING row, flips the conversation to
   * 'escalated' and emits the lifecycle outbox event.
   */
  async requestHumanHandoff(input: {
    orgId: string;
    runId: string;
    reason: string;
    note?: string;
  }): Promise<{ escalationId: string; state: string; conversationStatus: string }> {
    const found = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('run');
      }
      return rows[0];
    });
    if (isTerminalRun(found.state)) {
      throw ApiError.conflict('run is terminal; escalation rejected', { state: found.state });
    }
    const escalation = await this.escalations.escalate({
      orgId: input.orgId,
      conversationId: found.conversationId,
      runId: input.runId,
      reason: input.reason.startsWith('tool:') ? input.reason : `tool:request_human_handoff`,
      actor: 'agent-studio-runtime',
    });
    const conv = await this.db.withOrg(input.orgId, (tx) =>
      tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, found.conversationId)).limit(1),
    );
    await this.auditSafe({
      action: 'mcp.human_handoff_requested',
      resourceType: 'escalation',
      resourceId: escalation.id,
      tenantId: input.orgId,
      details: { run_id: input.runId, conversation_id: found.conversationId, note_len: input.note?.length ?? 0 },
    });
    return { escalationId: escalation.id, state: escalation.state, conversationStatus: conv[0]?.status ?? 'unknown' };
  }

  /**
   * PutRunArtifact (contract v1.3, FL-2.13/2.17) — Studio uploads a bounded
   * checkpoint or tool-result artifact through the Engine. Bytes go to
   * object storage under the org's tenant-bound prefix; the artifact row and
   * the returned claim-check ref are Engine-owned. The put is executed
   * BEFORE the row insert: a crash leaves an orphan object (rebuildable,
   * garbage-collectable), never a row whose bytes are missing.
   */
  async putRunArtifact(input: {
    orgId: string;
    runId: string;
    purpose: 'CHECKPOINT' | 'TOOL_RESULT' | 'GENERATED_MEDIA';
    mediaType: string;
    data: Buffer;
  }): Promise<{ artifactId: string; sha256: Buffer; byteLength: number }> {
    // FL-3.2 — GENERATED_MEDIA raises the size bound to the attachment cap
    // (5 MiB) and is restricted to image media; CHECKPOINT/TOOL_RESULT keep
    // the 512 KiB claim-check bound.
    const purposeBounds = {
      CHECKPOINT: { max: 524_288, comment: '512 KiB' },
      TOOL_RESULT: { max: 524_288, comment: '512 KiB' },
      GENERATED_MEDIA: { max: 5 * 1024 * 1024, comment: '5 MiB' },
    } as const;
    const bounds = purposeBounds[input.purpose as keyof typeof purposeBounds];
    if (!bounds) {
      throw ApiError.validation({ purpose: 'must be CHECKPOINT, TOOL_RESULT or GENERATED_MEDIA' });
    }
    if (input.data.byteLength > bounds.max) {
      throw ApiError.validation({ data: `artifact data exceeds the ${bounds.comment} bound for ${input.purpose}` });
    }
    if (input.purpose === 'GENERATED_MEDIA' && !['image/png', 'image/jpeg', 'image/webp'].includes(input.mediaType)) {
      throw ApiError.validation({ media_type: 'GENERATED_MEDIA must be image/png, image/jpeg or image/webp' });
    }
    const artifactId = uuidv7();
    const objectKey = `org/${input.orgId}/${input.purpose.toLowerCase()}/${artifactId}.bin`;
    this.storage.assertTenantKey(objectKey, input.orgId);
    await this.storage.putObject({ key: objectKey, contentType: input.mediaType, body: input.data });
    const sha256 = createHash('sha256').update(input.data).digest();
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        organizationId: input.orgId,
        purpose: input.purpose,
        objectKey,
        contentTypeDeclared: input.mediaType,
        contentTypeDetected: input.mediaType,
        byteLength: input.data.byteLength,
        sha256,
        scanStatus: 'skipped',
        state: 'active',
        createdBy: 'agent-studio-runtime',
      });
    });
    return { artifactId, sha256, byteLength: input.data.byteLength };
  }

  /**
   * GetToolCredential (contract v1.3, FL-2.10) — scoped disclosure of a
   * tool's customer-endpoint credential. The tool must be pinned on the
   * run's policy snapshot AND present in the org catalog with a bound
   * credential; disclosure is audited and never flows through the manifest.
   */
  async getToolCredential(input: { orgId: string; runId: string; toolName: string }): Promise<{ credential: string; credentialHeader: string }> {
    // REL-1.4 (release_ledger.md): model-provider keys ride the SAME audited
    // disclosure rail as tool credentials — the gateway asks for the
    // pseudo-tool `model:<provider>`. No contract change: GetToolCredential
    // already carries (credential, credential_header) and the capability
    // scope check happened at the transport boundary.
    if (input.toolName.startsWith('model:')) {
      const provider = input.toolName.slice('model:'.length);
      if (!isModelProvider(provider)) {
        throw ApiError.validation({ tool_name: `unknown model provider: ${provider}` });
      }
      return this.getModelCredential({ orgId: input.orgId, runId: input.runId, provider });
    }
    const found = await this.db.withOrg(input.orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (runRows.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = runRows[0];
      const snapshotRows = await tx.select().from(policySnapshots).where(eq(policySnapshots.id, run.policySnapshotId)).limit(1);
      const toolPolicy = (snapshotRows[0]?.toolPolicy as { tools?: Array<{ name: string }> } | null) ?? { tools: [] };
      const pinned = (toolPolicy.tools ?? []).some((t) => t.name === input.toolName);
      if (!pinned) {
        throw ApiError.validation({ tool_name: 'tool is not pinned on this run' });
      }
      const catalogRows = await tx
        .select()
        .from(toolCatalog)
        .where(and(eq(toolCatalog.organizationId, input.orgId), eq(toolCatalog.name, input.toolName)))
        .limit(1);
      const row = catalogRows[0] ?? null;
      // TPL-6.3 — same gates as authorize, adapted to the disclosure shape:
      // an operator block or a disabled flag denies loudly (audited throw),
      // while a missing row keeps the legacy empty-credential behavior
      // (platform built-ins carry no row and need no credential).
      if (row) {
        const toolBlock = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'tool', input.toolName);
        if (toolBlock || !row.enabled) {
          const reason = toolBlock ? `tool ${input.toolName} is blocked (${toolBlock.reason})` : `tool ${input.toolName} is disabled at this org`;
          await this.auditSafe({
            action: 'mcp.tool_credential_denied',
            resourceType: 'tool_catalog',
            resourceId: row.id,
            tenantId: input.orgId,
            details: { run_id: input.runId, tool: input.toolName, reason },
          });
          // Policy denial, not a malformed request — forbidden (403), the
          // same semantics an authorize denial would produce.
          throw ApiError.forbidden(reason, { tool_name: input.toolName });
        }
      }
      return row;
    });
    const entry = found;
    if (!entry || !entry.credentialSealed) {
      return { credential: '', credentialHeader: 'authorization' };
    }
    const binding = (entry.httpBinding ?? {}) as { header_name?: string };
    await this.auditSafe({
      action: 'mcp.tool_credential_disclosed',
      resourceType: 'tool_catalog',
      resourceId: entry.id,
      tenantId: input.orgId,
      details: { run_id: input.runId, tool: input.toolName },
    });
    return {
      credential: envelopeDecrypt(entry.credentialSealed),
      credentialHeader: binding.header_name ?? 'authorization',
    };
  }

  /**
   * Model-provider credential disclosure (REL-1.4 Engine half). Gates, in
   * order: the provider must appear on THIS run's resolved model manifest
   * (a run can never reach a provider its snapshot did not pin), the
   * capability-level kill switch (`model:<provider>`) must be silent, the
   * provider must be enabled at the org, and an ACTIVE credential must
   * exist. Every outcome — denial or disclosure — is audited. The plaintext
   * exists only inside envelopeDecrypt for the length of this call.
   */
  private async getModelCredential(input: { orgId: string; runId: string; provider: string }): Promise<{ credential: string; credentialHeader: string }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (runRows.length === 0) {
        throw ApiError.notFound('run');
      }
      const snapshotRows = await tx.select().from(policySnapshots).where(eq(policySnapshots.id, runRows[0].policySnapshotId)).limit(1);
      const modelRef = (snapshotRows[0]?.modelRef ?? null) as { models?: Array<{ provider?: string }> } | null;
      const providersOnRun = new Set((modelRef?.models ?? []).map((m) => m?.provider).filter((p): p is string => typeof p === 'string'));
      if (!providersOnRun.has(input.provider)) {
        throw ApiError.forbidden(`provider ${input.provider} is not on this run's model manifest`, { provider: input.provider });
      }
      const block = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'capability', `model:${input.provider}`);
      if (block) {
        await this.auditSafe({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: { run_id: input.runId, provider: input.provider, reason: `blocked (${block.reason})` },
        });
        throw ApiError.forbidden(`model capability ${input.provider} is blocked (${block.reason})`, { provider: input.provider });
      }
      const enableRows = await tx
        .select()
        .from(providerEnablements)
        .where(and(eq(providerEnablements.organizationId, input.orgId), eq(providerEnablements.provider, input.provider)))
        .limit(1);
      if (enableRows[0] && !enableRows[0].enabled) {
        await this.auditSafe({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: { run_id: input.runId, provider: input.provider, reason: 'provider disabled at this org' },
        });
        throw ApiError.forbidden(`provider ${input.provider} is disabled at this org`, { provider: input.provider });
      }
      const credRows = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.organizationId, input.orgId),
            eq(providerCredentials.provider, input.provider),
            eq(providerCredentials.status, 'active'),
          ),
        )
        .orderBy(desc(providerCredentials.createdAt))
        .limit(1);
      const cred = credRows[0] ?? null;
      if (!cred) {
        await this.auditSafe({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: { run_id: input.runId, provider: input.provider, reason: 'no active credential' },
        });
        throw ApiError.forbidden(`no active ${input.provider} credential at this org`, { provider: input.provider });
      }
      await this.auditSafe({
        action: 'mcp.model_credential_disclosed',
        resourceType: 'provider_credential',
        resourceId: cred.id,
        tenantId: input.orgId,
        details: { run_id: input.runId, provider: input.provider },
      });
      return { credential: envelopeDecrypt(cred.secretSealed), credentialHeader: 'authorization' };
    });
  }

  /** GetLatestCheckpoint (contract v1.3, FL-2.17) — newest run checkpoint. */
  async getLatestCheckpoint(input: {
    orgId: string;
    runId: string;
  }): Promise<{
    checkpointRef: string;
    checkpointVersion: number;
    artifact?: { artifactId: string; mediaType: string; byteLength: number; sha256: Buffer; purpose: string };
  } | null> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.organizationId, input.orgId), eq(checkpoints.runId, input.runId)))
        .orderBy(desc(checkpoints.checkpointVersion))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      let artifact: { artifactId: string; mediaType: string; byteLength: number; sha256: Buffer; purpose: string } | undefined;
      if (row.artifactId) {
        const artRows = await tx.select().from(artifacts).where(eq(artifacts.id, row.artifactId)).limit(1);
        const art = artRows[0];
        if (art) {
          artifact = {
            artifactId: art.id,
            mediaType: art.contentTypeDetected ?? art.contentTypeDeclared,
            byteLength: art.byteLength,
            sha256: Buffer.from(art.sha256),
            purpose: art.purpose,
          };
        }
      }
      return { checkpointRef: row.checkpointRef, checkpointVersion: row.checkpointVersion, artifact };
    });
  }

  // ── Memory proposals (5.9) — proposals are NOT truth ────────────────────

  /**
   * GetApprovalState (contract v1.2) — Studio observes the durable decision
   * for an approval it proposed. Run-bound safe read: the approval row must
   * belong to the ctx run, otherwise NOT_FOUND (never leaks other runs').
   */
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
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.organizationId, input.orgId), eq(approvals.approvalRef, input.approvalRef)))
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
  }): Promise<{ approvalId: string; state: 'APPROVED' | 'DENIED' | 'PENDING'; runState: string; replay: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
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
        throw ApiError.forbidden('approver must differ from author', { approval_id: approval.id, author: approval.createdBy });
      }

      // REL-11.4: multi-approver chain — when `requiredApprovals` > 1 we
      // collect individual approvals in `approvalsReceived` and only transition
      // the approval/run when the threshold is reached. Any DENIED short-circuits
      // to DENIED/CANCELED. Duplicate actor votes are conflicts.
      const required = Math.min(5, Math.max(1, approval.requiredApprovals ?? 1));
      const received = Array.isArray(approval.approvalsReceived) ? (approval.approvalsReceived as Array<{ actor: string; decision: string }>) : [];
      if (required > 1) {
        if (received.some((r) => r.actor === input.actor)) {
          throw ApiError.conflict('actor has already voted on this approval', { approval_id: approval.id, actor: input.actor });
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
          return { approvalId: approval.id, state: approval.state as 'APPROVED' | 'DENIED', runState: runRows[0]?.state ?? 'UNKNOWN', replay: true };
        }
        throw ApiError.conflict('approval already decided', { approval_id: approval.id, state: approval.state });
      }

      const foundRun = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
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
          const nextReceived = [...received, { actor: input.actor, decision: 'APPROVED', decided_at: now }];
          // Not yet at threshold — record the vote, stay PENDING, do not resume run.
          if (nextReceived.filter((r) => r.decision === 'APPROVED').length < required) {
            await tx
              .update(approvals)
              .set({ approvalsReceived: nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived, decisionActorId: input.actor, decidedAt: now } as never)
              .where(eq(approvals.id, approval.id));
            await this.auditSafe({
              action: 'mcp.approval_voted',
              resourceType: 'approval',
              resourceId: approval.id,
              tenantId: input.orgId,
              details: { run_id: run.id, decision: 'APPROVED', actor: input.actor, received: nextReceived.length, required },
            });
            return { approvalId: approval.id, state: 'PENDING' as const, runState: run.state, replay: false };
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
              approvalsReceived: nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived,
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
        await this.auditSafe({
          action: 'mcp.approval_decided',
          resourceType: 'approval',
          resourceId: approval.id,
          tenantId: input.orgId,
          details: { run_id: run.id, decision: 'APPROVED', actor: input.actor, required, received: required > 1 ? required : 1 },
        });
        return { approvalId: approval.id, state: 'APPROVED', runState: 'RUNNING', replay: false };
      }

      // DENIED — any DENIED short-circuits the chain (even for multi-approver).
      if (required > 1) {
        const nextReceived = [...received, { actor: input.actor, decision: 'DENIED', decided_at: now }];
        await tx
          .update(approvals)
          .set({
            state: 'DENIED',
            decisionActorId: input.actor,
            decisionId,
            decidedAt: now,
            approvalsReceived: nextReceived as unknown as typeof approvals.$inferInsert.approvalsReceived,
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
      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversationId,
        payload: { run_id: run.id, conversation_id: run.conversationId, reason: input.reason ?? 'approval_denied' },
      });
      await this.auditSafe({
        action: 'mcp.approval_decided',
        resourceType: 'approval',
        resourceId: approval.id,
        tenantId: input.orgId,
        details: { run_id: run.id, decision: 'DENIED', actor: input.actor },
      });
      return { approvalId: approval.id, state: 'DENIED', runState: 'CANCELED', replay: false };
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

      // TPL-6.3 kill levels 2-4 — evaluated on EVERY new authorization (no
      // cache, so kill-to-deny latency is one RPC). Order: explicit operator
      // blocks first (cheapest, most specific), then the catalog enabled
      // flag. NOTE: the dedup early-return above intentionally precedes all
      // of this — replaying an already-authorized call's ack is idempotency,
      // not a new authorization; freezing it would corrupt exactly-once
      // completion of in-flight effects.
      const deny = async (reason: string): Promise<{ allowed: false; reason: string; approvalRequired: false; duplicate: false }> => {
        await this.auditSafe({
          action: 'mcp.tool_denied',
          resourceType: 'tool_effect',
          resourceId: run.id,
          tenantId: input.orgId,
          details: { run_id: input.runId, tool: input.toolName, reason },
        });
        return { allowed: false, reason, approvalRequired: false, duplicate: false };
      };
      const capabilityBlock = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'capability', 'tool');
      if (capabilityBlock) {
        return deny(`tool capability frozen (${capabilityBlock.reason})`);
      }
      const toolBlock = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'tool', input.toolName);
      if (toolBlock) {
        return deny(`tool ${input.toolName} is blocked (${toolBlock.reason})`);
      }
      if (!BUILT_IN_TOOLS.has(input.toolName)) {
        const catalogRows = await tx
          .select({ id: toolCatalog.id, enabled: toolCatalog.enabled })
          .from(toolCatalog)
          .where(and(eq(toolCatalog.organizationId, input.orgId), eq(toolCatalog.name, input.toolName)))
          .limit(1);
        const row = catalogRows[0];
        if (!row) {
          // Pinned at publish but the row is gone (deleted post-publish) —
          // fail closed rather than executing against an ungoverned tool.
          return deny(`tool ${input.toolName} has no catalog row at this org`);
        }
        if (!row.enabled) {
          return deny(`tool ${input.toolName} is disabled at this org`);
        }
      }
      // Assistant-level kill for in-flight runs: acceptance already refuses
      // new runs, but a run accepted BEFORE the kill must not authorize new
      // tool calls after it. Either the disabled flag or an active block
      // freezes the assistant. (Version blocks intentionally do NOT gate
      // here — in-flight runs stay pinned to their manifest by invariant.)
      const versionRows = await tx
        .select({ assistantId: assistantVersions.assistantId })
        .from(assistantVersions)
        .where(eq(assistantVersions.id, run.assistantVersionId))
        .limit(1);
      const assistantId = versionRows[0]?.assistantId;
      if (assistantId) {
        const assistantRows = await tx.select({ disabledAt: assistants.disabledAt }).from(assistants).where(eq(assistants.id, assistantId)).limit(1);
        if (assistantRows[0]?.disabledAt) {
          return deny(`assistant is disabled`);
        }
        const assistantBlock = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'assistant', assistantId);
        if (assistantBlock) {
          return deny(`assistant is blocked (${assistantBlock.reason})`);
        }
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
      allowedOps: ['lease', 'context', 'search_knowledge', 'append_events', 'approval', 'memory_proposal', 'tool', 'checkpoint', 'commit', 'observe', 'escalation', 'artifact'],
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
    memories: Array<{ memoryId: string; scope: string; scopeId?: string; provenance: string; content?: string; contentMediaType?: string }>;
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
      httpBinding?: { url: string; method: string; timeout_ms: number; header_name: string } | null;
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
      outputSchema?: string;
    };
    budgets: {
      maxToolCalls: number;
      maxModelCalls: number;
      maxOutputBytes: bigint;
      maxTotalTokens: bigint;
      maxCostMicros: bigint;
      wallClockSeconds: number;
    };
    /** FL-1.4: pinned guardrail policy strings — Studio resolves moderation behavior. */
    guardrailPolicy: {
      inputPolicy: string;
      outputPolicy: string;
      piiRedaction: boolean;
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
      const contextPolicy = (snapshot?.contextPolicy as { history_limit?: number; knowledge_sources?: string[]; memory_scope?: string } | null) ?? {};
      const knowledgePolicy = (snapshot?.knowledgePolicy as { retrieval_enabled?: boolean; max_results?: number } | null) ?? {};
      const guardrailPolicy = (snapshot?.guardrailPolicy as { input_policy?: string; output_policy?: string; pii_redaction?: boolean } | null) ?? {};
      const piiOff = guardrailPolicy.pii_redaction === false;
      const modelParams = (snapshot?.modelParams as { temperature?: number; max_output_tokens?: number; top_p?: number; reasoning_effort?: string } | null) ?? null;
      const modelPolicy = (snapshot?.modelPolicy as { allowed_models?: string[] } | null) ?? {};
      const allowedModels = Array.isArray(modelPolicy.allowed_models) ? modelPolicy.allowed_models.slice(0, 16) : [];
      const budgetPolicy = (snapshot?.budgetPolicy as {
        max_total_tokens?: number;
        max_cost_micros?: number;
        wall_clock_seconds?: number;
        max_tool_calls?: number;
        max_model_calls?: number;
      } | null) ?? {};

      // FL-1.5 — the pinned memory_scope decides WHICH memory surfaces the
      // manifest carries. Undefined keeps the legacy default (organization +
      // conversation rows) for pre-FL-1.5 snapshots; 'none' excludes the
      // surface entirely; 'user' resolves the run actor's account via the
      // trigger message — user-scoped rows are NEVER visible across accounts.
      const memoryScopeRaw = typeof contextPolicy.memory_scope === 'string' ? contextPolicy.memory_scope : undefined;
      const memoryScope = memoryScopeRaw === 'user' || memoryScopeRaw === 'organization' || memoryScopeRaw === 'conversation' || memoryScopeRaw === 'none' ? memoryScopeRaw : undefined;
      // Run actor: the trigger message author when it is an account id.
      // Drives user-scoped memory AND source-ACL identity (P0-1) — the two
      // concerns share one lookup but diverge after: memory keeps the legacy
      // scope default, source matching always uses the actor when known.
      const triggerRows = await tx
        .select({ createdBy: messages.createdBy })
        .from(messages)
        .where(eq(messages.id, run.inputMessageId))
        .limit(1);
      const triggerAuthor = triggerRows[0]?.createdBy ?? null;
      const runActorAccountId = triggerAuthor !== null && McpAuthorityService.UUID_RE.test(triggerAuthor) ? triggerAuthor : null;
      const userAccountId = memoryScope === 'user' ? runActorAccountId : null;

      // History — bounded by the pinned context policy (contract caps 20).
      const historyLimit = Math.min(Math.max(1, contextPolicy.history_limit ?? 20), 20);
      const recent = await tx
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          sequence: messages.sequence,
          artifactRefs: messages.artifactRefs,
        })
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

      // Approved memories — scoped rows WITH content, selected by the pinned
      // memory_scope (FL-1.5). FL-2.4: selection is SEMANTIC — the trigger
      // message is the query; RetrievalService orders by cosine similarity
      // with the scope OR-list inside the ranking statement (ACL-before-
      // scoring) and degrades to recency for zero signal / pre-0038 rows.
      // Proposals never surface here (Phase 7.8). Content is untrusted →
      // spotlight (+PII redact).
      const triggerText = [...orderedRecent].reverse().find((m) => m.role === 'user');
      const triggerQuery = String((triggerText?.content as { text?: unknown } | null)?.text ?? '');
      let memoryRows: Array<typeof memoryItems.$inferSelect> = [];
      if (memoryScope !== 'none') {
        const scopes =
          memoryScope === undefined
            ? // Legacy default: organization + conversation surfaces.
              [{ scopeType: 'organization' as const }, { scopeType: 'conversation' as const, scopeId: run.conversationId }]
            : memoryScope === 'conversation'
              ? [{ scopeType: 'conversation' as const, scopeId: run.conversationId }]
              : memoryScope === 'organization'
                ? [{ scopeType: 'organization' as const }]
                // user scope without a resolvable account (service/channel
                // trigger) yields NO scopes — zero user memories, never a
                // widening to another scope.
                : userAccountId !== null
                  ? [{ scopeType: 'user' as const, scopeId: userAccountId }]
                  : [];
        memoryRows = await this.retrieval.searchApprovedMemories({
          orgId: input.orgId,
          query: triggerQuery,
          scopes,
          limit: 20,
        });
      }

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
      if (knowledgePolicy.retrieval_enabled && triggerText) {
        const query = String((triggerText.content as { text?: unknown }).text ?? '').slice(0, 512);
        if (query.trim().length > 0) {
          const hits = await this.retrieval.searchKnowledge({
            orgId: input.orgId,
            query,
            limit: Math.min(Math.max(1, knowledgePolicy.max_results ?? 5), 20),
            // E-1: constrain to the snapshot's resolved pins (undefined =
            // unpinned legacy versions keep the org-wide posture).
            allowedDocumentVersionIds: McpAuthorityService.resolvedPinVersionIds(snapshot),
            callerAccountId: runActorAccountId ?? undefined,
          });
          // FL-2.9 — the retrieval leg is a durable run event; CommitRunResult
          // reads it in the SAME TX as the terminal commit and pins bounded
          // citations onto the assistant message.
          await this.recordRetrievalEvent({ orgId: input.orgId, runId: input.runId, query, hits, tx });
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
      // TPL-6.3 — disabled or operator-blocked tools are withheld from the
      // served descriptors: the model is never offered what authorize would
      // deny. Silent on this read path by design (documented); authorize
      // denies loudly with audit — the decision point, not the read path.
      const blockRows = await tx
        .select({ targetName: controlBlocks.targetName })
        .from(controlBlocks)
        .where(
          and(
            eq(controlBlocks.organizationId, input.orgId),
            eq(controlBlocks.targetType, 'tool'),
            or(isNull(controlBlocks.expiresAt), sql`${controlBlocks.expiresAt} > now()`),
          ),
        );
      const blockedNames = new Set(blockRows.map((r) => r.targetName));
      const visibleTools = pinnedTools.filter((t) => {
        if (blockedNames.has(t.name)) return false;
        const entry = catalogByName.get(t.name);
        if (entry && !entry.enabled) return false;
        return true;
      });
      const tools = visibleTools.map((t) => {
        const entry = catalogByName.get(t.name);
        // Built-in tools (e.g. request_human_handoff) resolve without a
        // catalog row - the platform implements them (FL-1.7c).
        const builtin = BUILT_IN_TOOLS.get(t.name);
        const annotations = (entry?.annotations ?? {}) as { read_only?: boolean; destructive?: boolean; idempotent?: boolean; open_world?: boolean };
        return {
          name: t.name,
          effectClass: entry?.effectClass ?? builtin?.effectClass ?? (t.access === 'read' ? 'READ_ONLY' : 'MUTATING'),
          approvalRequirement: entry?.approvalRequirement ?? builtin?.approvalRequirement ?? (t.approval === 'required' ? 'REQUIRED' : 'NONE'),
          description: entry?.description ?? builtin?.description ?? undefined,
          inputSchemaJson: entry
            ? JSON.stringify(entry.inputSchema)
            : builtin
              ? JSON.stringify(builtin.inputSchema)
              : undefined,
          httpBinding: entry
            ? ((entry.httpBinding ?? null) as { url: string; method: string; timeout_ms: number; header_name: string } | null)
            : undefined,
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
        recentMessages: orderedRecent.map((m) => {
          // FL-1.6 — pinned MESSAGE_ATTACHMENT claim-check refs; the runtime
          // fetches each via GetRunArtifact and builds provider image parts.
          const refs = Array.isArray(m.artifactRefs)
            ? (m.artifactRefs as Array<{ artifact_id: string; media_type: string; byte_length: number; sha256: string; purpose: string }>)
            : [];
          return {
            messageId: m.id,
            role: m.role,
            text: String((m.content as { text?: unknown }).text ?? '').slice(0, 8192),
            attachments: refs.slice(0, 4).map((r) => ({
              artifactId: r.artifact_id,
              mediaType: r.media_type,
              byteLength: r.byte_length,
              sha256: Buffer.from(r.sha256, 'hex'),
              purpose: r.purpose,
            })),
          };
        }),
        memories: memoryRows.map((m) => {
          const content = piiOff ? m.content : redactPii(m.content).redacted;
          return {
            memoryId: m.id,
            scope: m.scopeType,
            scopeId: m.scopeId ?? undefined,
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
              outputSchema: (modelParams as { output_schema?: string }).output_schema,
            }
          : undefined,
        budgets: {
          maxToolCalls: budgetPolicy.max_tool_calls ?? 8,
          maxModelCalls: budgetPolicy.max_model_calls ?? 16,
          maxOutputBytes: 262144n,
          maxTotalTokens: BigInt(budgetPolicy.max_total_tokens ?? 200_000),
          maxCostMicros: BigInt(budgetPolicy.max_cost_micros ?? 0),
          wallClockSeconds: budgetPolicy.wall_clock_seconds ?? 0,
        },
        guardrailPolicy: {
          inputPolicy: guardrailPolicy.input_policy ?? 'default',
          outputPolicy: guardrailPolicy.output_policy ?? 'default',
          piiRedaction: !piiOff,
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
    const hits = await this.retrieval.searchKnowledge({
      orgId: input.orgId,
      query,
      limit,
      // E-1: same pin enforcement as manifest assembly — the run's snapshot
      // decides the retrievable set, not the org pool.
      allowedDocumentVersionIds: await this.pinnedVersionIdsForRun(input.orgId, input.runId),
      callerAccountId: (await this.runActorAccountId(input.orgId, input.runId)) ?? undefined,
    });
    await this.recordRetrievalEvent({ orgId: input.orgId, runId: input.runId, query, hits });
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
   * E-1 — pin allow-list for retrieval. Returns undefined when the snapshot
   * declares no pins (legacy org-wide posture preserved); otherwise the
   * resolved document_version ids (possibly [] → retrieval matches nothing,
   * fail-closed). Pure over the snapshot row — unit-tested.
   */
  private static resolvedPinVersionIds(snapshot: { knowledgePins?: unknown } | null): string[] | undefined {
    return resolvedPinVersionIds(snapshot);
  }

  /** E-1 — run-scoped pin lookup for the agentic SearchKnowledge path. */
  private async pinnedVersionIdsForRun(orgId: string, runId: string): Promise<string[] | undefined> {
    const found = await this.db.withOrg(orgId, (tx) =>
      tx.select({ policySnapshotId: runs.policySnapshotId }).from(runs).where(eq(runs.id, runId)).limit(1),
    );
    const snapshotId = found[0]?.policySnapshotId ?? null;
    if (!snapshotId) {
      return undefined;
    }
    const snapshots = await this.db.withOrg(orgId, (tx) =>
      tx.select({ knowledgePins: policySnapshots.knowledgePins }).from(policySnapshots).where(eq(policySnapshots.id, snapshotId)).limit(1),
    );
    return McpAuthorityService.resolvedPinVersionIds((snapshots[0] ?? null) as { knowledgePins?: unknown } | null);
  }

  /** P0-1 — run actor account for source-ACL matching (trigger author iff an account id). */
  private async runActorAccountId(orgId: string, runId: string): Promise<string | null> {
    const found = await this.db.withOrg(orgId, (tx) =>
      tx.select({ inputMessageId: runs.inputMessageId }).from(runs).where(eq(runs.id, runId)).limit(1),
    );
    const messageId = found[0]?.inputMessageId ?? null;
    if (!messageId) {
      return null;
    }
    const trigger = await this.db.withOrg(orgId, (tx) =>
      tx.select({ createdBy: messages.createdBy }).from(messages).where(eq(messages.id, messageId)).limit(1),
    );
    const author = trigger[0]?.createdBy ?? null;
    return author !== null && McpAuthorityService.UUID_RE.test(author) ? author : null;
  }

  /**
   * FL-2.9 — durable retrieval event (wire EVENT_TYPE_RETRIEVAL → stored
   * '5', payload {case:'retrieval', value:{citations}}). eventId is
   * deterministic per (run, query) so a re-driven context assembly dedups;
   * the payload mirrors the transport's {case, value, redaction} envelope.
   */
  private async recordRetrievalEvent(
    input: {
      orgId: string;
      runId: string;
      query: string;
      hits: Array<{ documentId: string; chunkId: string; sourceRange: { byteStart: number; byteEnd: number } }>;
      tx?: Parameters<Parameters<DbService['withOrg']>[1]>[0];
    },
  ): Promise<void> {
    const citations = input.hits.slice(0, 10).map((h) => ({
      document_id: h.documentId,
      chunk_id: h.chunkId,
      source_range_start: h.sourceRange.byteStart,
      source_range_end: h.sourceRange.byteEnd,
    }));
    if (citations.length === 0) {
      return;
    }
    const eventId = `retr-${createHash('sha256').update(`${input.runId}:${input.query}`).digest('hex').slice(0, 56)}`;
    const insert = (tx: Parameters<Parameters<DbService['withOrg']>[1]>[0]): Promise<unknown> =>
      tx
        .insert(runEvents)
        .values({
          id: uuidv7(),
          eventId,
          runId: input.runId,
          organizationId: input.orgId,
          eventType: '5',
          schemaVersion: 1,
          producerIdentity: 'engine:mcp-authority',
          payload: { case: 'retrieval', value: { citations }, redaction: 'NONE' } as never,
        })
        .onConflictDoNothing({ target: [runEvents.runId, runEvents.eventId] });
    if (input.tx) {
      await insert(input.tx);
      return;
    }
    await this.db.withOrg(input.orgId, insert);
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

  private async auditSafe(event: { action: string; resourceType: string; resourceId: string | null; tenantId: string; details: Record<string, unknown> }): Promise<void> {
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

/**
 * E-1 — snapshot pin allow-list for retrieval. Undefined when the snapshot
 * declares no pins (legacy org-wide posture preserved); otherwise the
 * resolved document_version ids ([] constrains to nothing — fail-closed).
 */
export function resolvedPinVersionIds(snapshot: { knowledgePins?: unknown } | null): string[] | undefined {
  const pins = snapshot?.knowledgePins;
  if (!Array.isArray(pins)) {
    return undefined;
  }
  return (pins as Array<{ resolved?: unknown; document_version_id?: unknown }>)
    .filter((p) => p?.resolved === true && typeof p?.document_version_id === 'string' && (p.document_version_id as string).length > 0)
    .map((p) => p.document_version_id as string);
}
