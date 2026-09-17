import { z } from 'zod';
import { ApiError } from '../../common/http/api-error';

/** Provider-neutral generation parameters (contract v1.1 ModelParams). */
export const modelParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_output_tokens: z.number().int().min(1).max(200_000).optional(),
    top_p: z.number().gt(0).max(1).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    /** FL-2.14: JSON Schema (2020-12) for structured output - bounded text. */
    output_schema: z
      .string()
      .max(16_384)
      .refine((v) => {
        try {
          const parsed = JSON.parse(v) as unknown;
          return typeof parsed === 'object' && parsed !== null;
        } catch {
          return false;
        }
      }, 'must be a JSON object schema')
      .optional(),
  })
  .strict();

/**
 * FL-1.2: the Engine-authoritative RunBudgets set. Absent dimensions fall
 * back to the manifest defaults; Studio enforces what the manifest serves.
 * Caps keep a single tenant from pinning the fleet (2M tokens, 24h wall
 * clock, 1k tool calls per run).
 */
export const budgetPolicySchema = z
  .object({
    max_total_tokens: z.number().int().min(1000).max(2_000_000).optional(),
    max_cost_micros: z.number().int().min(0).max(1_000_000_000_000).optional(),
    wall_clock_seconds: z.number().int().min(0).max(86_400).optional(),
    max_tool_calls: z.number().int().min(0).max(1000).optional(),
    max_model_calls: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const assistantPayloadSchema = z.object({
  // Schema v2: the system prompt. Optional at the type level so legacy v1
  // payloads still validate; the publish path rejects v2 drafts without one
  // (a published assistant without instructions cannot execute).
  instructions: z.string().min(1).max(32_768).optional(),
  // G4 (customer-setup-review.md): brand voice is FIRST-CLASS runtime input,
  // not a consumer-side note. Persisted on the version row + snapshot,
  // covered by the content hash, and composed into the served system prompt
  // at context assembly (pinned snapshot = deterministic, auditable).
  brand: z.string().max(2_000).optional(),
  model_params: modelParamsSchema.optional(),
  budget_policy: budgetPolicySchema.optional(),
  model_policy: z.object({
    allowed_models: z.array(z.string().min(1)).min(1).max(20),
    fallback_enabled: z.boolean().optional().default(false),
  }),
  context_policy: z.object({
    history_limit: z.number().int().min(1).max(100).default(30),
    summary_enabled: z.boolean().optional().default(true),
    knowledge_sources: z.array(z.string()).optional().default([]),
    memory_scope: z
      .enum(['user', 'organization', 'conversation', 'none'])
      .optional()
      .default('user'),
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
          /**
           * P4: per-binding execution mode. `shadow` simulates the call
           * (Studio returns a marked-simulated result, executes nothing) —
           * the enterprise rollout path for mutating tools. Default live.
           */
          execution_mode: z.enum(['live', 'shadow']).optional().default('live'),
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
    /**
     * P3 (ai-native-review.md §7.3): verdict execution mode. `blocking`
     * refuses violating content; `logging` records the verdict (span +
     * Studio-side observation) without severing — the safe rollout path for
     * new guardrails (measure two weeks, then flip to blocking). Default
     * blocking: existing versions behave exactly as before. The flip is a
     * definition change (new draft, auditable) — never a silent toggle.
     * Engine verdict points are Studio-resolved (moderation hook runs in the
     * runtime); the engine versions the contract, hands the mode to Studio
     * in the authorized context, and emits the policy span per run.
     */
    execution_mode: z.enum(['blocking', 'logging']).optional().default('blocking'),
  }),
});

export type AssistantPayload = z.infer<typeof assistantPayloadSchema>;
export type ModelParams = z.infer<typeof modelParamsSchema>;

/**
 * Secret shapes that indicate pasted credential MATERIAL.
 * - Values: assignment form `name: value` / `name = value` — so prose
 *   mentions ("token budget", "password reset flow") and numeric budgets
 *   pass while pasted credentials ("api_key: sk-…", "password=hunter2") fail.
 * - Keys: a secret-named key carrying a non-empty string value (e.g.
 *   `api_key: "sk-..."`) — the value alone would not match the assignment
 *   shape, but the key reveals the secret. Schema vocabulary legitimately
 *   contains "token" inside `max_output_tokens` / `max_total_tokens`; the
 *   word-boundary check avoids flagging those while still catching true
 *   secret keys (`api_key`, `secret`, `password`, `bearer`, `token`).
 */
const SECRET_ASSIGNMENT = /\b(api[_-]?key|secret|password|bearer|token)\b\s*[:=]\s*\S{4,}/i;
const SECRET_KEY = /\b(api[_-]?key|secret|password|bearer|token)\b/i;

function containsSecretValue(value: unknown): string | null {
  if (typeof value === 'string') {
    if (SECRET_ASSIGNMENT.test(value)) {
      return 'payload contains suspected secret material (credential assignment shape)';
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsSecretValue(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && typeof v === 'string' && v.trim().length >= 4) {
        return `payload contains suspected secret material (key "${k}" carries a secret-like value)`;
      }
      const hit = containsSecretValue(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** Shared redaction before persistence — secrets must never land in payload. */
function containsSecret(value: unknown): string | null {
  return containsSecretValue(value);
}

export function validateAssistantPayload(
  payload: unknown,
): { ok: true; normalized: AssistantPayload } | { ok: false; issues: unknown } {
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
    // Typed 422 (never a 500): a draft that reached publish without a prompt
    // is a caller error, not an invariant failure.
    throw ApiError.validation({
      instructions: 'schema v2 assistants require non-empty instructions to publish',
    });
  }
}

/**
 * TPL-2.1 (plan §7.2 item 4) — template-only extensions (effect_class,
 * when_to_use, seed_queries, banned_claims, brand, retrieval_policy,
 * max_context_tokens…) live in template metadata / console.json, never in the
 * Engine version row. Non-strict zod strips unknown keys SILENTLY, at every
 * depth — so the "rejected with a 422 listing them" guarantee needs an
 * explicit key diff against the schema tree. Known keys are derived from the
 * schema shapes themselves — no second list to drift.
 */
export function rejectUnknownPayloadKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const offenders = collectUnknownKeys(payload, assistantPayloadSchema, []);
  if (offenders.length > 0) {
    throw ApiError.validation({
      definition: `unknown keys rejected (template-only extensions do not belong in the Engine payload): ${offenders.join(', ')}`,
    });
  }
  return payload;
}

function collectUnknownKeys(value: unknown, schema: z.ZodTypeAny, path: string[]): string[] {
  const shape = objectShape(schema);
  if (!shape || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const offenders: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const childSchema = shape[key];
    if (!childSchema) {
      offenders.push(childPath.join('.'));
      continue;
    }
    const element = arrayElement(childSchema);
    if (element) {
      if (Array.isArray(child)) {
        child.forEach((item, index) =>
          offenders.push(...collectUnknownKeys(item, element, [...childPath, String(index)])),
        );
      }
      continue;
    }
    offenders.push(...collectUnknownKeys(child, childSchema, childPath));
  }
  return offenders;
}

/** Unwrap optional/default/effects wrappers to an object schema's shape, or null. */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) {
      return current.shape as Record<string, z.ZodTypeAny>;
    }
    const def = (
      current as unknown as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } }
    )._def;
    const inner = def?.innerType ?? def?.schema ?? null;
    if (!inner) {
      return null;
    }
    current = inner;
  }
  return null;
}

/** Unwrap optional/default wrappers to an array schema's element, or null. */
function arrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodArray) {
      return current._def.type as z.ZodTypeAny;
    }
    const def = (
      current as unknown as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } }
    )._def;
    const inner = def?.innerType ?? def?.schema ?? null;
    if (!inner) {
      return null;
    }
    current = inner;
  }
  return null;
}
