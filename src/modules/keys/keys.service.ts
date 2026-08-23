import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { legacyApiKeys } from '../../common/infra/db/legacy-schema';

/**
 * Key/token authority — ENGINE side of handover A-1 (ledger agent-runtime).
 *
 * The engine becomes the issuer of `nrv_live_` API keys while the Python
 * runtime keeps verifying them. Mechanics of the documented dual-write
 * window (ownership-map.json → api_keys): the table is Python-owned DDL;
 * the engine now holds the WRITE path (console key CRUD) and the runtime
 * holds read/verify. During the window the runtime also still accepts its
 * own legacy writes; the A-1 flip makes the engine the only writer.
 *
 * Key format mirrors the Python engine exactly: `nrv_live_` + 32 bytes
 * base64url; only the SHA-256 hash is stored; lookup is by hash.
 *
 * NOTE: project-scoped keys (project_id/owner_account_id/org_id columns)
 * arrive with Python Alembic 0017 (plan P3) — until then the engine writes
 * only the existing columns; this service is the single choke point so the
 * columns land here, nowhere else.
 */
export const L2_KEY_PREFIX = 'nrv_live_';
/** Roles the engine may mint for org keys (platform staff roles excluded — those are operator-issued). */
export const ORG_KEY_ROLES = ['operator', 'auditor'] as const;

@Injectable()
export class KeysService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<
    Array<{
      id: string;
      name: string;
      prefix: string;
      role: string;
      scopes: string[];
      expiresAt: string | null;
      revoked: boolean;
      usageCount: number;
      lastUsedAt: string | null;
      createdAt: string;
    }>
  > {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(legacyApiKeys).where(eq(legacyApiKeys.tenantId, orgId)).orderBy(desc(legacyApiKeys.createdAt)).limit(200),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      role: row.role,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expiresAt: row.expiresAt ?? null,
      revoked: row.revoked,
      usageCount: row.usageCount,
      lastUsedAt: row.lastUsedAt ?? null,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Issue a key. The raw key is returned ONCE (this response only); the
   * table stores its hash. Wildcard scopes (`*`) require the caller to
   * have passed step-up (controller-enforced per the access-model).
   */
  async issue(input: {
    orgId: string;
    name: string;
    role: string;
    scopes: string[];
    expiresAt: string | null;
    actorId: string;
  }): Promise<{ key: string; id: string }> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a key name is required' });
    }
    if (!ORG_KEY_ROLES.includes(input.role as (typeof ORG_KEY_ROLES)[number])) {
      throw ApiError.validation({ role: `org keys may use: ${ORG_KEY_ROLES.join(', ')}` });
    }
    if (input.scopes.includes('*') && !input.scopes.every((s) => s === '*')) {
      throw ApiError.validation({ scopes: "'*' cannot be mixed with other scopes" });
    }
    if (input.expiresAt) {
      const exp = Date.parse(input.expiresAt);
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        throw ApiError.validation({ expires_at: 'must be a future ISO timestamp' });
      }
    }

    const raw = `${L2_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(legacyApiKeys)
        .values({
          id: randomUUID(),
          name,
          keyHash: sha256Hex(raw),
          prefix: `${L2_KEY_PREFIX}${raw.slice(L2_KEY_PREFIX.length, L2_KEY_PREFIX.length + 8)}`,
          role: input.role,
          tenantId: input.orgId,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
          revoked: false,
          usageCount: 0,
          mfaEnabled: false,
        })
        .returning({ id: legacyApiKeys.id }),
    );
    await this.audit.add({
      action: 'key.created',
      resourceType: 'api_key',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { role: input.role, scopes: input.scopes, wildcard: input.scopes.includes('*'), name },
    });
    return { key: raw, id: inserted[0].id };
  }

  async revoke(input: { orgId: string; keyId: string; actorId: string }): Promise<void> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select({ id: legacyApiKeys.id }).from(legacyApiKeys).where(and(eq(legacyApiKeys.id, input.keyId), eq(legacyApiKeys.tenantId, input.orgId))).limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('api key');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(legacyApiKeys).set({ revoked: true, updatedAt: new Date().toISOString() }).where(eq(legacyApiKeys.id, input.keyId)),
    );
    await this.audit.add({
      action: 'key.revoked',
      resourceType: 'api_key',
      resourceId: input.keyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  /**
   * Satellite validation lookup (the runtime-side cache's origin): the
   * runtime sends the SHA-256 it computed; the engine answers with the
   * principal data + a cache TTL. Negative answers are explicit
   * ({valid:false}) so the runtime may cache them briefly too — a missing
   * key is not an error, it is an authentication decision.
   */
  async validateByHash(keyHash: string): Promise<{
    valid: boolean;
    cache_ttl_seconds: number;
    key_id?: string;
    role?: string;
    org_id?: string | null;
    scopes?: string[];
    expires_at?: string | null;
    reason?: 'unknown' | 'revoked' | 'expired';
  }> {
    const response = (over: Record<string, unknown>) => ({ valid: false, cache_ttl_seconds: 5, ...over });
    if (!/^[0-9a-f]{64}$/.test(keyHash)) {
      throw ApiError.validation({ key_hash: 'must be a 64-char sha-256 hex digest' });
    }
    const rows = await this.db.root.select().from(legacyApiKeys).where(eq(legacyApiKeys.keyHash, keyHash)).limit(1);
    const row = rows[0];
    if (!row) {
      return response({ reason: 'unknown' });
    }
    if (row.revoked) {
      return response({ reason: 'revoked' });
    }
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
      return response({ reason: 'expired' });
    }
    return {
      valid: true,
      cache_ttl_seconds: 15,
      key_id: row.id,
      role: row.role,
      org_id: row.tenantId ?? null,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expires_at: row.expiresAt ?? null,
    };
  }
}

declare global {
  // crypto.randomUUID is available on Node 19+ as a global; the explicit
  // import keeps older Node toolchains compiling.
}
