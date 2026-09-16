# dev_scripts — Windows-native runner (no Docker)

> **Local-only, never committed.** This directory is gitignored (`engine/.gitignore`).
> Production and CI stay on Docker (`ops/docker-compose.yml` → managed Postgres/Redis/S3/Jaeger).
> This lane exists so Windows devs can run the full stack as native processes — no Docker Desktop, no WSL, no Hyper-V.

## When to use which lane

| Lane | Services | How |
|---|---|---|
| **Production / CI** | Managed Postgres + Redis + S3 + Jaeger, Engine, Studio, Website behind Caddy | `ops/docker-compose.yml` + `ops/engine/docker-compose.yml` |
| **Windows dev (this dir)** | Native Postgres (EDB) + Memurai Redis + MinIO binary + Engine + Studio `runtime-control` (inline) + Website | `dev_scripts/*.ps1` |

## Prerequisites (one-time)

* **Node 22 LTS** (`node --version` ≥ 22) — https://nodejs.org
* **pnpm 9** via `corepack` — `corepack enable` (admin) then `corepack prepare pnpm@9.12.0 --activate`. This repo uses `npx pnpm` as fallback so PATH issues don't block you.
* **PostgreSQL 16 or 17** (EDB installer) — https://www.postgresql.org/download/windows/ . Data dir `C:\Program Files\PostgreSQL\17\data` is the convention this script expects.
* **pgvector** — `CREATE EXTENSION vector` must succeed. Built from source with VS C++ tools: `nmake /F Makefile.win` (`pgvector/pgvector` README, `https://github.com/pgvector/pgvector?tab=readme-ov-file#windows`). `setup.ps1` checks and guides you.
* **Memurai Developer Edition** (Redis 7.2.6 API on Windows) — https://www.memurai.com / https://redis.io/tutorials/howtos/how-to-run-redis-on-windows-natively-with-memurai/ . Installs as Windows service `Memurai` on `:6379`. The script also accepts WSL/Docker Redis on `:6379` as fallback — it just probes the port.
* **No manual MinIO install** — `setup.ps1` downloads `minio.exe` + `mc.exe` to `dev_scripts/bin/` from `https://dl.min.io/.../windows-amd64/` (official docs: `https://minio.community/.../baremetal-deploy-minio-on-windows.html`).

## Quick start

```powershell
# 0. One-time: install/check everything (downloads MinIO, checks PG/Redis/pgvector)
powershell -ExecutionPolicy Bypass -File dev_scripts/setup.ps1

# 1. Fill env (first time only)
Copy-Item .env.example dev_scripts/.env.windows -ErrorAction SilentlyContinue
# edit dev_scripts/.env.windows and copy to .env when happy, or just edit .env directly
# Minimal dev .env: DATABASE_URL, REDIS_URL, S3_* + MODULES__* flags. See ops/README.md.

# 2. Full stack (infra + migrate + engine + studio runtime-control inline + website)
powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1
# or: dev_scripts/dev.ps1 -SkipInfra -SkipMigrate  (when infra already up)

# 3. Just infra (PG + Redis + MinIO) without Node services
powershell -ExecutionPolicy Bypass -File dev_scripts/start-infra.ps1
powershell -ExecutionPolicy Bypass -File dev_scripts/stop-infra.ps1   # stop MinIO job

# 4. Health probe
powershell -ExecutionPolicy Bypass -File dev_scripts/check.ps1
```

`dev.ps1` uses [`concurrently`](https://www.npmjs.com/package/concurrently) (cross-platform, Windows double-quote aware — `https://github.com/open-cli-tools/concurrently`) with `npx concurrently` so no global install is needed. Logs are prefixed `[engine]`, `[studio]`, `[web]`; `Ctrl+C` kills all (`--kill-others-on-fail`).

## Ports (must be free)

| Service | Port | Check |
|---|---|---|
| Engine | 3001 | `http://localhost:3001/health/live` |
| Studio runtime-control | 8080 | `http://localhost:8080/health` (when running) |
| Website (Vite) | 3000 | `http://localhost:3000` — proxies `/engine` → `:3001`, `/runtime` → `:8080` (`console/neryva-website/vite.config.ts:41-52`) |
| Postgres | 5432 | `pg_isready` / `psql` |
| Redis / Memurai | 6379 | `redis-cli ping` / `memurai-cli ping` |
| MinIO API / Console | 9000 / 9001 | `http://localhost:9000/minio/health/live` |

## What each script does

* **`setup.ps1`** — verifies Node/pnpm, locates `psql`, checks `vector` extension, checks `:6379` (Memurai/Redis), downloads `minio.exe`+`mc.exe` to `bin/`, prints next steps. Idempotent.
* **`start-infra.ps1`** — ensures Postgres service running, probes Redis/Memurai, starts MinIO (`bin/minio.exe server <data> --console-address :9001`) as background job, waits for `/minio/health/live`, creates buckets `neryva-uploads` + `content/covers` with `mc`, sets public-read.
* **`stop-infra.ps1`** — stops the MinIO job (Postgres/Redis are Windows services — left running; stop them via `services.msc` if needed).
* **`dev.ps1`** — calls `start-infra.ps1`, runs `npx pnpm run migrate` (once), builds `@neryva/mcp-contract` if needed, then `npx concurrently` for Engine (`npx pnpm run dev` → `tsc && node --watch dist/main.js` on `:3001`), Studio runtime-control (`PORT=8080 EXECUTION_MODE=inline npx tsx --watch apps/runtime-control/src/main.ts`), and Website (`npx pnpm --filter neryva-website dev` or `npx vite` fallback). Requires `NERYVA_RUNTIME_BASE_URL=http://localhost:8080` in Engine `.env` for Engine→Studio dispatch (`src/transport/mcp/runtime-control.client.ts:33-35` — empty = run stays `ACCEPTED`).
* **`check.ps1`** — probes `GET /health/live`, `/health/ready`, `/metrics`, Postgres `SELECT 1`, Redis `PING`, MinIO health, and `GET /health` on `:8080`/`:3000`.

## Troubleshooting

* **Postgres bin missing** (`C:\Program Files\PostgreSQL\17\bin` not found but `data/` exists) — reinstall EDB Postgres 17 over the existing data dir, or point `DATABASE_URL` to a fresh instance. Then re-run `setup.ps1` and `CREATE EXTENSION vector;`.
* **pgvector `nmake` fails** — run `x64 Native Tools Command Prompt for VS` as Administrator, `set PGROOT=C:\Program Files\PostgreSQL\17`, `nmake /F Makefile.win && nmake /F Makefile.win install`, restart Postgres.
* **Redis/Memurai not reachable** — install Memurai MSI (`msiexec /quiet /i memurai.msi` per `https://redis.io/.../how-to-run-redis-on-windows-natively-with-memurai/`), ensure service `Memurai` is Running, or run Redis via WSL `sudo service redis-server start` as fallback.
* **MinIO port in use** — `stop-infra.ps1` then check `netstat -ano | findstr 9000`.
* **Engine never dispatches to Studio** — set `NERYVA_RUNTIME_BASE_URL=http://localhost:8080` in `.env` and restart Engine. Without it the outbox row stays `PUBLISHED` with skip (`runtime-control.client.ts:12-15`).
* **`pnpm` not found** — use `npx pnpm` (scripts do), or `corepack enable` in an elevated shell.

## References

* Engine bootstrap `src/main.ts:141` (`app.listen(env.PORT, env.HOST)`), env `src/common/config/env.ts:196-201`.
* Infra compose being replaced here: `ops/docker-compose.yml:1-75` (pgvector:pg16, redis:7-alpine, minio/minio + minio-init bucket creation).
* Runtime-control config `products/agent-studio/apps/runtime-control/src/config.ts` (`PORT` default 3001 — overridden to 8080 here; `EXECUTION_MODE` inline vs temporal).
* Postgres + pgvector Windows build: `https://github.com/pgvector/pgvector?tab=readme-ov-file#windows`, install notes `https://mehmetakar.dev/install-pgvector-on-windows/`.
* Redis on Windows: Memurai native port `https://redis.io/tutorials/howtos/how-to-run-redis-on-windows-natively-with-memurai/` + `https://www.memurai.com/redis-windows`, Layerbase Windows Redis binary alternative `https://layerbase.com/blog/redis-on-windows-without-docker`.
* MinIO Windows binary: `https://dl.min.io/server/minio/release/windows-amd64/minio.exe`, docs `https://minio.community/.../baremetal-deploy-minio-on-windows.html`.
* Concurrently: `https://www.npmjs.com/package/concurrently`, `https://github.com/open-cli-tools/concurrently` (Windows double-quote rule, `--kill-others`).
