import { describe, it, expect } from 'vitest';
import { validateAssistantPayload } from '../../src/modules/assistants/validation';

/**
 * P3 (ai-native-review.md §7.3) — guardrail execution_mode contract:
 * optional, defaults to blocking (legacy behavior pinned), logging admitted,
 * anything else refused. The flip is a versioned definition change, so the
 * schema is the enforcement point for the vocabulary.
 */

const base = {
  model_policy: { allowed_models: ['test/model'] },
  context_policy: {},
  tool_policy: { tools: [] },
  guardrail_policy: {},
};

describe('guardrail execution_mode', () => {
  it('defaults to blocking when absent (legacy versions unchanged)', () => {
    const result = validateAssistantPayload(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.guardrail_policy.execution_mode).toBe('blocking');
    }
  });

  it('admits logging explicitly', () => {
    const result = validateAssistantPayload({
      ...base,
      guardrail_policy: { execution_mode: 'logging' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.guardrail_policy.execution_mode).toBe('logging');
    }
  });

  it('refuses unknown modes', () => {
    const result = validateAssistantPayload({
      ...base,
      guardrail_policy: { execution_mode: 'permissive' },
    });
    expect(result.ok).toBe(false);
  });
});
