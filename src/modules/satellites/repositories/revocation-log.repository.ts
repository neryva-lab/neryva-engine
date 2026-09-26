/**
 * Revocation-log repository (P3) — the persistence port for the
 * `revocation_events` append-only feed.
 *
 * Platform-scoped (no orgId) — see the registry port for the
 * tenant-discipline note.
 *
 * Row types are imported as *types only* from the module schema.
 */
import type { RevocationEventRow } from '../satellite.schema';

export type RevocationKind = 'session' | 'account_all' | 'key';

export interface IRevocationLogRepository {
  /** Append one durable revocation row. */
  appendRevocation(input: {
    kind: RevocationKind;
    subjectId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Events strictly after the cursor (occurredAt, id) — the resumable
   * satellite cursor protocol. `id` is '' for the head of the stream.
   * Ascending (occurred_at, id), bounded by limit.
   */
  listSince(occurredAtIso: string, id: string, limit: number): Promise<RevocationEventRow[]>;

  /** Rows in a time window, ascending, bounded. */
  listBetween(fromIso: string, toIso: string, limit: number): Promise<RevocationEventRow[]>;

  /** Prune rows older than the cutoff. Returns rows removed. */
  pruneOlderThan(cutoffIso: string): Promise<number>;
}
