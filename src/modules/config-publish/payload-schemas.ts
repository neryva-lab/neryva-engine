import { z } from 'zod';
import { ConfigScope } from './config-publish.schema';

/**
 * Per-scope payload validation (handover A-4). A published config is
 * consumed by satellites without an operator in the loop — the puller
 * applies whatever version arrives — so a malformed payload would fail at
 * enforcement time, in production, silently. Every publish and every draft
 * save therefore passes HERE first: unknown fields rejected, enums closed,
 * bounds enforced, semantic cross-field rules checked. The shapes mirror
 * the agent-runtime's actual consumption code (its policy editor input,
 * TenantConfig guardrail fields, budgets.py quota composition, and the
 * model_catalog table) — validated at the source instead of trusted at the
 * edge.
 *
 * Invalid configs cannot publish — the same gate the runtime runs locally
 * (tenant_config_versions P5-2 "validated-gated promotion"), moved to the
 * engine side per A-4.
 */

/** Wire-size ceiling for any payload (jsonb document, not a file dump). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export type PayloadIssue = { path: string; message: string };

export type PayloadValidation =
  | { ok: true; normalized: Record<string, unknown> }
  | { ok: false; issues: PayloadIssue[] };

// ── policy_set ─────────────────────────────────────────────────────────────
// Mirrors the runtime policy editor (routes/policies.py): frontend kinds
// (input|output|tool|topic|safety) map to its policy types, actions are the
// four the evaluator implements, and pattern-driven kinds REQUIRE a pattern
// (a block rule with nothing to match is a config bug the engine refuses).

const GUARDRAIL_KEYS = ['regex_fastpath', 'classifier', 'nemo_rails', 'jailbreak_detection', 'output_validation', 'pii_detection', 'spotlighting'] as const;
const THRESHOLD_KEYS = ['classifier', 'jailbreak', 'pii'] as const;
const PATTERN_KINDS = ['input', 'output', 'topic'] as const;

const policyRule = z
  .object({
    name: z.string().min(1).max(128),
    kind: z.enum(['input', 'output', 'tool', 'topic', 'safety']),
    action: z.enum(['block', 'flag', 'redact', 'escalate']),
    pattern: z.string().min(1).max(512).optional(),
    description: z.string().max(1024).default(''),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    enabled: z.boolean().default(true),
  })
  .strict();

const policySetSchema = z
  .object({
    name: z.string().min(1).max(128).default('default'),
    rules: z.array(policyRule).max(200).default([]),
  })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of set.rules.entries()) {
      if (seen.has(rule.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index, 'name'], message: `duplicate rule name "${rule.name}"` });
      }
      seen.add(rule.name);
      if ((PATTERN_KINDS as readonly string[]).includes(rule.kind) && rule.action !== 'escalate' && !rule.pattern) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index, 'pattern'], message: `kind "${rule.kind}" with action "${rule.action}" requires a pattern` });
      }
    }
  });

// ── guardrail_profile ─────────────────────────────────────────────────────
// Mirrors TenantConfig.guardrail_config / guardrail_thresholds (the runtime
// merges engine values OVER its built-in defaults, so only known rails may
// appear — an unknown key would be silently ignored and the operator would
// believe a rail is configured when it is not). shadow_mode is the A-4
// shadow config: rails evaluate and record evidence but never block.

const guardrailProfileSchema = z
  .object({
    guardrail_config: z.record(z.enum(GUARDRAIL_KEYS), z.boolean()).default({}),
    guardrail_thresholds: z.record(z.enum(THRESHOLD_KEYS), z.number().min(0).max(1)).default({}),
    shadow_mode: z.boolean().default(false),
    stream_moderation_window_chars: z.number().int().min(0).max(100_000).nullable().default(null),
  })
  .strict();

// ── quota_profile ─────────────────────────────────────────────────────────
// Mirrors budgets.py: execution budgets (per-turn guards) + the USD quota
// ladder the gateway composes. 0 on a quota = unlimited (runtime contract).

const quotaProfileSchema = z
  .object({
    budgets: z
      .object({
        max_redact_iterations: z.number().int().min(0).max(50).default(2),
        max_graph_steps: z.number().int().min(1).max(10_000).default(50),
        max_duration_s: z.number().int().min(1).max(3_600).default(60),
      })
      .strict()
      .default({}),
    quotas: z
      .object({
        quota_platform_usd: z.number().min(0).max(1_000_000).default(0),
        quota_tenant_usd: z.number().min(0).max(1_000_000).default(0),
        quota_surface_usd: z.number().min(0).max(1_000_000).default(0),
        quota_end_user_usd: z.number().min(0).max(1_000_000).default(0),
      })
      .strict()
      .default({}),
  })
  .strict();

// ── model_catalog ─────────────────────────────────────────────────────────
// Mirrors the model_catalog table: unique (provider, model) entries with
// fallback order and a per-1k cost ceiling; the optional defaults must
// reference an entry that exists (a default pointing outside the catalog
// would send requests to a model the org has not enabled).

const modelEntry = z
  .object({
    provider: z.string().min(1).max(32),
    model: z.string().min(1).max(128),
    enabled: z.boolean().default(true),
    cost_ceiling_per_1k: z.number().min(0).max(10_000).default(0),
    fallback_order: z.number().int().min(0).max(1_000).default(0),
    /** FL-2.19: residency regions this deployment serves ('eu'|'us'|...). */
    regions: z.array(z.enum(['default', 'eu', 'us'])).min(1).default(['default']),
  })
  .strict();

const modelCatalogSchema = z
  .object({
    default_provider: z.string().min(1).max(32).optional(),
    default_model: z.string().min(1).max(128).optional(),
    models: z.array(modelEntry).min(1).max(100),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of catalog.models.entries()) {
      const key = `${entry.provider}/${entry.model}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['models', index], message: `duplicate provider/model pair "${key}"` });
      }
      seen.add(key);
    }
    if (catalog.default_provider && catalog.default_model && !seen.has(`${catalog.default_provider}/${catalog.default_model}`)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default_provider'], message: 'default provider/model pair is not present in models' });
    }
  });

// -- knowledge_config -------------------------------------------------------
// FL-2.3: per-org embedding + chunking controls honored by the ingestion
// pipeline. embedding_model tags every vector the pipeline writes (a real
// per-org provider lands with BYOK, FL-2.18); the re-embed worker re-indexes
// documents whose active vectors were computed with a different model.

const knowledgeConfigSchema = z
  .object({
    embedding_model: z.string().min(1).max(64).default('local-lexical-v1'),
    /** FL-2.19: residency pin — model routing must honor it at publish. */
    residency: z.enum(['default', 'eu', 'us']).default('default'),
    chunk_size: z.number().int().min(200).max(8000).default(1000),
    chunk_overlap: z.number().int().min(0).max(1000).default(0),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.chunk_overlap >= cfg.chunk_size) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunk_overlap'], message: 'chunk_overlap must be smaller than chunk_size' });
    }
  });

const SCHEMAS: Record<ConfigScope, z.ZodTypeAny> = {
  policy_set: policySetSchema,
  guardrail_profile: guardrailProfileSchema,
  quota_profile: quotaProfileSchema,
  model_catalog: modelCatalogSchema,
  knowledge_config: knowledgeConfigSchema,
};

/**
 * Validate (and normalize) a payload for a scope. Returns issues instead of
 * throwing so draft saves can persist an INVALID draft with its report (the
 * operator fixes it in place); publish treats !ok as a 422.
 */
export function validatePayload(scope: ConfigScope, payload: unknown): PayloadValidation {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, issues: [{ path: 'payload', message: 'must be a JSON object' }] };
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, issues: [{ path: 'payload', message: `exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${bytes})` }] };
  }
  const result = SCHEMAS[scope].safeParse(payload);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.slice(0, 50).map((issue) => ({
        path: issue.path.length ? issue.path.join('.') : 'payload',
        message: issue.message,
      })),
    };
  }
  return { ok: true, normalized: result.data as Record<string, unknown> };
}
