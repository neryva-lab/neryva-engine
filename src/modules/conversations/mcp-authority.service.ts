import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { StorageService } from '../../common/infra/storage/storage.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { withSpan, setSpanAttributes, hashedAttr } from '../../common/observability/spans';
import type { Run } from './schema';
import { isRunState, isTerminalRun } from './state-machine';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import { QuotaService } from '../billing/quota.service';
import { EscalationsService } from './escalations.service';
import { issueCapability } from '../../common/auth/capability-token';
import { qualifyModelAliases } from '../../common/model-aliases';
import { isModelProvider } from '../assistants/provider-credentials.schema';
import { modelCatalogEntries } from '../assistants/model-catalog.schema';
import { ControlBlocksService } from '../assistants/control-blocks.service';
import { RetrievalService } from '../knowledge/retrieval.service';
import { spotlight, redactPii } from '../../common/guardrails';
import { envelopeDecrypt } from '../../common/infra/crypto/envelope';
import {
  RUN_LEASE_REPOSITORY,
  RUN_EVENTS_REPOSITORY,
  APPROVAL_REPOSITORY,
  TOOL_AUTHORITY_REPOSITORY,
  CHECKPOINT_REPOSITORY,
  ARTIFACT_REPOSITORY,
  RUN_CONTEXT_REPOSITORY,
  MEMORY_REPOSITORY,
  RUN_TERMINAL_REPOSITORY,
  CONVERSATION_REPOSITORY,
} from './repositories/repository-tokens';
import type { IRunLeaseRepository } from './repositories/run-lease.repository';
import type { IRunEventsRepository } from './repositories/run-events.repository';
import type { IApprovalRepository } from './repositories/approval.repository';
import type { IToolAuthorityRepository } from './repositories/tool-authority.repository';
import type { ICheckpointRepository } from './repositories/checkpoint.repository';
import type { IArtifactRepository } from './repositories/artifact.repository';
import type { IRunContextRepository } from './repositories/run-context.repository';
import type { IMemoryRepository } from './repositories/memory.repository';
import type { IRunTerminalRepository } from './repositories/run-terminal.repository';
import type { IConversationRepository } from './repositories/conversation.repository';

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
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly db: DbService, // Retained for model-catalog global read (outside conversations repository scope)
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly purge: RetentionPurgeService,
    private readonly retrieval: RetrievalService,
    private readonly escalations: EscalationsService,
    private readonly quota: QuotaService,
    @Inject(RUN_LEASE_REPOSITORY)
    private readonly runLease: IRunLeaseRepository,
    @Inject(RUN_EVENTS_REPOSITORY)
    private readonly runEventsRepo: IRunEventsRepository,
    @Inject(APPROVAL_REPOSITORY)
    private readonly approvalsRepo: IApprovalRepository,
    @Inject(TOOL_AUTHORITY_REPOSITORY)
    private readonly toolAuthority: IToolAuthorityRepository,
    @Inject(CHECKPOINT_REPOSITORY)
    private readonly checkpointsRepo: ICheckpointRepository,
    @Inject(ARTIFACT_REPOSITORY)
    private readonly artifactsRepo: IArtifactRepository,
    @Inject(RUN_CONTEXT_REPOSITORY)
    private readonly runContext: IRunContextRepository,
    @Inject(MEMORY_REPOSITORY)
    private readonly memory: IMemoryRepository,
    @Inject(RUN_TERMINAL_REPOSITORY)
    private readonly terminalRuns: IRunTerminalRepository,
    @Inject(CONVERSATION_REPOSITORY)
    private readonly conversationsRepo: IConversationRepository,
  ) {}

  /**
   * Drop the advisory Redis quota hold (W2.4 — the advisory plane mirrors
   * the durable reservation; a terminal run that never consumed a billable
   * event must return its hold). Best-effort: the spend ledger and the
   * durable reservation stay the billing truth, so a Redis hiccup here
   * must never fail the terminal transition — failures are logged (a
   * persistent Redis outage would otherwise hide counter drift until the
   * hourly reconcile notices). Caller must gate on `flipped` (only the
   * call that actually transitioned the run releases) so idempotent
   * replays never double-release the shared org counter.
   */
  private async releaseRunQuotaHold(orgId: string): Promise<void> {
    try {
      await this.quota.release({
        orgId,
        product: 'agents',
        units: 1,
        estimatedCostUsd: 0,
      });
    } catch (err) {
      // Advisory only — the hourly reconcile + TTL backstop resync the
      // counter; never fail the terminal transition over it.
      McpAuthorityService.logger.warn(
        `quota hold release failed (advisory, reconciled hourly): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Lease fencing (5.4) ─────────────────────────────────────────────────

  async acquireOrRenewRunLease(input: {
    orgId: string;
    runId: string;
    callerScope: string;
    expectedOwner: string | null;
    expectedEpoch: number;
    renewUntil: Date;
  }): Promise<{ run: Run; acquired: boolean; leaseEpoch: number }> {
    return this.runLease.acquireOrRenewRunLease(input);
  }

  async releaseRunLease(input: { orgId: string; runId: string; leaseEpoch: number }): Promise<Run> {
    return this.runLease.releaseRunLease(input);
  }

  async getRun(orgId: string, runId: string): Promise<Run> {
    const run = await this.terminalRuns.getRun(orgId, runId);
    if (!run) {
      // Distinguish a purged conversation from an unknown run (typed 410,
      // ledger 9.8 — CommitRunResult/GetRunContext fail closed on purged IDs).
      await this.purge.assertNotTombstoned('conversation', runId);
      await this.purge.assertNotTombstoned('run', runId);
      throw ApiError.notFound('run');
    }
    return run;
  }

  // ── Terminal transitions (5.11) — reuse the Phase 4 atomic paths ────────

  /**
   * Pre-flight CAS for CommitRunResult/FailRun `expected_version`. The atomic
   * core is delegated to ConversationsService (its own transaction); callers
   * re-read the run afterwards for the authoritative projection.
   */
  async assertExpectedVersion(
    orgId: string,
    runId: string,
    expectedVersion?: number,
  ): Promise<Run> {
    const run = await this.getRun(orgId, runId);
    if (
      expectedVersion !== undefined &&
      run.state !== 'COMPLETED' &&
      expectedVersion !== run.version
    ) {
      throw ApiError.conflict('stale run version', {
        expected: expectedVersion,
        actual: run.version,
      });
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
    const outcome = await this.terminalRuns.failRun(input);
    // W2.4 — the durable reservation released in-TX (REL-4.4); the advisory
    // Redis hold was never released here (proved by wave-4 failure injection:
    // the org events counter leaked +1 per FAILED run). Release after commit,
    // only when this call flipped the run — replays must not double-release.
    if (outcome.flipped && outcome.run.runKind === 'standard') {
      await this.releaseRunQuotaHold(input.orgId);
    }
    return outcome.run;
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
  }): Promise<{
    accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }>;
    duplicateCount: number;
  }> {
    if (input.events.length === 0 || input.events.length > 32) {
      throw ApiError.validation({ events: 'batch must contain 1..32 events' });
    }
    for (const event of input.events) {
      if (
        typeof event.eventId !== 'string' ||
        event.eventId.length < 1 ||
        event.eventId.length > 64
      ) {
        throw ApiError.validation({ events: 'event_id must be 1..64 chars' });
      }
    }
    return this.runEventsRepo.appendRunEvents(input);
  }

  async listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ) {
    return this.runEventsRepo.listRunEvents(orgId, runId, opts);
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
    return this.approvalsRepo.createApprovalRequest(input);
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
    const found = await this.terminalRuns.getRun(input.orgId, input.runId);
    if (!found) {
      throw ApiError.notFound('run');
    }
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
    const conv = await this.conversationsRepo.getConversation(input.orgId, found.conversationId);
    await this.auditSafe({
      action: 'mcp.human_handoff_requested',
      resourceType: 'escalation',
      resourceId: escalation.id,
      tenantId: input.orgId,
      details: {
        run_id: input.runId,
        conversation_id: found.conversationId,
        note_len: input.note?.length ?? 0,
      },
    });
    return {
      escalationId: escalation.id,
      state: escalation.state,
      conversationStatus: conv?.status ?? 'unknown',
    };
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
      throw ApiError.validation({
        data: `artifact data exceeds the ${bounds.comment} bound for ${input.purpose}`,
      });
    }
    if (
      input.purpose === 'GENERATED_MEDIA' &&
      !['image/png', 'image/jpeg', 'image/webp'].includes(input.mediaType)
    ) {
      throw ApiError.validation({
        media_type: 'GENERATED_MEDIA must be image/png, image/jpeg or image/webp',
      });
    }
    const artifactId = uuidv7();
    const objectKey = `org/${input.orgId}/${input.purpose.toLowerCase()}/${artifactId}.bin`;
    this.storage.assertTenantKey(objectKey, input.orgId);
    await this.storage.putObject({
      key: objectKey,
      contentType: input.mediaType,
      body: input.data,
    });
    const sha256 = createHash('sha256').update(input.data).digest();
    await this.artifactsRepo.registerArtifact({
      orgId: input.orgId,
      artifactId,
      purpose: input.purpose,
      objectKey,
      mediaType: input.mediaType,
      byteLength: input.data.byteLength,
      sha256,
    });
    return { artifactId, sha256, byteLength: input.data.byteLength };
  }

  /**
   * GetToolCredential (contract v1.3, FL-2.10) — scoped disclosure of a
   * tool's customer-endpoint credential. The tool must be pinned on the
   * run's policy snapshot AND present in the org catalog with a bound
   * credential; disclosure is audited and never flows through the manifest.
   */
  async getToolCredential(input: {
    orgId: string;
    runId: string;
    toolName: string;
  }): Promise<{ credential: string; credentialHeader: string }> {
    // REL-1.4 (release_ledger.md): model-provider keys ride the SAME audited
    // disclosure rail as tool credentials — the gateway asks for the
    // pseudo-tool `model:<provider>`. The repository handles the
    // `model:<provider>` branch (gating on the run's model manifest,
    // capability kill-switch, org enablement, and active credential).
    // No contract change: GetToolCredential already carries (credential,
    // credential_header) and the capability scope check happened at the
    // transport boundary.
    if (input.toolName.startsWith('model:')) {
      const provider = input.toolName.slice('model:'.length);
      if (!isModelProvider(provider)) {
        throw ApiError.validation({ tool_name: `unknown model provider: ${provider}` });
      }
    }
    const outcome = await this.toolAuthority.getToolCredential(input);
    // Replay the repository's audit trail (best-effort — audit failures
    // must not fail the credential disclosure).
    for (const event of outcome.auditTrail) {
      await this.auditSafe(event);
    }
    if (outcome.outcome === 'denied') {
      throw ApiError.forbidden(outcome.reason, { tool_name: input.toolName });
    }
    if (outcome.outcome === 'empty') {
      return { credential: '', credentialHeader: 'authorization' };
    }
    return {
      credential: envelopeDecrypt(outcome.credentialSealed),
      credentialHeader: outcome.credentialHeader,
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
  /** GetLatestCheckpoint (contract v1.3, FL-2.17) — newest run checkpoint. */
  async getLatestCheckpoint(input: { orgId: string; runId: string }): Promise<{
    checkpointRef: string;
    checkpointVersion: number;
    artifact?: {
      artifactId: string;
      mediaType: string;
      byteLength: number;
      sha256: Buffer;
      purpose: string;
    };
  } | null> {
    return this.checkpointsRepo.getLatestCheckpoint(input);
  }

  async getApprovalState(input: { orgId: string; runId: string; approvalRef: string }): Promise<{
    found: boolean;
    approvalId?: string;
    state: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'NOT_FOUND';
    decisionId?: string;
    decidedBy?: string;
    decidedAt?: string;
  }> {
    return this.approvalsRepo.getApprovalState(input);
  }

  async decideApproval(input: {
    orgId: string;
    runId: string;
    approvalId: string;
    decision: 'APPROVED' | 'DENIED';
    actor: string;
    reason?: string;
  }): Promise<{
    approvalId: string;
    state: 'APPROVED' | 'DENIED' | 'PENDING';
    runState: string;
    replay: boolean;
  }> {
    const outcome = await this.approvalsRepo.decideApproval(input);
    // Replay the repository's audit trail (best-effort).
    for (const event of outcome.auditTrail) {
      await this.auditSafe(event);
    }
    // W2.4 — the denial path previously leaked both the durable reservation
    // and the advisory Redis hold (proved by wave-4 approval-denial injection:
    // a DENIED run left its quota hold behind). The durable release above
    // rides the TX; the advisory release runs after commit.
    if (!outcome.replay && outcome.runState === 'CANCELED' && outcome.runKind === 'standard') {
      await this.releaseRunQuotaHold(input.orgId);
    }
    // runKind is internal quota-plane routing — strip it so the HTTP
    // response carries exactly the declared shape (TS types do not strip
    // extra runtime properties).
    return {
      approvalId: outcome.approvalId,
      state: outcome.state,
      runState: outcome.runState,
      replay: outcome.replay,
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
   * - Durable RESERVED quota for the run → RELEASED; Redis advisory hold
   *   released after commit.
   * - One transactional `run.canceled` outbox event per terminalized run.
   * - Sibling PENDING approvals on a terminalized run also expire.
   *
   * Idempotent: re-running on an already-swept org is a no-op (claims only
   * fire on still-PENDING rows).
   */
  async sweepExpiredApprovals(input: {
    orgId: string;
    batchSize?: number;
  }): Promise<{
    sweptApprovals: Array<{ approvalId: string; runId: string; runTerminalized: boolean }>;
    canceledRuns: Array<{ runId: string }>;
  }> {
    const outcome = await this.approvalsRepo.sweepExpiredApprovals(input.orgId, input.batchSize);
    // Replay the repository's audit trail (best-effort).
    for (const event of outcome.auditTrail) {
      await this.auditSafe(event);
    }
    // Advisory Redis quota-hold releases (best-effort, one per claimed approval).
    for (let i = 0; i < outcome.quotaHoldReleases; i++) {
      await this.releaseRunQuotaHold(input.orgId);
    }
    return {
      sweptApprovals: outcome.sweptApprovals,
      canceledRuns: outcome.canceledRuns,
    };
  }

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
    return this.memory.submitMemoryProposal(input);
  }

  async authorizeToolCall(input: {
    orgId: string;
    runId: string;
    stepId?: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    argumentDigest: Buffer;
  }): Promise<{
    allowed: boolean;
    reason?: string;
    toolCapability?: string;
    approvalRequired: boolean;
    duplicate: boolean;
    /**
     * P4: true when the pinned binding runs in shadow mode (simulate, never
     * execute). The Studio runtime consumes this (contract pointer — the MCP
     * AuthorizeToolCall response gains the field when the contract revs);
     * engine records + audits the mode on every authorization either way.
     */
    shadow: boolean;
  }> {
    // P1 (§6a) — tool.authorization span. Deny reasons are operator free
    // text: recorded as a hash (attribute law), never raw. The inner body is
    // untouched — outcome attributes attach at the withOrg boundary.
    return withSpan(
      'tool.authorization',
      { org_id: input.orgId, run_id: input.runId, tool_name: input.toolName },
      async (span) => {
        const outcome = await this.toolAuthority.authorizeToolCall(input);
        // Replay the repository's audit trail (best-effort).
        for (const event of outcome.auditTrail) {
          await this.auditSafe(event);
        }
        setSpanAttributes(span, {
          allowed: outcome.allowed,
          duplicate: outcome.duplicate,
          approval_required: outcome.approvalRequired,
          shadow: outcome.shadow,
          reason_hash: outcome.allowed || !outcome.reason ? null : hashedAttr(outcome.reason),
        });
        return outcome;
      },
    );
  }

  async recordToolOutcome(input: {
    orgId: string;
    toolCallId: string;
    resultDigest?: Buffer;
    status: string;
    resultArtifactId?: string;
  }): Promise<{ accepted: boolean; wasDuplicate: boolean }> {
    return this.toolAuthority.recordToolOutcome(input);
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
    return this.checkpointsRepo.saveCheckpointRef(input);
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
    ref: {
      artifactId: string;
      uri: string;
      mediaType: string;
      byteLength: number;
      sha256: Buffer;
      purpose: string;
      encryptionKeyId: string;
      expiresAt: string;
    };
  }> {
    const MCP_READ_PURPOSES = new Set(['checkpoint', 'tool_result', 'source_document']);
    await this.getRun(input.orgId, input.runId); // fail-closed on purged/tombstoned runs
    const { artifact, bound } = await this.artifactsRepo.findRunArtifact({
      orgId: input.orgId,
      runId: input.runId,
      artifactId: input.artifactId,
    });
    if (!artifact) {
      throw ApiError.notFound('artifact');
    }
    // Run-scope binding: checkpoints / tool_effects / run_events of THIS run.
    if (!bound) {
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
        mediaType: artifact.contentTypeDetected ?? artifact.contentTypeDeclared ?? 'application/octet-stream',
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
  async mintRunCapability(input: {
    orgId: string;
    runId: string;
    actor: string;
  }): Promise<{ token: string; capabilityId: string; expiresAt: Date }> {
    const run = await this.getRun(input.orgId, input.runId);
    const issued = issueCapability({
      organizationId: input.orgId,
      conversationId: run.conversationId,
      runId: run.id,
      assistantVersionId: run.assistantVersionId,
      policyVersion: run.policySnapshotId,
      allowedOps: [
        'lease',
        'context',
        'search_knowledge',
        'append_events',
        'approval',
        'memory_proposal',
        'tool',
        'checkpoint',
        'commit',
        'observe',
        'escalation',
        'artifact',
      ],
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
  /**
   * P2 (overflow routing): alias → catalog context window. GLOBAL table, so
   * a root read with no tenant context (documented posture, like the
   * template registry). Only `active` entries answer; anything else is null
   * (unknown — Studio treats null as "no window truth", never as room).
   * Failure falls back to all-null (advisory data must never fail context
   * assembly — the run proceeds with aliases only, exactly as before P2).
   */
  /**
   * Active platform model catalog rows (identity + context windows). This is
   * a root read with no tenant context (documented posture, like the
   * template registry). Empty on failure: model identity and window data are
   * advisory and must never fail context assembly — the run proceeds with
   * aliases only.
   */
  private async activeModelCatalogRows(): Promise<
    Array<{ provider: string; modelId: string; window: number | null }>
  > {
    try {
      return await this.db.root
        .select({
          provider: modelCatalogEntries.provider,
          modelId: modelCatalogEntries.modelId,
          window: modelCatalogEntries.contextWindowTokens,
        })
        .from(modelCatalogEntries)
        .where(eq(modelCatalogEntries.status, 'active'));
    } catch (err) {
      McpAuthorityService.logger.warn(
        `model catalog unavailable, aliases unresolved: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Per-alias context windows from the platform catalog. Keyed by the same
   * (qualified) references carried in `allowed_models`, so Studio's pre-call
   * overflow check reads them with the identical key. Aliases with no catalog
   * entry map to null (unknown, never zero — zero would look like a real
   * 0-token window).
   */
  private resolveModelWindows(
    aliases: string[],
    rows: Array<{ provider: string; modelId: string; window: number | null }>,
  ): Record<string, number | null> {
    const windows: Record<string, number | null> = {};
    for (const alias of aliases) {
      windows[alias] = null;
    }
    const byQualified = new Map(rows.map((r) => [`${r.provider}/${r.modelId}`, r.window]));
    for (const alias of aliases) {
      if (byQualified.has(alias)) {
        windows[alias] = byQualified.get(alias) ?? null;
      }
    }
    return windows;
  }

  async getAuthorizedRunContext(input: { orgId: string; runId: string }): Promise<{
    assistantVersionId: string;
    policyVersion: string;
    /** A4-82: the run actor's account id (null for service/channel triggers). Lets the runtime worker match user-scoped memories without guessing. */
    runUserId: string | null;
    conversationSummary: string;
    recentMessages: Array<{ messageId: string; role: string; text: string }>;
    memories: Array<{
      memoryId: string;
      scope: string;
      scopeId?: string;
      provenance: string;
      content?: string;
      contentMediaType?: string;
    }>;
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
      annotations?: {
        readOnly: boolean;
        destructive: boolean;
        idempotent: boolean;
        openWorld: boolean;
      };
    }>;
    artifactRefs: unknown[];
    instructions?: string;
    allowedModels: string[];
    /**
     * P2 (overflow routing): alias → context window in tokens, null when the
     * platform catalog carries no window for the alias. Studio's pre-call
     * overflow check reads this — it is advisory sizing truth, not policy.
     */
    modelWindows: Record<string, number | null>;
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
    /**
     * FL-1.4: pinned guardrail policy strings — Studio resolves moderation behavior.
     * P3: executionMode travels with them (Studio enforces blocking vs logging).
     */
    guardrailPolicy: {
      inputPolicy: string;
      outputPolicy: string;
      piiRedaction: boolean;
      /** P3: blocking | logging — Studio enforces; legacy snapshots resolve blocking. */
      executionMode: 'blocking' | 'logging';
    };
    /**
     * G4: pinned brand voice, verbatim from the snapshot (null when the
     * version declares none). The served `instructions` already compose it
     * (see composeSystemPrompt) — this field exists so Studio, eval
     * provenance, and auditors can read the voice separately from the
     * prompt without parsing delimiters.
     */
    brandVoice?: string;
  }> {
    // P1 §6a: run.context span. The guardrail policy observation rides it
    // (policy identifiers only — verdicts are Studio-resolved; see the
    // execution_mode contract in validation.ts).
    return withSpan('run.context', { org_id: input.orgId, run_id: input.runId }, async (span) => {
      const assembled = await this.runContext.assembleRunContext(
        { orgId: input.orgId, runId: input.runId },
        {
          searchApprovedMemories: (hookInput) =>
            this.retrieval.searchApprovedMemories(hookInput),
          searchKnowledge: async (hookInput) => {
            const hits = await this.searchKnowledge({
              orgId: hookInput.orgId,
              runId: input.runId,
              query: hookInput.query,
              maxResults: hookInput.limit,
            });
            // Adapt service shape to repository KnowledgeHitRow
            return hits.map((h) => ({
              documentId: h.documentId,
              chunkId: h.chunkId,
              text: h.snippet,
              title: h.title ?? null,
              score: h.score,
              sourceRange: {
                byteStart: h.sourceRangeStart,
                byteEnd: h.sourceRangeEnd,
              },
            }));
          },
        },
      );
      return assembled;
    });
  }

  /**
   * Agentic mid-run retrieval (contract v1.1 SearchKnowledge). Same
   * authorization path as manifest assembly: RetrievalService applies
   * ACL-before-scoring in the query. Results are spotlighted + bounded.
   */
  async searchKnowledge(input: {
    orgId: string;
    runId: string;
    query: string;
    maxResults: number;
  }): Promise<
    Array<{
      documentId: string;
      chunkId: string;
      snippet: string;
      title?: string;
      score: number;
      sourceRangeStart: number;
      sourceRangeEnd: number;
    }>
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
  private static resolvedPinVersionIds(
    snapshot: { knowledgePins?: unknown } | null,
  ): string[] | undefined {
    return resolvedPinVersionIds(snapshot);
  }

  /** E-1 — run-scoped pin lookup for the agentic SearchKnowledge path. */
  private async pinnedVersionIdsForRun(
    orgId: string,
    runId: string,
  ): Promise<string[] | undefined> {
    return this.runContext.pinnedVersionIdsForRun(orgId, runId);
  }

  /** P0-1 — run actor account for source-ACL matching (trigger author iff an account id). */
  private async runActorAccountId(orgId: string, runId: string): Promise<string | null> {
    return this.runContext.runActorAccountId(orgId, runId);
  }

  /**
   * FL-2.9 — durable retrieval event (wire EVENT_TYPE_RETRIEVAL → stored
   * '5', payload {case:'retrieval', value:{citations}}). eventId is
   * deterministic per (run, query) so a re-driven context assembly dedups;
   * the payload mirrors the transport's {case, value, redaction} envelope.
   */
  private async recordRetrievalEvent(input: {
    orgId: string;
    runId: string;
    query: string;
    hits: Array<{
      documentId: string;
      chunkId: string;
      sourceRange: { byteStart: number; byteEnd: number };
    }>;
  }): Promise<void> {
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
    await this.runEventsRepo.appendRunEvents({
      orgId: input.orgId,
      runId: input.runId,
      producerIdentity: 'engine:mcp-authority',
      events: [
        {
          eventId,
          eventType: '5',
          schemaVersion: 1,
          payload: { case: 'retrieval', value: { citations } },
        },
      ],
    });
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
    return this.conversationsRepo.saveConversationSummary({
      orgId: input.orgId,
      conversationId: input.conversationId,
      sourceSequence: input.sourceSequence,
      summary,
      tokenCount: input.tokenCount,
      modelId: input.modelId,
      callerScope: input.callerScope,
      idempotencyKey: input.idempotencyKey,
    });
  }

  // ── Run idempotency (run-scoped helper for callers that need it) ────────


  private async auditSafe(event: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    tenantId: string;
    details: Record<string, unknown>;
  }): Promise<void> {
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
      McpAuthorityService.logger.warn(
        `audit write failed for ${event.action}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * E-1 — snapshot pin allow-list for retrieval. Undefined when the snapshot
 * declares no pins (legacy org-wide posture preserved); otherwise the
 * resolved document_version ids ([] constrains to nothing — fail-closed).
 */
export function resolvedPinVersionIds(
  snapshot: { knowledgePins?: unknown } | null,
): string[] | undefined {
  const pins = snapshot?.knowledgePins;
  if (!Array.isArray(pins)) {
    return undefined;
  }
  return (pins as Array<{ resolved?: unknown; document_version_id?: unknown }>)
    .filter(
      (p) =>
        p?.resolved === true &&
        typeof p?.document_version_id === 'string' &&
        (p.document_version_id as string).length > 0,
    )
    .map((p) => p.document_version_id as string);
}

/**
 * G4 (customer-setup-review.md) — brand voice composition. The pinned
 * brand block is appended to the pinned instructions under a STABLE
 * delimiter both makers and auditors can recognize (and the manifest
 * carries brandVoice separately so nobody must parse it back out).
 * Blank/absent brand returns instructions untouched — no phantom blocks,
 * no trailing whitespace games. Pure — unit-tested.
 */
export function composeSystemPrompt(
  instructions: string | null,
  brand: string | null,
): string | undefined {
  const prompt =
    typeof instructions === 'string' && instructions.trim() !== '' ? instructions : null;
  const voice = typeof brand === 'string' && brand.trim() !== '' ? brand.trim() : null;
  if (!prompt && !voice) {
    return undefined;
  }
  if (!voice) {
    return prompt as string;
  }
  if (!prompt) {
    return `Brand voice: ${voice}`;
  }
  return `${prompt}\n\nBrand voice: ${voice}`;
}
