/**
 * Content-staff repository port (P3) — `corporate_content_staff`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): content is a company surface,
 * not an org surface (ADR-004 D4). No orgId on these methods by design.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */

/** Plain domain view of a `corporate_content_staff` row (drizzle-free). */
export interface ContentStaffGrantRow {
  accountId: string;
  grantedBy: string;
  grantedAt: string;
}

export interface IContentStaffRepository {
  /** True when the account holds a content-staff grant. */
  isContentStaff(accountId: string): Promise<boolean>;
  /** All grants (platform-operator staff management). */
  listGrants(): Promise<ContentStaffGrantRow[]>;
  /** Grant content-staff to an account (idempotent). */
  grantStaff(input: { accountId: string; grantedBy: string }): Promise<void>;
  /** Revoke a content-staff grant (idempotent). */
  revokeStaff(accountId: string): Promise<void>;
}
