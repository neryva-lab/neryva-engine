import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { SatelliteRegistryService } from '../satellites/satellite-registry.service';
import {
  CONFIG_SCOPES,
  ConfigScope,
  configDrafts,
  configNotifications,
  publishedConfigs,
  PublishedConfig,
  ConfigDraft,
} from './config-publish.schema';
import { validatePayload } from './payload-schemas';
import { diffJson, JsonDiffEntry } from './json-diff';

/**
 * Config publishing (handover A-4, engine side): the engine is the single
 * decision point for policy sets, guardrail profiles, quota profiles, and
 * model catalogs per org. The full lifecycle lives here:
 *
 *   draft (validates on save; invalid drafts persist WITH their report,
 *         but cannot publish)
 *     → publish (strict payload validation → immutable version → audit →
 *                event → satellite fanout ledger)
 *     → history / diff / rollback (rollback = a NEW version restoring an
 *                old payload — versions are never edited)
 *     → delivery (per-satellite ACK tracking; re-notify; stale sweep)
 *     → retention (prune old versions + acked notifications; the live
 *                version is never pruned)
 *
 * Satellites consume three read shapes: versioned pull (`since`), latest
 * (with ETag), and bootstrap (every key's live version in one call). The
 * runtime's local editing routes freeze read-only at A-4 — drafts are where
 * those edits moved to.
 */
@Injectable()
export class ConfigPublishService {
  private static readonly logger = new Logger(ConfigPublishService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly satellites: SatelliteRegistryService,
    private readonly manifests: ManifestRegistryService,
  ) {}

  // ── Publish (immutable versions) ─────────────────────────────────────────

  /**
   * Publish the next version of (org, scope, product). Payload passes the
   * strict per-scope schema first (invalid configs cannot publish), a
   * product tag must be a registered product, and a byte-identical
   * republish of the live version is rejected — a no-op publish would bump
   * the version and fan out satellites for nothing. Versions are computed
   * under a transaction-scoped advisory lock keyed to the exact config
   * key, so concurrent publishes serialize instead of colliding.
   */
  async publish(input: {
    orgId: string;
    scope: ConfigScope;
    product: string | null;
    payload: unknown;
    notes?: string | null;
    rollbackOf?: number | null;
    publishedBy: string;
  }): Promise<PublishedConfig> {
    assertScope(input.scope);
    assertOrgId(input.orgId);
    this.assertProductTag(input.product);
    const normalized = validatePayload(input.scope, input.payload);
    if (!normalized.ok) {
      throw ApiError.validation({ payload: normalized.issues });
    }
    const payloadHash = hashPayload(normalized.normalized);

    const current = await this.latest(input.orgId, input.scope, input.product);
    if (current && current.payloadHash === payloadHash) {
      throw ApiError.conflict(
        `payload is identical to the live version ${current.version} — nothing to publish`,
        { scope: input.scope, version: current.version },
      );
    }

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
          payload: normalized.normalized,
          payloadHash,
          notes: input.notes ?? null,
          rollbackOf: input.rollbackOf ?? null,
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
      details: {
        scope: input.scope,
        version: inserted.version,
        payload_hash: payloadHash.slice(0, 16),
        ...(input.rollbackOf ? { rollback_of: input.rollbackOf } : {}),
      },
    });
    await this.events.emit(EngineEvents.ConfigPublished, {
      orgId: input.orgId,
      configId: inserted.id,
      scope: input.scope,
      product: input.product,
      version: inserted.version,
      payloadHash,
    });
    await this.fanout(inserted);
    return inserted;
  }

  /** Publish the stored draft for a key (the A-4 editing flow). */
  async publishDraft(input: {
    orgId: string;
    scope: ConfigScope;
    product: string | null;
    notes?: string | null;
    publishedBy: string;
  }): Promise<PublishedConfig> {
    const draft = await this.getDraft(input.orgId, input.scope, input.product);
    if (!draft) {
      throw ApiError.notFound('config draft');
    }
    if (draft.validationStatus !== 'valid') {
      throw ApiError.validation({ draft: 'draft has validation errors — fix them before publishing' });
    }
    const published = await this.publish({
      orgId: input.orgId,
      scope: input.scope,
      product: input.product,
      payload: draft.payload,
      notes: input.notes ?? draft.notes,
      publishedBy: input.publishedBy,
    });
    // Drop the draft only if it still matches what was published (a
    // concurrent edit keeps the draft alive for its author).
    await this.db
      .withOrg(input.orgId, (tx) =>
        tx
          .delete(configDrafts)
          .where(and(draftKey(input.orgId, input.scope, input.product), eq(configDrafts.payloadHash, published.payloadHash))),
      )
      .catch(() => undefined);
    return published;
  }

  /** Rollback = a NEW version whose payload restores an older version. */
  async rollback(input: {
    orgId: string;
    scope: ConfigScope;
    product: string | null;
    toVersion: number;
    notes?: string | null;
    publishedBy: string;
  }): Promise<PublishedConfig> {
    const target = await this.version(input.orgId, input.scope, input.product, input.toVersion);
    if (!target) {
      throw ApiError.notFound(`config version ${input.toVersion}`);
    }
    const current = await this.latest(input.orgId, input.scope, input.product);
    if (current && current.payloadHash === target.payloadHash) {
      throw ApiError.conflict(`version ${target.version} is already the live content (v${current.version})`);
    }
    const published = await this.publish({
      orgId: input.orgId,
      scope: input.scope,
      product: input.product,
      payload: target.payload,
      notes: input.notes ?? `rollback to v${target.version}`,
      rollbackOf: target.version,
      publishedBy: input.publishedBy,
    });
    await this.audit.add({
      action: 'config.rolled_back',
      resourceType: 'published_config',
      resourceId: published.id,
      actorType: 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      productTag: input.product,
      details: { scope: input.scope, to_version: target.version, new_version: published.version },
    });
    return published;
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  /**
   * Save (upsert) the draft for a key. The payload is validated on EVERY
   * save and the verdict stored with it: an invalid draft is kept — with
   * its issue list — so the operator can iterate in place, but publish
   * refuses anything not 'valid'.
   */
  async saveDraft(input: {
    orgId: string;
    scope: ConfigScope;
    product: string | null;
    payload: unknown;
    notes?: string | null;
    updatedBy: string;
  }): Promise<ConfigDraft> {
    assertScope(input.scope);
    assertOrgId(input.orgId);
    this.assertProductTag(input.product);
    const result = validatePayload(input.scope, input.payload);
    // Drafts keep the RAW payload (not the normalized one) so the author
    // sees exactly what they typed; publish normalizes on the way out.
    const payload = input.payload as Record<string, unknown>;
    const payloadHash = hashPayload(payload);

    const saved = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(configDrafts)
        .values({
          orgId: input.orgId,
          scope: input.scope,
          product: input.product,
          payload,
          payloadHash,
          validationStatus: result.ok ? 'valid' : 'invalid',
          validationIssues: result.ok ? null : { issues: result.issues },
          notes: input.notes ?? null,
          createdBy: input.updatedBy,
          updatedBy: input.updatedBy,
        })
        .onConflictDoUpdate({
          target: [configDrafts.orgId, configDrafts.scope, configDrafts.product],
          set: {
            payload,
            payloadHash,
            validationStatus: result.ok ? 'valid' : 'invalid',
            validationIssues: result.ok ? null : { issues: result.issues },
            notes: input.notes ?? null,
            updatedBy: input.updatedBy,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });

    await this.audit.add({
      action: 'config.draft_saved',
      resourceType: 'config_draft',
      resourceId: saved.id,
      actorType: 'account',
      actorId: input.updatedBy,
      tenantId: input.orgId,
      productTag: input.product,
      details: { scope: input.scope, valid: result.ok },
    });
    return saved;
  }

  async getDraft(orgId: string, scope: ConfigScope, product: string | null): Promise<ConfigDraft | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(configDrafts).where(draftKey(orgId, scope, product)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listDrafts(orgId: string): Promise<ConfigDraft[]> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(configDrafts).orderBy(configDrafts.scope, configDrafts.product));
  }

  async deleteDraft(orgId: string, scope: ConfigScope, product: string | null, deletedBy: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.delete(configDrafts).where(draftKey(orgId, scope, product)).returning({ id: configDrafts.id }));
    if (rows[0]) {
      await this.audit.add({
        action: 'config.draft_deleted',
        resourceType: 'config_draft',
        resourceId: rows[0].id,
        actorType: 'account',
        actorId: deletedBy,
        tenantId: orgId,
        productTag: product,
        details: { scope },
      });
    }
  }

  /** Dry-run validation for the editor (no persistence). */
  validateDryRun(scope: ConfigScope, payload: unknown) {
    assertScope(scope);
    return validatePayload(scope, payload);
  }

  // ── Reads (console + satellite) ──────────────────────────────────────────

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

  /** One specific version (history drill-down / rollback source). */
  async version(orgId: string, scope: ConfigScope, product: string | null, version: number): Promise<PublishedConfig | null> {
    if (!Number.isInteger(version) || version < 1) {
      throw ApiError.validation({ version: 'must be a positive integer' });
    }
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
    limit = 25,
    offset = 0,
  ): Promise<{ versions: PublishedConfig[]; total: number }> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = await this.db.withOrg(orgId, async (tx) => {
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
    return rows;
  }

  /**
   * Structural diff between two versions of a key. `a`/`b` are version
   * numbers, or the literal 'draft' (the current draft payload) — the
   * editor's "preview against live" is diff(latest, 'draft').
   */
  async diff(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    a: number | 'draft',
    b: number | 'draft',
  ): Promise<{ a: string; b: string; entries: JsonDiffEntry[] }> {
    const load = async (ref: number | 'draft'): Promise<unknown> => {
      if (ref === 'draft') {
        const draft = await this.getDraft(orgId, scope, product);
        if (!draft) {
          throw ApiError.notFound('config draft');
        }
        return draft.payload;
      }
      const row = await this.version(orgId, scope, product, ref);
      if (!row) {
        throw ApiError.notFound(`config version ${ref}`);
      }
      return row.payload;
    };
    const [before, after] = await Promise.all([load(a), load(b)]);
    return { a: String(a), b: String(b), entries: diffJson(before, after) };
  }

  /**
   * The org's whole config surface in one call — every key (scope ×
   * product, published or drafted) with its live version, draft state, and
   * unacked fanout count. The console landing view.
   */
  async overview(orgId: string): Promise<
    Array<{
      scope: ConfigScope;
      product: string | null;
      latest: { id: string; version: number; payloadHash: string; publishedBy: string; publishedAt: string; notes: string | null; rollbackOf: number | null } | null;
      draft: { id: string; validationStatus: string; updatedAt: string; updatedBy: string } | null;
      unackedNotifications: number;
    }>
  > {
    const [published, drafts] = await Promise.all([
      this.db.withOrg(orgId, (tx) =>
        tx
          .select()
          .from(publishedConfigs)
          .orderBy(desc(publishedConfigs.version)),
      ),
      this.listDrafts(orgId),
    ]);

    const latestBykey = new Map<string, PublishedConfig>();
    for (const row of published) {
      const key = `${row.scope}::${row.product ?? '*'}`;
      if (!latestBykey.has(key)) {
        latestBykey.set(key, row); // desc order → first is latest
      }
    }
    const latestIds = [...latestBykey.values()].map((c) => c.id);
    const unacked = new Map<string, number>();
    if (latestIds.length > 0) {
      const counted = await this.db.root
        .select({ configId: configNotifications.configId, count: sql<number>`count(*)::int` })
        .from(configNotifications)
        .where(and(inArray(configNotifications.configId, latestIds), isNull(configNotifications.ackedAt)))
        .groupBy(configNotifications.configId);
      for (const row of counted) {
        unacked.set(row.configId, row.count);
      }
    }

    const keys = new Set([...latestBykey.keys(), ...drafts.map((d) => `${d.scope}::${d.product ?? '*'}`)]);
    return [...keys].sort().map((key) => {
      const [scope, productPart] = key.split('::');
      const product = productPart === '*' ? null : productPart;
      const latest = latestBykey.get(key) ?? null;
      const draft = drafts.find((d) => d.scope === scope && (d.product ?? '*') === productPart) ?? null;
      return {
        scope: scope as ConfigScope,
        product,
        latest: latest
          ? {
              id: latest.id,
              version: latest.version,
              payloadHash: latest.payloadHash,
              publishedBy: latest.publishedBy,
              publishedAt: latest.publishedAt,
              notes: latest.notes,
              rollbackOf: latest.rollbackOf,
            }
          : null,
        draft: draft ? { id: draft.id, validationStatus: draft.validationStatus, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy } : null,
        unackedNotifications: latest ? (unacked.get(latest.id) ?? 0) : 0,
      };
    });
  }

  /**
   * Bootstrap pull: every key's LIVE version in one call plus a ready-made
   * cursor map — a cold-start satellite syncs its whole cache with one
   * request instead of one per scope.
   */
  async bootstrap(orgId: string): Promise<{
    configs: Array<Pick<PublishedConfig, 'id' | 'scope' | 'product' | 'version' | 'payload' | 'payloadHash' | 'publishedAt'>>;
    cursors: Record<string, number>;
  }> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(publishedConfigs).orderBy(desc(publishedConfigs.version)),
    );
    const latestByKey = new Map<string, PublishedConfig>();
    for (const row of rows) {
      const key = `${row.scope}::${row.product ?? '*'}`;
      if (!latestByKey.has(key)) {
        latestByKey.set(key, row);
      }
    }
    const configs = [...latestByKey.values()].map((c) => ({
      id: c.id,
      scope: c.scope,
      product: c.product,
      version: c.version,
      payload: c.payload,
      payloadHash: c.payloadHash,
      publishedAt: c.publishedAt,
    }));
    const cursors: Record<string, number> = {};
    for (const c of configs) {
      cursors[c.product ? `${c.scope}:${c.product}` : c.scope] = c.version;
    }
    return { configs, cursors };
  }

  /**
   * Versioned pull (satellite subscribe): every version strictly greater
   * than `sinceVersion` for the key, oldest first — the satellite applies
   * them in order and stores the last version as its cursor. Capped at
   * `limit` with a continuation cursor so a large catch-up is never
   * silently truncated.
   */
  async since(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    sinceVersion: number,
    limit = 100,
  ): Promise<{ configs: PublishedConfig[]; nextSince: number; hasMore: boolean }> {
    if (!Number.isInteger(sinceVersion) || sinceVersion < 0) {
      throw ApiError.validation({ since: 'must be a non-negative integer version cursor' });
    }
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

  // ── Notification ledger ──────────────────────────────────────────────────

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
    ConfigPublishService.logger.log(`config ${config.scope} v${config.version} for org ${config.orgId} → notified ${targets.map((t) => t.key).join(', ')}`);
  }

  /** Re-run fanout for a version — catches satellites activated after publish. */
  async renotify(configId: string, by: string): Promise<{ notified: string[] }> {
    const config = await this.findConfigById(configId);
    const rows = await this.satellites.list();
    const targets = rows.filter((s) => s.status === 'active' && (s.products as string[]).some((p) => config.product === null || p === config.product));
    if (targets.length > 0) {
      await this.db.root
        .insert(configNotifications)
        .values(targets.map((t) => ({ configId: config.id, satelliteKey: t.key })))
        .onConflictDoNothing();
    }
    await this.audit.add({
      action: 'config.renotified',
      resourceType: 'published_config',
      resourceId: config.id,
      actorType: 'account',
      actorId: by,
      tenantId: config.orgId,
      productTag: config.product,
      details: { scope: config.scope, version: config.version, targets: targets.map((t) => t.key) },
    });
    return { notified: targets.map((t) => t.key) };
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
      .orderBy(configNotifications.notifiedAt)
      .limit(limit);
    return rows;
  }

  /**
   * Delivery status for one config version (default: the key's live one) —
   * the per-satellite view of the notification ledger. `liveness` is the
   * registry's authoritative lease state (the satellites sweeper's machine:
   * live | stale | offline | never), so an unacked row for a `stale`
   * satellite reads as "dead puller", not "slow puller".
   */
  async deliveryStatus(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    version?: number,
  ): Promise<{
    config: { id: string; scope: string; product: string | null; version: number; publishedAt: string };
    targets: Array<{ satelliteKey: string; satelliteStatus: string; liveness: string | null; notifiedAt: string | null; ackedAt: string | null }>;
  }> {
    const config = version === undefined ? await this.latest(orgId, scope, product) : await this.version(orgId, scope, product, version);
    if (!config) {
      throw ApiError.notFound('config version');
    }
    const [rows, registry] = await Promise.all([
      this.db.root.select().from(configNotifications).where(eq(configNotifications.configId, config.id)),
      this.satellites.list(),
    ]);
    const byKey = new Map(registry.map((s) => [s.key, s]));
    const targets = rows.map((n) => {
      const satellite = byKey.get(n.satelliteKey);
      return {
        satelliteKey: n.satelliteKey,
        satelliteStatus: satellite?.status ?? 'unknown',
        liveness: satellite?.liveness ?? null,
        notifiedAt: n.notifiedAt,
        ackedAt: n.ackedAt,
      };
    });
    targets.sort((a, b) => (a.ackedAt ? 1 : 0) - (b.ackedAt ? 1 : 0) || a.satelliteKey.localeCompare(b.satelliteKey));
    return {
      config: { id: config.id, scope: config.scope, product: config.product, version: config.version, publishedAt: config.publishedAt },
      targets,
    };
  }

  // ── Maintenance (worker) ─────────────────────────────────────────────────

  /**
   * Retention sweep: (1) acked notification rows age out after
   * CONFIG_NOTIFICATION_RETENTION_DAYS; (2) per key, only the newest
   * CONFIG_VERSION_RETENTION versions stay — the live version always has
   * rank 1 and is never eligible. Cascades clean the version's pending
   * notifications with it (an unacked version old enough to prune was for
   * a satellite that never came back).
   */
  async retentionSweep(): Promise<{ notificationsDeleted: number; versionsDeleted: number }> {
    const result = await this.db.withBypass(async (tx) => {
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
    if (result.notificationsDeleted > 0 || result.versionsDeleted > 0) {
      await this.audit.add({
        action: 'config.retention_pruned',
        resourceType: 'published_config',
        actorType: 'system',
        details: { ...result },
      });
      ConfigPublishService.logger.log(`retention sweep: ${result.versionsDeleted} version(s), ${result.notificationsDeleted} acked notification(s) pruned`);
    }
    return result;
  }

  // ── shared ───────────────────────────────────────────────────────────────

  /** Product tags must be registered products (manifest registry, C-1). */
  private assertProductTag(product: string | null): void {
    if (product === null) {
      return;
    }
    if (!/^[a-z0-9_]{1,64}$/.test(product)) {
      throw ApiError.validation({ product: 'lowercase letters, digits, underscores (max 64)' });
    }
    if (!this.manifests.get(product)) {
      throw ApiError.validation({ product: `"${product}" is not a registered product` });
    }
  }

  private async findConfigById(configId: string): Promise<PublishedConfig> {
    if (!/^[0-9a-f-]{36}$/i.test(configId)) {
      throw ApiError.validation({ config_id: 'must be a uuid' });
    }
    const rows = await this.db.withBypass((tx) => tx.select().from(publishedConfigs).where(eq(publishedConfigs.id, configId)).limit(1));
    const row = rows[0];
    if (!row) {
      throw ApiError.notFound('config version');
    }
    return row;
  }
}

function configKey(orgId: string, scope: ConfigScope, product: string | null) {
  return product === null
    ? and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), isNull(publishedConfigs.product))
    : and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, scope), eq(publishedConfigs.product, product));
}

function draftKey(orgId: string, scope: ConfigScope, product: string | null) {
  return product === null
    ? and(eq(configDrafts.orgId, orgId), eq(configDrafts.scope, scope), isNull(configDrafts.product))
    : and(eq(configDrafts.orgId, orgId), eq(configDrafts.scope, scope), eq(configDrafts.product, product));
}

export function assertScope(scope: string): asserts scope is ConfigScope {
  if (!(CONFIG_SCOPES as readonly string[]).includes(scope)) {
    throw ApiError.validation({ scope: `must be one of ${CONFIG_SCOPES.join(', ')}` });
  }
}

function assertOrgId(orgId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

/** Stable digest input: sorted-keys JSON (the audit chain's canonical form). */
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');
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
