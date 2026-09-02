import { ConnectError, Code } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  Run as WireRun,
  RunSchema,
  RunState,
  RunEventSchema,
  EventType,
  RedactionClass,
  ApprovalState,
  ApprovalRequirement,
  ToolEffectClass,
} from '@neryva/mcp-contract';
import type { ApiError } from '../../common/http/api-error';

/**
 * Wire ↔ domain mapping for the MCP authority surface. The wire contract's
 * RunState enum is authoritative on the wire; the DB state machine is
 * Engine-internal (pinned terminal state: COMPLETED).
 */
const DB_TO_WIRE_STATE: Record<string, RunState> = {
  ACCEPTED: RunState.QUEUED,
  DISPATCHED: RunState.CLAIMED,
  RUNNING: RunState.RUNNING,
  WAITING_APPROVAL: RunState.WAITING_APPROVAL,
  WAITING_INPUT: RunState.WAITING_INPUT,
  COMPLETED: RunState.SUCCEEDED,
  FAILED: RunState.FAILED,
  CANCELED: RunState.CANCELLED,
  EXPIRED: RunState.EXPIRED,
};

export function toWireState(dbState: string): RunState {
  const wire = DB_TO_WIRE_STATE[dbState];
  if (wire === undefined) {
    throw new ConnectError(`unknown run state ${dbState}`, Code.Internal);
  }
  return wire;
}

export function toTimestamp(iso: string | null): { seconds: bigint; nanos: number } | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

export function toWireRun(run: {
  id: string;
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  state: string;
  version: number;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}): WireRun {
  return create(RunSchema, {
    runId: run.id,
    organizationId: run.organizationId,
    conversationId: run.conversationId,
    assistantVersionId: run.assistantVersionId,
    state: toWireState(run.state),
    version: BigInt(run.version),
    leaseEpoch: BigInt(run.leaseEpoch),
    createdAt: toTimestamp(run.createdAt)!,
    updatedAt: toTimestamp(run.updatedAt)!,
    leaseOwner: run.leaseOwner ?? '',
    leaseExpiresAt: toTimestamp(run.leaseExpiresAt),
  });
}

/** DB run_events.event_type stores the wire enum's numeric value as text. */
export function toWireEventType(eventType: string): EventType {
  const numeric = Number(eventType);
  if (!Number.isNaN(numeric) && Object.values(EventType).includes(numeric as EventType)) {
    return numeric as EventType;
  }
  return EventType.UNSPECIFIED;
}

export function wireEventTypeToStore(type: EventType): string {
  return String(type);
}

type RunEventRow = {
  id: string;
  runId: string;
  eventType: string;
  schemaVersion: number;
  engineSequence: number;
  producerIdentity: string | null;
  producerSequence: number | null;
  payload: unknown;
  artifactId: string | null;
  createdAt: string;
};

type StoredPayload = { case?: string; value?: unknown; redaction?: number } | null;

export function toWireRunEvent(row: RunEventRow): ReturnType<typeof create<typeof RunEventSchema>> {
  const payload = row.payload as StoredPayload;
  let body: Record<string, unknown> = {};
  if (payload?.case) {
    body = { [payload.case]: payload.value ?? {} };
  }
  return create(RunEventSchema, {
    eventId: row.id,
    runId: row.runId,
    type: toWireEventType(row.eventType),
    schemaVersion: String(row.schemaVersion),
    producerId: row.producerIdentity ?? 'engine',
    producerSequence: BigInt(row.producerSequence ?? 0),
    producerTimestamp: toTimestamp(row.createdAt)!,
    redaction: (payload?.redaction as RedactionClass) ?? RedactionClass.NONE,
    sequence: BigInt(row.engineSequence),
    ...body,
  });
}

/** Echo an accepted request event back with its authoritative Engine sequence. */
export function toWireRunEventFromRequest(ev: Record<string, unknown>, runId: string, producerIdentity: string, engineSequence: number): ReturnType<typeof create<typeof RunEventSchema>> {
  const body = ev.body as { case: string; value: unknown } | undefined;
  return create(RunEventSchema, {
    eventId: String(ev.eventId),
    runId,
    type: toWireEventType(String(ev.type ?? '')),
    schemaVersion: String(Number(ev.schemaVersion) || 1),
    producerId: producerIdentity,
    producerSequence: BigInt(ev.producerSequence !== undefined ? Number(ev.producerSequence) : 0),
    producerTimestamp: toTimestamp(new Date().toISOString())!,
    redaction: (ev.redaction as RedactionClass) ?? RedactionClass.NONE,
    sequence: BigInt(engineSequence),
    ...(body ? { [body.case]: body.value } : {}),
  });
}

export function toWireApprovalState(state: string): ApprovalState {
  switch (state) {
    case 'APPROVED':
      return ApprovalState.APPROVED;
    case 'DENIED':
      return ApprovalState.DENIED;
    case 'EXPIRED':
      return ApprovalState.EXPIRED;
    default:
      return ApprovalState.PENDING;
  }
}

export function wireToolEffectClass(access: string): ToolEffectClass {
  return access === 'read' ? ToolEffectClass.READ_ONLY : ToolEffectClass.MUTATING;
}

export function wireApprovalRequirement(approval: string | undefined): ApprovalRequirement {
  return approval === 'required' ? ApprovalRequirement.REQUIRED : ApprovalRequirement.NONE;
}

/**
 * ApiError → ConnectError. Fencing and CAS conflicts surface as Aborted
 * (caller must re-read); idempotency digest conflicts surface as
 * AlreadyExists; everything else maps by its HTTP semantics.
 */
export function toConnectError(err: unknown): unknown {
  if (ConnectError.from(err)) {
    return err;
  }
  const apiErr = err as ApiError;
  if (typeof apiErr?.code !== 'string' || typeof apiErr?.getStatus !== 'function') {
    return err;
  }
  const status = apiErr.getStatus();
  let code: Code = Code.Internal;
  if (apiErr.code === 'conflict') {
    code = Code.Aborted;
  } else if (apiErr.code === 'idempotency_conflict') {
    code = Code.AlreadyExists;
  } else if (apiErr.code === 'idempotency_in_flight') {
    code = Code.Unavailable;
  } else if (status === 400) {
    code = Code.InvalidArgument;
  } else if (status === 401) {
    code = Code.Unauthenticated;
  } else if (status === 403) {
    code = Code.PermissionDenied;
  } else if (status === 404) {
    code = Code.NotFound;
  } else if (status === 429) {
    code = Code.Unavailable;
  } else if (status >= 500) {
    code = Code.Internal;
  }
  const message = typeof (apiErr as { message?: unknown }).message === 'string' ? (apiErr as Error).message : 'authority error';
  return new ConnectError(message, code, { details: JSON.stringify(apiErr.details ?? null) });
}

/** Wrap a handler so ApiErrors surface as typed ConnectErrors. */
export function connectHandler<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toConnectError(err);
    }
  };
}
