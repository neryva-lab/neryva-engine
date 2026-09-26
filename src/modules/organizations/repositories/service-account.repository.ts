/**
 * Service-account repository (P3) — the persistence port for the
 * org-owned machine identities (`OrgServiceAccountsService`). Each account
 * holds at most ONE active token (sha256 at rest, returned exactly once on
 * create/rotate) — the token lifecycle below is the revocation bound the
 * AuthGuard relies on.
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every org-scoped method takes the organization id
 * explicitly as the first parameter (or inside `input`). The PostgreSQL
 * implementation applies it via `DbService.withOrg` (RLS); the MongoDB
 * implementation applies it as an explicit `org_id` predicate on every
 * collection access (there is no RLS on that lane). `findByTokenHash` and
 * `touchTokenLastUsed` are deliberately cross-tenant and global —
 * authentication happens before any org context exists; the filter is the
 * globally-unique unguessable hash (pg: `withBypass`; mongo:
 * `PlatformCollection` with a justifying comment).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them; `token_hash` /
 * `token_prefix` are omitted — not null — on token-less docs, paired with a
 * sparse unique index so multiple null-token docs stay legal exactly like
 * pg's NULL-distinct unique semantics).
 *
 * What stays OUT of the repository (still the service's job):
 * - token minting (randomBytes) and hashing (sha256Hex)
 * - input validation (name/scope rules)
 * - token-state guards ("disabled — enable it before rotating",
 *   "has no active token")
 * - audit writes (`org.service_account_*`, replayed by the service)
 * - event emission (`ServiceAccountTokenRotated`)
 * - the validateByHash outcome shaping (disabled/expired/no_token reasons)
 */
import type { orgServiceAccounts } from '../schema';

export type ServiceAccountRow = typeof orgServiceAccounts.$inferSelect;

export interface IServiceAccountRepository {
  /** Service accounts of the org, newest first. */
  listServiceAccounts(orgId: string): Promise<ServiceAccountRow[]>;

  /** Raw row read; the service maps a miss to NotFoundException. */
  getServiceAccount(orgId: string, id: string): Promise<ServiceAccountRow | null>;

  /** Insert with a freshly minted token hash/prefix (computed by the service). */
  createServiceAccount(input: {
    orgId: string;
    name: string;
    description: string | null;
    scopes: string[];
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    createdBy: string;
  }): Promise<ServiceAccountRow>;

  /**
   * Compare-and-swap the token hash on the row's current hash so a
   * concurrent rotate cannot silently win. Returns false when no row
   * matched (stale expected hash) — the service maps that to
   * ApiError.conflict, the same code the pg lane produces. The swap itself
   * is the revocation of the previous token; expiry clears.
   */
  rotateTokenHash(input: {
    orgId: string;
    id: string;
    expectedTokenHash: string | null;
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    updatedAt: string;
  }): Promise<boolean>;

  /** Revoke just the token — the identity and its metadata stay. */
  revokeToken(orgId: string, id: string, updatedAt: string): Promise<void>;

  /** Disable (voids the token) — the account stops authenticating. */
  disableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void>;

  /** Re-enable; the token must be rotated to authenticate again. */
  enableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void>;

  /** Delete the identity row. */
  removeServiceAccount(orgId: string, id: string): Promise<void>;

  /**
   * AuthGuard lookup by token hash — deliberately cross-tenant and global
   * (see the tenant-discipline note above). The service applies the
   * disabled/expired policy on the returned row.
   */
  findByTokenHash(tokenHash: string): Promise<ServiceAccountRow | null>;

  /**
   * Fire-and-forget usage telemetry: the service awaits nothing and
   * swallows errors. Best-effort by contract on both lanes.
   */
  touchTokenLastUsed(id: string, at: string): Promise<void>;
}
