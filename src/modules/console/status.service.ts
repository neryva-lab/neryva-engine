import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { HealthRegistry } from '../../common/health/health.controller';
import { SatelliteRegistryService } from '../satellites/satellite-registry.service';
import { consoleAnnouncements } from './announcements.schema';

/**
 * The platform status center (statuspage parity, in-console): aggregated
 * component health (kernel checks + satellite liveness) plus the active
 * announcement window (maintenance/incidents/notices). Announcement CRUD
 * is staff-gated at the controller (L2 operator).
 */
export type AnnouncementInput = {
  kind: 'maintenance' | 'incident' | 'notice' | 'product_release';
  severity?: 'info' | 'warn' | 'critical';
  title: string;
  body?: string;
  link?: string;
  activeUntil?: string | null;
  publishedBy: string;
};

@Injectable()
export class ConsoleStatusService {
  constructor(
    private readonly db: DbService,
    private readonly health: HealthRegistry,
    private readonly satellites: SatelliteRegistryService,
  ) {}

  async status(): Promise<{
    overall: 'operational' | 'degraded' | 'outage';
    components: Array<{ name: string; ok: boolean }>;
    satellites: Array<{ key: string; status: string; liveness: string; alive: boolean | null; heartbeat_age_seconds: number | null }>;
    announcements: Array<Record<string, unknown>>;
  }> {
    const [checks, satellites, announcements] = await Promise.all([
      this.health.runAll(),
      this.satellites.statusView(),
      this.activeAnnouncements(),
    ]);
    // Liveness semantics (eng-0010): `offline` (lease expired twice) is a
    // hard outage; `stale` (expired once) is degraded; `never` means the
    // client half of the connection contract isn't built yet —
    // informational, NOT degraded (a missing client is not an outage).
    const hardDown = checks.some((c) => !c.ok) || satellites.some((s) => s.status !== 'retired' && s.status !== 'placeholder' && s.liveness === 'offline');
    const soft = satellites.some((s) => s.status !== 'retired' && s.status !== 'placeholder' && s.liveness === 'stale');
    return {
      overall: hardDown ? 'outage' : soft ? 'degraded' : 'operational',
      components: checks,
      satellites: satellites.map((s) => ({ key: s.key, status: s.status, liveness: s.liveness, alive: s.alive, heartbeat_age_seconds: s.heartbeatAgeSeconds })),
      announcements,
    };
  }

  async activeAnnouncements(): Promise<Array<Record<string, unknown>>> {
    const now = new Date().toISOString();
    const rows = await this.db.root
      .select()
      .from(consoleAnnouncements)
      .where(and(lte(consoleAnnouncements.activeFrom, now), or(isNull(consoleAnnouncements.activeUntil), gte(consoleAnnouncements.activeUntil, now))))
      .orderBy(desc(consoleAnnouncements.activeFrom))
      .limit(20);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      link: row.link,
      active_from: row.activeFrom,
      active_until: row.activeUntil,
    }));
  }

  async createAnnouncement(input: AnnouncementInput): Promise<Record<string, unknown>> {
    const inserted = await this.db.root
      .insert(consoleAnnouncements)
      .values({
        kind: input.kind,
        severity: input.severity ?? 'info',
        title: input.title.slice(0, 256),
        body: (input.body ?? '').slice(0, 4000),
        link: input.link?.slice(0, 512) ?? null,
        activeUntil: input.activeUntil ?? null,
        publishedBy: input.publishedBy,
      })
      .returning();
    return inserted[0] as Record<string, unknown>;
  }

  /** Resolve = close the window and mark severity resolved (kept, not deleted — the incident history IS the status page). */
  async resolveAnnouncement(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const updated = await this.db.root
      .update(consoleAnnouncements)
      .set({ severity: 'resolved', activeUntil: now, updatedAt: now })
      .where(eq(consoleAnnouncements.id, id))
      .returning({ id: consoleAnnouncements.id });
    return updated.length === 1;
  }
}
