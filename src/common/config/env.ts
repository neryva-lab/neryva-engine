import { z } from 'zod';

/**
 * Typed environment. Parsing happens once at boot; a bad environment is a
 * loud boot failure, never a runtime surprise (mirrors the Python engine's
 * production discipline: refuse to run on generated/missing keys).
 */
const boolean = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const positiveInt = (defaultValue: number, max = 2_147_483_647) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive().max(max));

const optionalUrl = () =>
  z
    .string()
    .optional()
    .default('')
    .refine(
      (v) => v === '' || (() => { try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } })(),
      'Invalid url',
    );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(3001, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: positiveInt(10, 200),
  REDIS_URL: z.string().url(),

  ENGINE_BASE_URL: z.string().url(),
  /** The web app's public base (auth email links point here, not at the API). */
  ENGINE_UI_BASE_URL: z.string().optional().default(''),

  MODULES__CORPORATE_ENABLED: boolean(true),
  MODULES__IDENTITY_ENABLED: boolean(false),
  MODULES__ORGANIZATIONS_ENABLED: boolean(false),
  MODULES__CONSOLE_ENABLED: boolean(false),
  MODULES__BILLING_ENABLED: boolean(false),
  MODULES__AGENT_STUDIO_ENABLED: boolean(false),
  MODULES__DEPLOYMENT_ENABLED: boolean(false),
  MODULES__KEYS_ENABLED: boolean(false),
  MODULES__CONFIG_PUBLISH_ENABLED: boolean(false),
  MODULES__SATELLITES_ENABLED: boolean(false),
  MODULES__WEBHOOKS_ENABLED: boolean(false),
  MODULES__NOTIFICATIONS_ENABLED: boolean(false),
  MODULES__STAFF_ENABLED: boolean(false),
  MODULES__ASSISTANTS_ENABLED: boolean(false),
  MODULES__CONVERSATIONS_ENABLED: boolean(false),
  WORKERS__OUTBOX_ENABLED: boolean(true),
  WORKERS__APPROVAL_EXPIRY_ENABLED: boolean(true),
  WORKERS__APPROVAL_EXPIRY_INTERVAL_MS: positiveInt(60_000, 3_600_000),
  WORKERS__APPROVAL_EXPIRY_BATCH_SIZE: positiveInt(200, 1000),
  MODULES__MCP_ENABLED: boolean(false),
  MODULES__KNOWLEDGE_ENABLED: boolean(false),
  MODULES__CHANNELS_ENABLED: boolean(false),

  // Channel plane (Phase C — channel_integrations_plan.md). Hard caps keep
  // the public webhook/widget surfaces bounded; per-account rate limits live
  // in Redis, not env.
  CHANNELS__MAX_ACCOUNTS_PER_ORG: positiveInt(25, 500),
  /** Widget session TTL (seconds) — sliding on activity, hard cap 24h. */
  CHANNELS__WEB_SESSION_TTL_SECONDS: positiveInt(3600, 86_400),
  /** Per-session inbound message cap per rolling hour (abuse control). */
  CHANNELS__WEB_SESSION_HOURLY_MESSAGES: positiveInt(10, 1_000),
  /** Bounded raw webhook envelope stored for replay/diagnostics (bytes) —
   *  must fit real platform batch envelopes (Meta can batch several changes). */
  CHANNELS__WEBHOOK_MAX_EVENT_BYTES: positiveInt(65_536, 262_144),
  // FL-3.1 — inbound voice-note ASR (POST {audio_base64, media_type} → {text}).
  // Unset = voice notes are recorded without reply (text messaging unaffected).
  CHANNELS__VOICE_ASR_URL: optionalUrl(),
  // FL-3.17 — generic HTTP email provider seam for the `email` channel
  // sender (POST {to, subject, text} with `CHANNELS__EMAIL_API_KEY` bearer).
  CHANNELS__EMAIL_API_URL: optionalUrl(),
  CHANNELS__EMAIL_API_KEY: z.string().optional().default(''),

  /** Billing: cron for the B-5 cost-anomaly scan (daily 03:15 UTC default). */
  BILLING_ANOMALY_CRON: z.string().default('15 3 * * *'),
  /** Billing: hourly trial-expiry sweep (H-3) — minute offset avoids the anomaly scan. */
  BILLING_TRIAL_SWEEP_CRON: z.string().default('40 * * * *'),
  /** Billing: hourly quota-counter reconciliation from billing.spend_events (M-1). */
  BILLING_QUOTA_RECONCILE_CRON: z.string().default('20 * * * *'),
  /**
   * Burn-rate manual-resume cooldown (seconds): after an operator promotes a
   * fresh rollout following an auto-pause, the hourly sweep suppresses
   * re-pausing until this elapses (default one burn window). 0 disables
   * suppression. The ledger is immutable so the accumulator itself is never
   * reset — suppression honors explicit human judgment temporarily instead.
   */
  BURN_RATE_RESUME_COOLDOWN_SECONDS: positiveInt(3600, 86_400),
  /**
   * Stripe payment rail (H-1): off unless explicitly enabled AND a secret key
   * is present. The webhook secret verifies event signatures (fail-closed).
   */
  STRIPE_ENABLED: boolean(false),
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  STRIPE_CHECKOUT_SUCCESS_URL: z.string().optional().default(''),
  STRIPE_CHECKOUT_CANCEL_URL: z.string().optional().default(''),
  /**
   * Ingest cost posture (the B-1 trust fix): 'derive' = the engine computes
   * cost from the platform price catalog when derivable (satellite-reported
   * cost is advisory); 'enforce' = additionally REJECT rows that deviate
   * >10% from derived (or are unpriced); 'trust' = legacy passthrough
   * (documented compat mode, never for production).
   */
  BILLING_COST_VALIDATION: z.enum(['derive', 'enforce', 'trust']).default('derive'),
  /** Org deletion grace window before the purge job erases engine-owned rows. */
  ORG_DELETION_GRACE_DAYS: positiveInt(30, 365),
  /** Account deletion grace window before the identity purge job erases the account. */
  ACCOUNT_DELETION_GRACE_DAYS: positiveInt(30, 365),
  /** Invite lifetime (days) — the accept window offered to a invited email. */
  ORG_INVITE_TTL_DAYS: positiveInt(7, 30),
  /** Safety caps: pending (unaccepted) invites and total members per org. */
  ORG_MAX_PENDING_INVITES: positiveInt(100, 10_000),
  ORG_MAX_MEMBERS: positiveInt(500, 100_000),
  /** Default trial length (days) for console-initiated product trials. */
  ORG_TRIAL_DEFAULT_DAYS: positiveInt(14, 90),
  /**
   * REL-9 F2 — trial caps for the metered `agents` product, applied at trial
   * start (entitlements.service.ts). Unset preserves today's unlimited-trial
   * behavior; set them the moment the business prices the product and the
   * hard quota walls (D2) spring to life with zero code change. Empty string
   * counts as unset; any other non-numeric value fails closed at boot.
   */
  AGENTS_TRIAL_MONTHLY_SPEND_USD: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().positive().max(1_000_000).optional(),
  ),
  AGENTS_TRIAL_MONTHLY_EVENTS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().max(100_000_000).optional(),
  ),
  /** AUTH-2.2: abuse cap on how many orgs one account may simultaneously own. */
  ORGS__MAX_OWNED_PER_ACCOUNT: positiveInt(20, 1_000),
  /**
   * AUTH-1.1: cold-start seeding for the platform staff axis — comma-separated
   * emails upserted to super_admin on staff-module boot (audited, idempotent).
   * Accounts must already exist; missing emails are skipped with a warning.
   * Keep empty in production unless ops explicitly sets it.
   */
  PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS: z.string().optional().default(''),
  /**
   * AUTH-4.1: enforce the purchased seat wall at invite redemption. Off only
   * so integration suites can exercise the over-provision posture without
   * billing fixtures; billing keeps sole write authority on `seats`.
   */
  ENTITLEMENTS__SEAT_ENFORCEMENT: boolean(true),

  /** Satellites: heartbeat lease TTL (the live window) — every beat renews it. */
  SATELLITE_HEARTBEAT_TIMEOUT_SECONDS: positiveInt(120, 3600),
  /** Heartbeat sample retention for the ops history view (hours). */
  SATELLITE_SAMPLE_RETENTION_HOURS: positiveInt(24, 720),
  /** Revocation-log retention (days) — satellite caches are shorter than this. */
  SATELLITE_REVOCATION_RETENTION_DAYS: positiveInt(7, 90),
  /** Unacked config notifications older than this flag config drift (seconds). */
  SATELLITE_CONFIG_ACK_DRIFT_SECONDS: positiveInt(900, 86_400),
  /** Config-publish retention: versions kept per (org × scope × product) key. */
  CONFIG_VERSION_RETENTION: positiveInt(50, 10_000),
  /** Config-publish retention: ACKed notification ledger rows age out (days). */
  CONFIG_NOTIFICATION_RETENTION_DAYS: positiveInt(14, 365),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_API_AUDIENCE: z.string().min(1).default('neryva-engine'),
  IDENTITY_JWT_SIGNING_KEY_FILE: z.string().optional().default(''),
  IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE: z.string().optional().default(''),
  IDENTITY_COOKIE_KEYS: z.string().optional().default(''),
  IDENTITY_ALLOW_DEV_KEYS: boolean(false),
  IDENTITY_ACCESS_TTL_SECONDS: positiveInt(900, 3600),
  IDENTITY_REFRESH_TTL_SECONDS: positiveInt(1209600, 2_592_000),
  IDENTITY_CODE_TTL_SECONDS: positiveInt(60, 600),
  IDENTITY_EMAIL_CODE_TTL_SECONDS: positiveInt(600, 3600),
  IDENTITY_EMAIL_CODE_MAX_ATTEMPTS: positiveInt(5, 20),
  IDENTITY_JWKS_CACHE_TTL_SECONDS: positiveInt(300, 86400),
  // The agent-runtime satellite's client-credentials secret (ADR-006
  // connection contract #1). Set at deploy; seeded envelope-encrypted into
  // the svc-agent-runtime OP client on boot. Unset = the row keeps whatever
  // envelope it already has.
  IDENTITY_AGENT_RUNTIME_SECRET: z.string().min(16).optional(),

  // ── Onboarding consent (first-run welcome, ledger F1-7) ────────────────────
  // The version stamped onto every consent record plus the outbound links the
  // console renders beside the consent checkbox. Server-authoritative on
  // purpose: bumping the version re-opens the welcome gate for every account
  // exactly once (a client flag could never do that safely), and the recorded
  // version tells us WHICH terms text each account agreed to.
  // Empty URLs ⇒ the console renders the consent statement without links
  // (never a dead '#' href).
  LEGAL__TERMS_VERSION: z.string().min(1).max(32).default('2026-09-16'),
  LEGAL__TERMS_URL: optionalUrl(),
  LEGAL__PRIVACY_URL: optionalUrl(),

  // Neryva MCP authority (Phase 5). The capability signing key is base64 of
  // >= 32 random bytes; kid = its sha256 fingerprint. Fail-closed in
  // production when the MCP module is enabled (see production checks below).
  MCP_CAPABILITY_SIGNING_KEY: z.string().optional().default(''),
  MCP_CAPABILITY_TTL_SECONDS: positiveInt(300, 3600),
  /** Max duration (seconds) a single WatchRunEvents stream may stay open. */
  MCP_WATCH_MAX_DURATION_SECONDS: positiveInt(300, 3600),

  // Outbox dispatcher (Phase 6.3). NERYVA_RUNTIME_BASE_URL: Studio runtime's
  // Connect endpoint; empty = run.dispatch consumer skips (runs stay ACCEPTED).
  OUTBOX_DISPATCH_INTERVAL_MS: positiveInt(1000, 60_000),
  OUTBOX_BATCH_SIZE: positiveInt(10, 500),
  OUTBOX_MAX_ATTEMPTS: positiveInt(2, 50),
  NERYVA_RUNTIME_BASE_URL: z.string().default(''),

  // Knowledge pipeline (Phase 7). EMBEDDING_PROVIDER=local uses a
  // deterministic lexical hash (NOT semantic) — dev/test only; production
  // must wire a real embedding provider before retrieval goes live.
  KNOWLEDGE_MAX_UPLOAD_BYTES: positiveInt(1024, 1_073_741_824),
  EMBEDDING_PROVIDER: z.enum(['local']).default('local'),

  // Harness guardrails (final_ledger.md FL-1.4). HARNESS__MODERATION_PROVIDER
  // selects the runtime moderation classifier: 'noop' (dev default, allows
  // everything) or 'openai_compatible' (POST {base_url}/v1/moderations).
  // A CONFIGURED provider that fails at call time fails CLOSED in production
  // (verdict block) and stays permissive in development — availability
  // failures never silently pass content in prod.
  HARNESS__MODERATION_PROVIDER: z.enum(['noop', 'openai_compatible']).default('noop'),
  HARNESS__MODERATION_BASE_URL: optionalUrl(),
  HARNESS__MODERATION_API_KEY: z.string().optional().default(''),
  HARNESS__MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  HARNESS__MODERATION_TIMEOUT_MS: positiveInt(3000, 30_000),
  // Auto-escalation hook (FL-1.7c, flag-gated): when an end user leaves N
  // consecutive negative feedback ratings in one conversation, escalate to a
  // human agent. Default off - organizations opt in per deployment.
  HARNESS__AUTO_ESCALATE_ENABLED: boolean(false),
  HARNESS__AUTO_ESCALATE_NEGATIVE_STREAK: positiveInt(3, 20),

  // FL-2.1 — cross-encoder reranker over fused hybrid candidates. DEFAULT
  // OFF (noop identity): hybrid retrieval runs FTS+vector+RRF with zero
  // external dependencies; 'http' wires a /v1/rerank cross-encoder endpoint
  // and DEGRADES to fused order on failure (a reranker is a quality lever,
  // never an availability dependency).
  HARNESS__RERANKER_PROVIDER: z.enum(['noop', 'http']).default('noop'),
  HARNESS__RERANKER_URL: optionalUrl(),
  HARNESS__RERANKER_API_KEY: z.string().optional().default(''),
  HARNESS__RERANKER_TIMEOUT_MS: positiveInt(3000, 30_000),

  // FL-2.2 — resumable re-embed worker (batched, atomic per-document swap).
  WORKERS__REEMBED_ENABLED: boolean(false),
  WORKERS__REEMBED_BATCH: positiveInt(10, 200),
  WORKERS__CONNECTORS_ENABLED: boolean(false),
  WORKERS__CONNECTORS_INTERVAL_MS: positiveInt(300_000, 86_400_000),

  // FL-2.6 — self-hosted extraction workers. Absent = the media family is
  // unsupported for ingest (loud failure at the pipeline, never garbage).
  KNOWLEDGE_OCR_URL: optionalUrl(),
  KNOWLEDGE_TRANSCRIBE_URL: optionalUrl(),

  // FL-3.5 — hosted web-search endpoint for the builtin tool (POST {query}
  // -> {results: [{title, url, snippet}]}).
  HARNESS__WEB_SEARCH_URL: optionalUrl(),
  // FL-3.10 — auto memory extraction proposer (flag-gated; proposes through
  // the existing memory-proposal pipeline, never durable truth by itself).
  HARNESS__AUTO_MEMORY_ENABLED: boolean(false),

  // FL-3.7 — query rewriting port (multi-query expansion / HyDE-class).
  // Unset = identity (one variant, zero cost); failures degrade to the
  // original query (quality lever, never an availability dependency).
  HARNESS__QUERY_REWRITE_URL: optionalUrl(),
  HARNESS__QUERY_REWRITE_TIMEOUT_MS: positiveInt(3000, 30_000),

  // FL-3.13 — online LLM-as-judge over sampled completed runs. The judge
  // endpoint receives bounded input/output texts (server-side seam); verdicts
  // land in run_judgments. Sampling is deterministic per run id.
  WORKERS__LLM_JUDGE_ENABLED: boolean(false),
  HARNESS__LLM_JUDGE_URL: optionalUrl(),
  HARNESS__LLM_JUDGE_SAMPLE_PCT: positiveInt(10, 100),
  HARNESS__LLM_JUDGE_TIMEOUT_MS: positiveInt(5000, 60_000),
  HARNESS__LLM_JUDGE_RUBRIC: z.string().max(2048).default('Rate the assistant reply for helpfulness, correctness and tone on a 0-1 scale.'),

  // FL-3.1 — outbound text-to-speech for voice-capable channels (WhatsApp
  // audio notes). POST {text, voice} -> {audio_base64, media_type}.
  HARNESS__TTS_URL: optionalUrl(),
  HARNESS__TTS_VOICE: z.string().default('alloy'),
  // FL-3.2 — hosted image-generation endpoint for the generate_image builtin
  // (POST {prompt} -> {image_base64, media_type}).
  HARNESS__IMAGE_GEN_URL: optionalUrl(),

  // Social login (doc-06 Δ1) — a provider is enabled exactly when its
  // credentials are present. Redirect URI per provider:
  //   {ENGINE_BASE_URL}/login/social/callback/{provider}
  IDENTITY_SOCIAL_GOOGLE_CLIENT_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  IDENTITY_SOCIAL_GITHUB_CLIENT_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_GITHUB_CLIENT_SECRET: z.string().optional().default(''),
  IDENTITY_SOCIAL_APPLE_CLIENT_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_APPLE_TEAM_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_APPLE_KEY_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_APPLE_PRIVATE_KEY_FILE: z.string().optional().default(''),
  IDENTITY_SOCIAL_MICROSOFT_CLIENT_ID: z.string().optional().default(''),
  IDENTITY_SOCIAL_MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
  IDENTITY_SOCIAL_MICROSOFT_TENANT: z.string().optional().default('common'),

  MFA_PROOF_SIGNING_KEY: z.string().optional().default(''),
  MFA_PROOF_SIGNING_KEY_FILE: z.string().optional().default(''),
  MFA_PROOF_TTL_SECONDS: positiveInt(300, 3600),

  BOOTSTRAP_API_KEY: z.string().optional().default(''),

  EMAIL_TRANSPORT: z.enum(['none', 'file', 'resend', 'postmark']).default('file'),
  EMAIL_FROM: z.string().default('Neryva <no-reply@neryva.com>'),
  EMAIL_FILE_PATH: z.string().default('./var/outbox'),
  RESEND_API_KEY: z.string().optional().default(''),
  POSTMARK_SERVER_TOKEN: z.string().optional().default(''),
  EMAIL_RATE_LIMIT_PER_MINUTE: positiveInt(30, 10000),
  /** Shared secret providers send on bounce/complaint webhooks (X-Webhook-Secret). */
  EMAIL_WEBHOOK_SECRET: z.string().optional().default(''),
  /** Where contact-form team notifications land (unset = no team email). */
  CORPORATE_CONTACT_INBOX_EMAIL: z.string().optional().default(''),

  // ── Platform tooling (ADR-008) — every plane is optional-by-design and ────
  // degrades loudly at its surface (503 / no-op) rather than failing boot.

  /** Observability identity for traces and logs. */
  SERVICE_NAME: z.string().min(1).default('neryva-engine'),
  /**
   * Trust X-Forwarded-* headers (client IP resolution for rate limits and
   * audit trails). TRUE when the engine sits behind a trusted proxy/LB —
   * the default — and FALSE when the listener is directly internet-facing,
   * where a spoofable X-Forwarded-For would bypass IP-scoped controls.
   */
  TRUST_PROXY: boolean(true),
  /** OpenTelemetry traces: off unless explicitly enabled (requires endpoint). */
  OTEL_TRACING_ENABLED: boolean(false),
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(''),
  /** Sentry error tracking: no DSN, no SDK. */
  SENTRY_DSN: z.string().optional().default(''),
  /** Object storage (S3/MinIO/R2): configured when bucket+region+keys set. */
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().optional().default(''),
  S3_BUCKET: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: boolean(true),
  /** Public/CDN base for public-read objects (blog covers). */
  S3_PUBLIC_BASE_URL: z.string().optional().default(''),
  /** Cloudflare Turnstile on public forms: unset = off; set = fail-closed. */
  TURNSTILE_SECRET_KEY: z.string().optional().default(''),

  ENGINE_ENCRYPTION_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

function loadFromProcess(): NodeJS.ProcessEnv {
  return process.env;
}

function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Defaults that depend on other values are resolved after the base parse.
  const issuerDefault = `${(source.ENGINE_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')}/auth`;
  const merged: Record<string, string | undefined> = { ...source };
  merged.IDENTITY_ISSUER = merged.IDENTITY_ISSUER || issuerDefault;

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid engine environment:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.MODULES__IDENTITY_ENABLED && !env.IDENTITY_JWT_SIGNING_KEY_FILE) {
      throw new Error('IDENTITY_JWT_SIGNING_KEY_FILE is required in production when the identity module is enabled (production refuses auto-generated keys)');
    }
    if (env.MODULES__IDENTITY_ENABLED && !env.IDENTITY_COOKIE_KEYS) {
      throw new Error('IDENTITY_COOKIE_KEYS is required in production when the identity module is enabled');
    }
    // The deployment secrets vault (and confidential client secrets) seal
    // values with the AES-256-GCM envelope at WRITE time — a missing key
    // must be a boot failure, never a 500 on the first secret set.
    if (env.MODULES__DEPLOYMENT_ENABLED && !env.ENGINE_ENCRYPTION_KEY) {
      throw new Error('ENGINE_ENCRYPTION_KEY (32-byte base64) is required in production when the deployment module is enabled (secrets vault envelope)');
    }
    // Neryva MCP capability tokens sign with this key — a missing key must be
    // a boot failure, never an unauthenticated authority surface.
    if (env.MODULES__MCP_ENABLED && !env.MCP_CAPABILITY_SIGNING_KEY) {
      throw new Error('MCP_CAPABILITY_SIGNING_KEY (base64 of >= 32 bytes) is required in production when the MCP module is enabled');
    }
    // Stripe is fail-closed: enabled rail with missing keys would charge without webhook verification.
    if (env.STRIPE_ENABLED) {
      if (!env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY is required in production when STRIPE_ENABLED=true');
      }
      if (!env.STRIPE_WEBHOOK_SECRET) {
        throw new Error('STRIPE_WEBHOOK_SECRET is required in production when STRIPE_ENABLED=true');
      }
    }
    // Object storage is optional-by-design in dev/test, but a partial S3 config in production is a hard fail.
    const s3Keys = [env.S3_BUCKET, env.S3_REGION, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY];
    const s3Any = s3Keys.some((v) => !!v);
    const s3All = s3Keys.every((v) => !!v);
    if (s3Any && !s3All) {
      throw new Error('S3_* is partially configured in production: set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together, or set none');
    }
    // OTEL tracing enabled without an endpoint would silently drop traces.
    if (env.OTEL_TRACING_ENABLED && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT is required in production when OTEL_TRACING_ENABLED=true');
    }
    // Unsafe dev-key allowlist must never be enabled in production.
    if (env.IDENTITY_ALLOW_DEV_KEYS) {
      throw new Error('IDENTITY_ALLOW_DEV_KEYS must be false in production');
    }
    // Production URLs must be https unless explicitly localhost (local staging with http is guarded below).
    const requireHttps = (label: string, value: string) => {
      if (value.startsWith('http://') && !value.includes('localhost') && !value.includes('127.0.0.1')) {
        throw new Error(`${label} must use https in production (got ${value})`);
      }
    };
    requireHttps('ENGINE_BASE_URL', env.ENGINE_BASE_URL);
    requireHttps('IDENTITY_ISSUER', env.IDENTITY_ISSUER);
    if (env.S3_ENDPOINT) {
      try {
        const u = new URL(env.S3_ENDPOINT);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error(`S3_ENDPOINT must be http or https (got ${env.S3_ENDPOINT})`);
        }
      } catch {
        throw new Error(`S3_ENDPOINT is not a valid URL: ${env.S3_ENDPOINT}`);
      }
    }
    // Neryva MCP protocol versions — unsupported majors must not start in production.
    const supportedMcpMajors = new Set(['1']);
    const neryvaMcpVersion = process.env.NERYVA_MCP_PROTOCOL_VERSION ?? '1.0';
    const mcpMajor = neryvaMcpVersion.split('.')[0];
    if (!supportedMcpMajors.has(mcpMajor)) {
      throw new Error(`NERYVA_MCP_PROTOCOL_VERSION major ${mcpMajor} is not supported (supported: ${[...supportedMcpMajors].join(', ')})`);
    }
  }
  return env;
}

/** Immutable, parsed environment — the single source of runtime config. */
export const env: Env = parseEnv(loadFromProcess());

export const isProduction = env.NODE_ENV === 'production';
