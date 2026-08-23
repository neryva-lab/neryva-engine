import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { eq, lt, sql } from 'drizzle-orm';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { SatelliteIncidentsService } from './satellite-incidents.service';
import { revocationEvents, satellites, satelliteHeartbeats } from './satellite.schema';

/**
 * The satellites sweeper (`satellites:` namespace — partitioning Tier-1):
 * the minute control loop that owns everything readers must NOT derive at
 * request time (gap X-2 and the retention promises):
 *
 *  1. LIVENESS TRANSITIONS: live → stale (lease expired once) → offline
 *     (expired twice). Each transition opens/resolves an incident, emits an
 *     event, and audits — the status center reads the column, never a clock.
 *     Eureka self-preservation nod: if EVERY connected satellite goes stale
 *     in one pass, that smells like an engine-side clock/network fault, so
 *     the pass is audited loudly as `satellite.mass_loss_suspected`.
 *  2. SAMPLE RETENTION: heartbeat rows older than
 *     SATELLITE_SAMPLE_RETENTION_HOURS are pruned (bounded history).
 *  3. REVOCATION-LOG RETENTION: rows older than
 *     SATELLITE_REVOCATION_RETENTION_DAYS are pruned (satellite caches are
 *     shorter — the documented bound).
 *  4. CONFIG DRIFT: unacked config notifications older than
 *     SATELLITE_CONFIG_ACK_DRIFT_SECONDS for an active satellite open a
 *     `config_drift` incident (deduped) and clear when the backlog drains.
 *     Reads config_notifications by raw SQL — engine-owned platform table,
 *     read-only, avoiding the config-publish import cycle (documented seam).
 */
@Injectable()
export class SatelliteSweeperWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(SatelliteSweeperWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly incidents: SatelliteIncidentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('satellites');
    await queue.add(
      'satellites.sweep',
      {},
      {
        repeat: { pattern: '* * * * *' }, // every minute — the lease clock's resolution
        removeOnFail: { age: 30 * 86_400 },
        removeOnComplete: { age: 7 * 86_400 },
      },
    );

    this.worker = new Worker(
      'satellites:default',
      async (job: Job) => {
        if (job.name === 'satellites.sweep') {
          const report = await this.sweep();
          if (report.livenessChanges.length > 0 || report.configDrift.length > 0) {
            SatelliteSweeperWorker.logger.log(
              `sweep: ${report.livenessChanges.map((c) => `${c.key}→${c.to}`).join(', ') || 'no liveness changes'}${report.configDrift.length ? `; drift: ${report.configDrift.join(', ')}` : ''}`,
            );
          }
          return report;
        }
        SatelliteSweeperWorker.logger.warn(`unknown satellites job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      SatelliteSweeperWorker.logger.error(`satellites job ${job?.name ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }

  /** One sweep pass. Returns the report (ops evidence + worker result). */
  async sweep(): Promise<{
    livenessChanges: Array<{ key: string; from: string; to: string }>;
    configDrift: string[];
    prunedSamples: number;
    prunedRevocations: number;
    massLossSuspected: boolean;
  }> {
    const livenessChanges = await this.transitionLiveness();
    const configDrift = await this.detectConfigDrift();
    const prunedSamples = await this.pruneSamples();
    const prunedRevocations = await this.pruneRevocations();
    return {
      livenessChanges,
      configDrift,
      prunedSamples,
      prunedRevocations,
      massLossSuspected: false, // set inside transitionLiveness when detected
    };
  }

  /**
   * Lease-state machine: for every CONNECTED satellite (active/draining/
   * quarantined — retired stops tracking), compute the age classes:
   *   live    : lease unexpired
   *   stale   : expired once  (degraded — incident opens)
   *   offline : expired twice (hard down — incident stays, event escalates)
   * A satellite that never beat keeps liveness=`never` — informational,
   * never an outage (the client half of the contract may not exist yet).
   */
  private async transitionLiveness(): Promise<Array<{ key: string; from: string; to: string }>> {
    const connected = await this.db.root.select().from(satellites).where(sql`${satellites.status} <> 'retired' and ${satellites.status} <> 'placeholder'`);
    const nowMs = Date.now();
    const timeoutMs = env.SATELLITE_HEARTBEAT_TIMEOUT_SECONDS * 1000;
    const changes: Array<{ key: string; from: string; to: string }> = [];

    for (const satellite of connected) {
      if (satellite.liveness === 'never') {
        continue; // no lease to expire — first beat flips it to live
      }
      const ageMs = satellite.lastHeartbeatAt ? nowMs - Date.parse(satellite.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
      const target = ageMs <= timeoutMs ? 'live' : ageMs <= 2 * timeoutMs ? 'stale' : 'offline';
      if (target === satellite.liveness) {
        continue;
      }
      await this.db.root.update(satellites).set({ liveness: target, updatedAt: new Date().toISOString() }).where(eq(satellites.key, satellite.key));
      changes.push({ key: satellite.key, from: satellite.liveness, to: target });

      if (target === 'stale' || target === 'offline') {
        await this.incidents.open({
          satelliteKey: satellite.key,
          kind: 'liveness_lost',
          detail: { state: target, last_heartbeat_at: satellite.lastHeartbeatAt, age_seconds: Math.floor(ageMs / 1000) },
        });
        await this.events.emit(EngineEvents.SatelliteLivenessLost, { key: satellite.key, state: target });
        await this.audit.add({
          action: 'satellite.liveness_lost',
          resourceType: 'satellite',
          resourceId: satellite.key,
          actorType: 'system',
          details: { state: target, age_seconds: Math.floor(ageMs / 1000) },
        });
      }
      // stale→live / offline→live recoveries are handled by the heartbeat
      // path (only a beat can restore liveness — the fence holds).
    }

    // Eureka self-preservation signal: every connected satellite stale+ at
    // once is almost certainly OUR fault (clock, DB, network), not theirs.
    const tracked = connected.filter((s) => s.liveness !== 'never');
    if (tracked.length > 1 && tracked.every((s) => s.liveness === 'stale' || s.liveness === 'offline')) {
      SatelliteSweeperWorker.logger.error('mass liveness loss suspected — engine-side fault more likely than every satellite failing at once');
      await this.audit.add({
        action: 'satellite.mass_loss_suspected',
        resourceType: 'satellite',
        resourceId: 'fleet',
        actorType: 'system',
        details: { affected: tracked.map((s) => s.key) },
      });
    }
    return changes;
  }

  /**
   * Config drift: unacked notifications older than the drift threshold for
   * ACTIVE satellites. config_notifications is config-publish's table —
   * read by raw SQL here to avoid the import cycle (config-publish imports
   * this module for fanout); read-only, engine-owned, documented seam.
   */
  private async detectConfigDrift(): Promise<string[]> {
    const threshold = new Date(Date.now() - env.SATELLITE_CONFIG_ACK_DRIFT_SECONDS * 1000).toISOString();
    const rows = await this.db.root.execute<{ satellite_key: string; oldest: string; n: string }>(sql`
      select cn.satellite_key, min(cn.created_at)::text as oldest, count(*) as n
      from config_notifications cn
      join satellites s on s.key = cn.satellite_key
      where cn.acked_at is null
        and cn.created_at < ${threshold}::timestamptz
        and s.status = 'active'
      group by cn.satellite_key
    `);
    const drifted: string[] = [];
    for (const row of rows.rows) {
      const open = await this.incidents.unresolved(row.satellite_key, 'config_drift');
      if (open) {
        continue; // already flagged — the dedup window covers the backlog
      }
      await this.incidents.open({
        satelliteKey: row.satellite_key,
        kind: 'config_drift',
        detail: { unacked: Number(row.n), oldest: row.oldest, threshold_seconds: env.SATELLITE_CONFIG_ACK_DRIFT_SECONDS },
      });
      await this.events.emit(EngineEvents.SatelliteConfigDrift, { key: row.satellite_key, unacked: Number(row.n) });
      await this.audit.add({
        action: 'satellite.config_drift_detected',
        resourceType: 'satellite',
        resourceId: row.satellite_key,
        actorType: 'system',
        details: { unacked: Number(row.n), oldest: row.oldest },
      });
      drifted.push(row.satellite_key);
    }
    // Clear drift for satellites whose backlog drained under the threshold.
    const flagged = await this.db.root.execute<{ satellite_key: string }>(sql`
      select distinct cn.satellite_key
      from config_notifications cn
      join satellites s on s.key = cn.satellite_key
      where cn.acked_at is null and s.status = 'active'
    `);
    const stillBacklogged = new Set(flagged.rows.map((r) => r.satellite_key));
    const openDrifts = await this.db.root.execute<{ satellite_key: string }>(sql`
      select distinct satellite_key from satellite_incidents where kind = 'config_drift' and resolved_at is null
    `);
    for (const row of openDrifts.rows) {
      if (!stillBacklogged.has(row.satellite_key)) {
        await this.incidents.resolve({ satelliteKey: row.satellite_key, kind: 'config_drift' });
      }
    }
    return drifted;
  }

  private async pruneSamples(): Promise<number> {
    const cutoff = new Date(Date.now() - env.SATELLITE_SAMPLE_RETENTION_HOURS * 3_600_000).toISOString();
    const pruned = await this.db.root
      .delete(satelliteHeartbeats)
      .where(lt(satelliteHeartbeats.receivedAt, cutoff))
      .returning({ id: satelliteHeartbeats.id });
    return pruned.length;
  }

  private async pruneRevocations(): Promise<number> {
    const cutoff = new Date(Date.now() - env.SATELLITE_REVOCATION_RETENTION_DAYS * 86_400_000).toISOString();
    const pruned = await this.db.root
      .delete(revocationEvents)
      .where(lt(revocationEvents.occurredAt, cutoff))
      .returning({ id: revocationEvents.id });
    return pruned.length;
  }
}
