import { ConnectRouter, HandlerContext, Code, ConnectError } from '@connectrpc/connect';
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
  type RequestContext,
  type AcquireOrRenewRunLeaseRequest,
  type ReleaseRunLeaseRequest,
  type GetRunRequest,
  type CommitRunResultRequest,
  type FailRunRequest,
  type GetAuthorizedRunContextRequest,
  type CreateApprovalRequest,
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

function assertCapability(context: HandlerContext, op: CapabilityOp, scope: { organizationId: string; conversationId?: string; runId?: string }): void {
  try {
    assertCapabilityFor(capabilityToken(context), op, scope);
  } catch (err) {
    throw new ConnectError((err as Error).message, Code.PermissionDenied);
  }
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
      assertCapability(context, 'lease', c);
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
      assertCapability(context, 'lease', c);
      const run = await authority.releaseRunLease({ orgId: c.organizationId, runId: c.runId, leaseEpoch: Number(req.leaseEpoch ?? 0n) });
      return { run: toWireRun(run) };
    }),

    getRun: connectHandler(async (req: GetRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c);
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run) };
    }),

    // 5.11 — terminal atomicity: delegates to the Phase 4 atomic commit.
    commitRunResult: connectHandler(async (req: CommitRunResultRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'commit', c);
      if (req.resultArtifact) {
        throw new ConnectError('result_artifact claim-check lands with Phase 7 artifacts', Code.Unimplemented);
      }
      const text = (req.resultText ?? '').trim();
      if (!text) {
        throw new ConnectError('result_text is required', Code.InvalidArgument);
      }
      await authority.assertExpectedVersion(c.organizationId, c.runId, req.expectedVersion !== undefined ? Number(req.expectedVersion) : undefined);
      const result = await conversations.commitRunResult({ orgId: c.organizationId, runId: c.runId, content: { text }, actor: 'agent-studio-runtime' });
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run), messageId: result.message_id };
    }),

    failRun: connectHandler(async (req: FailRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'commit', c);
      const run = await authority.failRun({
        orgId: c.organizationId,
        runId: c.runId,
        errorCode: req.errorCode || 'studio_error',
        errorMessage: (req.errorMessage ?? '').slice(0, 1024),
        expectedVersion: req.expectedVersion !== undefined ? Number(req.expectedVersion) : undefined,
      });
      return { run: toWireRun(run) };
    }),

    // 5.6 — bounded batch, (run_id, event_id) dedup, engine_sequence authoritative.
    appendRunEvents: connectHandler(async (req: { ctx?: RequestContext; events?: Array<Record<string, unknown>> }, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'append_events', c);
      const events = req.events ?? [];
      if (events.length === 0 || events.length > 32) {
        throw new ConnectError('events batch must contain 1..32 events', Code.InvalidArgument);
      }
      // Optional per-event CAS against the run version.
      const run = await authority.getRun(c.organizationId, c.runId);
      for (const ev of events) {
        const expected = ev.expectedRunVersion;
        if (typeof expected === 'bigint' && expected > 0n && Number(expected) !== run.version) {
          throw new ConnectError('stale run version for event batch', Code.Aborted);
        }
      }
      const mapped = events.map((ev) => {
        const body = ev.body as { case: string; value: unknown } | undefined;
        const schema = body?.case ? BODY_SCHEMAS[body.case] : undefined;
        if (!body || !schema) {
          throw new ConnectError(`event ${String(ev.eventId)} has no known body`, Code.InvalidArgument);
        }
        return {
          eventId: String(ev.eventId),
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
      });
      const byId = new Map(result.accepted.map((a) => [a.eventId, a.engineSequence]));
      const accepted = events.map((ev) =>
        toWireRunEventFromRequest(ev, c.runId, `agent-studio:${c.actorId}`, byId.get(String(ev.eventId)) ?? 0),
      );
      return { accepted, duplicateCount: result.duplicateCount };
    }),

    // 5.5 — bounded manifest, filters applied in query, never after.
    getAuthorizedRunContext: connectHandler(async (req: GetAuthorizedRunContextRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'context', c);
      void req.requestedPurposes; // knowledge purposes filter activates with Phase 7 retrieval
      const manifest = await authority.getAuthorizedRunContext({ orgId: c.organizationId, runId: c.runId });
      // PlainMessage-compatible; knowledge/memory/artifact fields are typed
      // placeholders until Phase 7 populates them.
      return { manifest: manifest as never };
    }),

    // 5.7 — approvals persist WAITING_APPROVAL and emit an outbox event.
    createApprovalRequest: connectHandler(async (req: CreateApprovalRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'approval', c);
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

    // 5.9 — proposals are stored as proposals, never durable memory.
    submitMemoryProposal: connectHandler(async (req: SubmitMemoryProposalRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'memory_proposal', c);
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
      assertCapability(context, 'tool', c);
      const result = await authority.authorizeToolCall({
        orgId: c.organizationId,
        runId: c.runId,
        stepId: req.stepId || undefined,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        toolVersion: req.toolVersion || undefined,
        argumentDigest: Buffer.from(req.argumentDigest),
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
      assertCapability(context, 'tool', c);
      const result = await authority.recordToolOutcome({
        orgId: c.organizationId,
        toolCallId: req.toolCallId,
        resultDigest: req.resultDigest ? Buffer.from(req.resultDigest) : undefined,
        status: req.status,
      });
      return { accepted: result.accepted, wasDuplicate: result.wasDuplicate };
    }),

    // 5.8 — checkpoint claim-check pointer; bytes stay in object storage.
    saveCheckpointRef: connectHandler(async (req: SaveCheckpointRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'checkpoint', c);
      const result = await authority.saveCheckpointRef({
        orgId: c.organizationId,
        runId: c.runId,
        checkpointRef: req.checkpointId,
        checkpointVersion: Number(req.checkpointVersion ?? 1n),
        artifactId: req.artifactRef?.artifactId || undefined,
        digest: Buffer.from(req.digest),
        producer: `agent-studio:${c.actorId}`,
      });
      return { accepted: result.accepted, checkpointId: req.checkpointId };
    }),
  });

  router.service(RunObservationService, {
    getRun: connectHandler(async (req: GetRunRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c);
      const run = await authority.getRun(c.organizationId, c.runId);
      return { run: toWireRun(run) };
    }),

    listRunEvents: connectHandler(async (req: ListRunEventsRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c);
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
    // run is terminal (bounded by MCP_WATCH_MAX_DURATION_SECONDS).
    watchRunEvents: async function* (req: WatchRunEventsRequest, context: HandlerContext): AsyncGenerator<{ event: ReturnType<typeof toWireRunEvent> }> {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c);
      const deadline = Date.now() + env.MCP_WATCH_MAX_DURATION_SECONDS * 1000;
      let cursor = req.afterSequence !== undefined ? Number(req.afterSequence) : 0;
      while (Date.now() < deadline) {
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

    // 5.12 + 7.9 — artifact facade: 7 fresh checks, short-TTL presigned GET.
    getRunArtifact: connectHandler(async (req: GetRunArtifactRequest, context: HandlerContext) => {
      const c = readCtx(req.ctx);
      assertCapability(context, 'observe', c);
      const result = await authority.getRunArtifact({ orgId: c.organizationId, artifactId: req.artifactId });
      return {
        artifact: {
          artifactId: result.ref.artifactId,
          uri: '',
          mediaType: result.ref.mediaType,
          byteLength: BigInt(result.ref.byteLength),
          sha256: new Uint8Array(result.ref.sha256),
          encryptionKeyId: '',
          purpose: result.ref.purpose,
          expiresAt: result.ref.expiresAt ? toTimestamp(result.ref.expiresAt.toISOString()) : undefined,
        },
        accessUrl: result.accessUrl,
      };
    }),
  });
}
