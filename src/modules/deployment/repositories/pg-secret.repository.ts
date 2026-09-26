/**
 * PostgreSQL implementation of `IDeploymentSecretRepository` (P3).
 *
 * Mechanical move of the `SecretsService` persistence units: byte-identical
 * queries, the same transaction boundaries, the same error codes. Envelope
 * encryption/decryption, key/preview derivation, expiry/cadence validation,
 * and the metadata-only projection stay in the service; the repository
 * carries ciphertext only.
 */
import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { secrets } from '../schema';
import type {
  ExpiringSecret,
  IDeploymentSecretRepository,
  SecretMetadata,
} from './secret.repository';

const DAY_MS = 86_400_000;

export class PgDeploymentSecretRepository implements IDeploymentSecretRepository {
  constructor(private readonly db: DbService) {}

  async listMetadata(orgId: string, environmentId?: string): Promise<SecretMetadata[]> {
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

  async stats(orgId: string): Promise<{ total: number; rotated_30d: number; expiring_soon: number }> {
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
    return {
      total: rows[0]?.total ?? 0,
      rotated_30d: rows[0]?.rotated30d ?? 0,
      expiring_soon: rows[0]?.expiringSoon ?? 0,
    };
  }

  async lastSecretAuditAt(orgId: string): Promise<string | null> {
    const auditRows = await this.db.withBypass((tx) =>
      tx.execute(sql`select max(created_at)::text as last_at from audit_events where tenant_id = ${orgId} and action like 'deployment.secret%'`),
    );
    return (auditRows.rows?.[0] as { last_at?: string } | undefined)?.last_at ?? null;
  }

  async upsertSecret(input: {
    orgId: string;
    environmentId: string;
    key: string;
    valueCiphertext: string;
    kmsRef: string | null;
    preview: string;
    expiresAt: string | null;
    rotationIntervalDays: number | null;
    now: string;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(secrets)
        .values({
          orgId: input.orgId,
          environmentId: input.environmentId,
          key: input.key,
          valueCiphertext: input.valueCiphertext,
          kmsRef: input.kmsRef,
          preview: input.preview,
          expiresAt: input.expiresAt,
          rotationIntervalDays: input.rotationIntervalDays,
          version: 1,
          rotatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: {
            valueCiphertext: input.valueCiphertext,
            kmsRef: input.kmsRef,
            preview: input.preview,
            expiresAt: input.expiresAt,
            rotationIntervalDays: input.rotationIntervalDays,
            version: sql`${secrets.version} + 1`,
            rotatedAt: input.now,
            updatedAt: input.now,
          },
        }),
    );
  }

  async findById(orgId: string, secretId: string): Promise<{ id: string; environmentId: string; key: string } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: secrets.id, environmentId: secrets.environmentId, key: secrets.key })
        .from(secrets)
        .where(and(eq(secrets.id, secretId), eq(secrets.orgId, orgId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async rotateSecret(input: { orgId: string; secretId: string; valueCiphertext: string; preview: string; now: string }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(secrets)
        .set({ valueCiphertext: input.valueCiphertext, preview: input.preview, version: sql`${secrets.version} + 1`, rotatedAt: input.now, updatedAt: input.now })
        .where(and(eq(secrets.id, input.secretId), eq(secrets.orgId, input.orgId))),
    );
  }

  async deleteSecret(orgId: string, secretId: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) => tx.delete(secrets).where(and(eq(secrets.id, secretId), eq(secrets.orgId, orgId))));
  }

  async fetchCiphertexts(orgId: string, environmentId: string): Promise<Array<{ key: string; valueCiphertext: string }>> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ key: secrets.key, valueCiphertext: secrets.valueCiphertext })
        .from(secrets)
        .where(and(eq(secrets.orgId, orgId), eq(secrets.environmentId, environmentId))),
    );
    return rows;
  }

  async touchLastUsed(orgId: string, environmentId: string, now: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(secrets)
        .set({ lastUsedAt: now })
        .where(and(eq(secrets.orgId, orgId), eq(secrets.environmentId, environmentId))),
    );
  }

  async scanExpiring(withinDays: number): Promise<ExpiringSecret[]> {
    const soonCutoff = new Date(Date.now() + withinDays * DAY_MS).toISOString();
    const overdueCutoff = new Date(Date.now() - DAY_MS).toISOString();
    const rows = await this.db.withBypass((tx) =>
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
            sql`${secrets.rotationIntervalDays} is not null and (${secrets.rotatedAt} + (${secrets.rotationIntervalDays} || ' days')::interval) < ${overdueCutoff}`,
          ),
        )
        .limit(500),
    );
    return rows.map((row) => ({
      orgId: row.orgId,
      environmentId: row.environmentId,
      key: row.key,
      expiresAt: row.expiresAt,
      rotatedAt: row.rotatedAt,
      intervalDays: row.intervalDays,
    }));
  }
}
