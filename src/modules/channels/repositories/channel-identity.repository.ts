/**
 * Channel-identity repository (P3) — the persistence port for
 * `channel_identities` (the per-account external-user directory) plus the
 * identity-scoped reads the ingest/outbound flows need.
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly. The
 * PostgreSQL implementation applies it via `DbService.withOrg` (RLS) except
 * where the current code deliberately runs on `db.withBypass` (the ingest
 * half has no tenant context — the account row already resolved the tenant);
 * there the org travels as an explicit predicate/value, mirroring the pg
 * lane exactly. The MongoDB implementation applies the same explicit
 * `organization_id` scoping.
 *
 * CROSS-MODULE READ SEAM (documented, not hidden): `findActiveConversationIdByIdentity`
 * reads the conversations plane (`conversations.channel_binding`) — the same
 * query the current ingest code runs inline. Both lanes keep the read inside
 * this port so the service never touches another module's tables directly.
 */
export interface IChannelIdentityRepository {
  /**
   * Upsert the (account, external user) identity and refresh the Meta 24h
   * messaging window when `hasWindow` (whatsapp/messenger/instagram).
   * Returns the identity id. Idempotent: concurrent upserts for the same
   * external user converge on one row via the unique
   * (channel_account_id, external_user_id) key.
   */
  upsertInboundIdentity(input: {
    orgId: string;
    accountId: string;
    platform: string;
    externalUserId: string;
    displayName: string | null;
    locale: string | null;
    hasWindow: boolean;
  }): Promise<string>;

  /**
   * Latest ACTIVE conversation bound to this identity
   * (`channel_binding->>'channel_identity_id'`), or null. Purged
   * (tombstoned) conversations are never revived — the service asserts that
   * separately via the purge service.
   */
  findActiveConversationIdByIdentity(orgId: string, identityId: string): Promise<string | null>;

  /** The identity's messaging-window expiry (Meta window policy), or null. */
  getIdentityWindow(
    orgId: string,
    identityId: string,
  ): Promise<{ windowExpiresAt: string | null } | null>;

  /** The provider-side user id for outbound addressing, or null. */
  externalUserIdFor(orgId: string, identityId: string): Promise<string | null>;
}
