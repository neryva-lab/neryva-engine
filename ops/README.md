# ops — Engine Operations

Local development stack and runbooks. Production deployment lane lives in `ops/engine/` (A-0/C8).

## Bring-up (Phase 0.7)

```bash
# 1. Start infrastructure
docker compose -f ops/docker-compose.yml up -d

# 2. Migrate (release-job semantics locally: run once)
pnpm run migrate          # eng-0001..eng-0018 (and 0019 after P0 fix)

# 3. Dev server (watches dist/main.js with .env)
pnpm run dev              # tsc -p tsconfig.json && node --watch dist/main.js

# 4. Verify
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
curl http://localhost:3001/metrics | head
```

UI / endpoints:

| Service | URL | Env to enable |
|---|---|---|
| Engine API | `http://localhost:3001` | `ENGINE_BASE_URL=http://localhost:3001` |
| Postgres | `postgresql://neryva:neryva@127.0.0.1:5432/neryva` | `DATABASE_URL` |
| Redis | `redis://127.0.0.1:6379` | `REDIS_URL` |
| MinIO | `http://localhost:9000` (console `http://localhost:9001`, `minioadmin/minioadmin`) | `S3_ENDPOINT=http://localhost:9000`, `S3_BUCKET=neryva-uploads`, `S3_FORCE_PATH_STYLE=true`, `S3_PUBLIC_BASE_URL=http://localhost:9000/neryva-uploads` |
| Jaeger | `http://localhost:16686` | `OTEL_TRACING_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces` |

Buckets after `minio-init` once: `neryva-uploads` (+ `content/covers` public-read for CMS).

## Teardown

```bash
docker compose -f ops/docker-compose.yml down
# add -v to drop pgdata/miniodata (destroys local DB / buckets)
```

## Relationship to `ops/engine/docker-compose.yml`

- `ops/docker-compose.yml` — **local dev stack**: commented infrastructure from the production lane is enabled here. Single command brings everything.
- `ops/engine/docker-compose.yml` — **production lane**: expects external managed Postgres/Redis; local infra is commented. Edge (`caddy`) + `engine` service with `secrets` and healthcheck.

Both share external network `neryva` (`docker network create neryva || true` is implicit via the compose `name: neryva`).

## Runbooks

`imp/ledger.md:10` requires `ops/runbooks/*.md` before production. Place them here:

- `runbooks/database-failover-pitr.md`
- `runbooks/migration-rollback-forward-fix.md`
- `runbooks/outbox-lag-dead-letter-replay.md`
- `runbooks/worker-crash-lease-recovery.md`
... per `engine_implementation_plan.md:679-696`
