import type { Db, Filter } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ProviderCredential, ProviderEnablement } from '../provider-credentials.schema';
import type { IProviderCredentialRepository } from './provider-credential.repository';
import {
  binUuid,
  isDuplicateKey,
  toProviderCredential,
  toProviderEnablement,
  type ProviderCredentialMongoDoc,
  type ProviderEnablementMongoDoc,
} from './mongo-documents';

/**
 * MongoDB lane for `IProviderCredentialRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings. Every
 * method is one `withOrg` unit (plan D5); every tenant collection access
 * carries an explicit `organization_id` predicate (plan D6 — there is no
 * RLS on this lane).
 *
 * Secrecy boundary: the service seals the secret (envelopeEncrypt) and
 * derives `secretFingerprint`/`externalRef` BEFORE calling — plaintext
 * never crosses this interface; only sealed rows are persisted/returned.
 * The guarded update is the concurrency authority for rotate; revoke is
 * check-then-act; duplicate keys (11000) map to conflict, never raw to the
 * caller.
 */
export class MongoProviderCredentialRepository implements IProviderCredentialRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly mongo: MongoDbService) {}

  private credentials(db: Db) {
    return db.collection<ProviderCredentialMongoDoc>('provider_credentials');
  }

  private enablements(db: Db) {
    return db.collection<ProviderEnablementMongoDoc>('provider_enablements');
  }

  /** The DB never returns raw duplicate keys — an (org, provider, external_ref) collision is a client conflict. */
  private static mapDuplicateKey(err: unknown): never {
    if (isDuplicateKey(err)) {
      throw ApiError.conflict(
        'a credential with this external ref already exists for this org and provider',
      );
    }
    throw err as Error;
  }

  /** Provision a new credential (sealed secret only — never plaintext). */
  async provisionCredential(input: {
    orgId: string;
    provider: string;
    label: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    source: 'platform' | 'byok';
    createdBy: string;
  }): Promise<ProviderCredential> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = binUuid(input.orgId, 'orgId');
      const now = new Date().toISOString();
      const doc: ProviderCredentialMongoDoc = {
        id: binUuid(uuidv7()),
        organization_id: orgId,
        provider: input.provider,
        label: input.label,
        external_ref: input.externalRef,
        source: input.source,
        status: 'active',
        secret_sealed: input.sealedSecret,
        secret_fingerprint: input.secretFingerprint,
        created_by: input.createdBy,
        rotated_by: null,
        created_at: now,
        rotated_at: null,
        revoked_at: null,
        revocation_reason: null,
        compromised: false,
      };
      try {
        await this.credentials(db).insertOne(doc, { session: ctx.session });
      } catch (err) {
        MongoProviderCredentialRepository.mapDuplicateKey(err);
      }
      const inserted = await this.credentials(db).findOne(
        { id: doc.id },
        { session: ctx.session },
      );
      if (!inserted) throw new Error('mongo provision: inserted row vanished');
      return toProviderCredential(inserted);
    });
  }

  /**
   * Atomic in-place key swap: the sealed material is replaced, status stays
   * active. Revoked rows never resurrect. A concurrent revoke between the
   * pre-check and the update is caught by the `status: {$ne: 'revoked'}`
   * predicate inside the update itself — the guarded update is the
   * authority, the pre-check is only for the error message.
   */
  async rotateCredential(input: {
    orgId: string;
    credentialId: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    rotatedBy: string;
  }): Promise<ProviderCredential> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = binUuid(input.orgId, 'orgId');
      const credentialId = binUuid(input.credentialId, 'credentialId');
      let matched = 0;
      try {
        const result = await this.credentials(db).updateOne(
          { id: credentialId, organization_id: orgId, status: { $ne: 'revoked' } },
          {
            $set: {
              secret_sealed: input.sealedSecret,
              secret_fingerprint: input.secretFingerprint,
              external_ref: input.externalRef,
              rotated_by: input.rotatedBy,
              rotated_at: new Date().toISOString(),
            },
          },
          { session: ctx.session },
        );
        matched = result.matchedCount;
      } catch (err) {
        MongoProviderCredentialRepository.mapDuplicateKey(err);
      }
      if (matched === 0) {
        const existing = await this.credentials(db).findOne(
          { id: credentialId },
          { session: ctx.session, projection: { id: 1 } },
        );
        if (!existing) {
          throw ApiError.notFound('provider credential');
        }
        throw ApiError.conflict(
          'credential is revoked — create a new credential instead of rotating it',
        );
      }
      const updated = await this.credentials(db).findOne(
        { id: credentialId },
        { session: ctx.session },
      );
      if (!updated) throw new Error('mongo rotate: updated row vanished');
      return toProviderCredential(updated);
    });
  }

  /** Terminal revoke (never hard-delete); check-then-act. */
  async revokeCredential(input: {
    orgId: string;
    credentialId: string;
    revocationReason: string | null;
    compromised: boolean;
  }): Promise<ProviderCredential> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = binUuid(input.orgId, 'orgId');
      const credentialId = binUuid(input.credentialId, 'credentialId');
      const filter: Filter<ProviderCredentialMongoDoc> = {
        id: credentialId,
        organization_id: orgId,
      };
      const existing = await this.credentials(db).findOne(filter, { session: ctx.session });
      if (!existing) {
        throw ApiError.notFound('provider credential');
      }
      if (existing.status === 'revoked') {
        throw ApiError.conflict('credential is already revoked');
      }
      await this.credentials(db).updateOne(
        filter,
        {
          $set: {
            status: 'revoked',
            revoked_at: new Date().toISOString(),
            revocation_reason: input.revocationReason,
            compromised: input.compromised,
          },
        },
        { session: ctx.session },
      );
      const updated = await this.credentials(db).findOne(filter, { session: ctx.session });
      if (!updated) throw new Error('mongo revoke: updated row vanished');
      return toProviderCredential(updated);
    });
  }

  async listCredentials(orgId: string): Promise<ProviderCredential[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const docs = await this.credentials(db)
        .find({ organization_id: binUuid(orgId, 'orgId') }, { session: ctx.session })
        .limit(MongoProviderCredentialRepository.LIST_CAP)
        .toArray();
      return docs.map(toProviderCredential);
    });
  }

  /** Providers with at least one ACTIVE credential in the org. */
  async providersWithActiveCredentials(orgId: string): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const providers = await this.credentials(db).distinct('provider', {
        organization_id: binUuid(orgId, 'orgId'),
        status: 'active',
      });
      return providers as string[];
    });
  }

  async listEnablements(orgId: string): Promise<ProviderEnablement[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const docs = await this.enablements(db)
        .find({ organization_id: binUuid(orgId, 'orgId') }, { session: ctx.session })
        .toArray();
      return docs.map(toProviderEnablement);
    });
  }

  /**
   * Upsert the per-org provider enablement (upsert on
   * (organization_id, provider)).
   */
  async upsertEnablement(input: {
    orgId: string;
    provider: string;
    enabled: boolean;
    updatedBy: string;
  }): Promise<ProviderEnablement> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = binUuid(input.orgId, 'orgId');
      const now = new Date().toISOString();
      await this.enablements(db).updateOne(
        { organization_id: orgId, provider: input.provider },
        {
          $set: { enabled: input.enabled, updated_by: input.updatedBy, updated_at: now },
          $setOnInsert: { organization_id: orgId, provider: input.provider },
        },
        { session: ctx.session, upsert: true },
      );
      const updated = await this.enablements(db).findOne(
        { organization_id: orgId, provider: input.provider },
        { session: ctx.session },
      );
      if (!updated) throw new Error('mongo enablement upsert returned no document');
      return toProviderEnablement(updated);
    });
  }
}
