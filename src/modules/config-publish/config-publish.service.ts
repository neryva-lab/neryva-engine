import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { SatelliteRegistryService } from '../satellites/satellite-registry.service';
import { CONFIG_SCOPES, ConfigScope, configNotifications, publishedConfigs, PublishedConfig } from './config-publish.schema';

/**
 * Config publishing (handover A-4, engine side): the engine is the single
 * decision point for policy sets, guardrail profiles, quota profiles, and
 * model catalogs per org. Publications are versioned, immutable, and
 * audited; satellites pull by cursor and are fanned out notification
 * ledger rows they ACK after applying.
 *
 * The runtime's local editing routes freeze read-only at A-4 — this service
 * is where those edits move TO (the console publish endpoint).
 */
@Injectable()
export class ConfigPublishService {
  private readonly logger = new Logger(ConfigPublishService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly satellites: SatelliteRegistryService,
  ) {}

  /**
   * Publish the next version of (org, scope, product). Versions are
   * computed under a transaction-scoped advisory lock keyed to the exact
   * config key, so concurrent publishes serialize instead of colliding.
   */
  async publish(input: {
    orgId: string;
    scope: ConfigScope;
    product: string | null;
    payload: Record<string, unknown>;
    publishedBy: string;
  }): Promise<PublishedConfig> {
    assertScope(input.scope);
    const payloadHash = createHash('sha256').update(canonicalize(input.payload)).digest('hex');

    const inserted = await this.db.withOrg(input.orgId, async (tx) => {
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
          payloadHash,
          publishedBy: input.publishedBy,
        })
        .returning();
      return rows[0];
    });

    await this.audit.add({
      action: 'config.published',
      resourceType: 'published_config',
      resourceId: inserted.id,
      actorType: input.publishedBy === 'system' ? 'system' : 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      productTag: input.product,
      details: { scope: input.scope, version: inserted.version, payload_hash: payloadHash.slice(0, 16) },
    });
    await this.events.emit(EngineEvents.ConfigPublished, {
      orgId: input.orgId,
      scope: input.scope,
      product: input.product,
      version: inserted.version,
    });
    await this.fanout(inserted);
    return inserted;
  }

  /** Latest version of one config key (null when nothing published). */
  async latest(orgId: string, scope: ConfigScope, product: string | null): Promise<PublishedConfig | null> {
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

  /**
   * Versioned pull (satellite subscribe): every version strictly greater
   * than `sinceVersion` for the key, oldest first — the satellite applies
   * them in order and stores the last version as its cursor.
   */
  async since(orgId: string, scope: ConfigScope, product: string | null, sinceVersion: number): Promise<PublishedConfig[]> {
    if (!Number.isInteger(sinceVersion) || sinceVersion < 0) {
      throw ApiError.validation({ since: 'must be a non-negative integer version cursor' });
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(publishedConfigs)
        .where(and(configKey(orgId, scope, product), gt(publishedConfigs.version, sinceVersion)))
        .orderBy(publishedConfigs.version)
        .limit(100),
    );
  }

  /**
   * The push-notification ledger: after a publish, every ACTIVE satellite
   * that serves the affected product gets a durable notification row.
   * (Placeholders get none — they have no puller.) The satellite's next
   * heartbeat or ack sweep drains these; unacked rows are the retry truth.
   */
  private async fanout(config: PublishedConfig): Promise<void> {
    const rows = await this.satellites.list();
    const targets = rows.filter((s) => s.status === 'active' && (s.products as string[]).some((p) => config.product === null || p === config.product));
    if (targets.length === 0) {
      return;
    }
    await this.db.root
      .insert(configNotifications)
      .values(targets.map((t) => ({ configId: config.id, satelliteKey: t.key })))
      .onConflictDoNothing();
    this.logger.log(`config ${config.scope} v${config.version} for org ${config.orgId} → notified ${targets.map((t) => t.key).join(', ')}`);
  }

  /** Satellite ACK: mark its notifications for a config as applied. */
  async ack(satelliteKey: string, configId: string): Promise<void> {
    await this.db.root
      .update(configNotifications)
      .set({ ackedAt: new Date().toISOString() })
      .where(and(eq(configNotifications.configId, configId), eq(configNotifications.satelliteKey, satelliteKey), isNull(configNotifications.ackedAt)));
  }

  /** Pending (unacked) notifications for one satellite — its work queue. */
  async pendingFor(satelliteKey: string, limit = 50): Promise<Array<{ configId: string }>> {
    const rows = await this.db.root
      .select({ configId: configNotifications.configId })
      .from(configNotifications)
      .where(and(eq(configNotifications.satelliteKey, satelliteKey), isNull(configNotifications.ackedAt)))
      .limit(limit);
    return rows;
  }
}

function configKey(orgId: string, scope: ConfigScope, product: string | null) {
  return product === null
    ? and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), isNull(publishedConfigs.product))
    : and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), eq(publishedConfigs.product, product));
}

function assertScope(scope: string): asserts scope is ConfigScope {
  if (!(CONFIG_SCOPES as readonly string[]).includes(scope)) {
    throw ApiError.validation({ scope: `must be one of ${CONFIG_SCOPES.join(', ')}` });
  }
}

/** Stable digest input: sorted-keys JSON (the audit chain's canonical form). */
function canonicalize(value: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
