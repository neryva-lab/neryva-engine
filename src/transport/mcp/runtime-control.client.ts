import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { RuntimeControlService, RequestContextSchema } from '@neryva/mcp-contract';
import { env } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';

/**
 * RuntimeControlService client port — Engine → Studio (ledger 5.1). The
 * dispatcher's run-dispatch consumer calls `startRun` when a Studio runtime
 * is configured (`NERYVA_RUNTIME_BASE_URL`); without one the consumer skips
 * (durable outcome: the outbox row stays PUBLISHED with a skip result_ref
 * and the run remains ACCEPTED for later dispatch — never silently "done").
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

export function isRuntimeConfigured(): boolean {
  return Boolean(env.NERYVA_RUNTIME_BASE_URL);
}

export async function startRunOnStudio(args: StartRunArgs): Promise<{ workflowId: string; alreadyStarted: boolean }> {
  const transport = createConnectTransport({ baseUrl: env.NERYVA_RUNTIME_BASE_URL, httpVersion: '1.1' });
  const client = createClient(RuntimeControlService, transport);
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
  const response = await client.startRun({
    ctx,
    assistantVersionId: args.assistantVersionId,
    inputMessageId: args.messageId,
    expectedConversationVersion: BigInt(args.expectedConversationVersion),
    capabilityToken: args.capabilityToken,
  });
  return { workflowId: response.workflowId, alreadyStarted: response.alreadyStarted };
}
