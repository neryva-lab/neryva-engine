import type { Config } from 'drizzle-kit';

export default {
  // Engine-owned migrations only (ownership map: engine/ownership-map.json).
  // Python-owned tables are never present in the drizzle schemas.
  schema: [
    './src/modules/identity/schema.ts',
    './src/modules/organizations/schema.ts',
    './src/modules/corporate/email/schema.ts',
    './src/modules/corporate/public.schema.ts',
    './src/modules/billing/schema.ts',
    './src/modules/deployment/schema.ts',
    './src/modules/agent-studio/schema.ts',
    './src/modules/satellites/satellite.schema.ts',
    './src/modules/config-publish/config-publish.schema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  verbose: true,
  strict: true,
} satisfies Config;
