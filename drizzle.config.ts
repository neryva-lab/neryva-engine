import { existsSync } from 'node:fs';
import type { Config } from 'drizzle-kit';

// Local dev convenience: honor a repo-local .env when running drizzle-kit
// directly (`npm run migrate`); CI/compose provide DATABASE_URL themselves.
if (existsSync('.env')) process.loadEnvFile('.env');

export default {
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://neryva:neryva@127.0.0.1:5432/neryva',
  },
  // Engine-owned migrations only (ownership map: engine/ownership-map.json).
  // Python-owned tables are never present in the drizzle schemas.
  schema: [
    './src/modules/identity/schema.ts',
    './src/modules/organizations/schema.ts',
    './src/modules/corporate/email/schema.ts',
    './src/modules/corporate/public.schema.ts',
    './src/modules/billing/schema.ts',
    './src/modules/billing/billing-extension.schema.ts',
    './src/modules/deployment/schema.ts',
    './src/modules/studio-furniture/schema.ts',
    './src/modules/assistants/schema.ts',
    './src/modules/conversations/schema.ts',
    './src/common/infra/outbox/schema.ts',
    './src/common/http/idempotency-records.ts',
    './src/modules/conversations/mcp.schema.ts',
    './src/modules/knowledge/schema.ts',
    './src/modules/channels/schema.ts',
    './src/modules/billing/usage-ledger.schema.ts',
    './src/modules/lifecycle/lifecycle.schema.ts',
    './src/modules/satellites/satellite.schema.ts',
    './src/modules/webhooks/schema.ts',
    './src/modules/notifications/schema.ts',
    './src/modules/staff/schema.ts',
    './src/modules/config-publish/config-publish.schema.ts',
    './src/modules/console/announcements.schema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  verbose: true,
  strict: true,
} satisfies Config;
