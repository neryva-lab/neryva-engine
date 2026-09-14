import { describe, expect, it } from 'vitest';
import { decideBlockedContent, decideRequiredChecks, throwGateRefusal } from '../../src/modules/assistants/release-gate';

/**
 * REL-3.3 unit lane — the pure publish-gate rules. The DB-backed wiring
 * (policy join, latest-decision lookup, tenant scoping) lives in
 * tests/integration/publish-gate.test.ts (db-suites lane).
 */

describe('decideRequiredChecks (REL-3.2 rule)', () => {
  it('passes when the template declares no required checks (legacy posture)', () => {
    expect(decideRequiredChecks([], null)).toBeNull();
    expect(decideRequiredChecks([], 'BLOCK')).toBeNull();
  });

  it('passes on a fresh PASS for the required checks', () => {
    expect(decideRequiredChecks(['smoke', 'regression'], 'PASS')).toBeNull();
  });

  it('refuses WARN on a production pointer', () => {
    const refusal = decideRequiredChecks(['smoke'], 'WARN');
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('smoke');
    expect(refusal?.message).toContain('WARN');
  });

  it('refuses an absent decision with the absent marker', () => {
    const refusal = decideRequiredChecks(['smoke'], null);
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('absent');
    expect(refusal?.details).toEqual({ required_checks: ['smoke'], latest_decision: null });
  });

  it('refuses BLOCK through the required-checks rule too (precedence is decided by the evaluator)', () => {
    const refusal = decideRequiredChecks(['smoke'], 'BLOCK');
    expect(refusal?.gate).toBe('required_checks');
  });
});

describe('decideBlockedContent (TPL-6.1 rule)', () => {
  it('refuses only BLOCK; everything else passes this rule', () => {
    expect(decideBlockedContent('BLOCK')?.gate).toBe('blocked_content');
    expect(decideBlockedContent('PASS')).toBeNull();
    expect(decideBlockedContent('WARN')).toBeNull();
    expect(decideBlockedContent(null)).toBeNull();
    expect(decideBlockedContent(undefined)).toBeNull();
  });
});

describe('throwGateRefusal (publish-path error contract)', () => {
  it('raises a no-retry conflict carrying the assistant id plus the rule details', () => {
    let thrown: unknown;
    try {
      throwGateRefusal(
        { gate: 'required_checks', message: 'needs PASS', details: { required_checks: ['smoke'], latest_decision: null } },
        'assistant-1',
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: 'conflict',
      message: 'needs PASS',
      details: { assistant_id: 'assistant-1', required_checks: ['smoke'], latest_decision: null },
    });
  });
});
