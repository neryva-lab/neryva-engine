/**
 * MongoDB concurrency utilities — plan D7 primitives for the Mongo lane.
 *
 * - lease-lock: distributed lease replacing `pg_advisory_xact_lock`.
 * - counters: atomic `$inc` sequences replacing `max()+1` and `bigserial`.
 * - tenant-guard: fail-closed tenant scoping replacing the RLS backstop.
 */
export {
  acquireLease,
  ensureLeaseIndexes,
  LEASES_COLLECTION,
  LeaseAcquisitionError,
} from './lease-lock';
export type { AcquireLeaseOptions, LeaseHandle } from './lease-lock';

export { nextSequence, COUNTERS_COLLECTION } from './counters';
export type { NextSequenceOptions } from './counters';

export { TenantScopedCollection, PlatformCollection } from './tenant-guard';
export type { TenantScopedOptions } from './tenant-guard';
