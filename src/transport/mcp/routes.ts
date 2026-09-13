import { ConnectRouter, HandlerContext, Code, ConnectError } from '@connectrpc/connect';
import { createHash } from 'node:crypto';
import { toJson, type DescMessage } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import {
  RunAuthorityService,
  RunObservationService,
  EventType,
  RedactionClass,
  ApprovalState,
  ApprovalRequestSchema,
  PageResponseSchema,
  LifecycleBodySchema,
  AssistantChunkBodySchema,
  ToolCallBodySchema,
  ToolResultBodySchema,
  TerminalBodySchema,
  ArtifactBodySchema,
  ModelBodySchema,
  RetrievalBodySchema,
  ApprovalBodySchema,
  MemoryBodySchema,
  CheckpointBodySchema,
  PolicyBodySchema,
  UsageBodySchema,
  MediaBodySchema,
  type RequestContext,
  type AcquireOrRenewRunLeaseRequest,
  type ReleaseRunLeaseRequest,
  type GetRunRequest,
  type CommitRunResultRequest,
  type FailRunRequest,
  type GetAuthorizedRunContextRequest,
  type SearchKnowledgeRequest,
  type SaveConversationSummaryRequest,
  type CreateApprovalRequest,
  type GetApprovalStateRequest,
  type RequestHumanHandoffRequest,
  type PutRunArtifactRequest,
  type GetLatestCheckpointRequest,
  type GetToolCredentialRequest,
  type SubmitMemoryProposalRequest,
  type AuthorizeToolCallRequest,
  type RecordToolOutcomeRequest,
  type SaveCheckpointRequest,
  type ListRunEventsRequest,
  type WatchRunEventsRequest,
  type GetRunArtifactRequest,
} from '@neryva/mcp-contract';
import { env } from '../../common/config/env';
import { assertCapabilityFor, CapabilityOp } from '../../common/auth/capability-token';
import { isTerminalRun } from '../../modules/conversations/state-machine';
import { McpAuthorityService } from '../../modules/conversations/mcp-authority.service';
import { ConversationsService } from '../../modules/conversations/conversations.service';
import {
  connectHandler,
  toWireRun,
  toWireRunEvent,
  toTimestamp,
  wireEventTypeToStore,
  wireApprovalRequirement,
  toWireRunEventFromRequest,
} from './mapper';

/**
 * Connect route registration for the Engine authority surface (ledger 5.1).
 * Every mutating RPC carries a RequestContext; every handler validates the
 * run-scoped capability token against that context (signature, expiry,
 * audience, op, then exact scope match — a mismatch is an error, never a
 * repair). Handlers never touch SQL.
 */

const BODY_SCHEMAS: Record<string, DescMessage> = {
  lifecycle: LifecycleBodySchema,
  assistantChunk: AssistantChunkBodySchema,
  toolCall: ToolCallBodySchema,
  toolResult: ToolResultBodySchema,
  terminal: TerminalBodySchema,
  artifact: ArtifactBodySchema,
  model: ModelBodySchema,
  retrieval: RetrievalBodySchema,
  approval: ApprovalBodySchema,
  memory: MemoryBodySchema,
  checkpoint: CheckpointBodySchema,
  policy: PolicyBodySchema,
  usage: UsageBodySchema,
  media: MediaBodySchema,
};

interface CtxFields {
  organizationId: string;
  conversationId: string;
  runId: string;
  actorId: string;
  idempotencyKey: string;
  capabilityId: string;
}

function readCtx(ctx: RequestContext | undefined): CtxFields {
  const organizationId = ctx?.organizationId ?? '';
  const conversationId = ctx?.conversationId ?? '';
  const runId = ctx?.runId ?? '';
  const actorId = ctx?.actorId ?? '';
  const idempotencyKey = ctx?.idempotencyKey ?? '';
  const capabilityId = ctx?.capabilityId ?? '';
  if (!organizationId || !conversationId || !runId || !actorId || !idempotencyKey || !capabilityId) {
    throw new ConnectError(
      'request context is incomplete (organization, conversation, run, actor, idempotency key, capability id are required)',
      Code.InvalidArgument,
    );
  }
  return { organizationId, conversationId, runId, actorId, idempotencyKey, capabilityId };
}

function capabilityToken(context: HandlerContext): string | undefined {
  const header = context.requestHeader.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '') || undefined;
}

function assertCapability(
  context: HandlerContext,
  op: CapabilityOp,
  scope: { organizationId: string; conversationId?: string; runId?: string },
  capabilityId?: string,
): ReturnType<typeof assertCapabilityFor> {
  try {
    const claims = assertCapabilityFor(capabilityToken(context), op, scope);
    // common.proto RequestContext.capability_id binds the request to the
    // presented token (kid/nonce binding) — a mismatch is a scope-confusion
    // attempt, never a repair (ledger 5.3 interceptor chain).
    if (capabilityId && claims.capability_id !== capabilityId) {
      throw new Error('request context capability_id does not match the presented capability token');
    }
    return claims;
  } catch (err) {
    throw new ConnectError((err as Error).message, Code.PermissionDenied);
  }
}

/**
 * proto3 implicit presence: an OMITTED uint64 arrives as 0n. The contract
 * treats expected_version = 0 as "no CAS" (matches the AppendRunEvents
 * convention); coercing it to a numeric 0 would fail every CAS.
 */
function optionalUint64(v: bigint | undefined): number | undefined {
  return v !== undefined && v > 0n ? Number(v) : undefined;
}

function assertDigest32(digest: Uint8Array | undefined, what: string): Buffer {
  const buf = Buffer.from(digest ?? new Uint8Array());
  // common.proto: "Exactly 32 bytes; validated at schema boundary."
  if (buf.length !== 32) {
    throw new ConnectError(`${what} must be exactly 32 bytes`, Code.InvalidArgument);
  }
  return buf;
}

function tsToDate(ts: { seconds: bigint; nanos?: number } | undefined): Date {
  if (!ts) {
    throw new ConnectError('missing timestamp', Code.InvalidArgument);
  }
  return new Date(Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface McpRouteDeps {
  authority: McpAuthorityService;
  conversations: ConversationsService;
}

export function registerMcpRoutes(router: ConnectRouter, deps: McpRouteDeps): void {
  const { authority, conversations } = deps;

  router.service(RunAuthorityService, {
    // 5.4 — lease fencing with CAS on lease_epoch (lease state lives on the runs row).
    acquireOrRenewRunLease: connectHandler(async (req: AcquireOrRenewRunLeaseRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'lease', c, c.capabilityId);
      const renewUntil = req.renewUntil ? tsToDate(req.renewUntil) : new Date(Date.now() + 60_000);
      const result = await authority.acquireOrRenewRunLease({
        orgId: c.organizationId,
        runId: c.runId,
        callerScope: `agent-studio:${c.actorId}`,
        expectedOwner: req.expectedLeaseOwner || null,
        expectedEpoch: Number(req.expectedLeaseEpoch ?? 0n),
        renewUntil,
      });
      return { run: toWireRun(result.run), acquired: result.acquired };
    }),

    releaseRunLease: connectHandler(async (req: ReleaseRunLeaseRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'lease', c, c.capabilityId);
      const run = await authority.releaseRunLease({ orgId: c.organizationId, runId: c.runId, leaseEpoch: Number(req.leaseEpoch ?? 0n) });
      return { run: toWireRun(run) };
    }),

    getRun: connectHandler(async (req: GetRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c, c.capabilityId);
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run) };
    }),

    // 5.11 — terminal atomicity: delegates to the Phase 4 atomic commit.
    // expected_version CAS + lease-epoch fencing run INSIDE the commit TX.
    commitRunResult: connectHandler(async (req: CommitRunResultRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      const claims = assertCapability(context, 'commit', c, c.capabilityId);
      if (req.resultArtifact) {
        throw new ConnectError('result_artifact claim-check lands with Phase 7 artifacts', Code.Unimplemented);
      }
      const text = (req.resultText ?? '').trim();
      if (!text) {
        throw new ConnectError('result_text is required', Code.InvalidArgument);
      }
      const result = await conversations.commitRunResult({
        orgId: c.organizationId,
        runId: c.runId,
        content: { text },
        actor: 'agent-studio-runtime',
        expectedVersion: optionalUint64(req.expectedVersion),
        leaseEpoch: claims.lease_epoch,
        usage: req.usage
          ? {
              provider: req.usage.provider || 'unknown',
              model: req.usage.model || 'unknown',
              promptTokens: Number(req.usage.promptTokens ?? 0n),
              completionTokens: Number(req.usage.completionTokens ?? 0n),
              totalTokens: Number(req.usage.totalTokens ?? 0n),
            }
          : undefined,
        // v1.2 (FL-3.4) — bounded follow-ups recorded with the terminal commit.
        ...(req.suggestedFollowups && req.suggestedFollowups.length > 0
          ? { suggestedFollowups: [...req.suggestedFollowups] }
          : {}),
      });
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run), messageId: result.message_id };
    }),

    failRun: connectHandler(async (req: FailRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      const claims = assertCapability(context, 'commit', c, c.capabilityId);
      const run = await authority.failRun({
        orgId: c.organizationId,
        runId: c.runId,
        errorCode: req.errorCode || 'studio_error',
        errorMessage: (req.errorMessage ?? '').slice(0, 1024),
        expectedVersion: optionalUint64(req.expectedVersion),
        leaseEpoch: claims.lease_epoch,
      });
      return { run: toWireRun(run) };
    }),

    // 5.6 — bounded batch, (run_id, event_id) dedup, engine_sequence authoritative.
    appendRunEvents: connectHandler(async (req: { ctx?: RequestContext; events?: Array<Record<string, unknown>> }, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      const claims = assertCapability(context, 'append_events', c, c.capabilityId);
      const events = req.events ?? [];
      if (events.length === 0 || events.length > 32) {
        throw new ConnectError('events batch must contain 1..32 events', Code.InvalidArgument);
      }
      const mapped = events.map((ev) => {
        const body = ev.body as { case: string; value: unknown } | undefined;
        const schema = body?.case ? BODY_SCHEMAS[body.case] : undefined;
        if (!body || !schema) {
          throw new ConnectError(`event ${String(ev.eventId)} has no known body`, Code.InvalidArgument);
        }
        return {
          eventId: String(ev.eventId ?? ''),
          eventType: wireEventTypeToStore(ev.type as EventType),
          schemaVersion: Number(ev.schemaVersion) || 1,
          producerSequence: ev.producerSequence !== undefined ? Number(ev.producerSequence) : undefined,
          payload: { case: body.case, value: toJson(schema, body.value as never) as unknown, redaction: ev.redaction as RedactionClass },
        };
      });
      const result = await authority.appendRunEvents({
        orgId: c.organizationId,
        runId: c.runId,
        producerIdentity: `agent-studio:${c.actorId}`,
        events: mapped,
        // Batch CAS + request-level idempotency are evaluated inside the
        // authority transaction (the old pre-flight read was a TOCTOU gap).
        expectedRunVersion: events.reduce<number | undefined>((acc, ev) => {
          const expected = ev.expectedRunVersion;
          return typeof expected === 'bigint' && expected > 0n ? Number(expected) : acc;
        }, undefined),
        idempotency: {
          callerScope: `agent-studio:${c.actorId}`,
          idempotencyKey: c.idempotencyKey,
          requestHash: createHash('sha256')
            .update(JSON.stringify({ run: c.runId, events: mapped.map((m) => [m.eventId, m.eventType, m.schemaVersion]) }))
            .digest('hex'),
        },
        leaseEpoch: claims.lease_epoch,
      });
      const byId = new Map(result.accepted.map((a) => [a.eventId, a]));
      const accepted = events.map((ev) =>
        toWireRunEventFromRequest(ev, c.runId, `agent-studio:${c.actorId}`, byId.get(String(ev.eventId))?.engineSequence ?? 0),
      );
      return { accepted, duplicateCount: result.duplicateCount };
    }),

    // 5.5 — bounded manifest, filters applied in query, never after.
    getAuthorizedRunContext: connectHandler(async (req: GetAuthorizedRunContextRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'context', c, c.capabilityId);
      void req.requestedPurposes; // knowledge purposes filter activates with Phase 7 retrieval
      const manifest = await authority.getAuthorizedRunContext({ orgId: c.organizationId, runId: c.runId });
      // PlainMessage-compatible — the authority service returns the exact wire shape.
      return { manifest: manifest as never };
    }),

    // v1.1 — agentic mid-run retrieval, same ACL-before-scoring path.
    searchKnowledge: connectHandler(async (req: SearchKnowledgeRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'search_knowledge', c, c.capabilityId);
      const results = await authority.searchKnowledge({
        orgId: c.organizationId,
        runId: c.runId,
        query: req.query || '',
        maxResults: Number(req.maxResults ?? 5),
      });
      return {
        results: results.map((r) => ({
          documentId: r.documentId,
          chunkId: r.chunkId,
          snippet: r.snippet,
          title: r.title,
          score: r.score,
          sourceRangeStart: r.sourceRangeStart,
          sourceRangeEnd: r.sourceRangeEnd,
        })),
      };
    }),

    // v1.1 — Studio-produced conversation compaction persisted as truth.
    saveConversationSummary: connectHandler(async (req: SaveConversationSummaryRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'context', c, c.capabilityId);
      if (!req.summary) {
        throw new ConnectError('summary is required', Code.InvalidArgument);
      }
      const result = await authority.saveConversationSummary({
        orgId: c.organizationId,
        conversationId: c.conversationId,
        sourceSequence: Number(req.sourceSequence ?? 0n),
        summary: req.summary,
        tokenCount: Number(req.tokenCount ?? 0),
        modelId: req.modelId || undefined,
        callerScope: `agent-studio:${c.actorId}`,
        idempotencyKey: `summary:${c.conversationId}:${Number(req.sourceSequence ?? 0n)}`,
      });
      return { summaryId: result.summaryId, wasDuplicate: result.duplicate };
    }),

    // 5.7 — approvals persist WAITING_APPROVAL and emit an outbox event.
    createApprovalRequest: connectHandler(async (req: CreateApprovalRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'approval', c, c.capabilityId);
      const approval = req.approval;
      if (!approval?.approvalId || !approval.summary) {
        throw new ConnectError('approval.approval_id and approval.summary are required', Code.InvalidArgument);
      }
      const expiresAt = approval.expiresAt ? tsToDate(approval.expiresAt) : new Date(Date.now() + 15 * 60_000);
      await authority.createApprovalRequest({
        orgId: c.organizationId,
        runId: c.runId,
        approvalRef: approval.approvalId,
        summary: approval.summary.slice(0, 512),
        actionType: approval.actionType || undefined,
        policyVersion: approval.policyVersion || undefined,
        expiresAt,
        callerScope: `agent-studio:${c.actorId}`,
      });
      return {
        approval: create(ApprovalRequestSchema, {
          approvalId: approval.approvalId,
          organizationId: c.organizationId,
          runId: c.runId,
          summary: approval.summary.slice(0, 512),
          actionType: approval.actionType ?? '',
          policyVersion: approval.policyVersion ?? '',
          state: ApprovalState.PENDING,
          expiresAt: toTimestamp(expiresAt.toISOString())!,
        }),
      };
    }),

    // v1.3 — claim-check write (FL-2.13/2.17): bounded checkpoint/tool-result
    // artifacts through the Engine; returns the claim-check ref.
    putRunArtifact: connectHandler(async (req: PutRunArtifactRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'artifact', c, c.capabilityId);
      const purpose =
        req.purpose === 'CHECKPOINT' || req.purpose === 'TOOL_RESULT' || req.purpose === 'GENERATED_MEDIA' ? req.purpose : '';
      if (!purpose) {
        throw new ConnectError('purpose must be CHECKPOINT, TOOL_RESULT or GENERATED_MEDIA', Code.InvalidArgument);
      }
      if (!req.mediaType) {
        throw new ConnectError('media_type is required', Code.InvalidArgument);
      }
      const result = await authority.putRunArtifact({
        orgId: c.organizationId,
        runId: c.runId,
        purpose,
        mediaType: req.mediaType,
        data: Buffer.from(req.data ?? new Uint8Array()),
      });
      return {
        artifact: {
          artifactId: result.artifactId,
          uri: `neryva-mcp://org/${c.organizationId}/artifact/${result.artifactId}`,
          purpose,
          mediaType: req.mediaType,
          byteLength: BigInt(result.byteLength),
          sha256: new Uint8Array(result.sha256),
          encryptionKeyId: '',
        },
      };
    }),

    // v1.3 — scoped tool-credential disclosure for the HTTP executor (FL-2.10).
    getToolCredential: connectHandler(async (req: GetToolCredentialRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'tool', c, c.capabilityId);
      if (!req.toolName) {
        throw new ConnectError('tool_name is required', Code.InvalidArgument);
      }
      const result = await authority.getToolCredential({
        orgId: c.organizationId,
        runId: c.runId,
        toolName: req.toolName,
      });
      return { credential: result.credential, credentialHeader: result.credentialHeader };
    }),

    // v1.3 — latest checkpoint read for resume-from-checkpoint (FL-2.17).
    getLatestCheckpoint: connectHandler(async (req: GetLatestCheckpointRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'checkpoint', c, c.capabilityId);
      const result = await authority.getLatestCheckpoint({ orgId: c.organizationId, runId: c.runId });
      if (!result) {
        return { checkpointRef: '', checkpointVersion: 0n, artifact: undefined };
      }
      return {
        checkpointRef: result.checkpointRef,
        checkpointVersion: BigInt(result.checkpointVersion),
        artifact: result.artifact
          ? {
              artifactId: result.artifact.artifactId,
              organizationId: c.organizationId,
              runId: c.runId,
              purpose: result.artifact.purpose,
              mediaType: result.artifact.mediaType,
              byteLength: BigInt(result.artifact.byteLength),
              sha256: new Uint8Array(result.artifact.sha256),
              encryptionKeyId: '',
            }
          : undefined,
      };
    }),

    // v1.2 — human handoff (FL-1.7c): the built-in `request_human_handoff`
    // tool lands here; Engine opens the escalation in one TX.
    requestHumanHandoff: connectHandler(async (req: RequestHumanHandoffRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'escalation', c, c.capabilityId);
      if (!req.reason) {
        throw new ConnectError('reason is required', Code.InvalidArgument);
      }
      const result = await authority.requestHumanHandoff({
        orgId: c.organizationId,
        runId: c.runId,
        reason: req.reason,
        note: req.note || undefined,
      });
      return {
        escalationId: result.escalationId,
        state: result.state,
        conversationStatus: result.conversationStatus,
      };
    }),

    // v1.2 — approval observation: Studio reads the durable decision for an
    // approval it proposed (park/resume loop). Run-bound safe read.
    getApprovalState: connectHandler(async (req: GetApprovalStateRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'approval', c, c.capabilityId);
      if (!req.approvalRef) {
        throw new ConnectError('approval_ref is required', Code.InvalidArgument);
      }
      const result = await authority.getApprovalState({
        orgId: c.organizationId,
        runId: c.runId,
        approvalRef: req.approvalRef,
      });
      return {
        approvalId: result.approvalId ?? '',
        approvalRef: req.approvalRef,
        state: result.state,
        decisionId: result.decisionId ?? '',
        decidedBy: result.decidedBy ?? '',
        decidedAt:
          result.decidedAt !== undefined
            ? (toTimestamp(result.decidedAt) ?? undefined)
            : undefined,
      };
    }),

    // 5.9 — proposals are stored as proposals, never durable memory.
    submitMemoryProposal: connectHandler(async (req: SubmitMemoryProposalRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'memory_proposal', c, c.capabilityId);
      const result = await authority.submitMemoryProposal({
        orgId: c.organizationId,
        runId: c.runId,
        proposalRef: req.proposalId,
        scope: req.scope,
        value: req.value,
        provenance: req.provenance || undefined,
        confidence: req.confidence > 0 ? req.confidence : undefined,
        visibility: req.visibility || undefined,
        expiresAt: req.expiresAt ? tsToDate(req.expiresAt) : undefined,
      });
      return { proposalId: req.proposalId, accepted: result.accepted, storedId: result.storedId };
    }),

    // 5.10 — scoped tool capability bound to run/step/tool_call + digests.
    authorizeToolCall: connectHandler(async (req: AuthorizeToolCallRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'tool', c, c.capabilityId);
      const result = await authority.authorizeToolCall({
        orgId: c.organizationId,
        runId: c.runId,
        stepId: req.stepId || undefined,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        toolVersion: req.toolVersion || undefined,
        argumentDigest: assertDigest32(req.argumentDigest, 'argument_digest'),
      });
      return {
        allowed: result.allowed,
        reason: result.reason ?? '',
        toolCapabilityToken: result.toolCapability ?? '',
        approvalRequirement: wireApprovalRequirement(result.approvalRequired ? 'required' : undefined),
      };
    }),

    recordToolOutcome: connectHandler(async (req: RecordToolOutcomeRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'tool', c, c.capabilityId);
      const result = await authority.recordToolOutcome({
        orgId: c.organizationId,
        toolCallId: req.toolCallId,
        resultDigest: req.resultDigest ? assertDigest32(req.resultDigest, 'result_digest') : undefined,
        status: req.status,
      });
      return { accepted: result.accepted, wasDuplicate: result.wasDuplicate };
    }),

    // 5.8 — checkpoint claim-check pointer; bytes stay in object storage.
    saveCheckpointRef: connectHandler(async (req: SaveCheckpointRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'checkpoint', c, c.capabilityId);
      const result = await authority.saveCheckpointRef({
        orgId: c.organizationId,
        runId: c.runId,
        checkpointRef: req.checkpointId,
        checkpointVersion: Number(req.checkpointVersion ?? 1n),
        artifactId: req.artifactRef?.artifactId || undefined,
        digest: assertDigest32(req.digest, 'digest'),
        producer: `agent-studio:${c.actorId}`,
      });
      return { accepted: result.accepted, checkpointId: req.checkpointId };
    }),
  });

  router.service(RunObservationService, {
    getRun: connectHandler(async (req: GetRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c, c.capabilityId);
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run) };
    }),

    listRunEvents: connectHandler(async (req: ListRunEventsRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c, c.capabilityId);
      const limit = req.page?.pageSize || 50;
      const rows = await authority.listRunEvents(c.organizationId, c.runId, {
        afterSequence: req.afterSequence !== undefined ? Number(req.afterSequence) : 0,
        limit,
      });
      const events = rows.map(toWireRunEvent);
      const last = events.length > 0 && events.length === limit ? events[events.length - 1].sequence : undefined;
      return {
        events,
        page: create(PageResponseSchema, { nextPageToken: last !== undefined ? String(last) : '' }),
      };
    }),

    // Server-streaming replay: events after the cursor, then tail until the
    // run is terminal (bounded by MCP_WATCH_MAX_DURATION_SECONDS). The
    // abort signal ends the loop so a disconnected client stops polling.
    watchRunEvents: async function* (req: WatchRunEventsRequest, context: HandlerContext): AsyncGenerator<{ event: ReturnType<typeof toWireRunEvent> }> {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c, c.capabilityId);
      const deadline = Date.now() + env.MCP_WATCH_MAX_DURATION_SECONDS * 1000;
      let cursor = req.afterSequence !== undefined ? Number(req.afterSequence) : 0;
      while (Date.now() < deadline) {
        if (context.signal?.aborted) {
          return;
        }
        const rows = await authority.listRunEvents(c.organizationId, c.runId, { afterSequence: cursor, limit: 50 });
        for (const row of rows) {
          cursor = row.engineSequence;
          yield { event: toWireRunEvent(row) };
        }
        if (rows.length === 0) {
          const run = await authority.getRun(c.organizationId, c.runId);
          if (isTerminalRun(run.state)) {
            return;
          }
        }
        await sleep(500);
      }
    },

    // 5.12 + 7.9 — artifact facade: 7 fresh checks + run-scope binding,
    // short-TTL presigned GET. The ref's uri/key-id/expiry fields are always
    // populated — protovalidate requires min_len 1 on uri and
    // encryption_key_id, and a present expires_at.
    getRunArtifact: connectHandler(async (req: GetRunArtifactRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c, c.capabilityId);
      const result = await authority.getRunArtifact({ orgId: c.organizationId, runId: c.runId, artifactId: req.artifactId });
      return {
        artifact: {
          artifactId: result.ref.artifactId,
          uri: result.ref.uri,
          mediaType: result.ref.mediaType,
          byteLength: BigInt(result.ref.byteLength),
          sha256: new Uint8Array(result.ref.sha256),
          encryptionKeyId: result.ref.encryptionKeyId,
          purpose: result.ref.purpose,
          expiresAt: toTimestamp(result.ref.expiresAt),
        },
        accessUrl: result.accessUrl,
      };
    }),
  });
}
