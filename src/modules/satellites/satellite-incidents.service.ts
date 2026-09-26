import { Inject, Injectable } from '@nestjs/common';
import { SATELLITE_INCIDENT_REPOSITORY } from './repositories/repository-tokens';
import type { ISatelliteIncidentRepository, SatelliteIncidentKind } from './repositories/satellite-incident.repository';
import { SatelliteIncidentRow } from './satellite.schema';

/**
 * The satellite incident timeline (eng-0010): liveness transitions,
 * quarantines, version-floor violations, config drift. One OPEN incident
 * per (satellite, kind) — a repeat condition extends the window instead of
 * spamming rows; resolution closes it. The list IS the status page's
 * history (statuspage parity) and the ops evidence trail.
 */
export type IncidentKind = SatelliteIncidentKind;

@Injectable()
export class SatelliteIncidentsService {
  constructor(
    @Inject(SATELLITE_INCIDENT_REPOSITORY)
    private readonly incidents: ISatelliteIncidentRepository,
  ) {}

  /**
   * Open (or extend) an incident. `liveness_restored`-style kinds resolve
   * instantly (they are their own closure); persistent kinds (drift, floor)
   * stay open until the matching condition clears.
   */
  async open(input: { satelliteKey: string; kind: IncidentKind; detail?: Record<string, unknown>; autoResolve?: boolean }): Promise<void> {
    const now = new Date().toISOString();
    if (input.autoResolve) {
      await this.incidents.openIncident({
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
      await this.incidents.extendIncident(existing.id, {
        ...(existing.detail as Record<string, unknown>),
        last_seen: now,
        ...(input.detail ?? {}),
      });
      return;
    }
    await this.incidents.openIncident({
      satelliteKey: input.satelliteKey,
      kind: input.kind,
      detail: { ...(input.detail ?? {}), first_seen: now },
      openedAt: now,
    });
  }

  /** Close every open incident of a kind for a satellite (condition cleared). */
  async resolve(input: { satelliteKey: string; kind?: IncidentKind }): Promise<number> {
    return this.incidents.resolveIncidents(input.satelliteKey, input.kind);
  }

  async unresolved(satelliteKey: string, kind: IncidentKind): Promise<SatelliteIncidentRow | null> {
    return this.incidents.findUnresolved(satelliteKey, kind);
  }

  async listFor(satelliteKey: string, limit = 100): Promise<SatelliteIncidentRow[]> {
    return this.incidents.listFor(satelliteKey, limit);
  }

  /** Unresolved incidents only (the detail view's "open now" panel). */
  async listOpen(satelliteKey: string, limit = 50): Promise<SatelliteIncidentRow[]> {
    return this.incidents.listOpen(satelliteKey, limit);
  }

  /** The status page feed: every satellite's recent incidents, newest first. */
  async recent(limit = 100): Promise<SatelliteIncidentRow[]> {
    return this.incidents.listRecent(limit);
  }

  async openCount(): Promise<number> {
    return this.incidents.countOpen();
  }
}
