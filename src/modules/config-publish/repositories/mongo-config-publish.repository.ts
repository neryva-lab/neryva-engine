/**
 * MongoDB lane for `IConfigPublishRepository` (P3) — the immutable config
 * version store.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. The pg `id`
 * column is kept as the Binary field `id`; `_id` is left to the driver's
 * default ObjectId. Mongo applies no column defaults, so every field is set
 * explicitly on insert (pg `defaultRandom()`/`defaultNow()` have no
 * counterpart here).
 *
 * Tenant discipline: every tenant-scoped access goes through
 * `TenantScopedCollection` with the `org_id` tenant field (the org-furniture
 * group — config-publish's tenant column is `org_id`, not
 * `organization_id`). The `getById` and `retentionSweep` paths are
 * platform-plane (bypass) by design.
 *
 * Serialization: `insertNextVersion` acquires the distributed lease
 * `cfg:<org>:<scope>:<product>` (the exact pg advisory-lock key domain)
 * BEFORE opening its `withOrg` transaction and releases it after
 * commit/rollback (lease-lock.ts: "a transaction-scoped advisory lock maps
 * to acquire before the TX, release after commit, owned by the caller"). The
 * lease TTL bounds how long a crashed holder blocks the key; a stolen
 * lease mid-TX fails closed via the unique (org_id, scope, product,
 * version) index, never silently.
 *
 * The service keeps: input validation, the byte-identical republish
 * pre-check, audits, and logging.
 */
import type { Binary, Db, Filter } from 'mongodb';
import { env } from '../../../common/config/env';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { acquireLease } from '../../../common/infra/db/mongo/concurrency/lease-lock';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ConfigScope, PublishedConfig } from '../config-publish.schema';
import type {
  IConfigPublishRepository,
  PublishVersionInput,
} from './config-publish.repository';
import {
  binUuid,
  isDuplicateKey,
  tenantCollection,
  toPublishedConfig,
  type ConfigNotificationMongoDoc,
  type PublishedConfigMongoDoc,
} from './mongo-documents';

/**
 * Lease TTL for the `cfg:<org>:<scope>:<product>` distributed lock, read
 * from the parsed runtime configuration (`MONGODB_PUBLISH_LEASE_TTL_MS`,
 * default 30s) at each acquisition — read per call (never snapshotted at
 * import) so it always reflects the process configuration.
 */
const publishLeaseTtlMs = (): number => env.MONGODB_PUBLISH_LEASE_TTL_MS;
/** How long to wait for a contended config-key lock before failing. */
const CONFIG_LOCK_TIMEOUT_MS = 30_000;

export class MongoConfigPublishRepository implements IConfigPublishRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    published: TenantScopedCollection<PublishedConfigMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      published: tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs'),
    };
  }

  /**
   * Insert the next version for (org, scope, product): the distributed lease
   * (the pg `pg_advisory_xact_lock` key domain) serializes concurrent
   * publishes of the same key, then version = max+1 and the insert — one
   * `withOrg` unit. A duplicate-key hit on the unique (org_id, scope,
   * product, version) index (a stolen lease mid-TX) fails closed as a
   * conflict; the error is converted without further reads/writes, so the
   * aborted transaction is never reused.
   */
  async insertNextVersion(input: PublishVersionInput): Promise<PublishedConfig> {
    const db = this.mongo.root;
    const lease = await acquireLease(
      db,
      `cfg:${input.orgId}:${input.scope}:${input.product ?? '*'}`,
      publishLeaseTtlMs(),
      { timeoutMs: CONFIG_LOCK_TIMEOUT_MS },
    );
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
        const t = this.tx(db, ctx);
        const latestDocs = await t.published
          .find(input.orgId, keyFilter(input.scope, input.product), {
            sort: { version: -1 },
            limit: 1,
            ...t.session,
          })
          .toArray();
        const nextVersion = (latestDocs[0]?.version ?? 0) + 1;
        const now = new Date().toISOString();
        const doc: PublishedConfigMongoDoc = {
          id: binUuid(uuidv7()),
          org_id: binUuid(input.orgId, 'orgId'),
          scope: input.scope,
          product: input.product,
          version: nextVersion,
          payload: input.payload,
          payload_hash: input.payloadHash,
          notes: input.notes,
          rollback_of: input.rollbackOf,
          published_by: input.publishedBy,
          published_at: now,
        };
        try {
          await t.published.insertOne(input.orgId, doc, t.session);
        } catch (err) {
          if (isDuplicateKey(err)) {
            throw ApiError.conflict('concurrent publish collided on version — retry', {
              scope: input.scope,
              version: nextVersion,
            });
          }
          throw err;
        }
        return toPublishedConfig(doc);
      });
    } finally {
      await lease.release();
    }
  }

  /** Latest version of one config key (null when nothing published). */
  async latest(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<PublishedConfig | null> {
    const db = this.mongo.root;
    const published = tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs');
    const doc = await published.findOne(orgId, keyFilter(scope, product), {
      sort: { version: -1 },
    });
    return doc ? toPublishedConfig(doc) : null;
  }

  /** One specific version (history drill-down / rollback source). */
  async version(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    version: number,
  ): Promise<PublishedConfig | null> {
    const db = this.mongo.root;
    const published = tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs');
    const doc = await published.findOne(orgId, {
      ...keyFilter(scope, product),
      version,
    });
    return doc ? toPublishedConfig(doc) : null;
  }

  /** Version history, newest first, paginated. */
  async history(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    limit: number,
    offset: number,
  ): Promise<{ versions: PublishedConfig[]; total: number }> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const db = this.mongo.root;
    const published = tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs');
    const filter = keyFilter(scope, product);
    const docs = await published
      .find(orgId, filter, {
        sort: { version: -1 },
        limit: cappedLimit,
        skip: Math.max(offset, 0),
      })
      .toArray();
    const total = await published.countDocuments(orgId, filter);
    return { versions: docs.map(toPublishedConfig), total };
  }

  /** Every version row for the org, newest first (overview/bootstrap scan). */
  async listAllDesc(orgId: string): Promise<PublishedConfig[]> {
    const db = this.mongo.root;
    const published = tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs');
    const docs = await published.find(orgId, {}, { sort: { version: -1 } }).toArray();
    return docs.map(toPublishedConfig);
  }

  /**
   * Versioned pull (satellite subscribe): every version strictly greater
   * than `sinceVersion` for the key, oldest first, with a continuation
   * cursor so a large catch-up is never silently truncated.
   */
  async since(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    sinceVersion: number,
    limit: number,
  ): Promise<{ configs: PublishedConfig[]; nextSince: number; hasMore: boolean }> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const db = this.mongo.root;
    const published = tenantCollection<PublishedConfigMongoDoc>(db, 'published_configs');
    const docs = await published
      .find(
        orgId,
        { ...keyFilter(scope, product), version: { $gt: sinceVersion } },
        { sort: { version: 1 }, limit: capped + 1 },
      )
      .toArray();
    const hasMore = docs.length > capped;
    const page = hasMore ? docs.slice(0, capped) : docs;
    const configs = page.map(toPublishedConfig);
    return {
      configs,
      nextSince: configs.length ? configs[configs.length - 1].version : sinceVersion,
      hasMore,
    };
  }

  /**
   * Bypass lookup by row id. Bypass is safe: the lookup is by the
   * globally-unique row id (no tenant predicate to drop), used by the
   * renotify/ack flows that address the config by the id the engine itself
   * handed out; the caller owns tenant authorization.
   */
  async getById(configId: string): Promise<PublishedConfig | null> {
    const db = this.mongo.root;
    const doc = await db
      .collection<PublishedConfigMongoDoc>('published_configs')
      .findOne({ id: binUuid(configId, 'configId') });
    return doc ? toPublishedConfig(doc) : null;
  }

  /**
   * Retention sweep: (1) acked notification rows older than
   * CONFIG_NOTIFICATION_RETENTION_DAYS are pruned; (2) per key only the
   * newest CONFIG_VERSION_RETENTION versions stay — the live version
   * (rank 1) is never eligible. One `withBypass` unit, as on the pg lane.
   * The pg lane's `ON DELETE CASCADE` (config_id → published_configs) has
   * no mongo counterpart, so the pruned versions' notification rows are
   * deleted explicitly.
   */
  async retentionSweep(): Promise<{ notificationsDeleted: number; versionsDeleted: number }> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const session = { session: ctx.session };
      const cutoff = new Date(
        Date.now() - env.CONFIG_NOTIFICATION_RETENTION_DAYS * 86_400_000,
      ).toISOString();
      const notifications = db.collection<ConfigNotificationMongoDoc>('config_notifications');
      // Bypass is safe: the predicate (acked + older than the retention
      // cutoff) selects the exact prune set cross-org by design — this is
      // the platform-plane maintenance path, identical to the pg lane's
      // unscoped raw DELETE.
      const notifResult = await notifications.deleteMany(
        { acked_at: { $ne: null, $lt: cutoff } },
        session,
      );
      // Versions beyond the newest CONFIG_VERSION_RETENTION per
      // (org_id, scope, product): the aggregation sorts newest-first, keeps
      // the first RETENTION ids per key, and returns the rest.
      const retention = env.CONFIG_VERSION_RETENTION;
      const pruned = await db
        .collection<PublishedConfigMongoDoc>('published_configs')
        .aggregate<{ pruned: Binary[] }>(
          [
            { $sort: { version: -1 } },
            {
              $group: {
                _id: { org_id: '$org_id', scope: '$scope', product: '$product' },
                ids: { $push: '$id' },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: retention } } },
            {
              $project: {
                _id: 0,
                pruned: { $slice: ['$ids', retention, { $subtract: ['$count', retention] }] },
              },
            },
          ],
          session,
        )
        .toArray();
      const prunedIds = pruned.flatMap((row) => row.pruned);
      let versionsDeleted = 0;
      if (prunedIds.length > 0) {
        // Bypass is safe: the id list is the exact aggregation-derived prune
        // set — deleting by explicit id cannot touch any other row.
        const versionResult = await db
          .collection<PublishedConfigMongoDoc>('published_configs')
          .deleteMany({ id: { $in: prunedIds } }, session);
        versionsDeleted = versionResult.deletedCount;
        // The pg lane's ON DELETE CASCADE, done explicitly: notifications
        // carry no tenant column and reference the pruned version ids.
        await notifications.deleteMany({ config_id: { $in: prunedIds } }, session);
      }
      return {
        notificationsDeleted: notifResult.deletedCount,
        versionsDeleted,
      };
    });
  }
}

/** The (org, scope, product) key predicate (null product = org-wide key). */
function keyFilter(scope: ConfigScope, product: string | null): Filter<PublishedConfigMongoDoc> {
  return { scope, product };
}
