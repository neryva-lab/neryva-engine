import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { satelliteIncidents, SatelliteIncidentRow } from './satellite.schema';

/**
 * The satellite incident timeline (eng-0010): liveness transitions,
 * quarantines, version-floor violations, config drift. One OPEN incident
 * per (satellite, kind) — a repeat condition extends the window instead of
 * spamming rows; resolution closes it. The list IS the status page's
 * history (statuspage parity) and the ops evidence trail.
 */
export type IncidentKind =
  | 'liveness_lost'
  | 'liveness_restored'
  | 'quarantined'
  | 'released'
  | 'version_floor'
  | 'config_drift'
  | 'drained'
  | 'resumed';

@Injectable()
export class SatelliteIncidentsService {
  constructor(private readonly db: DbService) {}

  /**
   * Open (or extend) an incident. `liveness_restored`-style kinds resolve
   * instantly (they are their own closure); persistent kinds (drift, floor)
   * stay open until the matching condition clears.
   */
  async open(input: { satelliteKey: string; kind: IncidentKind; detail?: Record<string, unknown>; autoResolve?: boolean }): Promise<void> {
    const now = new Date().toISOString();
    if (input.autoResolve) {
      await this.db.root.insert(satelliteIncidents).values({
        satelliteKey: input.satelliteKey,
        kind: input.kind,
        detail: input.detail ?? {},
        openedAt: now,
        resolvedAt: now,
      });
      return;
    }
    // Dedup: extend the open window of the same kind if one exists.
    const existing = await this.unresolved(input.satelliteKey, input.kind);
    if (existing) {
      await this.db.root
        .update(satelliteIncidents)
        .set({ detail: { ...(existing.detail as Record<string, unknown>), last_seen: now, ...(input.detail ?? {}) } })
        .where(eq(satelliteIncidents.id, existing.id));
      return;
    }
    await this.db.root.insert(satelliteIncidents).values({
      satelliteKey: input.satelliteKey,
      kind: input.kind,
      detail: { ...(input.detail ?? {}), first_seen: now },
    });
  }

  /** Close every open incident of a kind for a satellite (condition cleared). */
  async resolve(input: { satelliteKey: string; kind?: IncidentKind }): Promise<number> {
    const conditions = [eq(satelliteIncidents.satelliteKey, input.satelliteKey), isNull(satelliteIncidents.resolvedAt)];
    if (input.kind) {
      conditions.push(eq(satelliteIncidents.kind, input.kind));
    }
    const resolved = await this.db.root
      .update(satelliteIncidents)
      .set({ resolvedAt: new Date().toISOString() })
      .where(and(...conditions))
      .returning({ id: satelliteIncidents.id });
    return resolved.length;
  }

  async unresolved(satelliteKey: string, kind: IncidentKind): Promise<SatelliteIncidentRow | null> {
    const rows = await this.db.root
      .select()
      .from(satelliteIncidents)
      .where(and(eq(satelliteIncidents.satelliteKey, satelliteKey), eq(satelliteIncidents.kind, kind), isNull(satelliteIncidents.resolvedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listFor(satelliteKey: string, limit = 100): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .where(eq(satelliteIncidents.satelliteKey, satelliteKey))
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Unresolved incidents only (the detail view's "open now" panel). */
  async listOpen(satelliteKey: string, limit = 50): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .where(and(eq(satelliteIncidents.satelliteKey, satelliteKey), isNull(satelliteIncidents.resolvedAt)))
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /** The status page feed: every satellite's recent incidents, newest first. */
  async recent(limit = 100): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  async openCount(): Promise<number> {
    const rows = await this.db.root
      .select({ id: satelliteIncidents.id })
      .from(satelliteIncidents)
      .where(isNull(satelliteIncidents.resolvedAt));
    return rows.length;
  }
}
