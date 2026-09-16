import { ApiError } from '../../common/http/api-error';

/**
 * Run state machine — authoritative per engine_data_and_lifecycle.md:161-186.
 * Lease state is fencing, NOT business state: terminal transitions are decided
 * by the domain, the lease only gates who may write.
 */
export const RUN_STATES = [
  'ACCEPTED',
  'DISPATCHED',
  'RUNNING',
  'WAITING_APPROVAL',
  'WAITING_INPUT',
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];

const ALLOWED_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  ACCEPTED: ['DISPATCHED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'],
  DISPATCHED: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'],
  RUNNING: ['WAITING_APPROVAL', 'WAITING_INPUT', 'COMPLETED', 'FAILED', 'CANCELED'],
  WAITING_APPROVAL: ['RUNNING', 'CANCELED', 'EXPIRED'],
  WAITING_INPUT: ['RUNNING', 'CANCELED', 'EXPIRED'],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
  EXPIRED: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!(ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw ApiError.conflict(`run transition ${from} -> ${to} is not allowed`, { from, to });
  }
}

export function isTerminalRun(state: string): state is RunState {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export function isRunState(state: string): state is RunState {
  return (RUN_STATES as readonly string[]).includes(state);
}
