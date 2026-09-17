import { describe, it, expect } from 'vitest';
import { normalizeToolPerimeter } from '../../src/modules/assistants/tool-catalog.service';
import { validateAssistantPayload } from '../../src/modules/assistants/validation';

/**
 * P4 (ai-native-review.md execution perimeter) — normalization rules and the
 * version-level execution_mode contract. Fail-closed defaults: absent env =
 * external_gateway; absent egress on an http tool = exactly the binding host
 * (recorded, never silent); in_process forbids any egress surface.
 */

/** ApiError carries the specific message in `details` (message is generic). */
function detailsOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { details?: unknown }).details;
  }
  throw new Error('expected ApiError, nothing thrown');
}

describe('normalizeToolPerimeter', () => {
  it('defaults a bare tool to external_gateway with no egress', () => {
    expect(normalizeToolPerimeter({})).toEqual({
      executionEnvironment: 'external_gateway',
      allowedEgressDomains: null,
    });
  });

  it('defaults http tools to exactly their binding host', () => {
    expect(
      normalizeToolPerimeter({ httpBinding: { url: 'https://api.example.com:8443/v1/run' } }),
    ).toEqual({
      executionEnvironment: 'external_gateway',
      allowedEgressDomains: ['api.example.com'],
    });
  });

  it('accepts an explicit list covering the host, deduped and lowered', () => {
    expect(
      normalizeToolPerimeter({
        httpBinding: { url: 'https://API.Example.COM/hook' },
        allowedEgressDomains: ['api.example.com', 'API.EXAMPLE.COM', 'cdn.example.com'],
      }),
    ).toEqual({
      executionEnvironment: 'external_gateway',
      allowedEgressDomains: ['api.example.com', 'cdn.example.com'],
    });
  });

  it('refuses lists that drop the binding host', () => {
    expect(
      detailsOf(() =>
        normalizeToolPerimeter({
          httpBinding: { url: 'https://api.example.com/x' },
          allowedEgressDomains: ['other.example.com'],
        }),
      ),
    ).toMatchObject({
      allowed_egress_domains: expect.stringContaining("must cover the tool's own binding host"),
    });
  });

  it('refuses non-http bindings, bad hostnames, and bad lists', () => {
    expect(
      detailsOf(() => normalizeToolPerimeter({ httpBinding: { url: 'ftp://x.example.com/f' } })),
    ).toMatchObject({
      http_binding: expect.stringContaining('valid http(s) URL'),
    });
    expect(detailsOf(() => normalizeToolPerimeter({ allowedEgressDomains: [] }))).toMatchObject({
      allowed_egress_domains: expect.stringContaining('1..32 hostnames'),
    });
    expect(
      detailsOf(() =>
        normalizeToolPerimeter({ allowedEgressDomains: ['https://x.example.com/path'] }),
      ),
    ).toMatchObject({
      allowed_egress_domains: expect.stringContaining('bare hostname'),
    });
    expect(
      detailsOf(() => normalizeToolPerimeter({ allowedEgressDomains: ['ok.example.com:8443'] })),
    ).toMatchObject({
      allowed_egress_domains: expect.stringContaining('bare hostname'),
    });
    expect(
      detailsOf(() => normalizeToolPerimeter({ executionEnvironment: 'quantum' })),
    ).toMatchObject({
      execution_environment: expect.stringContaining('in_process, sandboxed_microvm'),
    });
  });

  it('forbids any egress surface on in_process tools', () => {
    expect(
      detailsOf(() =>
        normalizeToolPerimeter({
          executionEnvironment: 'in_process',
          httpBinding: { url: 'https://x.example.com/' },
        }),
      ),
    ).toMatchObject({
      execution_environment: expect.stringContaining('must not carry an http_binding'),
    });
    expect(
      detailsOf(() =>
        normalizeToolPerimeter({
          executionEnvironment: 'in_process',
          allowedEgressDomains: ['x.example.com'],
        }),
      ),
    ).toMatchObject({
      execution_environment: expect.stringContaining('must not declare allowed_egress_domains'),
    });
    expect(normalizeToolPerimeter({ executionEnvironment: 'in_process' })).toEqual({
      executionEnvironment: 'in_process',
      allowedEgressDomains: null,
    });
  });

  it('admits sandboxed_microvm with explicit egress', () => {
    expect(
      normalizeToolPerimeter({
        executionEnvironment: 'sandboxed_microvm',
        allowedEgressDomains: ['py.example.com'],
      }),
    ).toEqual({
      executionEnvironment: 'sandboxed_microvm',
      allowedEgressDomains: ['py.example.com'],
    });
  });
});

describe('version execution_mode', () => {
  const base = {
    model_policy: { allowed_models: ['test/model'] },
    context_policy: {},
    tool_policy: { tools: [{ name: 'my_tool', access: 'read' }] },
    guardrail_policy: {},
  };

  it('defaults to live', () => {
    const result = validateAssistantPayload(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.normalized.tool_policy.tools[0] as { execution_mode: string }).execution_mode,
      ).toBe('live');
    }
  });

  it('admits shadow explicitly', () => {
    const result = validateAssistantPayload({
      ...base,
      tool_policy: { tools: [{ name: 'my_tool', access: 'read', execution_mode: 'shadow' }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.normalized.tool_policy.tools[0] as { execution_mode: string }).execution_mode,
      ).toBe('shadow');
    }
  });

  it('refuses unknown modes', () => {
    expect(
      validateAssistantPayload({
        ...base,
        tool_policy: { tools: [{ name: 'my_tool', access: 'read', execution_mode: 'dry' }] },
      }).ok,
    ).toBe(false);
  });
});
