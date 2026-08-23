import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeDecrypt, envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { environments, secrets } from './schema';

/**
 * The per-environment secrets vault (D-5): values are sealed with the
 * kernel's AES-256-GCM envelope (`enc:v1:`) BEFORE they touch the database;
 * an optional kms_ref names an external KMS key for the day the envelope
 * key custody moves there.
 *
 * Read discipline (the security posture, unchanged from the thin pass):
 *  - the CONSOLE sees metadata only: key, masked preview (derived at write
 *    time — first/last chars), rotation timestamps, version. Plaintext is
 *    never returned to a console caller, full stop.
 *  - the RUNTIME plane (the serving agent-runtime, L3 service identity)
 *    resolves decrypted values through the internal controller ONLY, with
 *    an audit row per resolve and a last_used_at bump per secret.
 *
 * Rotation governance: expires_at + rotation_interval_days drive the daily
 * expiring scan; `version` counts overwrites (audit records THAT a
 * rotation happened, never WHAT the value was).
 */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const DAY_MS = 86_400_000;

@Injectable()
export class SecretsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Metadata only — never ciphertext, never plaintext. */
  async list(orgId: string, environmentId?: string): Promise<
    Array<{
      id: string;
      environment_id: string;
      key: string;
      preview: string | null;
      kms_ref: string | null;
      version: number;
      expires_at: string | null;
      rotation_interval_days: number | null;
      rotated_at: string | null;
      last_used_at: string | null;
      created_at: string;
    }>
  > {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          id: secrets.id,
          environmentId: secrets.environmentId,
          key: secrets.key,
          preview: secrets.preview,
          kmsRef: secrets.kmsRef,
          version: secrets.version,
          expiresAt: secrets.expiresAt,
          rotationIntervalDays: secrets.rotationIntervalDays,
          rotatedAt: secrets.rotatedAt,
          lastUsedAt: secrets.lastUsedAt,
          createdAt: secrets.createdAt,
        })
        .from(secrets)
        .where(environmentId ? and(eq(secrets.orgId, orgId), eq(secrets.environmentId, environmentId)) : eq(secrets.orgId, orgId))
        .orderBy(secrets.key),
    );
    return rows.map((row) => ({
      id: row.id,
      environment_id: row.environmentId,
      key: row.key,
      preview: row.preview,
      kms_ref: row.kmsRef,
      version: row.version,
      expires_at: row.expiresAt,
      rotation_interval_days: row.rotationIntervalDays,
      rotated_at: row.rotatedAt,
      last_used_at: row.lastUsedAt,
      created_at: row.createdAt,
    }));
  }

  /** Vault totals for the secrets page header. */
  async stats(orgId: string): Promise<{ total: number; rotated_30d: number; expiring_soon: number; last_audited: string | null }> {
    const monthAgo = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const soonCutoff = new Date(Date.now() + 14 * DAY_MS).toISOString();
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          total: sql<number>`count(*)::int`,
          rotated30d: sql<number>`(count(*) filter (where ${secrets.rotatedAt} >= ${monthAgo}))::int`,
          expiringSoon: sql<number>`(count(*) filter (where ${secrets.expiresAt} is not null and ${secrets.expiresAt} <= ${soonCutoff}))::int`,
        })
        .from(secrets)
        .where(eq(secrets.orgId, orgId)),
    );
    const auditRows = await this.db.withBypass((tx) =>
      tx.execute(sql`select max(created_at)::text as last_at from audit_events where tenant_id = ${orgId} and action like 'deployment.secret%'`),
    );
    const lastAudited = (auditRows.rows?.[0] as { last_at?: string } | undefined)?.last_at ?? null;
    return {
      total: rows[0]?.total ?? 0,
      rotated_30d: rows[0]?.rotated30d ?? 0,
      expiring_soon: rows[0]?.expiringSoon ?? 0,
      last_audited: lastAudited,
    };
  }

  async set(input: {
    orgId: string;
    environmentId: string;
    key: string;
    value: string;
    kmsRef?: string | null;
    expiresAt?: string | null;
    rotationIntervalDays?: number | null;
    actorId: string;
  }): Promise<void> {
    await this.assertEnvironment(input.orgId, input.environmentId);
    const key = input.key.trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) {
      throw ApiError.validation({ key: 'UPPER_SNAKE_CASE, max 128 chars' });
    }
    if (typeof input.value !== 'string' || input.value.length === 0 || input.value.length > 64 * 1024) {
      throw ApiError.validation({ value: '1..65536 chars' });
    }
    const expiry = this.validateExpiry(input.expiresAt);
    const cadence = this.validateCadence(input.rotationIntervalDays);
    const ciphertext = envelopeEncrypt(input.value);
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(secrets)
        .values({
          orgId: input.orgId,
          environmentId: input.environmentId,
          key,
          valueCiphertext: ciphertext,
          kmsRef: input.kmsRef ?? null,
          preview: derivePreview(input.value),
          expiresAt: expiry,
          rotationIntervalDays: cadence,
          version: 1,
          rotatedAt: now,
        })
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: {
            valueCiphertext: ciphertext,
            kmsRef: input.kmsRef ?? null,
            preview: derivePreview(input.value),
            expiresAt: expiry,
            rotationIntervalDays: cadence,
            version: sql`${secrets.version} + 1`,
            rotatedAt: now,
            updatedAt: now,
          },
        }),
    );
    await this.audit.add({
      action: 'deployment.secret_set',
      resourceType: 'deployment_secret',
      resourceId: `${input.environmentId}:${key}`,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { environment_id: input.environmentId, rotation: true },
    });
  }

  /** Rotate = replace the sealed value (audited, value never recorded). */
  async rotate(input: { orgId: string; secretId: string; value: string; actorId: string }): Promise<void> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ id: secrets.id, environmentId: secrets.environmentId, key: secrets.key })
        .from(secrets)
        .where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId)))
        .limit(1),
    );
    const existing = rows[0];
    if (!existing) {
      throw ApiError.notFound('secret');
    }
    if (typeof input.value !== 'string' || input.value.length === 0 || input.value.length > 64 * 1024) {
      throw ApiError.validation({ value: '1..65536 chars' });
    }
    const ciphertext = envelopeEncrypt(input.value);
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(secrets)
        .set({ valueCiphertext: ciphertext, preview: derivePreview(input.value), version: sql`${secrets.version} + 1`, rotatedAt: now, updatedAt: now })
        .where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'deployment.secret_rotated',
      resourceType: 'deployment_secret',
      resourceId: input.secretId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { environment_id: existing.environmentId, key: existing.key },
    });
  }

  async remove(input: { orgId: string; secretId: string; actorId: string }): Promise<void> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ id: secrets.id })
        .from(secrets)
        .where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('secret');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(secrets).where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'deployment.secret_removed',
      resourceType: 'deployment_secret',
      resourceId: input.secretId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
  }

  /**
   * Runtime resolve (internal plane ONLY): decrypted values for an entire
   * environment — the serving runtime's boot-time env bundle. Every call is
   * audited (keys list, never values) and bumps last_used_at.
   */
  async resolveForEnvironment(input: { orgId: string; environmentId: string; actorId: string }): Promise<Record<string, string>> {
    await this.assertEnvironment(input.orgId, input.environmentId);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ key: secrets.key, valueCiphertext: secrets.valueCiphertext })
        .from(secrets)
        .where(and(eq(secrets.orgId, input.orgId), eq(secrets.environmentId, input.environmentId))),
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      // A secret that no longer decrypts (e.g. envelope key custody rotated)
      // fails the whole resolve loudly — a partially-sealed environment must
      // not serve with silently-missing credentials.
      out[row.key] = envelopeDecrypt(row.valueCiphertext);
    }
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(secrets)
        .set({ lastUsedAt: now })
        .where(and(eq(secrets.orgId, input.orgId), eq(secrets.environmentId, input.environmentId))),
    );
    await this.audit.add({
      action: 'deployment.secret_resolved',
      resourceType: 'deployment_secret',
      resourceId: input.environmentId,
      actorType: 'service',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { environment_id: input.environmentId, keys: Object.keys(out), count: Object.keys(out).length },
    });
    return out;
  }

  /** The daily expiring scan (worker): soon-expiring + cadence-overdue secrets. */
  async scanExpiring(withinDays: number): Promise<Array<{ orgId: string; environmentId: string; key: string; expiresAt: string | null; overdueByDays: number }>> {
    const soonCutoff = new Date(Date.now() + withinDays * DAY_MS).toISOString();
    const overdueCutoff = new Date(Date.now() - DAY_MS).toISOString();
    return this.db.withBypass((tx) =>
      tx
        .select({
          orgId: secrets.orgId,
          environmentId: secrets.environmentId,
          key: secrets.key,
          expiresAt: secrets.expiresAt,
          rotatedAt: secrets.rotatedAt,
          intervalDays: secrets.rotationIntervalDays,
        })
        .from(secrets)
        .where(
          or(
            and(isNotNull(secrets.expiresAt), lte(secrets.expiresAt, soonCutoff)),
            // Cadence overdue: rotated_at + interval already in the past.
            sql`${secrets.rotationIntervalDays} is not null and (${secrets.rotatedAt} + (${secrets.rotationIntervalDays} || ' days')::interval) < ${overdueCutoff}`,
          ),
        )
        .limit(500),
    ).then((rows) =>
      rows.map((row) => ({
        orgId: row.orgId,
        environmentId: row.environmentId,
        key: row.key,
        expiresAt: row.expiresAt,
        overdueByDays:
          row.intervalDays && row.rotatedAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(row.rotatedAt) - row.intervalDays * DAY_MS) / DAY_MS))
            : 0,
      })),
    );
  }

  private validateExpiry(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw ApiError.validation({ expires_at: 'must be an ISO timestamp' });
    }
    return new Date(parsed).toISOString();
  }

  private validateCadence(value: number | null | undefined): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw ApiError.validation({ rotation_interval_days: '1..3650 days' });
    }
    return value;
  }

  private async assertEnvironment(orgId: string, environmentId: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, environmentId), eq(environments.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('environment in this organization');
    }
  }
}

/** Masked write-time hint: never decryptable, reveals at most 3 edge chars. */
function derivePreview(value: string): string {
  if (value.length <= 3) {
    return '•••';
  }
  if (value.length <= 8) {
    return `${value.slice(0, 1)}•••`;
  }
  return `${value.slice(0, 2)}•••${value.slice(-1)}`;
}
