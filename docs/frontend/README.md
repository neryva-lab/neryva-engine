# docs/frontend — Console & Product UI Specifications

> Read this file first in any new session touching console, product UI, onboarding, invites, or agent setup. It tells you what lives here, what is decided vs open, where the system truth lives, and the rules for changing anything without dropping quality.

## What this directory is

The **complete, build-ready specification set for the Neryva console and product UI** (`console/neryva-website`: Vite + React 18 + TanStack Router + TanStack Query + zustand). Engine, MCP contract, and Agent Studio runtime are DONE and headless — everything in this directory consumes Engine REST/JSON + SSE only, and specifies UI behavior against already-implemented Engine endpoints. Nothing here invents backend semantics; where a spec needs a missing Engine surface, it names it explicitly as a work-list item with contract.

**Canonical locations (do not re-derive, do not rename):**

| Plane | Location | Role |
|---|---|---|
| Engine (control plane, system of record) | `engine/` (this repo) | Identity, tenancy, assistants/versions, conversations/runs, knowledge, billing, audit, lifecycle; exposes `/console/*`, `/v1/*`, `/public/*`, SSE, ConnectRPC MCP authority |
| Neryva MCP contract | `products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`, `neryva.mcp.v1`) | Versioned Engine↔Studio protocol; consumed, never copied |
| Agent Studio runtime | `products/agent-studio/` (Temporal + TS) | Headless execution plane; no UI, no DB credentials |
| Console / website | `console/neryva-website/` | Marketing pages + `/platform` org admin + `/agent-studio` product console (`/deployment` dormant) |
| Legacy prototype (NOT canonical) | `products/neryva_agent_studio/` | Quarantined Python prototype; salvage IA/widget patterns only, never import |

## File index (read in this order)

1. **`frontend_implementation_plan.md`** (277 lines) — the master plan. Three-shell layout (marketing static pages stay JSON-fed; `/platform` org admin; `/agent-studio` product console), OAuth-only auth migration (delete password/OTP stack, test bypasses, legacy axios client), per-view Engine endpoint map, React Query/SSE/RBAC/step-up conventions, static-pages freeze, quality gates per milestone, M0→M6 build order. Start here for any console work.
2. **`first-run-onboarding.md`** (169 lines) — the first 60 seconds: OAuth callback → one prefilled screen (display name → `PATCH /auth/me`, workspace name → `PATCH settings`) → dashboard + live checklist. Invited-user path (redeem → land in inviter org, no setup screen), stash lifecycle, failure-copy table with exact Engine semantics, locked decisions (§6: activation = first successful run; value-first trial; user-created projects; template-first activation).
3. **`team-loop.md`** (172 lines) — the complete membership lifecycle: invite create (email+role+delivery), URL-first manual delivery with shown-once links + `mailto:` drafts, atomic email-bound redeem, role matrix with owner-only reserves, suspend-before-remove offboarding, new-member dashboard, notification wiring, acceptance gates. Includes the specified-then-implemented Engine work (§8).
4. **`agent-setup.md`** (117 lines) — agent authoring + knowledge + providers: data model, setup state machine, knowledge-first flow (uploads/connectors/mapping/enforced pins/permission sync), template install, two-tier provider config, authoring validation reference, test→evaluate→publish→operate, full endpoint+role table, error catalog. §10 locked (refuse pins, operate split — see Locked decisions below).

## Locked decisions (do not relitigate without new evidence)

- OAuth-only auth; no passwords/OTP in console; session tokens never in `localStorage` (sole exception: short-TTL single-purpose `neryva.pending_invite` stash per `team-loop.md` accept flow — not a session token).
- Personal org auto-created on signup; first run renames in place (no second org, no personal→team conversion).
- Value-first trial (runs work with no entitlement row); user-created projects; template-first activation.
- URL-first invite delivery (email retained); per-email binding is the real control; open reusable links rejected.
- Single-org-context UI; active org persisted (`neryva.active_org`), never defaulted by array index.
- Per-agent knowledge enforced at retrieval (pins), immutable slugs, permission sync default-deny.
- Engine stays system of record; Studio stays headless; no second runtime/state machine, ever.

## Still open (none — both prior items locked 2026-09-15 in `agent-setup.md:92-95`)

1. ~~Unresolved knowledge pins at publish: warn vs refuse~~ → **REFUSE (locked).** 422 with slugs unless `acknowledge_degraded_knowledge: true` (audited as `assistant.publish_degraded_acknowledged` — `engine/src/modules/assistants/assistants.service.ts:1212-1216`).
2. ~~Operate UI split~~ → **SPLIT (locked).** Emergency toggles (pause rollout + disable/kill) build now; analytics/anomaly/variant sliders deferred. Burn-rate is service-only (`engine/src/modules/billing/billing.worker.ts:61-62` hourly `billing.burn_sweep`); operate UI surfaces rollout state + `paused_reason/by/at` + `GET :assistantId/knowledge-health` (`engine/src/modules/assistants/assistants.controller.ts:122-127`).

## Working rules (how to keep quality up)

- **Verify against code, never from memory.** Every Engine claim needs a `file:line` citation re-checked in `engine/src` (controllers for routes+roles, services for semantics, `drizzle/*.sql` + `ownership-map.json` for data). Prior passes caught real doc bugs this way (step-up scope, phantom burn-rate endpoint, suspend matrix, token-in-URL logging).
- **Paths are repo-root-relative** (`neryva_studio/`): Engine files as `engine/src/...`, website as `console/neryva-website/src/...`, Studio/MCP as `products/...`.
- **Docs describe; code decides.** If doc and code disagree, code wins and the doc gets amended in the same session. Never edit Engine behavior to match a doc — spec the change as a work-list item first.
- **No new Engine endpoints invented in passing.** A missing surface gets a named subsection (contract, roles, errors, acceptance) marked `REQUIRED ENGINE ADDITION` until implemented, then flipped to implemented with the commit reference.
- **Frontend never:** holds provider secrets, canonical state, MCP capability tokens, or authz decisions; imports `@neryva_data/products/*` as runtime data; stores session tokens in `localStorage` (`neryva.pending_invite` invite-stash excepted); invents IDs/versions/entitlements.
- **Every mutation spec includes:** idempotency-key behavior, exact error strings with UI copy, role gating (UI hide + server enforce), and the retry/conflict path. Skipped states (seat-full, expired invite, BLOCK decision) always specify the exit, never a dead end.
- **Commit hygiene:** docs changes commit with the code they describe; one ledger/task ID per PR where applicable; run `typecheck` + relevant `vitest` before claiming done.

## Quick orientation for common tasks

| Task | Read | Then check |
|---|---|---|
| Build a console view | `frontend_implementation_plan.md` §4 + this README's conventions | Controller route + roles in `engine/src` |
| Touch auth/session/onboarding | `first-run-onboarding.md` + plan §3 | `engine/src/modules/identity/*`, `organizations/org-access.service.ts` |
| Touch invites/members/roles | `team-loop.md` | `engine/src/modules/organizations/invites.service.ts`, `memberships.service.ts` |
| Touch agents/templates/knowledge/models | `agent-setup.md` | `engine/src/modules/{assistants,knowledge,conversations}/*`, `products/agent-studio/contracts/*` |
| Add an Engine surface the UI needs | The relevant spec's work-list pattern | `ownership-map.json`, `drizzle/` migration order, controller + roles + tests |

## Running the stack locally (Engine + MCP + Studio) — Windows dev lane

> **For active UI work.** Engine is system of record, Studio is headless, MCP is the versioned `neryva.mcp.v1` contract (`@neryva/mcp-contract` at `products/neryva_mcp/neryva-mcp-contract`) — no separate MCP service. The Windows lane runs everything as native processes (no Docker). Production/CI stays on `ops/docker-compose.yml`.

**Prereqs (once):** Node 22 LTS, `corepack enable` (pnpm 9), EDB Postgres 16/17 + `CREATE EXTENSION vector` (`nmake /F Makefile.win` with `PGROOT=C:\Program Files\PostgreSQL\17`), Memurai on `:6379`, `setup.ps1` downloads `minio.exe`/`mc.exe` to `dev_scripts/bin/`.

```powershell
# 0. one-time check + downloads
powershell -ExecutionPolicy Bypass -File dev_scripts/setup.ps1

# 1. full stack (infra + migrate + engine + studio inline + website)
powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1
# resume: dev_scripts/dev.ps1 -SkipInfra -SkipMigrate
# infra only: dev_scripts/start-infra.ps1 / stop-infra.ps1
# health: dev_scripts/check.ps1
```

**What `dev.ps1` starts:**
- **Engine** `engine/` → `:3001` (`npx pnpm run dev` → `tsc && node --watch dist/main.js`, `src/main.ts:141`). Requires `NERYVA_RUNTIME_BASE_URL=http://localhost:8080` in `engine/.env` or runs stay `ACCEPTED` (`src/transport/mcp/runtime-control.client.ts:33`).
- **MCP** — no process; contract is built on demand (`npx pnpm --filter @neryva/mcp-contract build`), consumed via ConnectRPC (`engine/src/transport/mcp` authority, `products/agent-studio/packages/neryva-mcp-client`).
- **Agent Studio** `products/agent-studio/apps/runtime-control` → `:8080` (`PORT=8080 EXECUTION_MODE=inline npx tsx --watch apps/runtime-control/src/main.ts`, `src/config.ts`). Inline needs no Temporal; `temporal` is the Docker lane.
- **Website** `console/neryva-website` → `:3000` (`vite.config.ts:41` proxies `/engine→:3001`, `/runtime→:8080`).

**Ports:** `:3001` Engine `/health/live`, `:8080` Studio `/healthz`, `:3000` Web, `:5432` PG, `:6379` Redis, `:9000/:9001` MinIO. Full troubleshooting (pgvector `PGROOT`, MinIO busy, `pnpm` via `npx pnpm`) in `dev_scripts/README.md`.
