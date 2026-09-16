import { describe, expect, it } from 'vitest';
import { resolveOnboardingState, type OnboardingRow } from './onboarding.service';

/**
 * The first-run gate contract (F1-7). Pure: no database, no env — the service
 * layers `db.root` + `LEGAL__*` copy on top of exactly this decision.
 *
 * The cases encode the production failure this replaced: the gate must stay
 * OPEN for an account that has never completed the screen, no matter how much
 * wall-clock time has passed since the account row was created.
 */
const CURRENT = '2026-09-16';

function row(overrides: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    welcomeCompletedAt: '2026-09-16T15:00:00.000Z',
    welcomeSkipped: false,
    consentVersion: CURRENT,
    ...overrides,
  };
}

describe('resolveOnboardingState', () => {
  it('keeps the gate open when the account has no onboarding row at all', () => {
    expect(resolveOnboardingState(null, CURRENT)).toMatchObject({ needed: true, welcome_completed_at: null });
    expect(resolveOnboardingState(undefined, CURRENT).needed).toBe(true);
  });

  it('keeps the gate open when a row exists but was never completed', () => {
    const state = resolveOnboardingState(row({ welcomeCompletedAt: null }), CURRENT);
    expect(state.needed).toBe(true);
    expect(state.welcome_completed_at).toBeNull();
  });

  it('closes the gate when completion and the current terms version both hold', () => {
    const state = resolveOnboardingState(row(), CURRENT);
    expect(state.needed).toBe(false);
    expect(state.welcome_completed_at).toBe('2026-09-16T15:00:00.000Z');
    expect(state.consent_version).toBe(CURRENT);
  });

  it('re-opens the gate exactly once when the terms version is bumped', () => {
    // Consent was recorded against the OLD text: the account owes the screen
    // again — while the old evidence stays readable for the audit trail.
    const state = resolveOnboardingState(row({ consentVersion: '2026-01-01' }), CURRENT);
    expect(state.needed).toBe(true);
    expect(state.consent_version).toBe('2026-01-01');
    expect(state.welcome_completed_at).toBe('2026-09-16T15:00:00.000Z');
  });

  it('re-opens the gate when a completion carries no consent version', () => {
    // A pre-gate/backfilled row has a completion stamp but no consent record.
    expect(resolveOnboardingState(row({ consentVersion: null }), CURRENT).needed).toBe(true);
  });

  it('carries the skip flag so the funnel can tell personalization from skip', () => {
    expect(resolveOnboardingState(row({ welcomeSkipped: true }), CURRENT).welcome_skipped).toBe(true);
    expect(resolveOnboardingState(row(), CURRENT).welcome_skipped).toBe(false);
    // Absent row: nothing was skipped, nothing was completed.
    expect(resolveOnboardingState(null, CURRENT).welcome_skipped).toBe(false);
  });

  it('never reports a closed gate for an unknown/empty terms version', () => {
    // Defensive: an empty expected version must not accidentally match a row
    // whose stored version is also empty — that would silently skip onboarding.
    expect(resolveOnboardingState(row({ consentVersion: null }), '').needed).toBe(true);
  });
});