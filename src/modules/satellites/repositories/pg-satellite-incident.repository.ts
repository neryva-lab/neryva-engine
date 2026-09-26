/**
 * PostgreSQL satellite-incident repository (P3) — `satellite_incidents`.
 * Mechanical move of `SatelliteIncidentsService`'s persistence (open with
 * the unresolved-dedup read, extend, resolve, list variants, open count).
 * The open/extend decision (dedup vs new row) stays in the service — this
 * port owns only the queries.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { satelliteIncidents, type SatelliteIncidentRow } from '../satellite.schema';
import type { ISatelliteIncidentRepository, SatelliteIncidentKind } from './satellite-incident.repository';

export class PgSatelliteIncidentRepository implements ISatelliteIncidentRepository {
  constructor(private readonly db: DbService) {}

  async openIncident(input: {
    satelliteKey: string;
    kind: SatelliteIncidentKind;
    detail: Record<string, unknown>;
    openedAt: string;
    resolvedAt?: string | null;
  }): Promise<void> {
    await this.db.root.insert(satelliteIncidents).values({
      satelliteKey: input.satelliteKey,
      kind: input.kind,
      detail: input.detail,
      openedAt: input.openedAt,
      resolvedAt: input.resolvedAt ?? null,
    });
  }

  async extendIncident(id: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.root
      .update(satelliteIncidents)
      .set({ detail })
      .where(eq(satelliteIncidents.id, id));
  }

  async resolveIncidents(satelliteKey: string, kind?: SatelliteIncidentKind): Promise<number> {
    const conditions = [eq(satelliteIncidents.satelliteKey, satelliteKey), isNull(satelliteIncidents.resolvedAt)];
    if (kind) {
      conditions.push(eq(satelliteIncidents.kind, kind));
    }
    const resolved = await this.db.root
      .update(satelliteIncidents)
      .set({ resolvedAt: new Date().toISOString() })
      .where(and(...conditions))
      .returning({ id: satelliteIncidents.id });
    return resolved.length;
  }

  async findUnresolved(satelliteKey: string, kind: SatelliteIncidentKind): Promise<SatelliteIncidentRow | null> {
    const rows = await this.db.root
      .select()
      .from(satelliteIncidents)
      .where(and(eq(satelliteIncidents.satelliteKey, satelliteKey), eq(satelliteIncidents.kind, kind), isNull(satelliteIncidents.resolvedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listFor(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .where(eq(satelliteIncidents.satelliteKey, satelliteKey))
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  async listOpen(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .where(and(eq(satelliteIncidents.satelliteKey, satelliteKey), isNull(satelliteIncidents.resolvedAt)))
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  async listRecent(limit: number): Promise<SatelliteIncidentRow[]> {
    return this.db.root
      .select()
      .from(satelliteIncidents)
      .orderBy(desc(satelliteIncidents.openedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  async countOpen(): Promise<number> {
    const rows = await this.db.root
      .select({ id: satelliteIncidents.id })
      .from(satelliteIncidents)
      .where(isNull(satelliteIncidents.resolvedAt));
    return rows.length;
  }
}
