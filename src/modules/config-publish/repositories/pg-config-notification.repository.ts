import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { configNotifications } from '../config-publish.schema';
import type { ConfigNotification, IConfigNotificationRepository } from './config-publish.repository';

/**
 * PostgreSQL implementation of `IConfigNotificationRepository` (P3).
 *
 * Mechanical move of the `ConfigPublishService` fanout/ACK ledger units.
 * The `config_notifications` table is platform-plane by design (drizzle
 * 0007_satellite_surfaces.sql: "satellites and config_notifications are
 * platform-plane — no RLS"), so every method here runs on `db.root` with
 * an explicit predicate — exactly as the service did.
 */
export class PgConfigNotificationRepository implements IConfigNotificationRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert one notification row per satellite key; duplicates
   * ((config_id, satellite_key) already notified) are skipped
   * (`onConflictDoNothing`), never an error.
   */
  async insertFanout(configId: string, satelliteKeys: string[]): Promise<void> {
    if (satelliteKeys.length === 0) {
      return;
    }
    await this.db.root
      .insert(configNotifications)
      .values(satelliteKeys.map((satelliteKey) => ({ configId, satelliteKey })))
      .onConflictDoNothing();
  }

  /** Satellite ACK: mark its unacked notifications for a config as applied. */
  async ack(configId: string, satelliteKey: string): Promise<void> {
    await this.db.root
      .update(configNotifications)
      .set({ ackedAt: new Date().toISOString() })
      .where(
        and(
          eq(configNotifications.configId, configId),
          eq(configNotifications.satelliteKey, satelliteKey),
          isNull(configNotifications.ackedAt),
        ),
      );
  }

  /** Pending (unacked) notifications for one satellite — its work queue. */
  async pendingFor(satelliteKey: string, limit: number): Promise<Array<{ configId: string }>> {
    const rows = await this.db.root
      .select({ configId: configNotifications.configId })
      .from(configNotifications)
      .where(and(eq(configNotifications.satelliteKey, satelliteKey), isNull(configNotifications.ackedAt)))
      .orderBy(configNotifications.notifiedAt)
      .limit(limit);
    return rows;
  }

  /** Every notification row for one config version (delivery status view). */
  async notificationsForConfig(configId: string): Promise<ConfigNotification[]> {
    return this.db.root
      .select()
      .from(configNotifications)
      .where(eq(configNotifications.configId, configId));
  }

  /** Unacked counts per config id (the overview's unacked rollup). */
  async countUnackedByConfigIds(configIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (configIds.length === 0) {
      return out;
    }
    const counted = await this.db.root
      .select({ configId: configNotifications.configId, count: sql<number>`count(*)::int` })
      .from(configNotifications)
      .where(and(inArray(configNotifications.configId, configIds), isNull(configNotifications.ackedAt)))
      .groupBy(configNotifications.configId);
    for (const row of counted) {
      out.set(row.configId, row.count);
    }
    return out;
  }
}
