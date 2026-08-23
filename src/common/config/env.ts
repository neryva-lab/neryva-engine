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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(3001, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: positiveInt(10, 200),
  REDIS_URL: z.string().url(),

  ENGINE_BASE_URL: z.string().url(),

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

  /** Billing: cron for the B-5 cost-anomaly scan (daily 03:15 UTC default). */
  BILLING_ANOMALY_CRON: z.string().default('15 3 * * *'),

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
  }
  return env;
}

/** Immutable, parsed environment — the single source of runtime config. */
export const env: Env = parseEnv(loadFromProcess());

export const isProduction = env.NODE_ENV === 'production';
