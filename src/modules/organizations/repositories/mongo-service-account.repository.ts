/**
 * MongoDB lane for `IServiceAccountRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Org-scoped
 * methods are one `withOrg` unit (plan D5); the tenant predicate is enforced
 * by `TenantScopedCollection` via `orgCollection` (plan D6, tenant key
 * `org_id`).
 *
 * `token_hash` / `token_prefix` are OMITTED (not null) on token-less docs,
 * paired with the sparse unique index ensured here (plan D7) — multiple
 * null-token docs stay legal exactly like pg's NULL-distinct unique
 * semantics.
 *
 * The AuthGuard lookups are deliberately cross-tenant and global:
 * authentication happens before any org context exists, and the filter is
 * the globally-unique unguessable hash — `PlatformCollection` over
 * `this.mongo.root` with a justifying comment, mirroring the pg lane's
 * `withBypass` escape hatch.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureFurnitureIndexes,
  nowIso,
  orgCollection,
  toOrgServiceAccountRow,
} from './mongo-documents';
import type { OrgServiceAccountDoc } from './mongo-documents';
import type { IServiceAccountRepository, ServiceAccountRow } from './service-account.repository';

export class MongoServiceAccountRepository implements IServiceAccountRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    accounts: TenantScopedCollection<OrgServiceAccountDoc>;
  } {
    return {
      session: { session: ctx.session },
      accounts: orgCollection<OrgServiceAccountDoc>(db, 'org_service_accounts'),
    };
  }

  /**
   * Platform-plane handle for the cross-tenant token-hash lookups.
   * Deliberately UNSCOPED — the AuthGuard authenticates before any org
   * context exists; the filter is the globally-unique unguessable hash
   * (uq_org_service_accounts_token_hash), exactly like the pg lane's
   * `withBypass` escape hatch.
   */
  private platform(db: Db): PlatformCollection<OrgServiceAccountDoc> {
    return new PlatformCollection<OrgServiceAccountDoc>(
      db.collection<OrgServiceAccountDoc>('org_service_accounts'),
    );
  }

  /** Service accounts of the org, newest first. */
  async listServiceAccounts(orgId: string): Promise<ServiceAccountRow[]> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.accounts
        .find(orgId, {}, { ...t.session, sort: { created_at: -1 } })
        .toArray();
      return docs.map(toOrgServiceAccountRow);
    });
  }

  /** Raw row read; the service maps a miss to NotFoundException. */
  async getServiceAccount(orgId: string, id: string): Promise<ServiceAccountRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.accounts.findOne(orgId, { id: binUuid(id, 'id') }, t.session);
      return doc ? toOrgServiceAccountRow(doc) : null;
    });
  }

  /** Insert with a freshly minted token hash/prefix (computed by the service). */
  async createServiceAccount(input: {
    orgId: string;
    name: string;
    description: string | null;
    scopes: string[];
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    createdBy: string;
  }): Promise<ServiceAccountRow> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      const doc: OrgServiceAccountDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(input.orgId, 'orgId'),
        name: input.name,
        description: input.description,
        status: 'active',
        scopes: input.scopes,
        token_hash: input.tokenHash,
        token_prefix: input.tokenPrefix,
        token_expires_at: null,
        token_last_used_at: null,
        token_last_rotated_at: input.tokenLastRotatedAt,
        created_by: binUuid(input.createdBy, 'createdBy'),
        created_at: now,
        updated_at: now,
      };
      await t.accounts.insertOne(input.orgId, doc, t.session);
      return toOrgServiceAccountRow(doc);
    });
  }

  /**
   * Compare-and-swap the token hash on the row's current hash via
   * `findOneAndUpdate` with the expected-hash predicate — a concurrent
   * rotate cannot silently win. False when matchedCount is 0 (stale
   * expected hash), which the service maps to ApiError.conflict — the same
   * code the pg lane produces. The expected-hash predicate mirrors the pg
   * `tokenHash = expected ?? ''` shape exactly: a null prior hash matches
   * nothing on either lane, so rotating a token-less account is a conflict
   * on both.
   */
  async rotateTokenHash(input: {
    orgId: string;
    id: string;
    expectedTokenHash: string | null;
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    updatedAt: string;
  }): Promise<boolean> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.accounts.findOneAndUpdate(
        input.orgId,
        {
          id: binUuid(input.id, 'id'),
          token_hash: input.expectedTokenHash ?? '',
        },
        {
          $set: {
            token_hash: input.tokenHash,
            token_prefix: input.tokenPrefix,
            token_expires_at: null,
            token_last_rotated_at: input.tokenLastRotatedAt,
            updated_at: input.updatedAt,
          },
        },
        t.session,
      );
      return updated !== null;
    });
  }

  /** Revoke just the token — the identity and its metadata stay. */
  async revokeToken(orgId: string, id: string, updatedAt: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.accounts.updateOne(
        orgId,
        { id: binUuid(id, 'id') },
        {
          $set: { token_expires_at: null, updated_at: updatedAt },
          // Omit (not null) token fields so the sparse unique index keeps
          // token-less docs out of the index — pg NULL-distinct semantics.
          $unset: { token_hash: '', token_prefix: '' },
        },
        t.session,
      );
    });
  }

  /** Disable (voids the token) — the account stops authenticating. */
  async disableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.accounts.updateOne(
        orgId,
        { id: binUuid(id, 'id') },
        {
          $set: { status: 'disabled', token_expires_at: null, updated_at: updatedAt },
          $unset: { token_hash: '', token_prefix: '' },
        },
        t.session,
      );
    });
  }

  /** Re-enable; the token must be rotated to authenticate again. */
  async enableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.accounts.updateOne(
        orgId,
        { id: binUuid(id, 'id') },
        { $set: { status: 'active', updated_at: updatedAt } },
        t.session,
      );
    });
  }

  /** Delete the identity row. */
  async removeServiceAccount(orgId: string, id: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.accounts.deleteOne(orgId, { id: binUuid(id, 'id') }, t.session);
    });
  }

  /**
   * AuthGuard lookup by token hash — deliberately cross-tenant and global
   * (see `platform()`): authentication happens before any org context
   * exists; the filter is the globally-unique unguessable hash.
   */
  async findByTokenHash(tokenHash: string): Promise<ServiceAccountRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    const doc = await this.platform(db).findOne({ token_hash: tokenHash });
    return doc ? toOrgServiceAccountRow(doc) : null;
  }

  /**
   * Fire-and-forget usage telemetry (same discipline as L2 keys):
   * best-effort and cross-tenant by id — the id is globally unique, so no
   * tenant predicate applies, mirroring the pg `withBypass` update.
   */
  async touchTokenLastUsed(id: string, at: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.platform(db).updateOne(
      { id: binUuid(id, 'id') },
      { $set: { token_last_used_at: at } },
    );
  }
}
