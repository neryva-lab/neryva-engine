import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService, bullQueueName } from '../../common/infra/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { SATELLITE_REGISTRY_REPOSITORY, REVOCATION_LOG_REPOSITORY } from './repositories/repository-tokens';
import type { ISatelliteRegistryRepository } from './repositories/satellite-registry.repository';
import type { IRevocationLogRepository } from './repositories/revocation-log.repository';
import { SatelliteIncidentsService } from './satellite-incidents.service';

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
 *     Reads config_notifications read-only via the registry repository —
 *     engine-owned platform table, avoiding the config-publish import cycle
 *     (documented seam).
 */
@Injectable()
export class SatelliteSweeperWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(SatelliteSweeperWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    @Inject(SATELLITE_REGISTRY_REPOSITORY)
    private readonly registry: ISatelliteRegistryRepository,
    @Inject(REVOCATION_LOG_REPOSITORY)
    private readonly revocations: IRevocationLogRepository,
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
      bullQueueName('satellites'),
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
    const { changes, massLossSuspected } = await this.transitionLiveness();
    const configDrift = await this.detectConfigDrift();
    const prunedSamples = await this.pruneSamples();
    const prunedRevocations = await this.pruneRevocations();
    return {
      livenessChanges: changes,
      configDrift,
      prunedSamples,
      prunedRevocations,
      massLossSuspected,
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
  private async transitionLiveness(): Promise<{ changes: Array<{ key: string; from: string; to: string }>; massLossSuspected: boolean }> {
    const connected = await this.registry.listConnectedSatellites();
    const nowMs = Date.now();
    const timeoutMs = env.SATELLITE_HEARTBEAT_TIMEOUT_SECONDS * 1000;
    const changes: Array<{ key: string; from: string; to: string }> = [];
    // Effective post-pass liveness per tracked satellite (mass-loss reads
    // the AFTER state — evaluating pre-update rows would under-detect).
    const effective = new Map<string, string>();

    for (const satellite of connected) {
      if (satellite.liveness === 'never') {
        continue; // no lease to expire — first beat flips it to live
      }
      const ageMs = satellite.lastHeartbeatAt ? nowMs - Date.parse(satellite.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
      const target = ageMs <= timeoutMs ? 'live' : ageMs <= 2 * timeoutMs ? 'stale' : 'offline';
      effective.set(satellite.key, target);
      if (target === satellite.liveness) {
        continue;
      }
      await this.registry.setLiveness(satellite.key, target, new Date().toISOString());
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
    const tracked = [...effective.values()];
    let massLossSuspected = false;
    if (tracked.length > 1 && tracked.every((l) => l === 'stale' || l === 'offline')) {
      massLossSuspected = true;
      SatelliteSweeperWorker.logger.error('mass liveness loss suspected — engine-side fault more likely than every satellite failing at once');
      await this.audit.add({
        action: 'satellite.mass_loss_suspected',
        resourceType: 'satellite',
        resourceId: 'fleet',
        actorType: 'system',
        details: { affected: [...effective.keys()] },
      });
    }
    return { changes, massLossSuspected };
  }

  /**
   * Config drift: unacked notifications older than the drift threshold for
   * ACTIVE satellites. config_notifications is config-publish's table —
   * read read-only via the registry repository to avoid the import cycle
   * (config-publish imports this module for fanout); documented seam.
   */
  private async detectConfigDrift(): Promise<string[]> {
    const threshold = new Date(Date.now() - env.SATELLITE_CONFIG_ACK_DRIFT_SECONDS * 1000).toISOString();
    const candidates = await this.registry.driftCandidates(threshold);
    const drifted: string[] = [];
    for (const candidate of candidates) {
      const open = await this.incidents.unresolved(candidate.satelliteKey, 'config_drift');
      if (open) {
        continue; // already flagged — the dedup window covers the backlog
      }
      await this.incidents.open({
        satelliteKey: candidate.satelliteKey,
        kind: 'config_drift',
        detail: { unacked: candidate.count, oldest: candidate.oldest, threshold_seconds: env.SATELLITE_CONFIG_ACK_DRIFT_SECONDS },
      });
      await this.events.emit(EngineEvents.SatelliteConfigDrift, { key: candidate.satelliteKey, unacked: candidate.count });
      await this.audit.add({
        action: 'satellite.config_drift_detected',
        resourceType: 'satellite',
        resourceId: candidate.satelliteKey,
        actorType: 'system',
        details: { unacked: candidate.count, oldest: candidate.oldest },
      });
      drifted.push(candidate.satelliteKey);
    }
    // Clear drift for satellites whose backlog drained under the threshold.
    const stillBacklogged = new Set(await this.registry.backloggedSatelliteKeys());
    const openDrifts = await this.registry.openDriftIncidentKeys();
    for (const satelliteKey of openDrifts) {
      if (!stillBacklogged.has(satelliteKey)) {
        await this.incidents.resolve({ satelliteKey, kind: 'config_drift' });
      }
    }
    return drifted;
  }

  private async pruneSamples(): Promise<number> {
    const cutoff = new Date(Date.now() - env.SATELLITE_SAMPLE_RETENTION_HOURS * 3_600_000).toISOString();
    return this.registry.pruneHeartbeatSamples(cutoff);
  }

  private async pruneRevocations(): Promise<number> {
    const cutoff = new Date(Date.now() - env.SATELLITE_REVOCATION_RETENTION_DAYS * 86_400_000).toISOString();
    return this.revocations.pruneOlderThan(cutoff);
  }
}
