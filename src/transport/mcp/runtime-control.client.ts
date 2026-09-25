import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { RuntimeControlService, RequestContextSchema } from '@neryva/mcp-contract';
import { env } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';

/**
 * RuntimeControlService client port — Engine → Studio (ledger 5.1). The
 * dispatcher's run-dispatch consumer calls `startRun` when a Studio runtime
 * is configured (`NERYVA_RUNTIME_BASE_URL`); without one the consumer skips
 * (durable outcome: the outbox row stays PUBLISHED with a skip result_ref
 * and the run remains ACCEPTED for later dispatch — re-driven by the
 * accepted-run sweep worker, never silently "done").
 *
 * AuthN/Z for this leg is the run-scoped capability token minted at accept
 * time; mTLS/SPIFFE workload identity lands with the Studio runtime (ADR-004).
 */
export interface StartRunArgs {
  organizationId: string;
  conversationId: string;
  runId: string;
  messageId: string;
  assistantVersionId: string;
  expectedConversationVersion: number;
  capabilityToken: string;
  /**
   * Agent-level per-tool approval policy (from assistant_versions.tool_policy).
   * Maps tool name -> 'required' | 'optional' | 'none'. The Engine populates this
   * from the published version so the Studio can enforce the builder's
   * configuration at execution time.
   */
  agentApprovalPolicy?: Record<string, string> | undefined;
}

/** Proto guidance (run.proto): 5s default deadline for unary StartRun. */
const START_RUN_DEADLINE_MS = 5_000;

export function isRuntimeConfigured(): boolean {
  return Boolean(env.NERYVA_RUNTIME_BASE_URL);
}

// One transport per process — a fresh transport per call leaks sockets under
// dispatch load. The consumer's retry budget absorbs transient failures.
let transport: ReturnType<typeof createConnectTransport> | null = null;
let transportBaseUrl = '';

function clientForRuntime() {
  if (!transport || transportBaseUrl !== env.NERYVA_RUNTIME_BASE_URL) {
    transportBaseUrl = env.NERYVA_RUNTIME_BASE_URL;
    transport = createConnectTransport({ baseUrl: transportBaseUrl, httpVersion: '1.1' });
  }
  return createClient(RuntimeControlService, transport);
}

export async function startRunOnStudio(args: StartRunArgs): Promise<{ workflowId: string; alreadyStarted: boolean }> {
  const client = clientForRuntime();
  const ctx = create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    runId: args.runId,
    actorId: 'engine-dispatcher',
    // Deterministic per outbox event id — redelivery cannot double-start the
    // workflow (Studio keys on this + the deterministic Workflow ID).
    idempotencyKey: `start-run:${args.runId}`,
    protocolVersion: '1.0',
    capabilityId: 'engine-dispatch',
  });
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), START_RUN_DEADLINE_MS);
  timeout.unref();
  try {
    const response = await client.startRun(
      {
        ctx,
        assistantVersionId: args.assistantVersionId,
        inputMessageId: args.messageId,
        expectedConversationVersion: BigInt(args.expectedConversationVersion),
        capabilityToken: args.capabilityToken,
        // Agent-level approval policy from the published version.
        // Cast needed: generated types may lag the proto in some build setups.
        agentApprovalPolicy: args.agentApprovalPolicy ?? {},
      } as Parameters<typeof client.startRun>[0],
      { signal: deadline.signal },
    );
    return { workflowId: response.workflowId, alreadyStarted: response.alreadyStarted };
  } catch (err) {
    if (err instanceof ConnectError && (err.code === Code.DeadlineExceeded || err.code === Code.Unavailable)) {
      // Normalized to a retryable-shaped error message; the dispatcher's
      // retry machine classifies and schedules the redelivery.
      throw new Error(`studio startRun unavailable: ${err.code} — retryable`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Deadline per proto guidance — cancels are fire-and-forget admission. */
const CANCEL_RUN_DEADLINE_MS = 5_000;

/**
 * cancelRunOnStudio — FL-1.3: propagate an Engine cancel to the Studio
 * runtime so an in-flight provider call aborts instead of running to
 * completion. Best-effort by design: the Engine run row is already CANCELED
 * (system of record) when this is called; a missed delivery only means the
 * Studio process wastes work, never a wrong state. The run-cancel consumer
 * treats transport failures as retryable.
 */
export async function cancelRunOnStudio(args: {
  organizationId: string;
  conversationId: string;
  runId: string;
  reason: string;
}): Promise<void> {
  const client = clientForRuntime();
  const ctx = create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    runId: args.runId,
    actorId: 'engine-dispatcher',
    idempotencyKey: `cancel-run:${args.runId}`,
    protocolVersion: '1.0',
    capabilityId: 'engine-dispatch',
  });
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), CANCEL_RUN_DEADLINE_MS);
  timeout.unref();
  try {
    await client.cancelRun({ ctx, reason: args.reason }, { signal: deadline.signal });
  } finally {
    clearTimeout(timeout);
  }
}
