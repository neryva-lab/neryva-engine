import { describe, it, expect } from 'vitest';
import { isEvaluableVersionStatus } from '../../src/modules/knowledge/eval.service';

/**
 * R-2 unit gate (team_setup_ledger.md §3): formal evaluation admits DRAFT +
 * PUBLISHED (pre-publish EVALUATE → PUBLISH), never RETIRED or unknown.
 * Pure helper — no DB.
 */
describe('isEvaluableVersionStatus (R-2 draft evaluation)', () => {
  it('admits DRAFT (pre-publish evaluation with synthesized snapshot)', () => {
    expect(isEvaluableVersionStatus('DRAFT')).toBe(true);
  });

  it('admits PUBLISHED (regression evaluation)', () => {
    expect(isEvaluableVersionStatus('PUBLISHED')).toBe(true);
  });

  it.each(['RETIRED', 'VALID', 'VALIDATING', 'ROLLED_BACK', '', null, undefined, 0])(
    'refuses %p (only live content executes)',
    (status) => {
      expect(isEvaluableVersionStatus(status)).toBe(false);
    },
  );
});
