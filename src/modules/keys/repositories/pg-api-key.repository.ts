import { and, desc, eq, like, lte } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { legacyApiKeys, legacyAuditEvents } from '../../../common/infra/db/legacy-schema';
import type {
  ApiKeyCreateInput,
  ApiKeyEventRow,
  ApiKeyPatch,
  ApiKeyRow,
  ExpiringApiKeyRow,
  IApiKeyRepository,
} from './keys.repository';

/**
 * PostgreSQL implementation of `IApiKeyRepository` (P3).
 *
 * Mechanical move of the `KeysService` `api_keys` units: every method owns
 * its transaction via `DbService.withOrg`/`withBypass` (the two `db.root`
 * reads — the key-hash auth lookup and the audit-trail read — become
 * `withBypass`, exactly as the pre-extraction code's bypass semantics).
 * No transaction handle leaks through this interface.
 *
 * What stays OUT (still the caller's job): input validation, key-material
 * generation, audit writes, event-bus emissions, notifications.
 */
export class PgApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly db: DbService) {}

  async listKeys(orgId: string): Promise<ApiKeyRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legacyApiKeys)
        .where(eq(legacyApiKeys.tenant_id, orgId))
        .orderBy(desc(legacyApiKeys.created_at))
        .limit(200),
    );
  }

  async getKey(orgId: string, keyId: string): Promise<ApiKeyRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legacyApiKeys)
        .where(and(eq(legacyApiKeys.id, keyId), eq(legacyApiKeys.tenant_id, orgId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async createKey(input: ApiKeyCreateInput): Promise<{ id: string }> {
    try {
      const inserted = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(legacyApiKeys)
          .values({
            id: input.id,
            name: input.name,
            key_hash: input.keyHash,
            prefix: input.prefix,
            role: input.role,
            tenant_id: input.orgId,
            scopes: input.scopes,
            expires_at: input.expiresAt,
            revoked: false,
            usage_count: 0,
            mfa_enabled: false,
            created_at: input.createdAt,
            updated_at: input.updatedAt,
          })
          .returning({ id: legacyApiKeys.id }),
      );
      return { id: inserted[0].id };
    } catch (err) {
      // drizzle wraps driver errors (DrizzleQueryError.cause) — read the
      // code/constraint via pgViolation or the raw 23505 escapes.
      const v = pgViolation(err);
      if (v.code === '23505' && v.constraint === 'uq_api_keys_key_hash') {
        throw ApiError.conflict('api key hash already in use', { reason: 'duplicate_key_hash' });
      }
      throw err;
    }
  }

  async revokeKey(orgId: string, keyId: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: legacyApiKeys.id })
        .from(legacyApiKeys)
        .where(and(eq(legacyApiKeys.id, keyId), eq(legacyApiKeys.tenant_id, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('api key');
    }
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(legacyApiKeys)
        .set({ revoked: true, updated_at: new Date().toISOString() })
        .where(eq(legacyApiKeys.id, keyId)),
    );
  }

  async updateKey(orgId: string, keyId: string, patch: ApiKeyPatch): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legacyApiKeys)
        .where(and(eq(legacyApiKeys.id, keyId), eq(legacyApiKeys.tenant_id, orgId)))
        .limit(1),
    );
    const key = rows[0];
    if (!key || key.revoked) {
      throw ApiError.notFound('api key');
    }
    const values: { name?: string; scopes?: string[]; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.scopes !== undefined) values.scopes = patch.scopes;
    await this.db.withOrg(orgId, (tx) =>
      tx.update(legacyApiKeys).set(values).where(eq(legacyApiKeys.id, keyId)),
    );
  }

  async rotateKey(
    orgId: string,
    keyId: string,
    input: { keyHash: string; prefix: string },
  ): Promise<ApiKeyRow> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legacyApiKeys)
        .where(and(eq(legacyApiKeys.id, keyId), eq(legacyApiKeys.tenant_id, orgId)))
        .limit(1),
    );
    const existing = rows[0];
    if (!existing || existing.revoked) {
      throw ApiError.notFound('api key');
    }
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(legacyApiKeys)
        .set({
          key_hash: input.keyHash,
          prefix: input.prefix,
          usage_count: 0,
          updated_at: new Date().toISOString(),
        })
        .where(eq(legacyApiKeys.id, keyId)),
    );
    return existing;
  }

  /**
   * UNAUTHENTICATED auth path: `db.root` in the pre-extraction code (no
   * tenant context is set there) → `withBypass` here, keyed by key_hash
   * only. The org comes from the row's `tenant_id`.
   */
  async findByKeyHash(keyHash: string): Promise<ApiKeyRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(legacyApiKeys).where(eq(legacyApiKeys.key_hash, keyHash)).limit(1),
    );
    return rows[0] ?? null;
  }

  async scanExpiringKeys(horizonIso: string): Promise<ExpiringApiKeyRow[]> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({
          id: legacyApiKeys.id,
          name: legacyApiKeys.name,
          tenant_id: legacyApiKeys.tenant_id,
          expires_at: legacyApiKeys.expires_at,
        })
        .from(legacyApiKeys)
        // `expires_at <= horizon` is NULL for keys with no expiry — they are
        // excluded here (SQL three-valued logic), same as the pre-extraction
        // scan.
        .where(and(eq(legacyApiKeys.revoked, false), lte(legacyApiKeys.expires_at, horizonIso))),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tenantId: row.tenant_id ?? null,
      expiresAt: row.expires_at ?? null,
    }));
  }

  /**
   * The key.* audit-trail read: `db.root` in the pre-extraction code →
   * `withBypass` here, scoped by `(resource_id, action LIKE 'key.%')` only.
   */
  async listKeyEvents(keyId: string): Promise<ApiKeyEventRow[]> {
    return this.db.withBypass((tx) =>
      tx
        .select({
          action: legacyAuditEvents.action,
          actor_id: legacyAuditEvents.actor_id,
          created_at: legacyAuditEvents.created_at,
          details: legacyAuditEvents.details,
        })
        .from(legacyAuditEvents)
        .where(and(eq(legacyAuditEvents.resource_id, keyId), like(legacyAuditEvents.action, 'key.%')))
        .orderBy(desc(legacyAuditEvents.created_at))
        .limit(50),
    );
  }
}
