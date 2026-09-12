import { z } from 'zod';

/** Provider-neutral generation parameters (contract v1.1 ModelParams). */
export const modelParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_output_tokens: z.number().int().min(1).max(200_000).optional(),
    top_p: z.number().gt(0).max(1).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  })
  .strict();

export const assistantPayloadSchema = z.object({
  // Schema v2: the system prompt. Optional at the type level so legacy v1
  // payloads still validate; the publish path rejects v2 drafts without one
  // (a published assistant without instructions cannot execute).
  instructions: z.string().min(1).max(32_768).optional(),
  model_params: modelParamsSchema.optional(),
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
          /** Pin to a tool_catalog entry: publish rejects a mutated/absent schema. */
          schema_hash: z.string().length(64).optional(),
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
export type ModelParams = z.infer<typeof modelParamsSchema>;

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
  return { ok: true, normalized: result.data };
}

/**
 * Publish-time gate for schema v2: a published assistant must carry
 * instructions — the ContextManifest feeds them to the model verbatim, and a
 * run without a system prompt cannot execute deterministically.
 */
export function assertPublishable(payload: AssistantPayload): void {
  if (typeof payload.instructions !== 'string' || payload.instructions.trim().length === 0) {
    throw new Error('schema v2 assistants require non-empty instructions to publish');
  }
}
