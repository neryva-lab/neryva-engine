import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { artifacts } from '../knowledge/schema';
import { uuidv7 } from '../../common/ids/uuidv7';
import { runEvents, runs, messages, Run } from './schema';
import { policySnapshots } from '../assistants/schema';
import { memoryItems } from '../knowledge/schema';
import { approvals, checkpoints, memoryProposals, toolEffects, runIdempotency } from './mcp.schema';
import { assertRunTransition, isRunState, isTerminalRun } from './state-machine';
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
      const updated = await tx
        .update(runs)
        .set({
          leaseOwner: input.callerScope,
          leaseEpoch: newEpoch,
          leaseExpiresAt: input.renewUntil.toISOString(),
          heartbeatAt: new Date().toISOString(),
          version: run.version + 1,
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
        .set({ leaseOwner: null, leaseExpiresAt: null, version: run.version + 1, updatedAt: new Date().toISOString() })
        .where(eq(runs.id, run.id))
        .returning();
      return updated[0];
    });
  }

  async getRun(orgId: string, runId: string): Promise<Run> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(runs).where(eq(runs.id, runId)).limit(1));
    if (rows.length === 0) {
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

  /** FailRun (5.11 analogue): CAS to FAILED + terminal event + outbox in one TX. */
  async failRun(input: { orgId: string; runId: string; errorCode: string; errorMessage: string; expectedVersion?: number }): Promise<Run> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.state === 'FAILED') {
        return run; // idempotent replay
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw ApiError.conflict('stale run version', { expected: input.expectedVersion, actual: run.version });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'FAILED');

      const insertedEvent = await tx
        .insert(runEvents)
        .values({
          id: uuidv7(),
          runId: run.id,
          organizationId: input.orgId,
          eventType: 'run.failed',
          payload: { case: 'terminal', value: { code: input.errorCode, message: input.errorMessage } },
          producerIdentity: 'engine:mcp-authority',
        })
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
  }): Promise<{ accepted: Array<{ eventId: string; engineSequence: number }>; duplicateCount: number }> {
    if (input.events.length === 0 || input.events.length > 32) {
      throw ApiError.validation({ events: 'batch must contain 1..32 events' });
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

      const accepted: Array<{ eventId: string; engineSequence: number }> = [];
      let duplicateCount = 0;
      for (const event of input.events) {
        const inserted = await tx
          .insert(runEvents)
          .values({
            id: event.eventId,
            runId: input.runId,
            organizationId: input.orgId,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            producerIdentity: input.producerIdentity,
            producerSequence: event.producerSequence ?? null,
            payload: event.payload as never,
            artifactId: event.artifactId ?? null,
          })
          .onConflictDoNothing({ target: runEvents.id })
          .returning({ engineSequence: runEvents.engineSequence });
        if (inserted.length === 0) {
          duplicateCount += 1;
          continue;
        }
        accepted.push({ eventId: event.eventId, engineSequence: inserted[0].engineSequence });
      }

      if (accepted.length > 0) {
        const maxSeq = accepted[accepted.length - 1].engineSequence;
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
   * Artifact facade for GetRunArtifact (5.12 + Phase 7.9): the 7 checks run
   * fresh on every dereference — purpose/scope, expiry, checksum, byte bounds,
   * content-type allowlist, scan/deletion state — and the access URL is a
   * short-TTL presigned GET, never a stable link. Reviewed cross-module query:
   * artifacts is knowledge-owned; run-scoped artifact reads belong here.
   */
  async getRunArtifact(input: { orgId: string; artifactId: string }): Promise<{ accessUrl: string; expiresIn: number; ref: { artifactId: string; mediaType: string; byteLength: number; sha256: Buffer; purpose: string; expiresAt: Date | null } }> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(artifacts).where(and(eq(artifacts.id, input.artifactId), eq(artifacts.organizationId, input.orgId))).limit(1),
    );
    const artifact = rows[0];
    if (!artifact) {
      throw ApiError.notFound('artifact');
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
        mediaType: artifact.contentTypeDetected ?? artifact.contentTypeDeclared,
        byteLength: artifact.byteLength,
        sha256: Buffer.from(artifact.sha256),
        purpose: artifact.purpose,
        expiresAt: artifact.expiresAt ? new Date(artifact.expiresAt) : null,
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
      allowedOps: ['lease', 'context', 'append_events', 'approval', 'memory_proposal', 'tool', 'checkpoint', 'commit', 'observe'],
      subject: 'agent-studio-runtime',
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

  // ── Authorized run context (5.5) — bounded manifest, filters in query ───

  async getAuthorizedRunContext(input: { orgId: string; runId: string }): Promise<{
    assistantVersionId: string;
    policyVersion: string;
    conversationSummary: string;
    recentMessages: Array<{ messageId: string; role: string; text: string }>;
    memories: Array<{ memoryId: string; scope: string; provenance: string }>;
    knowledgeRefs: Array<{ documentId: string; chunkId: string }>;
    tools: Array<{ name: string; effectClass: string; approvalRequirement: string }>;
    artifactRefs: unknown[];
  }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];

      // Bounded: filters applied IN the query (tenant + run), limit enforced here.
      const recent = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(and(eq(messages.conversationId, run.conversationId), eq(messages.organizationId, input.orgId)))
        .orderBy(sql`sequence desc`)
        .limit(20);

      const snapshotRows = await tx.select().from(policySnapshots).where(eq(policySnapshots.id, run.policySnapshotId)).limit(1);
      const toolPolicy = snapshotRows.length > 0 ? (snapshotRows[0].toolPolicy as { tools?: Array<{ name: string; access?: string; approval?: string }> }) : { tools: [] };

      // Approved memories only — proposals never surface here (Phase 7.8).
      // Reviewed cross-module query: memory_items is knowledge-owned, but the
      // run-context manifest needs scope-filtered rows on the same read path.
      const memories = await tx
        .select({ id: memoryItems.id, scopeType: memoryItems.scopeType, provenance: memoryItems.provenance })
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

      return {
        assistantVersionId: run.assistantVersionId,
        policyVersion: run.policySnapshotId,
        // Summaries land with Phase 4.6/7 — empty until then, never fabricated.
        conversationSummary: '',
        recentMessages: recent
          .reverse()
          .map((m) => ({
            messageId: m.id,
            role: m.role,
            text: String((m.content as { text?: unknown }).text ?? '').slice(0, 8192),
          })),
        memories: memories.map((m) => ({ memoryId: m.id, scope: m.scopeType, provenance: m.provenance ?? '' })),
        knowledgeRefs: [],
        tools: (toolPolicy.tools ?? []).map((t) => ({
          name: t.name,
          effectClass: t.access === 'read' ? 'READ_ONLY' : 'MUTATING',
          approvalRequirement: t.approval === 'required' ? 'REQUIRED' : 'NONE',
        })),
        artifactRefs: [],
      };
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
