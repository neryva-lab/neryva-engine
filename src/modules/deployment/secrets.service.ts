import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeDecrypt, envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { type IDeploymentSecretRepository, type SecretMetadata } from './repositories/secret.repository';
import { DEPLOYMENT_SECRET_REPOSITORY } from './repositories/repository-tokens';
import { type IDeploymentEnvironmentRepository } from './repositories/environment.repository';
import { DEPLOYMENT_ENVIRONMENT_REPOSITORY } from './repositories/repository-tokens';

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
 *
 * Persistence goes through the P3 repository ports (P3) — the concrete
 * implementations are selected by `DB_PROVIDER`. This service is
 * provider-blind: envelope encryption/decryption, key derivation
 * (`derivePreview`), expiry/cadence validation, and the
 * plaintext-never-to-console guarantee all stay here.
 */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const DAY_MS = 86_400_000;

@Injectable()
export class SecretsService {
  constructor(
    @Inject(DEPLOYMENT_SECRET_REPOSITORY) private readonly secretsRepo: IDeploymentSecretRepository,
    @Inject(DEPLOYMENT_ENVIRONMENT_REPOSITORY) private readonly environmentsRepo: IDeploymentEnvironmentRepository,
    private readonly audit: AuditService,
  ) {}

  /** Metadata only — never ciphertext, never plaintext. */
  async list(orgId: string, environmentId?: string): Promise<SecretMetadata[]> {
    return this.secretsRepo.listMetadata(orgId, environmentId);
  }

  /** Vault totals for the secrets page header. */
  async stats(orgId: string): Promise<{ total: number; rotated_30d: number; expiring_soon: number; last_audited: string | null }> {
    const counts = await this.secretsRepo.stats(orgId);
    const lastAudited = await this.secretsRepo.lastSecretAuditAt(orgId);
    return {
      total: counts.total,
      rotated_30d: counts.rotated_30d,
      expiring_soon: counts.expiring_soon,
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
    await this.secretsRepo.upsertSecret({
      orgId: input.orgId,
      environmentId: input.environmentId,
      key,
      valueCiphertext: ciphertext,
      kmsRef: input.kmsRef ?? null,
      preview: derivePreview(input.value),
      expiresAt: expiry,
      rotationIntervalDays: cadence,
      now,
    });
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
    const existing = await this.secretsRepo.findById(input.orgId, input.secretId);
    if (!existing) {
      throw ApiError.notFound('secret');
    }
    if (typeof input.value !== 'string' || input.value.length === 0 || input.value.length > 64 * 1024) {
      throw ApiError.validation({ value: '1..65536 chars' });
    }
    const ciphertext = envelopeEncrypt(input.value);
    const now = new Date().toISOString();
    await this.secretsRepo.rotateSecret({
      orgId: input.orgId,
      secretId: input.secretId,
      valueCiphertext: ciphertext,
      preview: derivePreview(input.value),
      now,
    });
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
    const existing = await this.secretsRepo.findById(input.orgId, input.secretId);
    if (!existing) {
      throw ApiError.notFound('secret');
    }
    await this.secretsRepo.deleteSecret(input.orgId, input.secretId);
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
    const rows = await this.secretsRepo.fetchCiphertexts(input.orgId, input.environmentId);
    const out: Record<string, string> = {};
    for (const row of rows) {
      // A secret that no longer decrypts (e.g. envelope key custody rotated)
      // fails the whole resolve loudly — a partially-sealed environment must
      // not serve with silently-missing credentials.
      out[row.key] = envelopeDecrypt(row.valueCiphertext);
    }
    const now = new Date().toISOString();
    await this.secretsRepo.touchLastUsed(input.orgId, input.environmentId, now);
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
    const rows = await this.secretsRepo.scanExpiring(withinDays);
    return rows.map((row) => ({
      orgId: row.orgId,
      environmentId: row.environmentId,
      key: row.key,
      expiresAt: row.expiresAt,
      overdueByDays:
        row.intervalDays && row.rotatedAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(row.rotatedAt) - row.intervalDays * DAY_MS) / DAY_MS))
          : 0,
    }));
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
    // Throws `not_found` ('environment in this organization') when missing —
    // the exact error the previous inline query produced.
    await this.environmentsRepo.getInOrg(orgId, environmentId);
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
