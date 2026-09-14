import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Provider credential store — REL-1.1/REL-1.3 (release_ledger.md), root-gap
 * GAP-01. Model-provider API keys, org-scoped, envelope-sealed (`enc:v1:`)
 * by the application (drizzle/0050). Plaintext never enters a row, a log, a
 * trace, or a manifest — disclosure happens only through the audited MCP
 * authority path (mcp-authority.service.ts `getToolCredential`, pseudo-tool
 * `model:<provider>`).
 *
 * V1 posture (report §6.3): `source='platform'` rows are provisioned by
 * platform staff on behalf of the org; `source='byok'` rows arrive through
 * the org console (org-supplied keys — REL-11.1 adds their billing
 * accounting). Rotation swaps the sealed material in place; revocation is
 * terminal (a revoked row is never un-revoked).
 */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    label: varchar('label', { length: 128 }).notNull(),
    /** Stable non-secret correlation id (provider key id / derived hash) — unique per (org, provider). */
    externalRef: varchar('external_ref', { length: 256 }).notNull(),
    source: varchar('source', { length: 16 }).notNull().default('platform'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    secretSealed: text('secret_sealed').notNull(),
    /** Display-safe mask (`****` + last 4) — the only secret-derived material that ever leaves the row. */
    secretFingerprint: varchar('secret_fingerprint', { length: 32 }).notNull(),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    rotatedBy: varchar('rotated_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    uniqueIndex('uq_provider_credentials_org_provider_ref').on(t.organizationId, t.provider, t.externalRef),
    index('ix_provider_credentials_org_provider').on(t.organizationId, t.provider, t.status),
  ],
);

export type ProviderCredential = typeof providerCredentials.$inferSelect;

/**
 * Per-org provider enablement (REL-1.3) — the administrative switch that
 * decides whether a stored credential is usable. Kept separate from the
 * credential row so provisioning and enablement audit independently and a
 * revoked key can never silently "enable" a provider.
 */
export const providerEnablements = pgTable(
  'provider_enablements',
  {
    organizationId: uuid('organization_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: varchar('updated_by', { length: 128 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.provider] })],
);

export type ProviderEnablement = typeof providerEnablements.$inferSelect;

/** Closed provider vocabulary (extending it is a reviewed schema change). */
export const MODEL_PROVIDERS = ['openai', 'anthropic', 'google', 'azure-openai', 'amazon-bedrock', 'mistral', 'xai', 'deepseek', 'openrouter', 'ollama'] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(provider: string): provider is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(provider);
}

/** The pseudo-tool name under which the model gateway requests a provider key. */
export function modelProviderToolName(provider: string): string {
  return `model:${provider}`;
}

export const PROVIDER_CREDENTIAL_SOURCES = ['platform', 'byok'] as const;
export const PROVIDER_CREDENTIAL_STATUSES = ['active', 'rotating', 'revoked'] as const;
