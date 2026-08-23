import { eq } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { HEARTBEAT_TIMEOUT_SECONDS, satellites, Satellite } from './satellite.schema';

/**
 * The satellite registry service. Seeds the known deployables idempotently
 * at boot (the pattern pre-registration):
 *
 *  - `agent-runtime` — LIVE today: the Python studio runtime serving /v1 +
 *    /surfaces behind the proxy (ADR-006 D3, ledger A-0).
 *  - `inference` — PLACEHOLDER, trigger-gated (ADR-006 D4 / ledger
 *    inference.md): the row exists so the connection contract's shape is
 *    fixed before the pressure arrives. It carries no routes, no manifest,
 *    and no entitlements until an ADR-002 amendment opens it.
 */
@Injectable()
export class SatelliteRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SatelliteRegistryService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  private async seed(): Promise<void> {
    const seeds: Array<typeof satellites.$inferInsert> = [
      {
        key: 'agent-runtime',
        kind: 'agent-runtime',
        status: 'active',
        routePrefixes: ['/v1', '/surfaces'],
        serviceClientId: 'svc-agent-runtime',
        products: ['agent_studio'],
        metadata: { runtime: 'python', note: 'production runtime until the NestJS replacement flips namespaces (ADR-007 D4)' },
      },
      {
        key: 'inference',
        kind: 'inference',
        status: 'placeholder',
        routePrefixes: [],
        serviceClientId: null,
        products: [],
        metadata: { note: 'pre-registered placeholder — opens only via an ADR-002 register amendment (ADR-006 D4)' },
      },
    ];
    for (const seed of seeds) {
      await this.db.root.insert(satellites).values(seed).onConflictDoNothing({ target: satellites.key });
    }
    this.logger.log('satellite registry seeded (agent-runtime active; inference placeholder)');
  }

  async list(): Promise<Satellite[]> {
    return this.db.root.select().from(satellites).orderBy(satellites.key);
  }

  async get(key: string): Promise<Satellite | null> {
    const rows = await this.db.root.select().from(satellites).where(eq(satellites.key, key)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Heartbeat from a satellite (L3-authenticated). Idempotent, cheap, and
   * the ONLY write satellites perform here. A satellite key that is not
   * registered or is retired is rejected — heartbeats never conjure rows.
   */
  async heartbeat(input: { key: string; version?: string; metadata?: Record<string, unknown> }): Promise<{ ok: true; intervalSeconds: number }> {
    const rows = await this.db.root.select().from(satellites).where(eq(satellites.key, input.key)).limit(1);
    const satellite = rows[0];
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
    await this.db.root
      .update(satellites)
      .set({
        lastHeartbeatAt: new Date().toISOString(),
        lastHeartbeatVersion: input.version ?? null,
        updatedAt: new Date().toISOString(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .where(eq(satellites.key, input.key));
    return { ok: true, intervalSeconds: Math.floor(HEARTBEAT_TIMEOUT_SECONDS / 3) };
  }

  /** Operational status with liveness derived from the heartbeat age. */
  async statusView(): Promise<Array<Omit<Satellite, 'metadata'> & { alive: boolean | null; heartbeatAgeSeconds: number | null }>> {
    const rows = await this.list();
    const now = Date.now();
    return rows.map(({ metadata, ...rest }) => {
      void metadata;
      const age = rest.lastHeartbeatAt ? Math.floor((now - Date.parse(rest.lastHeartbeatAt)) / 1000) : null;
      return {
        ...rest,
        heartbeatAgeSeconds: age,
        alive: age === null ? null : age <= HEARTBEAT_TIMEOUT_SECONDS,
      };
    });
  }
}
