// Programmatic drizzle migrator — same engine as `drizzle-kit migrate`, but
// surfaces real errors (the kit's CLI spinner swallows them on Windows CI
// shells). Usage: node scripts/migrate.mjs [migrations-folder]
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL ?? 'postgresql://neryva:neryva@127.0.0.1:5432/neryva';
const folder = process.argv[2] ?? './drizzle';

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: folder });
  console.log(`migrations applied from ${folder}`);
} finally {
  await client.end();
}
