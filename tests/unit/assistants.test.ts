import { describe, it, expect } from 'vitest';
import { validateAssistantPayload, AssistantPayload } from '../../src/modules/assistants/validation';
import { canonicalHash } from '../../src/common/crypto/canonical-hash';
import { ASSISTANT_SCHEMA_VERSION, POLICY_SNAPSHOT_SCHEMA_VERSION } from '../../src/modules/assistants/schema';

/**
 * Phase 3 unit tests — pure domain logic (no DB):
 *  - payload validation + secret redaction gate (Phase 3.3)
 *  - canonical hash determinism (single source: src/modules/assistants/canonical.ts)
 *  - export envelope hash parity (import recomputes the same digest)
 */

export const validPayload: AssistantPayload = {
  model_policy: { allowed_models: ['neryva-core-1'], fallback_enabled: true },
  context_policy: { history_limit: 20, summary_enabled: true, knowledge_sources: ['docs'], memory_scope: 'organization' },
  tool_policy: { tools: [{ name: 'search_docs', access: 'read', approval: 'optional' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe', pii_redaction: true },
};

describe('assistant payload validation (Phase 3.3)', () => {
  it('accepts a valid payload and applies defaults', () => {
    const result = validateAssistantPayload(validPayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.context_policy.history_limit).toBe(20);
    expect(result.normalized.tool_policy.tools).toHaveLength(1);
  });

  it('applies zod defaults for omitted optional fields', () => {
    const result = validateAssistantPayload({
      model_policy: { allowed_models: ['m1'] },
      context_policy: {},
      tool_policy: {},
      guardrail_policy: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.context_policy.history_limit).toBe(30);
    expect(result.normalized.context_policy.memory_scope).toBe('user');
    expect(result.normalized.guardrail_policy.pii_redaction).toBe(true);
  });

  it('rejects payloads containing secret-shaped keys before persistence', () => {
    const leaky = {
      ...validPayload,
      model_policy: { allowed_models: ['m1'], fallback_enabled: false, api_key: 'sk-live-should-never-land' },
    };
    const result = validateAssistantPayload(leaky);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed tool descriptors', () => {
    const result = validateAssistantPayload({
      ...validPayload,
      tool_policy: { tools: [{ name: '', access: 'read' }] },
    });
    expect(result.ok).toBe(false);
  });
});

describe('canonical hash (assistant_versions.hash / policy_snapshots.hash)', () => {
  it('is order-independent for object keys', () => {
    const a = canonicalHash({ model_policy: { allowed_models: ['m1'], fallback_enabled: true }, guardrail_policy: { pii_redaction: true } });
    const b = canonicalHash({ guardrail_policy: { pii_redaction: true }, model_policy: { fallback_enabled: true, allowed_models: ['m1'] } });
    expect(a).toBe(b);
  });

  it('is deterministic across repeated calls', () => {
    expect(canonicalHash(validPayload)).toBe(canonicalHash(validPayload));
  });

  it('preserves array order (semantically significant)', () => {
    const ordered = canonicalHash({ allowed_models: ['a', 'b'] });
    const swapped = canonicalHash({ allowed_models: ['b', 'a'] });
    expect(ordered).not.toBe(swapped);
  });

  it('distinguishes different payloads', () => {
    const modified: AssistantPayload = {
      ...validPayload,
      context_policy: { ...validPayload.context_policy, history_limit: 25 },
    };
    expect(canonicalHash(validPayload)).not.toBe(canonicalHash(modified));
  });
});

describe('export envelope hash parity (Phase 3 exit gate)', () => {
  it('recomputing the hash over exported policy fields matches the stored hash', () => {
    const result = validateAssistantPayload(validPayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.normalized;
    const storedHash = canonicalHash(normalized);

    // This is exactly what AssistantsService.importVersion recomputes.
    const recomputed = canonicalHash({
      model_policy: normalized.model_policy,
      context_policy: normalized.context_policy,
      tool_policy: normalized.tool_policy,
      knowledge_policy: normalized.knowledge_policy,
      guardrail_policy: normalized.guardrail_policy,
    });
    expect(recomputed).toBe(storedHash);
  });

  it('schema versions are pinned and aligned with the migrations', () => {
    expect(ASSISTANT_SCHEMA_VERSION).toBe(1);
    expect(POLICY_SNAPSHOT_SCHEMA_VERSION).toBe(1);
  });
});
