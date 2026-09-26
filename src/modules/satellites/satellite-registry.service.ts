import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { ApiError } from '../../common/http/api-error';
import { SATELLITE_REGISTRY_REPOSITORY } from './repositories/repository-tokens';
import type { ISatelliteRegistryRepository } from './repositories/satellite-registry.repository';
import { SatelliteActivityService } from './satellite-activity.service';
import { SatelliteIncidentsService } from './satellite-incidents.service';
import { Satellite, SatelliteHeartbeatRow } from './satellite.schema';

/**
 * The satellite registry (ADR-006 D2/D4): the full lifecycle — seed,
 * register, quarantine, drain, retire — plus the heartbeat lease protocol.
 *
 * Design (eng-0010; kubelet-Lease + Eureka + tri-state-health synthesis):
 *
 *  - LEASE: a heartbeat renews lease_expires_at = now + timeout. The
 *    sweeper alone flips liveness down (stale/offline); the heartbeat alone
 *    flips it up (live). Readers never derive — they read the column.
 *  - DIRECTIVES: the heartbeat response carries desired state (run/drain/
 *    quarantine), the version floor, and the config-ACK backlog so the
 *    satellite converges itself — the engine never reaches into it.
 *  - QUARANTINE keeps heartbeats flowing (we still want to SEE it) while
 *    everything else refuses it; DRAIN is graceful retirement (finish
 *    in-flight, stop new work); RETIRE is terminal and refuses beats.
 *  - A never-beaten satellite is liveness=`never`, NOT degraded — the
 *    client half of a contract may legitimately not be built yet (the
 *    agent-runtime's engine client today); the status center must not cry
 *    outage over a missing client.
 */
@Injectable()
export class SatelliteRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SatelliteRegistryService.name);

  constructor(
    @Inject(SATELLITE_REGISTRY_REPOSITORY)
    private readonly registry: ISatelliteRegistryRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly incidents: SatelliteIncidentsService,
    private readonly activity: SatelliteActivityService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  get heartbeatIntervalSeconds(): number {
    return Math.max(5, Math.floor(this.timeoutSeconds / 3));
  }

  get timeoutSeconds(): number {
    return env.SATELLITE_HEARTBEAT_TIMEOUT_SECONDS;
  }

  private async seed(): Promise<void> {
    const seeds = [
      {
        key: 'agent-runtime',
        kind: 'agent-runtime',
        status: 'active',
        routePrefixes: ['/v1', '/surfaces'],
        serviceClientId: 'svc-agent-runtime',
        products: ['agent_studio'],
        endpointUrl: null,
        metadata: { runtime: 'python', note: 'production runtime until the NestJS replacement flips namespaces (ADR-007 D4)' },
      },
      {
        key: 'inference',
        kind: 'inference',
        status: 'placeholder',
        routePrefixes: [],
        serviceClientId: null,
        products: [],
        endpointUrl: null,
        metadata: { note: 'pre-registered placeholder — opens only via an ADR-002 register amendment (ADR-006 D4)' },
      },
    ];
    for (const seed of seeds) {
      await this.registry.seedSatellite(seed);
    }
    this.logger.log('satellite registry seeded (agent-runtime active; inference placeholder)');
  }

  async list(): Promise<Satellite[]> {
    return this.registry.listSatellites();
  }

  async get(key: string): Promise<Satellite | null> {
    return this.registry.getSatellite(key);
  }

  /**
   * Operational status view (staff + status center): the registry row plus
   * derived freshness. `liveness` is the persisted sweeper/heartbeat truth;
   * `alive` stays for the console status service's contract (null = never
   * connected — informational, NOT an outage).
   */
  async statusView(): Promise<
    Array<
      Satellite & {
        alive: boolean | null;
        heartbeatAgeSeconds: number | null;
        leaseExpiresInSeconds: number | null;
        heartbeatIntervalSeconds: number;
        openIncidents: number;
      }
    >
  > {
    const rows = await this.list();
    const now = Date.now();
    const openByKey = await this.registry.openIncidentCounts();
    return rows.map((row) => {
      const age = row.lastHeartbeatAt ? Math.floor((now - Date.parse(row.lastHeartbeatAt)) / 1000) : null;
      const lease = row.leaseExpiresAt ? Math.max(0, Math.floor((Date.parse(row.leaseExpiresAt) - now) / 1000)) : null;
      return {
        ...row,
        heartbeatAgeSeconds: age,
        alive: age === null ? null : row.liveness === 'live',
        leaseExpiresInSeconds: lease,
        heartbeatIntervalSeconds: this.heartbeatIntervalSeconds,
        openIncidents: openByKey.get(row.key) ?? 0,
      };
    });
  }

  // ── registration + lifecycle (staff operations) ──────────────────────────

  /**
   * Register or update a satellite (upsert). Staff-only at the controller;
   * every field change is audited with from→to. Registering a NEW key that
   * has no service client yet is allowed (identity lands with the client)
   * but the row stays liveness=`never` until something beats it.
   */
  async register(input: {
    key: string;
    kind: string;
    status?: 'active' | 'placeholder';
    routePrefixes?: string[];
    serviceClientId?: string | null;
    products?: string[];
    endpointUrl?: string | null;
    versionFloor?: string | null;
    capabilities?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    actorId: string;
  }): Promise<Satellite> {
    const key = input.key.trim().toLowerCase().slice(0, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw ApiError.validation({ key: 'lowercase kebab-case required (e.g. "agent-runtime")' });
    }
    if (!['agent-runtime', 'inference', 'custom', 'worker', 'gateway'].includes(input.kind)) {
      throw ApiError.validation({ kind: 'must be one of agent-runtime, inference, custom, worker, gateway' });
    }
    const prefixes = (input.routePrefixes ?? []).filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 16);
    const products = (input.products ?? []).filter((p) => typeof p === 'string').slice(0, 16);
    if (input.endpointUrl && !/^https?:\/\//.test(input.endpointUrl)) {
      throw ApiError.validation({ endpoint_url: 'must be an http(s) URL' });
    }

    const existing = await this.get(key);
    if (existing?.status === 'retired') {
      throw ApiError.conflict('retired satellites are terminal — register a new key instead');
    }

    const row = await this.registry.upsertSatellite(
      key,
      {
        kind: input.kind,
        routePrefixes: prefixes,
        serviceClientId: input.serviceClientId?.slice(0, 64) ?? null,
        products,
        endpointUrl: input.endpointUrl?.slice(0, 512) ?? null,
        versionFloor: input.versionFloor?.slice(0, 64) ?? null,
        capabilities: input.capabilities ?? {},
        metadata: input.metadata ?? {},
        updatedAt: new Date().toISOString(),
      },
      { status: input.status ?? 'active', createdBy: input.actorId },
    );

    const changes: Record<string, unknown> = existing
      ? {
          kind: existing.kind !== row.kind,
          route_prefixes: JSON.stringify(existing.routePrefixes) !== JSON.stringify(row.routePrefixes),
          service_client_id: existing.serviceClientId !== row.serviceClientId,
          products: JSON.stringify(existing.products) !== JSON.stringify(row.products),
          endpoint_url: existing.endpointUrl !== row.endpointUrl,
          version_floor: existing.versionFloor !== row.versionFloor,
        }
      : { registered: true, status: row.status };
    await this.audit.add({
      action: existing ? 'satellite.updated' : 'satellite.registered',
      resourceType: 'satellite',
      resourceId: key,
      actorType: 'account',
      actorId: input.actorId,
      details: changes,
    });
    if (!existing) {
      await this.events.emit(EngineEvents.SatelliteRegistered, { key, kind: row.kind });
      await this.incidents.open({ satelliteKey: key, kind: 'liveness_restored', detail: { note: 'registered', registered: true }, autoResolve: true }).catch(() => undefined);
    }
    return row;
  }

  /**
   * Quarantine: heartbeats still accepted (visibility), everything else
   * refuses it, and the beat response carries `desired: "quarantine"` — the
   * satellite drains itself. Reversable via release().
   */
  async quarantine(input: { key: string; reason: string; actorId: string }): Promise<void> {
    const satellite = await this.require(input.key);
    if (satellite.status === 'retired') {
      throw ApiError.conflict('satellite is retired');
    }
    if (satellite.status === 'quarantined') {
      throw ApiError.conflict('satellite is already quarantined');
    }
    const reason = input.reason.trim().slice(0, 512);
    if (reason.length < 3) {
      throw ApiError.validation({ reason: 'a quarantine reason is required (audited + shown to ops)' });
    }
    const now = new Date().toISOString();
    await this.registry.updateSatelliteStatus(input.key, {
      status: 'quarantined',
      quarantinedAt: now,
      quarantinedBy: input.actorId,
      quarantineReason: reason,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'satellite.quarantined',
      resourceType: 'satellite',
      resourceId: input.key,
      actorType: 'account',
      actorId: input.actorId,
      details: { reason },
    });
    await this.events.emit(EngineEvents.SatelliteQuarantined, { key: input.key, reason });
    await this.incidents.open({ satelliteKey: input.key, kind: 'quarantined', detail: { reason, by: input.actorId } });
  }

  async release(input: { key: string; actorId: string }): Promise<void> {
    const satellite = await this.require(input.key);
    if (satellite.status !== 'quarantined') {
      throw ApiError.conflict('satellite is not quarantined');
    }
    const now = new Date().toISOString();
    await this.registry.updateSatelliteStatus(input.key, {
      status: 'active',
      quarantinedAt: null,
      quarantinedBy: null,
      quarantineReason: null,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'satellite.released',
      resourceType: 'satellite',
      resourceId: input.key,
      actorType: 'account',
      actorId: input.actorId,
      details: {},
    });
    await this.events.emit(EngineEvents.SatelliteReleased, { key: input.key });
    await this.incidents.resolve({ satelliteKey: input.key, kind: 'quarantined' });
    await this.incidents.open({ satelliteKey: input.key, kind: 'released', detail: { by: input.actorId }, autoResolve: true });
  }

  /** Graceful retirement step 1: stop new work (fanout excludes draining), finish in-flight. */
  async drain(input: { key: string; actorId: string }): Promise<void> {
    const satellite = await this.require(input.key);
    if (satellite.status !== 'active') {
      throw ApiError.conflict(`only an active satellite can drain (current: ${satellite.status})`);
    }
    const now = new Date().toISOString();
    await this.registry.updateSatelliteStatus(input.key, {
      status: 'draining',
      drainStartedAt: now,
      drainedBy: input.actorId,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'satellite.draining',
      resourceType: 'satellite',
      resourceId: input.key,
      actorType: 'account',
      actorId: input.actorId,
      details: {},
    });
    await this.events.emit(EngineEvents.SatelliteDraining, { key: input.key });
    await this.incidents.open({ satelliteKey: input.key, kind: 'drained', detail: { by: input.actorId } });
  }

  async resume(input: { key: string; actorId: string }): Promise<void> {
    const satellite = await this.require(input.key);
    if (satellite.status !== 'draining') {
      throw ApiError.conflict('satellite is not draining');
    }
    const now = new Date().toISOString();
    await this.registry.updateSatelliteStatus(input.key, {
      status: 'active',
      drainStartedAt: null,
      drainedBy: null,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'satellite.resumed',
      resourceType: 'satellite',
      resourceId: input.key,
      actorType: 'account',
      actorId: input.actorId,
      details: {},
    });
    await this.events.emit(EngineEvents.SatelliteResumed, { key: input.key });
    await this.incidents.resolve({ satelliteKey: input.key, kind: 'drained' });
    await this.incidents.open({ satelliteKey: input.key, kind: 'resumed', detail: { by: input.actorId }, autoResolve: true });
  }

  /** Terminal. Retired rows never accept heartbeats again; register a new key instead. */
  async retire(input: { key: string; actorId: string }): Promise<void> {
    const satellite = await this.require(input.key);
    if (satellite.status === 'retired') {
      throw ApiError.conflict('satellite is already retired');
    }
    const now = new Date().toISOString();
    await this.registry.updateSatelliteStatus(input.key, {
      status: 'retired',
      retiredAt: now,
      updatedAt: now,
    });
    await this.audit.add({
      action: 'satellite.retired',
      resourceType: 'satellite',
      resourceId: input.key,
      actorType: 'account',
      actorId: input.actorId,
      details: { prior_status: satellite.status },
    });
    await this.events.emit(EngineEvents.SatelliteRetired, { key: input.key });
    await this.incidents.resolve({ satelliteKey: input.key });
    await this.incidents.open({ satelliteKey: input.key, kind: 'liveness_restored', detail: { note: 'retired' }, autoResolve: true }).catch(() => undefined);
  }

  // ── the heartbeat lease protocol ─────────────────────────────────────────

  /**
   * Heartbeat from a satellite (L3-authenticated). Idempotent, cheap, and
   * the ONLY write satellites perform here. Renews the lease, records a
   * sample row, bumps the compliance counter, enforces the version floor,
   * and answers with DIRECTIVES (desired state, floor, config backlog)
   * the satellite converges on itself.
   */
  async heartbeat(input: {
    key: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{
    ok: true;
    interval_seconds: number;
    liveness: string;
    desired: 'run' | 'drain' | 'quarantine';
    version_floor: string | null;
    quarantine_reason: string | null;
    server_time: string;
  }> {
    const satellite = await this.get(input.key);
    if (!satellite) {
      throw new Error(`unknown satellite: ${input.key}`);
    }
    if (satellite.status === 'retired') {
      throw new Error(`satellite retired: ${input.key}`);
    }
    if (satellite.status === 'placeholder') {
      // A placeholder receiving heartbeats means someone built against a
      // pattern that was never opened — loud failure, audited.
      await this.audit.add({
        action: 'satellite.placeholder_heartbeat_rejected',
        resourceType: 'satellite',
        resourceId: input.key,
        actorType: 'service',
        actorId: input.key,
        details: {},
      });
      throw new Error(`satellite ${input.key} is a placeholder — the trigger has not been pulled (ADR-002)`);
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + this.timeoutSeconds * 1000).toISOString();
    const wasNotLive = satellite.liveness !== 'live';
    await this.registry.renewHeartbeatLease(input.key, {
      liveness: 'live',
      leaseExpiresAt,
      lastHeartbeatAt: now,
      lastHeartbeatVersion: input.version?.slice(0, 64) ?? satellite.lastHeartbeatVersion,
      ...(satellite.firstHeartbeatAt ? {} : { firstHeartbeatAt: now }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      updatedAt: now,
    });

    // Bounded sample history (pruned by the sweeper).
    await this.registry.insertHeartbeatSample({
      satelliteKey: input.key,
      version: input.version?.slice(0, 64) ?? null,
      metrics: sanitizeJson(input.metrics),
      capabilities: sanitizeJson(input.capabilities),
      metadata: sanitizeJson(input.metadata),
      receivedAt: now,
    });
    this.activity.touch(input.key, 'heartbeat');

    if (wasNotLive) {
      // A recovery (or first contact): close the loss window, record it.
      await this.incidents.resolve({ satelliteKey: input.key, kind: 'liveness_lost' });
      await this.incidents.open({ satelliteKey: input.key, kind: 'liveness_restored', detail: { version: input.version ?? null }, autoResolve: true });
      await this.events.emit(EngineEvents.SatelliteLivenessRestored, { key: input.key });
      await this.audit.add({
        action: 'satellite.liveness_restored',
        resourceType: 'satellite',
        resourceId: input.key,
        actorType: 'service',
        actorId: input.key,
        details: { version: input.version ?? null },
      });
    }

    // Version floor (progressive-delivery lever): a beat below the floor
    // opens an incident — the lease stays (visibility first; the staff
    // action to take is quarantine/drain, not blindness). Comparison is
    // numeric per segment: '10.0.0' must NOT sort below '9.0.0'.
    if (satellite.versionFloor && input.version && versionLt(input.version, satellite.versionFloor)) {
      const open = await this.incidents.unresolved(input.key, 'version_floor');
      if (!open) {
        await this.incidents.open({ satelliteKey: input.key, kind: 'version_floor', detail: { reported: input.version, floor: satellite.versionFloor } });
        await this.events.emit(EngineEvents.SatelliteVersionFloorViolated, { key: input.key, reported: input.version, floor: satellite.versionFloor });
        await this.audit.add({
          action: 'satellite.version_floor_violated',
          resourceType: 'satellite',
          resourceId: input.key,
          actorType: 'service',
          actorId: input.key,
          details: { reported: input.version, floor: satellite.versionFloor },
        });
      }
    } else if (!input.version || !satellite.versionFloor || !versionLt(input.version, satellite.versionFloor)) {
      await this.incidents.resolve({ satelliteKey: input.key, kind: 'version_floor' });
    }

    return {
      ok: true,
      interval_seconds: this.heartbeatIntervalSeconds,
      liveness: 'live',
      desired: satellite.status === 'quarantined' ? 'quarantine' : satellite.status === 'draining' ? 'drain' : 'run',
      version_floor: satellite.versionFloor ?? null,
      quarantine_reason: satellite.status === 'quarantined' ? satellite.quarantineReason ?? null : null,
      server_time: now,
    };
  }

  /** Heartbeat history for the ops view (bounded window + cap). */
  async history(key: string, limit = 200): Promise<SatelliteHeartbeatRow[]> {
    return this.registry.listHeartbeatHistory(key, limit);
  }

  /** History for the fleet view (all satellites, recent window). */
  async recentHistory(minutes = 60): Promise<SatelliteHeartbeatRow[]> {
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    return this.registry.listRecentHeartbeats(since, 5000);
  }

  /** May this satellite serve traffic (config pull gate)? Quarantined/retired refuse. */
  isOperational(satellite: Satellite): boolean {
    return satellite.status === 'active' || satellite.status === 'draining';
  }

  private async require(key: string): Promise<Satellite> {
    const satellite = await this.get(key);
    if (!satellite) {
      throw ApiError.notFound('satellite');
    }
    return satellite;
  }
}

/** Cap + copy inbound JSON (metrics/capabilities/metadata) so a satellite cannot balloon rows. */
function sanitizeJson(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const serialized = JSON.stringify(input);
  if (serialized.length > 32_768) {
    return { truncated: true, size: serialized.length };
  }
  return { ...input };
}

/**
 * Numeric-segment version compare (a < b). Segments parse as integers with
 * a lexical tiebreak for non-numeric suffixes ('1.2.3-rc1'); shorter rows
 * pad with zeros ('1.2' === '1.2.0').
 */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s));
  const pb = b.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? 0;
    const sb = pb[i] ?? 0;
    if (sa === sb) {
      continue;
    }
    if (typeof sa === 'number' && typeof sb === 'number') {
      return sa < sb;
    }
    return String(sa) < String(sb);
  }
  return false;
}
