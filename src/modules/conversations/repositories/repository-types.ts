/**
 * Shared repository-layer types for the conversations module (P3).
 *
 * These types are provider-blind: the PostgreSQL and MongoDB repository
 * implementations behind `IConversationRepository` / `IEscalationRepository` /
 * `IRunAuthorityRepository` both speak them, and the services consume them
 * without knowing which provider is active.
 */

/**
 * An audit write the repository could not perform itself.
 *
 * Audit storage is owned by `AuditService` (a separate, still PostgreSQL-backed
 * service — its own provider port is out of scope for the conversations P3).
 * Repository methods therefore never call it; methods whose current
 * implementation audits from *inside* the transaction return the events they
 * would have written, in order, and the service replays them after the
 * repository call resolves (via `audit.add`, or the best-effort `auditSafe`
 * wrapper in `McpAuthorityService`).
 */
export interface RepositoryAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string | null;
  tenantId: string;
  details: Record<string, unknown>;
  /** Defaults to 'service' when omitted. */
  actorType?: 'account' | 'service';
  /** Defaults to 'agent-studio-runtime' when omitted. */
  actorId?: string;
}

/**
 * Advisory quota hold/release around run acceptance.
 *
 * The durable reservation (`quota_reservations`) lives in the repository
 * transaction; the Redis advisory hold lives in `QuotaService` and is NOT a
 * database concern, so the repository receives it as a callback pair instead
 * of depending on the billing module. Call order is preserved exactly:
 * `hold()` is invoked inside the unit of work at the same point the current
 * code calls it, and a failed `hold()` aborts the unit (fail-closed) while a
 * failed `release()` never does (best-effort — the implementation the
 * service passes already swallows errors and logs).
 */
export interface QuotaGate {
  /** Take the advisory hold; throws on refusal (fail-closed). */
  hold(): Promise<void>;
  /** Drop the advisory hold; best-effort, never throws. */
  release(): Promise<void>;
}
