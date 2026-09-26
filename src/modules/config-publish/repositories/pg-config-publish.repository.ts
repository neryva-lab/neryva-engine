import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { env } from '../../../common/config/env';
import { publishedConfigs } from '../config-publish.schema';
import type { ConfigScope, PublishedConfig } from '../config-publish.schema';
import type {
  IConfigPublishRepository,
  PublishVersionInput,
} from './config-publish.repository';

/**
 * PostgreSQL implementation of `IConfigPublishRepository` (P3).
 *
 * Mechanical move of the `ConfigPublishService` version-store units: every
 * method owns its transaction via `DbService.withOrg` (or `withBypass` for
 * the platform-plane paths), runs all reads/writes inside it, and commits
 * or rolls back as one. No transaction handle leaks through the interface.
 *
 * What stays OUT (still the service's job): input validation (`assertScope`,
 * `assertOrgId`, version/since clamps), payload validation, the
 * byte-identical republish pre-check, audit writes, and the event emit.
 */
export class PgConfigPublishRepository implements IConfigPublishRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert the next version for (org, scope, product): serialized by the
   * transaction-scoped advisory lock keyed to the exact config key, then
   * version = max+1, then the insert — one `withOrg` unit.
   */
  async insertNextVersion(input: PublishVersionInput): Promise<PublishedConfig> {
    return this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cfg:${input.orgId}:${input.scope}:${input.product ?? '*'}`}))`);
      const latest = await tx
        .select({ version: publishedConfigs.version })
        .from(publishedConfigs)
        .where(configKey(input.orgId, input.scope, input.product))
        .orderBy(desc(publishedConfigs.version))
        .limit(1);
      const nextVersion = (latest[0]?.version ?? 0) + 1;
      const rows = await tx
        .insert(publishedConfigs)
        .values({
          orgId: input.orgId,
          scope: input.scope,
          product: input.product,
          version: nextVersion,
          payload: input.payload,
          payloadHash: input.payloadHash,
          notes: input.notes,
          rollbackOf: input.rollbackOf,
          publishedBy: input.publishedBy,
        })
        .returning();
      return rows[0];
    });
  }

  /** Latest version of one config key (null when nothing published). */
  async latest(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<PublishedConfig | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(publishedConfigs)
        .where(configKey(orgId, scope, product))
        .orderBy(desc(publishedConfigs.version))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** One specific version (history drill-down / rollback source). */
  async version(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    version: number,
  ): Promise<PublishedConfig | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(publishedConfigs)
        .where(and(configKey(orgId, scope, product), eq(publishedConfigs.version, version)))
        .limit(1),
    );
    return rows[0] ?? null;
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
    return this.db.withOrg(orgId, async (tx) => {
      const versions = await tx
        .select()
        .from(publishedConfigs)
        .where(configKey(orgId, scope, product))
        .orderBy(desc(publishedConfigs.version))
        .limit(cappedLimit)
        .offset(Math.max(offset, 0));
      const counted = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(publishedConfigs)
        .where(configKey(orgId, scope, product));
      return { versions, total: counted[0]?.count ?? 0 };
    });
  }

  /** Every version row for the org, newest first (overview/bootstrap scan). */
  async listAllDesc(orgId: string): Promise<PublishedConfig[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(publishedConfigs).orderBy(desc(publishedConfigs.version)),
    );
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
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(publishedConfigs)
        .where(and(configKey(orgId, scope, product), gt(publishedConfigs.version, sinceVersion)))
        .orderBy(publishedConfigs.version)
        .limit(capped + 1),
    );
    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    return {
      configs: page,
      nextSince: page.length ? page[page.length - 1].version : sinceVersion,
      hasMore,
    };
  }

  /** Bypass lookup by row id (renotify/ack flows key on the uuid). */
  async getById(configId: string): Promise<PublishedConfig | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(publishedConfigs).where(eq(publishedConfigs.id, configId)).limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Retention sweep: (1) acked notification rows age out after
   * CONFIG_NOTIFICATION_RETENTION_DAYS; (2) per key, only the newest
   * CONFIG_VERSION_RETENTION versions stay — the live version always has
   * rank 1 and is never eligible. One `withBypass` unit, exactly as before.
   */
  async retentionSweep(): Promise<{ notificationsDeleted: number; versionsDeleted: number }> {
    return this.db.withBypass(async (tx) => {
      const notifications = await tx.execute(sql`
        delete from config_notifications
        where acked_at is not null
          and acked_at < now() - (${env.CONFIG_NOTIFICATION_RETENTION_DAYS} * interval '1 day')
      `);
      const versions = await tx.execute(sql`
        delete from published_configs
        where id in (
          select id from (
            select id, row_number() over (partition by org_id, scope, product order by version desc) as rank
            from published_configs
          ) ranked
          where ranked.rank > ${env.CONFIG_VERSION_RETENTION}
        )
      `);
      return {
        notificationsDeleted: notifications.rowCount ?? 0,
        versionsDeleted: versions.rowCount ?? 0,
      };
    });
  }
}

/** The (org, scope, product) key predicate (null product = org-wide key). */
function configKey(orgId: string, scope: ConfigScope, product: string | null) {
  return product === null
    ? and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), isNull(publishedConfigs.product))
    : and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), eq(publishedConfigs.product, product));
}
