// Diagnostic boot: run Nest init with plain console error output to surface
// what the pino logger swallows ({}) during DI failures.
import 'reflect-metadata';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const { NestFactory } = await import('@nestjs/core');
const { FastifyAdapter } = await import('@nestjs/platform-fastify');
const { AppModule } = await import('../src/app.module');

try {
  const app = await NestFactory.create(AppModule, new FastifyAdapter({ logger: false }), { logger: ['error', 'warn', 'log'] });
  await app.init();
  console.log('DIAG: init OK');
  await app.close();
  process.exit(0);
} catch (err) {
  console.error('DIAG FAILED:', err?.message ?? err);
  console.error(err?.stack ?? '');
  const cause = err?.meta ?? err?.cause;
  if (cause) console.error('meta/cause:', cause);
  process.exit(1);
}
