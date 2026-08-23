import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { environments, secrets } from './schema';

/**
 * The per-environment secrets vault (D-5): values are sealed with the
 * kernel's AES-256-GCM envelope (`enc:v1:`) BEFORE they touch the database;
 * an optional kms_ref names an external KMS key for the day the envelope
 * key custody moves there. There is deliberately NO read path that returns
 * plaintext to any console caller — the list view is metadata only, and a
 * runtime fetch surface (L5 runner identities) arrives with the handover
 * track. Rotation replaces the ciphertext; history is not kept (the
 * audit trail records THAT a rotation happened, never WHAT the value was).
 */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

@Injectable()
export class SecretsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Metadata only — never ciphertext, never plaintext. */
  async list(orgId: string, environmentId?: string): Promise<
    Array<{ id: string; environment_id: string; key: string; kms_ref: string | null; rotated_at: string | null; created_at: string }>
  > {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          id: secrets.id,
          environmentId: secrets.environmentId,
          key: secrets.key,
          kmsRef: secrets.kmsRef,
          rotatedAt: secrets.rotatedAt,
          createdAt: secrets.createdAt,
        })
        .from(secrets)
        .where(environmentId ? and(eq(secrets.orgId, orgId), eq(secrets.environmentId, environmentId)) : eq(secrets.orgId, orgId)),
    );
    return rows.map((row) => ({
      id: row.id,
      environment_id: row.environmentId,
      key: row.key,
      kms_ref: row.kmsRef,
      rotated_at: row.rotatedAt,
      created_at: row.createdAt,
    }));
  }

  async set(input: { orgId: string; environmentId: string; key: string; value: string; kmsRef?: string | null; actorId: string }): Promise<void> {
    await this.assertEnvironment(input.orgId, input.environmentId);
    const key = input.key.trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) {
      throw ApiError.validation({ key: 'UPPER_SNAKE_CASE, max 128 chars' });
    }
    if (typeof input.value !== 'string' || input.value.length === 0 || input.value.length > 64 * 1024) {
      throw ApiError.validation({ value: '1..65536 chars' });
    }
    const ciphertext = envelopeEncrypt(input.value);
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(secrets)
        .values({
          orgId: input.orgId,
          environmentId: input.environmentId,
          key,
          valueCiphertext: ciphertext,
          kmsRef: input.kmsRef ?? null,
          rotatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: { valueCiphertext: ciphertext, kmsRef: input.kmsRef ?? null, rotatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
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
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(secrets)
        .set({ valueCiphertext: ciphertext, rotatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
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
    const deleted = await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(secrets).where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId))).returning({ id: secrets.id }),
    );
    if (deleted.length === 0) {
      throw ApiError.notFound('secret');
    }
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
