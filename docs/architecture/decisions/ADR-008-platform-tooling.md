# ADR-008 — Platform tooling: what "modern infra" means here

**Date:** 2026-08-24 · **Status:** accepted · **Review against:** the 2026-08-24 feature audit

The question: "are we using the modern, robust tools the top AI companies use?"
Answer honestly, in three lists — already in use (some of it more modern than
assumed), added by this ADR (with code landing in the same wave), and
deliberately declined with the reason recorded so the choice is auditable, not
accidental.

## 1. Already in use (verified in code, not aspirational)

| Concern | Tool | Where |
| --- | --- | --- |
| Runtime | **Node 22 + NestJS 11 + Fastify** (not Express — 2× RPS, schema-based serialization) | `package.json`, `main.ts` |
| Data | **PostgreSQL + row-level security**, accessed via **Drizzle ORM** (typed SQL, RLS-first — chosen over Prisma in C16) | `common/infra/db` |
| Cache / coordination | **Redis (ioredis)** — BullMQ queues (8 namespaces), the Lua token-bucket rate limiter, the Lua quota reserve plane, deny-list + summary caches | `common/infra/redis.service.ts`, `billing/quota.service.ts`, `http/rate-limit.ts` |
| Jobs | **BullMQ** per-namespace workers with retry/backoff/DLQ semantics | `*/​*.worker.ts` |
| Identity | **oidc-provider (OP)** — a real OIDC certified IdP, RS256 custody with dual-key rotation | `modules/identity` |
| Passwords | **argon2id** (native `@node-rs/argon2`) | identity |
| Validation | **zod** (env + ingest + config payloads) + class-validator/class-transformer (DTO pipe, whitelist + forbidNonWhitelisted) | everywhere |
| Metrics | Prometheus text exposition at `/metrics` (L2-gated) with HTTP/auth/ingest/deployment/webhook series | `common/observability/metrics.ts` |
| Email | **Resend / Postmark** over their HTTP APIs (no SDK weight), suppression list + provider webhooks + RFC 8058 | `modules/corporate/email` |

So the stack is not "behind": Redis, queues, RLS, an OIDC IdP, argon2id and a
metrics endpoint are already the toolset of a serious platform. What was
genuinely missing are the four planes below — the ones that separate "has
Redis" from "operable like a top-tier platform".

## 2. Added by this ADR (this wave)

| Concern | Tool | Why this one | Code |
| --- | --- | --- | --- |
| **Tracing** | **OpenTelemetry** (NodeSDK + OTLP/HTTP exporter; http, fastify, pg, ioredis instrumentations) | The vendor-neutral standard — exports to any backend (Jaeger/Tempo/Datadog/Honeycomb) with zero code change. Off unless `OTEL_TRACING_ENABLED` | `src/tracing.ts` |
| **Structured logs** | **pino** via Fastify's native logger + a Nest `LoggerService` bridge; request-id correlation reuses the existing `X-Request-Id` convention; auth/cookie redaction; pretty in dev | JSON logs ship to any aggregator; one id now correlates request logs, error envelopes, and traces | `common/observability/logger.ts`, `main.ts` |
| **Error tracking** | **Sentry** (`@sentry/node`), env-gated by `SENTRY_DSN`, wired into the existing `AllExceptionsFilter` so domain `ApiError`s stay out (they are client errors) while unknown 500s report with request context | The industry default for exception telemetry; free-tier self-host (GlitchTip) compatible | `common/observability/sentry.ts` |
| **Object storage** | **S3-compatible storage (S3 / MinIO / R2)** with **SigV4 presigned PUT/GET written in-house** (node crypto, ~90 lines, no AWS SDK — same no-SDK discipline as Resend/Postmark) | Unblocks the two storage-backed features the audit flagged: career attachments (audit H-8, dead `file_ref`) and CMS cover images, plus future export artifacts | `common/infra/storage/storage.service.ts` |
| **Bot protection** | **Cloudflare Turnstile** on the public forms (contact, newsletter, careers apply) — invisible to humans, privacy-first (no Google), verified server-side against `challenges.cloudflare.com`; off unless `TURNSTILE_SECRET_KEY` set, fail-closed once configured | The public forms are the only unauthenticated write surface; honeypots alone are 2020-era | `common/http/turnstile.ts` |

Deliberate implementation notes:

- **Metrics stay on the in-house registry.** It already emits correct
  Prometheus exposition with six live series and zero dependencies; running
  prom-client alongside OTel would produce two competing metric planes. When a
  backend needs OTel metrics, the exporter can be added to `tracing.ts`
  without touching call sites.
- **OTel package versions must stay a coherent set** (sdk + exporter +
  instrumentations from one release line); `pnpm install` reconciling the
  caret ranges is the first gate, as with every dependency wave.

## 3. Deliberately declined (recorded so it is a decision, not an omission)

| Tool | Reason |
| --- | --- |
| **Kafka / Redpanda** | Wrong size: we need durable job queues with retry/DLQ, not a streaming log; BullMQ-on-Redis is the right-sized, operationally cheaper choice. Revisit only if cross-service event streaming arrives (e.g., many satellites fanning metering at high volume). |
| **Temporal / durable workflow engine** | The deployment workflow is a state machine + BullMQ steps with idempotent continuation; a workflow SaaS adds an operational dependency the engine does not need yet. |
| **ClickHouse** | Usage analytics at current scale is Postgres rollups; the ledger (billing-metering) already reserves the columnar-analytics decision for when volume justifies it. |
| **Elasticsearch / Meilisearch** | No search surface yet justifies an index cluster; when the console audit/org search needs more than indexed Postgres queries, revisit (pg FTS + trigram is the next step, still no new service). |
| **pgvector** | Vector/RAG is the agent-runtime's domain (its own stack), not the engine's; an engine-side vector store would duplicate ownership (ADR-006 discipline). |
| **Vault / KMS SaaS** | Secrets today are file-based envelope keys (AES-256-GCM, dual-key rotation for JWT custody) with the same custody semantics; a KMS interface can replace the key source later without touching consumers. |
| **Feature-flag SaaS (LaunchDarkly et al.)** | The entitlement plane + module flags ARE the flag system, with audit and billing teeth a SaaS toggle does not have. |
| **GraphQL / tRPC** | The product contract is REST with zod/DTO validation, manifest-enforced route bijection, and a composed OpenAPI surface — switching transports buys nothing here. |

## 4. Where this lands (wiring map)

- `main.ts`: `tracing` imported first, Sentry init, pino logger on the Fastify
  adapter + `app.useLogger(PinoLogger)`, request-id echo unchanged.
- `kernel.module.ts`: `StorageService` provided/exported (env-gated).
- `env.ts` / `.env.example`: `OTEL_*`, `SERVICE_NAME`, `SENTRY_DSN`, `S3_*`
  (endpoint/region/bucket/keys/path-style/public-base), `TURNSTILE_SECRET_KEY`.
- `ops/engine/docker-compose.yml`: commented local bring-up blocks for
  **Jaeger** (traces), **MinIO** (storage), matching the file's existing
  style for postgres/redis.
- Audit closure: feature-audit item **H-8** (career attachments dead field)
  is closed by the storage + presign endpoints.
