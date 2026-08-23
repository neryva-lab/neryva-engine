import type { Config } from 'drizzle-kit';

export default {
  // Engine-owned migrations only (ownership map: engine/ownership-map.json).
  // Python-owned tables are never present in the drizzle schemas.
  schema: [
    './src/modules/identity/schema.ts',
    './src/modules/organizations/schema.ts',
    './src/modules/corporate/email/schema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  verbose: true,
  strict: true,
} satisfies Config;
