import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { NotificationsService } from '../notifications/notifications.service';
import {
  API_KEY_REPOSITORY,
  STUDIO_PROJECT_KEY_REPOSITORY,
} from './repositories/repository-tokens';
import type {
  ApiKeyPatch,
  IApiKeyRepository,
  IStudioProjectKeyRepository,
} from './repositories/keys.repository';

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
 *
 * Persistence (P3): all database work goes through the `IApiKeyRepository`
 * / `IStudioProjectKeyRepository` ports. This service owns validation,
 * key-material generation, audit writes, event-bus hints, and
 * notifications. Public method signatures and behavior are unchanged.
 */
export const L2_KEY_PREFIX = 'nrv_live_';
/** Roles the engine may mint for org keys (platform staff roles excluded — those are operator-issued). */
export const ORG_KEY_ROLES = ['operator', 'auditor'] as const;

@Injectable()
export class KeysService {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly apiKeys: IApiKeyRepository,
    @Inject(STUDIO_PROJECT_KEY_REPOSITORY) private readonly projectKeys: IStudioProjectKeyRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notifications: NotificationsService,
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
    const rows = await this.apiKeys.listKeys(orgId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      role: row.role,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expiresAt: row.expires_at ?? null,
      revoked: row.revoked,
      usageCount: row.usage_count,
      lastUsedAt: row.last_used_at ?? null,
      createdAt: row.created_at,
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
    /** Optional project binding at issue time (K-2). */
    projectId?: string | null;
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
    const now = new Date().toISOString();
    const created = await this.apiKeys.createKey({
      id: randomUUID(),
      orgId: input.orgId,
      name,
      keyHash: sha256Hex(raw),
      prefix: `${L2_KEY_PREFIX}${raw.slice(L2_KEY_PREFIX.length, L2_KEY_PREFIX.length + 8)}`,
      role: input.role,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'key.created',
      resourceType: 'api_key',
      resourceId: created.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { role: input.role, scopes: input.scopes, wildcard: input.scopes.includes('*'), name },
    });
    // K-2: optional project binding AT ISSUE TIME (the engine-owned binding
    // table — one step instead of create-then-bind).
    if (input.projectId) {
      await this.projectKeys.bindKeyToProject({
        orgId: input.orgId,
        apiKeyId: created.id,
        projectId: input.projectId,
        boundBy: input.actorId,
      });
    }
    await this.notifyKeyEvent(input.orgId, 'API key created', `The key "${name}" was created.`, 'created');
    return { key: raw, id: created.id };
  }

  async revoke(input: { orgId: string; keyId: string; actorId: string }): Promise<void> {
    await this.apiKeys.revokeKey(input.orgId, input.keyId);
    await this.audit.add({
      action: 'key.revoked',
      resourceType: 'api_key',
      resourceId: input.keyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
    // Durable revocation log input: satellites converge on this via the feed.
    await this.events.emit(EngineEvents.KeyRevoked, { orgId: input.orgId, keyId: input.keyId });
    await this.notifyKeyEvent(input.orgId, 'API key revoked', 'A key was revoked. Applications using it will now receive 401s.', 'revoked');
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
    // Unauthenticated auth path: the port resolves the row by hash alone;
    // the org comes from the row's tenant_id.
    const row = await this.apiKeys.findByKeyHash(keyHash);
    if (!row) {
      return response({ reason: 'unknown' });
    }
    if (row.revoked) {
      return response({ reason: 'revoked' });
    }
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      return response({ reason: 'expired' });
    }
    return {
      valid: true,
      cache_ttl_seconds: 15,
      key_id: row.id,
      role: row.role,
      org_id: row.tenant_id ?? null,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expires_at: row.expires_at ?? null,
    };
  }

  // -- K-1: update (rename / scope change) ----------------------------------

  async update(input: { orgId: string; keyId: string; name?: string; scopes?: string[]; actorId: string }): Promise<void> {
    const patch: ApiKeyPatch = {};
    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 128);
      if (name.length < 1) {
        throw ApiError.validation({ name: 'a key name is required' });
      }
      patch.name = name;
    }
    if (input.scopes !== undefined) {
      if (input.scopes.includes('*') && !input.scopes.every((s) => s === '*')) {
        throw ApiError.validation({ scopes: "'*' cannot be mixed with other scopes" });
      }
      patch.scopes = input.scopes;
    }
    // The port reads the row (not_found when missing or revoked) and applies
    // the patch with an updated_at bump.
    await this.apiKeys.updateKey(input.orgId, input.keyId, patch);
    await this.audit.add({
      action: 'key.updated',
      resourceType: 'api_key',
      resourceId: input.keyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { renamed: input.name !== undefined, scopes_changed: input.scopes !== undefined },
    });
  }

  // -- Rotation (Stripe semantics): same row, new secret, old key dies now --

  async rotate(input: { orgId: string; keyId: string; actorId: string }): Promise<{ key: string }> {
    const raw = `${L2_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    // The port reads the row (not_found when missing or revoked), swaps the
    // secret hash + prefix, and resets usage_count.
    const existing = await this.apiKeys.rotateKey(input.orgId, input.keyId, {
      keyHash: sha256Hex(raw),
      prefix: `${L2_KEY_PREFIX}${raw.slice(L2_KEY_PREFIX.length, L2_KEY_PREFIX.length + 8)}`,
    });
    await this.audit.add({
      action: 'key.rotated',
      resourceType: 'api_key',
      resourceId: input.keyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { note: 'old secret invalidated immediately; identity/scopes preserved' },
    });
    // The old secret is dead from this instant - the revocation feed spreads it.
    await this.events.emit(EngineEvents.KeyRevoked, { orgId: input.orgId, keyId: input.keyId, kind: 'api_key_rotation' });
    await this.notifyKeyEvent(input.orgId, 'API key rotated', `The key "${existing.name}" was rotated - the previous secret stopped working immediately.`, 'rotated');
    return { key: raw };
  }

  // -- K-3: per-key detail - row + binding + counters + event trail ----------

  async detail(orgId: string, keyId: string): Promise<Record<string, unknown>> {
    const key = await this.apiKeys.getKey(orgId, keyId);
    if (!key) {
      throw ApiError.notFound('api key');
    }
    const [binding, events] = await Promise.all([
      this.projectKeys.getBindingByKeyId(orgId, keyId),
      this.apiKeys.listKeyEvents(keyId),
    ]);
    const daysToExpiry = key.expires_at ? Math.ceil((Date.parse(key.expires_at) - Date.now()) / 86_400_000) : null;
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      role: key.role,
      scopes: key.scopes,
      revoked: key.revoked,
      expires_at: key.expires_at,
      days_to_expiry: daysToExpiry,
      created_at: key.created_at,
      usage_count: key.usage_count,
      last_used_at: key.last_used_at,
      project_binding: binding ? { project_id: binding.projectId } : null,
      events,
    };
  }

  // -- K-4: expiring-key scan (the daily keys worker calls this) -------------

  async notifyExpiringKeys(withinDays: number): Promise<number> {
    const horizon = new Date(Date.now() + withinDays * 86_400_000).toISOString();
    const rows = await this.apiKeys.scanExpiringKeys(horizon);
    let sent = 0;
    for (const row of rows) {
      const days = Math.ceil((Date.parse(row.expiresAt as string) - Date.now()) / 86_400_000);
      if (row.tenantId) {
        await this.notifications
          .notifyOrgRoles(row.tenantId, ['owner', 'admin'], {
            kind: 'system',
            severity: days <= 3 ? 'warn' : 'info',
            title: `API key "${row.name}" expires in ${days} day(s)`,
            body: 'Rotate the key before it expires to avoid service interruption.',
            data: { route: '/platform/api-keys', key_id: row.id, days },
          })
          .catch(() => undefined);
        sent += 1;
      }
    }
    return sent;
  }

  // -- Bulk validation for satellite cache warm-up ---------------------------

  async validateManyHashes(hashes: string[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    for (const hash of hashes.slice(0, 200)) {
      results[hash] = await this.validateByHash(hash);
    }
    return results;
  }

  private async notifyKeyEvent(orgId: string, title: string, body: string, event: string): Promise<void> {
    await this.notifications
      .notifyOrgRoles(orgId, ['owner', 'admin'], {
        kind: 'system',
        severity: event === 'created' ? 'info' : 'warn',
        title,
        body,
        data: { route: '/platform/api-keys', event },
      })
      .catch(() => undefined);
  }
}
