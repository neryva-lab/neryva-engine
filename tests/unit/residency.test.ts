import { describe, expect, it } from 'vitest';
import { modelServesResidency, normalizeResidency } from '../../src/modules/assistants/residency';

describe('residency routing (REL-11.2)', () => {
  it('normalizes residency aliases', () => {
    expect(normalizeResidency('default')).toBe('default');
    expect(normalizeResidency('us')).toBe('us');
    expect(normalizeResidency('us-east-1')).toBe('us');
    expect(normalizeResidency('eu')).toBe('eu');
    expect(normalizeResidency('eu-west-1')).toBe('eu');
    expect(normalizeResidency(null)).toBe('default');
    expect(normalizeResidency(undefined)).toBe('default');
  });

  it('rejects unknown residency', () => {
    expect(() => normalizeResidency('moon')).toThrow(/unknown residency/);
  });

  it('default/us org is permissive — any model serves', () => {
    expect(modelServesResidency('default', null)).toBe(true);
    expect(modelServesResidency('default', [])).toBe(true);
    expect(modelServesResidency('us', ['eu'])).toBe(true); // us is permissive, even eu models serve us
    expect(modelServesResidency('default', ['eu'])).toBe(true);
  });

  it('eu org is strict — only eu or global models serve', () => {
    expect(modelServesResidency('eu', ['eu'])).toBe(true);
    expect(modelServesResidency('eu', ['global'])).toBe(true);
    expect(modelServesResidency('eu', ['eu', 'us'])).toBe(true);
    expect(modelServesResidency('eu', ['us'])).toBe(false);
    expect(modelServesResidency('eu', null)).toBe(false);
    expect(modelServesResidency('eu', [])).toBe(false);
    expect(modelServesResidency('eu', ['default'])).toBe(false);
  });
});
