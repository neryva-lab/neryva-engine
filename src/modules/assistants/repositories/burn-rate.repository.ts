/**
 * Burn-rate repository (P3) — a READ-ONLY port for the burn-rate
 * auto-rollback worker (`BurnRateService`).
 *
 * This port never writes. The worker makes all its decisions from reads
 * here and routes any pausing through `IRolloutRepository.pauseRelease`
 * — the write ownership for rollouts stays in exactly one place. Each
 * method is one read-consistent unit of work; nothing here participates
 * in a caller transaction.
 *
 * Tenant discipline: `sweepCandidates` is intentionally cross-org (the
 * worker sweeps all tenants; the optional `limit` bounds a single sweep
 * batch). The per-assistant methods take the organization id explicitly
 * (first parameter); the PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS), the MongoDB implementation as an explicit
 * `organization_id` predicate (there is no RLS on that lane).
 *
 * Foreign tables read here (owned by other modules — this port reads them
 * as read-only shapes, never mutates): `billing.usage_ledger_entries`
 * (cost windows), `assistants.assistant_rollouts` (sweep + newest active
 * rollout), `audit_events` (last auto-rollback marker). No row types are
 * imported for them; the port returns scalars only, so the implementation
 * may map BSON or SQL rows freely.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, limit clamps)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - burn-rate threshold math and rollback decisions (worker policy)
 * - pausing (routed through `IRolloutRepository`)
 */
export interface IBurnRateRepository {
  /**
   * Cross-org sweep: assistant addresses with active rollouts worth
   * checking this pass. Bounded by `limit`.
   */
  sweepCandidates(
    limit?: number,
  ): Promise<Array<{ orgId: string; assistantId: string }>>;

  /** Aggregate spend for the assistant's org over the trailing windows. */
  costWindows(orgId: string): Promise<{ lastHourCost: number; lastDayCost: number }>;

  /** When this assistant was last auto-rolled-back (audit_events), if ever. */
  lastAutoRollbackAt(orgId: string, assistantId: string): Promise<string | null>;

  /** Created-at of the newest active rollout for the assistant, if any. */
  newestActiveRolloutCreatedAt(
    orgId: string,
    assistantId: string,
  ): Promise<string | null>;
}
