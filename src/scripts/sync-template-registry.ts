import { existsSync } from 'node:fs';

// Entry shim: repo-local .env must load BEFORE any module import, because
// src/common/config/env.ts validates at import time. The implementation
// lives in ./sync-template-registry.impl.js (no top-level await here — the
// engine tsconfig is CommonJS, so the run is promise-chained).
if (existsSync('.env')) process.loadEnvFile('.env');

// The sync path uses DbService + AuditService only — it never dials model,
// channel, or harness endpoints. env.ts still validates every URL at import
// (zod validates .default('') against .url()), so unset harness URLs would
// fail the import before main runs. Fill obviously-fake loopback placeholders
// ONLY when unset; release/CI provides real values via the environment.
// Never add real endpoint URLs here.
for (const key of [
  'CHANNELS__VOICE_ASR_URL',
  'CHANNELS__EMAIL_API_URL',
  'HARNESS__MODERATION_BASE_URL',
  'HARNESS__RERANKER_URL',
  'KNOWLEDGE_OCR_URL',
  'KNOWLEDGE_TRANSCRIBE_URL',
  'HARNESS__WEB_SEARCH_URL',
  'HARNESS__QUERY_REWRITE_URL',
  'HARNESS__LLM_JUDGE_URL',
  'HARNESS__TTS_URL',
  'HARNESS__IMAGE_GEN_URL',
]) {
  process.env[key] ??= 'http://127.0.0.1:9/';
}

import('./sync-template-registry.impl.js').then(
  (impl) => impl.run(),
  (err: unknown) => {
    console.error(`sync-template-registry failed to load: ${(err as Error).message}`);
    process.exit(1);
  },
).catch((err: unknown) => {
  console.error(`sync-template-registry failed: ${(err as Error).message}`);
  process.exit(1);
});
