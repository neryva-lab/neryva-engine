/**
 * Pure retention-rule evaluation (unit-tested).
 *
 * Note: the retention sweep (RetentionPurgeService.sweepRetention) evaluates
 * eligibility in SQL, not through this helper — this module is a standalone
 * predicate, not shared sweep logic.
 * Fail-safe: an invalid rule NEVER flags data for deletion.
 */
export const RETENTION_RULES = {
  KEEP_DAYS_KEY: 'keep_days',
} as const;

export function isRetentionEligible(input: { createdAt: string; keepDays: number; now?: string }): boolean {
  if (!Number.isInteger(input.keepDays) || input.keepDays < 1) {
    return false;
  }
  const created = Date.parse(input.createdAt);
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (Number.isNaN(created) || Number.isNaN(now)) {
    return false;
  }
  return now - created > input.keepDays * 24 * 3600 * 1000;
}
