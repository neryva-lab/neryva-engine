/**
 * Suppression repository port (P3) — `email_suppressions`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): per `public.schema.ts`, the
 * corporate plane is "Platform-plane like accounts: NOT tenant-scoped, no
 * RLS — the engine is the only writer". No orgId on these methods by design.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */
/** Plain domain view of an `email_suppressions` row (drizzle-free). */
export interface EmailSuppressionRow {
  id: string;
  email: string;
  reason: string;
  detail: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface SuppressInput {
  email: string;
  reason: SuppressionReason;
  detail?: string;
}

export interface ISuppressionRepository {
  /** True when the address is on the suppression list. */
  isSuppressed(email: string): Promise<boolean>;
  /**
   * Insert a suppression (idempotent on email). When reason is
   * 'unsubscribe', also flips any non-unsubscribed newsletter_subs row —
   * the one chokepoint both flows share (same as the original service).
   */
  suppress(input: SuppressInput): Promise<void>;
  /** Staff: the list, newest first. */
  listSuppressions(limit: number): Promise<EmailSuppressionRow[]>;
  /**
   * Staff: resolve a suppression (fixed addresses may mail again).
   * Returns the suppression id; throws `not_found` when unknown.
   */
  resolveSuppression(email: string): Promise<string>;
}
