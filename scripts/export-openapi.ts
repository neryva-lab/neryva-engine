/**
 * Engine OpenAPI export (contract composition input — correction C7).
 *
 * Boots the app with every module flag ON (so the spec covers the full
 * surface regardless of the deployment env) and writes the
 * @nestjs/swagger-generated spec to JSON. Composed with the runtime's
 * pinned spec by compose-contract.ts; CI fails on drift.
 *
 * Usage: npx tsx scripts/export-openapi.ts [outPath]
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
// The env parser requires these at import time; the export never connects.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://export:export@localhost:5432/export';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.ENGINE_BASE_URL = process.env.ENGINE_BASE_URL ?? 'http://localhost:3001';
process.env.MODULES__CORPORATE_ENABLED = 'true';
process.env.MODULES__IDENTITY_ENABLED = 'true';
process.env.MODULES__ORGANIZATIONS_ENABLED = 'true';
process.env.MODULES__CONSOLE_ENABLED = 'true';
process.env.IDENTITY_JWT_SIGNING_KEY_FILE = process.env.IDENTITY_JWT_SIGNING_KEY_FILE ?? '';
process.env.IDENTITY_ALLOW_DEV_KEYS = 'true';
process.env.MFA_PROOF_SIGNING_KEY = process.env.MFA_PROOF_SIGNING_KEY ?? 'export-only-dummy-key-32-bytes!!';

import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'var/engine-openapi.json';
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });

  const config = new DocumentBuilder()
    .setTitle('Neryva Engine API')
    .setDescription('Control plane + public surfaces of the Neryva platform engine (TS core). Runtime-plane /v1 and /surfaces live in the agent-runtime satellite contract; the composed contract merges both.')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'L2ApiKey')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'L1L3Bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.paths = document.paths ?? {};

  writeFileSync(out, JSON.stringify(document, null, 2));
  // eslint-disable-next-line no-console
  console.log(`engine spec written: ${out} (${Object.keys(document.paths).length} paths)`);
  await app.close();
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('export failed:', err);
  process.exit(1);
});
