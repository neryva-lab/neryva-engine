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
      },
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
