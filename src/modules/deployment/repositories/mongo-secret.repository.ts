/**
 * MongoDB lane for `IDeploymentSecretRepository` (P3) — the secrets vault as
 * driven by `SecretsService`.
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Every method is one `withOrg` unit (plan D5);
 * the tenant predicate is enforced by `TenantScopedCollection` (plan D6).
 * `scanExpiring` runs through `withBypass` with an explicit filter, exactly
 * like the pg lane's `withBypass` unit.
 *
 * The `(environment_id, key)` unique claim is enforced by the P1 migration
 * registry. The set-overwrite path is one upsert (`$inc: { version: 1 }` +
 * `$setOnInsert` for the insert shape): the insert case yields version 1, the
 * overwrite case bumps the version and restamps `rotated_at` — the same
 * semantics as the pg `onConflictDoUpdate` unit.
 *
 * The repository carries ciphertext only; envelope encryption/decryption,
 * `derivePreview`, and expiry/cadence validation stay in the service.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ExpiringSecret, IDeploymentSecretRepository, SecretMetadata } from './secret.repository';
import { binUuid, deploymentCollections } from './mongo-documents';
import type { SecretMongoDoc } from './mongo-documents';

const DAY_MS = 86_400_000;

export class MongoDeploymentSecretRepository implements IDeploymentSecretRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...deploymentCollections(db) };
  }

  async listMetadata(orgId: string, environmentId?: string): Promise<SecretMetadata[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.secrets
        .find(
          orgId,
          environmentId ? { environment_id: binUuid(environmentId, 'environmentId') } : {},
          { ...t.session, projection: { value_ciphertext: 0 } },
        )
        .sort({ key: 1 })
        .toArray();
      return docs.map((doc) => ({
        id: doc.id.toUUID().toString(),
        environment_id: doc.environment_id.toUUID().toString(),
        key: doc.key,
        preview: doc.preview,
        kms_ref: doc.kms_ref,
        version: doc.version,
        expires_at: doc.expires_at,
        rotation_interval_days: doc.rotation_interval_days,
        rotated_at: doc.rotated_at,
        last_used_at: doc.last_used_at,
        created_at: doc.created_at,
      }));
    });
  }

  async stats(orgId: string): Promise<{ total: number; rotated_30d: number; expiring_soon: number }> {
    const db = this.mongo.root;
    const monthAgo = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const soonCutoff = new Date(Date.now() + 14 * DAY_MS).toISOString();
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const total = await t.secrets.countDocuments(orgId, {}, t.session);
      const rotated30d = await t.secrets.countDocuments(orgId, { rotated_at: { $gte: monthAgo } }, t.session);
      const expiringSoon = await t.secrets.countDocuments(
        orgId,
        { expires_at: { $ne: null, $lte: soonCutoff } },
        t.session,
      );
      return { total, rotated_30d: rotated30d, expiring_soon: expiringSoon };
    });
  }

  async lastSecretAuditAt(orgId: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      // tenant_id tolerates both the string and Binary-subtype-4 forms: the
      // audit service has not been ported to the mongo lane yet, so no writer
      // exists on this lane today and the match shape is deliberately loose
      // ("strings accepted during the port transition", per the migration
      // registry's own validator notes).
      const rows = await db
        .collection('audit_events')
        .aggregate(
          [
            {
              $match: {
                tenant_id: { $in: [orgId, binUuid(orgId, 'orgId')] },
                action: { $regex: '^deployment\\.secret' },
              },
            },
            { $group: { _id: null, last_at: { $max: '$created_at' } } },
          ],
          { session: ctx.session },
        )
        .toArray();
      return (rows[0] as { last_at?: string } | undefined)?.last_at ?? null;
    });
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
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.secrets.unsafeNative.updateOne(
        {
          organization_id: binUuid(input.orgId, 'orgId'),
          environment_id: binUuid(input.environmentId, 'environmentId'),
          key: input.key,
        },
        {
          $set: {
            value_ciphertext: input.valueCiphertext,
            kms_ref: input.kmsRef,
            preview: input.preview,
            expires_at: input.expiresAt,
            rotation_interval_days: input.rotationIntervalDays,
            rotated_at: input.now,
            updated_at: input.now,
          },
          $setOnInsert: {
            id: binUuid(uuidv7()),
            organization_id: binUuid(input.orgId, 'orgId'),
            environment_id: binUuid(input.environmentId, 'environmentId'),
            key: input.key,
            created_at: input.now,
          },
          $inc: { version: 1 },
        },
        { session: ctx.session, upsert: true },
      );
    });
  }

  async findById(orgId: string, secretId: string): Promise<{ id: string; environmentId: string; key: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.secrets.findOne(orgId, { id: binUuid(secretId, 'secretId') }, t.session);
      return doc
        ? { id: doc.id.toUUID().toString(), environmentId: doc.environment_id.toUUID().toString(), key: doc.key }
        : null;
    });
  }

  async rotateSecret(input: { orgId: string; secretId: string; valueCiphertext: string; preview: string; now: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.secrets.updateOne(
        input.orgId,
        { id: binUuid(input.secretId, 'secretId') },
        {
          $set: { value_ciphertext: input.valueCiphertext, preview: input.preview, rotated_at: input.now, updated_at: input.now },
          $inc: { version: 1 },
        },
        t.session,
      );
    });
  }

  async deleteSecret(orgId: string, secretId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.secrets.deleteOne(orgId, { id: binUuid(secretId, 'secretId') }, t.session);
    });
  }

  async fetchCiphertexts(orgId: string, environmentId: string): Promise<Array<{ key: string; valueCiphertext: string }>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.secrets
        .find(
          orgId,
          { environment_id: binUuid(environmentId, 'environmentId') },
          { ...t.session, projection: { key: 1, value_ciphertext: 1 } },
        )
        .toArray();
      return docs.map((d) => ({ key: d.key, valueCiphertext: d.value_ciphertext }));
    });
  }

  async touchLastUsed(orgId: string, environmentId: string, now: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.secrets.updateMany(
        orgId,
        { environment_id: binUuid(environmentId, 'environmentId') },
        { $set: { last_used_at: now } },
        t.session,
      );
    });
  }

  async scanExpiring(withinDays: number): Promise<ExpiringSecret[]> {
    const db = this.mongo.root;
    const soonCutoff = new Date(Date.now() + withinDays * DAY_MS).toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const docs = await db
        .collection<SecretMongoDoc>('product_deployment_secrets')
        .find(
          {
            $or: [
              { expires_at: { $ne: null, $lte: soonCutoff } },
              { rotation_interval_days: { $ne: null } },
            ],
          },
          { session: ctx.session },
        )
        .limit(500)
        .toArray();
      const out: ExpiringSecret[] = [];
      for (const doc of docs) {
        if (doc.expires_at) {
          out.push({
            orgId: doc.organization_id.toUUID().toString(),
            environmentId: doc.environment_id.toUUID().toString(),
            key: doc.key,
            expiresAt: doc.expires_at,
            rotatedAt: doc.rotated_at,
            intervalDays: doc.rotation_interval_days,
          });
          continue;
        }
        // Rotation-overdue branch: the pg lane computes
        // `rotated_at + intervalDays < now - 1 day` in SQL; rotated_at is an
        // ISO string on this lane, so the arithmetic happens here in JS.
        if (doc.rotation_interval_days != null && doc.rotated_at) {
          const overdueByMs = Date.now() - Date.parse(doc.rotated_at) - doc.rotation_interval_days * DAY_MS;
          if (overdueByMs > DAY_MS) {
            out.push({
              orgId: (doc.organization_id as { toUUID(): { toString(): string } }).toUUID().toString(),
              environmentId: (doc.environment_id as { toUUID(): { toString(): string } }).toUUID().toString(),
              key: doc.key,
              expiresAt: doc.expires_at,
              rotatedAt: doc.rotated_at,
              intervalDays: doc.rotation_interval_days,
            });
          }
        }
      }
      return out;
    });
  }
}
