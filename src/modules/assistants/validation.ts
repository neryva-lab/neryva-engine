import { z } from 'zod';

export const assistantPayloadSchema = z.object({
  model_policy: z.object({
    allowed_models: z.array(z.string().min(1)).min(1).max(20),
    fallback_enabled: z.boolean().optional().default(false),
  }),
  context_policy: z.object({
    history_limit: z.number().int().min(1).max(100).default(30),
    summary_enabled: z.boolean().optional().default(true),
    knowledge_sources: z.array(z.string()).optional().default([]),
    memory_scope: z.enum(['user', 'organization', 'conversation']).optional().default('user'),
  }),
  tool_policy: z.object({
    tools: z
      .array(
        z.object({
          name: z.string().min(1).max(64),
          access: z.enum(['read', 'write']),
          approval: z.enum(['required', 'optional']).optional().default('optional'),
        }),
      )
      .max(50)
      .default([]),
  }),
  knowledge_policy: z
    .object({
      retrieval_enabled: z.boolean().optional().default(false),
      max_results: z.number().int().min(1).max(20).optional().default(5),
    })
    .optional(),
  guardrail_policy: z.object({
    input_policy: z.string().min(1).default('default'),
    output_policy: z.string().min(1).default('brand-safe'),
    pii_redaction: z.boolean().optional().default(true),
  }),
});

export type AssistantPayload = z.infer<typeof assistantPayloadSchema>;

/** Shared redaction before persistence — secrets must never land in payload. */
const SECRET_PATTERNS = [/api[_-]?key/i, /secret/i, /password/i, /token/i, /bearer/i];

function containsSecret(value: unknown): string | null {
  const json = JSON.stringify(value);
  for (const re of SECRET_PATTERNS) {
    if (re.test(json)) {
      // Do not echo the matched value — return the pattern only.
      return `payload contains suspected secret pattern ${re.source}`;
    }
  }
  return null;
}

export function validateAssistantPayload(payload: unknown): { ok: true; normalized: AssistantPayload } | { ok: false; issues: unknown } {
  const secret = containsSecret(payload);
  if (secret) {
    return { ok: false, issues: [{ path: ['payload'], message: secret }] };
  }
  const result = assistantPayloadSchema.safeParse(payload);
  if (!result.success) {
    return { ok: false, issues: result.error.flatten() };
  }
  // Capability registry check (model allowlist) is wired in the publish path where org entitlements are available.
  // For Phase 3.3, we validate structurally here; Phase 3.5 wires catalog checks.
  return { ok: true, normalized: result.data };
}
