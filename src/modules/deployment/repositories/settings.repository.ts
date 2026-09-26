/**
 * Deployment settings repository (P3) — the persistence port for
 * `SettingsService`: the org-level settings singleton, lazily materialized.
 *
 * The repository moves the raw row; the service composes `EffectiveSettings`
 * over built-in defaults and normalizes/validates every input field.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (strategy membership, ladder normalization, weight
 *   clamping) and the effective-settings composition
 * - audit writes
 */
import type { SettingsRow } from '../schema';

export interface IDeploymentSettingsRepository {
  /** The stored row, or null when the org never saved one. */
  getRow(orgId: string): Promise<SettingsRow | null>;

  /** Insert-or-update the singleton row (atomic). */
  upsert(input: {
    orgId: string;
    defaultStrategy?: string;
    defaultLadder?: unknown[];
    autoRollback?: boolean;
    defaultCanaryWeight?: number;
    updatedBy: string;
    now: string;
  }): Promise<void>;
}
