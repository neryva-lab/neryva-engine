# Neryva Engine — Database Call-Site Inventory (via `DbService`)

**Date:** 2026-09-26
**Repo:** `~/workspace/neryva/neryva-engine` @ `main` (`6a92168`)
**Purpose:** Exhaustive inventory of every database access in Neryva Engine that flows through `DbService`, to support the MongoDB-as-selectable-alternative research. **Research only — no code was changed.**

## 1. Scope and counting rules

- **In scope:** every call of `db.root`, `db.root.transaction(...)`, `db.withOrg(...)`, `db.withBypass(...)`, `db.check()`, and `db.withSerializable(...)` in non-test TypeScript under `src/`. Each call is one call site. A multi-line or nested statement counts once.
- **Out of scope:** `*.spec.ts` / `*.test.ts` / `*.e2e-spec.ts` test files; schema definitions (`schema.ts`); `DbService` itself (`src/common/infra/db/db.service.ts`); string/comment mentions of `db.root` (7 comment false positives identified and excluded during reconciliation).
- **Verification:** each module was inventoried by an independent worker that verified every hit against the `DbService` import + constructor injection (no false positives from other `db` objects). An independent mechanical grep was then reconciled against every worker file at the `file:line` level — **all 859 call sites reconcile exactly** (see §10):
  - `withOrg`: grep 446 = inventory 446 ✓
  - `withBypass`: grep 96 = inventory 96 ✓
  - `root`: grep 296 = inventory 296 ✓
  - `root.transaction`: grep 8 = inventory 8 ✓
  - `check`: grep 13 = inventory 13 ✓
- Two worker summary arithmetic errors were found and corrected during reconciliation:
  - `corporate`: stated 82 → actual **85** (root 83, not 80).
  - `lifecycle`: stated withOrg 18 / withBypass 11 → actual **withOrg 17 / withBypass 12** (total unchanged at 29).
- `db.withSerializable` has **zero call sites** anywhere in the codebase (the helper exists on `DbService` but is never called).

## 2. `DbService` semantics (observed 2026-09-26, `src/common/infra/db/db.service.ts`)

| Method | Semantics |
|---|---|
| `db.root` | Direct Drizzle PostgreSQL database handle. **No tenant context, no RLS.** Single statements run outside any transaction. |
| `db.root.transaction(fn)` | Manual PostgreSQL transaction on the root handle. Still no tenant context / RLS unless the callback sets it explicitly (one site does: organizations' org-create sets `app.current_tenant` manually). |
| `db.withOrg(orgId, fn)` | PostgreSQL transaction with **transaction-local tenant context** (`app.current_tenant`), so RLS policies apply. The standard lane for tenant-owned data. |
| `db.withBypass(fn)` | PostgreSQL transaction with **RLS bypassed and tenant context cleared**. The lane for cross-org workers, sweeps, public/unauthenticated reads, and platform-plane writes. |
| `db.check()` | Raw `SELECT 1`-style PostgreSQL health probe. Used only in `HealthRegistry` registrations (module constructors). |
| `db.withSerializable` | Serializable-retry helper. **Zero call sites.** |

**Why this matters for MongoDB:** `withOrg` relies on PostgreSQL RLS for tenant isolation; `withBypass`/`root` rely on its *absence*. In MongoDB there is no RLS — every `withOrg` call site becomes an application-enforced `organization_id` predicate (or a collection-per-tenant decision), and every `root`/`withBypass` call site must be audited for whether it touches tenant-owned data (see §7 RLS-sensitive paths).

## 3. Grand totals

| Module | Call sites | withOrg | withBypass | root | root.transaction | check |
|---|---|---|---|---|---|---|
| deployment | 76 | 70 | 5 | 0 | 0 | 1 |
| corporate | 85 | 0 | 0 | 83 | 1 | 1 |
| organizations | 99 | 74 | 9 | 14 | 1 | 1 |
| lifecycle | 29 | 17 | 12 | 0 | 0 | 0 |
| config-publish | 21 | 12 | 2 | 6 | 0 | 1 |
| staff | 19 | 0 | 0 | 18 | 0 | 1 |
| common infra (`src/common/`) | 17 | 0 | 12 | 4 | 1 | 0 |
| webhooks | 16 | 12 | 3 | 0 | 0 | 1 |
| keys | 15 | 11 | 1 | 2 | 0 | 1 |
| console | 10 | 3 | 0 | 6 | 0 | 1 |
| studio-furniture | 8 | 5 | 0 | 2 | 0 | 1 |
| notifications | 6 | 0 | 0 | 5 | 0 | 1 |
| scripts (`src/scripts/`) | 2 | 0 | 0 | 2 | 0 | 0 |
| assistants | 80 | 52 | 4 | 24 | 0 | 0 |
| conversations | 62 | 58 | 3 | 1 | 0 | 0 |
| billing | 51 | 32 | 13 | 4 | 1 | 1 |
| identity | 96 | 0 | 1 | 90 | 4 | 1 |
| knowledge | 71 | 60 | 11 | 0 | 0 | 0 |
| satellites | 36 | 0 | 0 | 35 | 0 | 1 |
| channels | 29 | 20 | 9 | 0 | 0 | 0 |
| workers (`src/workers/`) | 31 | 20 | 11 | 0 | 0 | 0 |
| **TOTAL** | **859** | **446** | **96** | **296** | **8** | **13** |

Three architectural postures are visible:
1. **RLS-tenant modules** (`deployment`, `organizations`, `lifecycle`, `assistants`, `conversations`, `billing`, `knowledge`, `webhooks`, `keys`, `channels`, `workers`): predominantly `withOrg`, with `withBypass` reserved for worker sweeps.
2. **Platform-plane modules** (`corporate`, `staff`, `identity`, `notifications`, `satellites`): entirely or almost entirely `db.root` — these tables have **no RLS by design** (documented in schema comments).
3. **Mixed infrastructure** (`src/common/` outbox/audit/idempotency, `config-publish`, `console`, `scripts`): `withBypass` for cross-cutting machinery, `root` for global reads.

## 4. Per-module inventories

What follows is the full per-call-site inventory. Each entry gives exact `file:line`, `DbService` method, enclosing function, SQL table name(s) (resolved from the Drizzle schema definitions), read/write classification, and in-transaction status. Transaction boundaries, raw SQL, locks, and upserts are called out per module; cross-cutting patterns are synthesized in §§5–7.


## deployment — DB call-site inventory

Module: `src/modules/deployment/` (NestJS + Drizzle, schema `product_deployment`).
All call sites verified against DbService injection (`private readonly db: DbService` in every file; `deployment.module.ts` constructor injects `DbService`). Controllers (`deployment.controller.ts`, `internal-deployments.controller.ts`, `runtime-deployments.controller.ts`), `deployment.workflow.ts`, `gate-evaluator.ts`, `rollout.ts`, `plans.ts` have **zero** DB call sites (they go through services).

Table-name resolution (from `src/modules/deployment/schema.ts`, `pgSchema('product_deployment')`):
- `pipelines` → `product_deployment.pipelines`
- `pipelineStages` → `product_deployment.pipeline_stages`
- `environments` → `product_deployment.environments`
- `deployments` → `product_deployment.deployments`
- `deploymentEvents` → `product_deployment.deployment_events`
- `secrets` → `product_deployment.secrets`
- `deploymentSettings` → `product_deployment.deployment_settings`
- `audit_events` (raw SQL, NOT in module schema — audit domain table)

### Call sites

#### deployment.module.ts
- `src/modules/deployment/deployment.module.ts:68` — check — tables: — (health check only) — in-tx: n/a — liveness probe `db.check()`

#### deployment.worker.ts
- `src/modules/deployment/deployment.worker.ts:111` — withBypass — tables: `product_deployment.deployments` — read — in-tx: yes — selectDistinct orgIds from deployments (per-org retention loop seed)
- `src/modules/deployment/deployment.worker.ts:123` — withBypass — tables: `product_deployment.deployment_events` — write — in-tx: yes — delete expired event rows for org (returning ids), retention job

#### deployments.service.ts
- `src/modules/deployment/deployments.service.ts:84` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — list runs with optional pipeline/env/status filters
- `src/modules/deployment/deployments.service.ts:102` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — get single run by id (get())
- `src/modules/deployment/deployments.service.ts:113` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — get run's stage
- `src/modules/deployment/deployments.service.ts:116` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — get run's pipeline
- `src/modules/deployment/deployments.service.ts:126` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — run's event log (limit 500)
- `src/modules/deployment/deployments.service.ts:141` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — org activity feed with kind filter
- `src/modules/deployment/deployments.service.ts:204` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active (pending/gated/rolling) runs on a stage (trigger guard; sql`` count + status fragment)
- `src/modules/deployment/deployments.service.ts:226` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active runs on env (concurrency guard)
- `src/modules/deployment/deployments.service.ts:256` — withOrg — tables: `product_deployment.deployments` — write — in-tx: yes — insert new run row (status pending, frozen ladder)
- `src/modules/deployment/deployments.service.ts:319` — withOrg — tables: `product_deployment.deployments` — write — in-tx: yes — guarded status-machine transition (update status/started_at/completed_at/last_error)
- `src/modules/deployment/deployments.service.ts:362` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — select actors of gate.approved events (dedup approvals)
- `src/modules/deployment/deployments.service.ts:416` — withOrg — tables: `product_deployment.deployments` — write — in-tx: yes — update metrics jsonb feed
- `src/modules/deployment/deployments.service.ts:435` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — distinct approval actors for gate evaluation
- `src/modules/deployment/deployments.service.ts:471` — withOrg — tables: `product_deployment.deployments` — write — in-tx: yes — update canary_percent
- `src/modules/deployment/deployments.service.ts:482` — withOrg — tables: `product_deployment.deployments` — write — in-tx: yes — update rollout_state bookkeeping
- `src/modules/deployment/deployments.service.ts:651` — withOrg — tables: `product_deployment.deployment_events` — write — in-tx: yes — appendEvent: insert event row
- `src/modules/deployment/deployments.service.ts:657` — withBypass — tables: `product_deployment.deployments` — read — in-tx: yes — cross-org stale active runs scan (coalesce lastTickAt sql fragment; reconcile input)
- `src/modules/deployment/deployments.service.ts:738` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — readPipeline: non-archived pipeline row
- `src/modules/deployment/deployments.service.ts:748` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — readPipeline: stages ordered by position
- `src/modules/deployment/deployments.service.ts:756` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — nextStage: first stage after position

#### environments.service.ts
- `src/modules/deployment/environments.service.ts:35` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — list environments
- `src/modules/deployment/environments.service.ts:41` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — get environment by id
- `src/modules/deployment/environments.service.ts:79` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — count envs (plan limit guard)
- `src/modules/deployment/environments.service.ts:87` — withOrg — tables: `product_deployment.environments` — write — in-tx: yes — insert env; onConflictDoNothing on (org_id, name)
- `src/modules/deployment/environments.service.ts:140` — withOrg — tables: `product_deployment.environments` — write — in-tx: yes — update env settings/protection fields
- `src/modules/deployment/environments.service.ts:188` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — count stages bound to env (delete guard)
- `src/modules/deployment/environments.service.ts:197` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active runs on env (delete guard)
- `src/modules/deployment/environments.service.ts:212` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — count envs (last-env guard)
- `src/modules/deployment/environments.service.ts:218` — withOrg — tables: `product_deployment.environments` — write — in-tx: yes — delete environment (secrets cascade by FK)
- `src/modules/deployment/environments.service.ts:238` — withOrg — tables: `product_deployment.environments` — write — in-tx: yes — markLive: set live_* serving state
- `src/modules/deployment/environments.service.ts:252` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — latest other live run on env (rollback target)
- `src/modules/deployment/environments.service.ts:262` — withOrg — tables: `product_deployment.environments` — write — in-tx: yes — restorePreviousLive: set/clear live_* state

#### pipelines.service.ts
- `src/modules/deployment/pipelines.service.ts:31` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — list non-archived pipelines
- `src/modules/deployment/pipelines.service.ts:37` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — all stages of org for list
- `src/modules/deployment/pipelines.service.ts:54` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — get pipeline by id
- `src/modules/deployment/pipelines.service.ts:64` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — stages of pipeline ordered by position
- `src/modules/deployment/pipelines.service.ts:89` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — count pipelines (plan limit guard)
- `src/modules/deployment/pipelines.service.ts:97` — withOrg — tables: `product_deployment.pipelines` — write — in-tx: yes — insert pipeline; onConflictDoNothing on (org_id, name)
- `src/modules/deployment/pipelines.service.ts:141` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — name-clash check on update
- `src/modules/deployment/pipelines.service.ts:152` — withOrg — tables: `product_deployment.pipelines` — write — in-tx: yes — update pipeline fields
- `src/modules/deployment/pipelines.service.ts:184` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active runs (pause guard)
- `src/modules/deployment/pipelines.service.ts:194` — withOrg — tables: `product_deployment.pipelines` — write — in-tx: yes — setStatus active/paused
- `src/modules/deployment/pipelines.service.ts:232` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — verify env belongs to org (addStage)
- `src/modules/deployment/pipelines.service.ts:255` — withOrg — tables: `product_deployment.pipeline_stages` — read+write — in-tx: yes — addStage: select max(position)+1 then insert stage
- `src/modules/deployment/pipelines.service.ts:325` — withOrg — tables: `product_deployment.pipeline_stages` — write — in-tx: yes — updateStage: policy/config fields
- `src/modules/deployment/pipelines.service.ts:358` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active runs on stage (removeStage guard)
- `src/modules/deployment/pipelines.service.ts:367` — withOrg — tables: `product_deployment.pipeline_stages` — write — in-tx: yes — removeStage: delete stage + raw-SQL reposition of tail
- `src/modules/deployment/pipelines.service.ts:388` — withOrg — tables: `product_deployment.pipeline_stages` — read — in-tx: yes — getStage by id
- `src/modules/deployment/pipelines.service.ts:403` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count active runs (archive guard)
- `src/modules/deployment/pipelines.service.ts:412` — withOrg — tables: `product_deployment.pipelines` — write — in-tx: yes — archive pipeline (set status archived)

#### releases.service.ts
- `src/modules/deployment/releases.service.ts:55` — withOrg — tables: `product_deployment.deployments`, `product_deployment.pipelines`, `product_deployment.environments` — read — in-tx: yes — 30d runs joined with pipeline+env names (release cards)
- `src/modules/deployment/releases.service.ts:164` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — canary.weight boundary events per run
- `src/modules/deployment/releases.service.ts:187` — withOrg — tables: `product_deployment.deployment_events` — read — in-tx: yes — status.live terminal events per run

#### secrets.service.ts
- `src/modules/deployment/secrets.service.ts:53` — withOrg — tables: `product_deployment.secrets` — read — in-tx: yes — list metadata only (no ciphertext), optional env filter
- `src/modules/deployment/secrets.service.ts:91` — withOrg — tables: `product_deployment.secrets` — read — in-tx: yes — aggregate stats (total / rotated_30d / expiring_soon via filter aggregates)
- `src/modules/deployment/secrets.service.ts:101` — withBypass — tables: `audit_events` (raw SQL, non-module table) — read — in-tx: yes — raw tx.execute: max(created_at) from audit_events for last_audited
- `src/modules/deployment/secrets.service.ts:135` — withOrg — tables: `product_deployment.secrets` — write — in-tx: yes — set: insert envelope-encrypted value; onConflictDoUpdate on (environment_id, key) with version+1 bump
- `src/modules/deployment/secrets.service.ts:178` — withOrg — tables: `product_deployment.secrets` — read — in-tx: yes — get secret identity for rotate
- `src/modules/deployment/secrets.service.ts:194` — withOrg — tables: `product_deployment.secrets` — write — in-tx: yes — rotate: update ciphertext + version+1 + rotated_at
- `src/modules/deployment/secrets.service.ts:213` — withOrg — tables: `product_deployment.secrets` — read — in-tx: yes — get secret identity for remove
- `src/modules/deployment/secrets.service.ts:223` — withOrg — tables: `product_deployment.secrets` — write — in-tx: yes — delete secret
- `src/modules/deployment/secrets.service.ts:244` — withOrg — tables: `product_deployment.secrets` — read — in-tx: yes — resolveForEnvironment: select key+ciphertext for env (decrypts in app code)
- `src/modules/deployment/secrets.service.ts:258` — withOrg — tables: `product_deployment.secrets` — write — in-tx: yes — resolveForEnvironment: bump last_used_at for env's secrets
- `src/modules/deployment/secrets.service.ts:281` — withBypass — tables: `product_deployment.secrets` — read — in-tx: yes — cross-org expiring/cadence-overdue scan (raw interval sql fragment)
- `src/modules/deployment/secrets.service.ts:336` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — assertEnvironment: env exists in org

#### settings.service.ts
- `src/modules/deployment/settings.service.ts:32` — withOrg — tables: `product_deployment.deployment_settings` — read — in-tx: yes — get org settings row (lazy defaults if absent)
- `src/modules/deployment/settings.service.ts:70` — withOrg — tables: `product_deployment.deployment_settings` — write — in-tx: yes — upsert org settings; onConflictDoUpdate on org_id

#### summary.service.ts
- `src/modules/deployment/summary.service.ts:33` — withOrg — tables: `product_deployment.pipelines` — read — in-tx: yes — count active (non-archived) pipelines
- `src/modules/deployment/summary.service.ts:39` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count deploys in last 7d
- `src/modules/deployment/summary.service.ts:45` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — total + rolled_back count for rollback rate
- `src/modules/deployment/summary.service.ts:54` — withOrg — tables: `product_deployment.deployments` — read — in-tx: yes — count failed runs in last 24h
- `src/modules/deployment/summary.service.ts:60` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — env names in maintenance
- `src/modules/deployment/summary.service.ts:66` — withOrg — tables: `product_deployment.environments` — read — in-tx: yes — count environments (quota KPI)

### Transaction boundaries

Every `withOrg`/`withBypass` callback runs inside one Postgres transaction. Nearly all are single-statement transactions. Multi-statement transactions (2, both nested savepoints via `tx.transaction(...)` — drizzle SAVEPOINT, same connection/transaction):

1. `src/modules/deployment/pipelines.service.ts:255` (withOrg → `tx.transaction` savepoint, addStage):
   - `select coalesce(max(position),0)::int + 1 from product_deployment.pipeline_stages where pipeline_id = $1`
   - `insert into product_deployment.pipeline_stages (...) returning ...`
   - Purpose: gapless position assignment — atomic so two concurrent addStage calls cannot collide on position.
2. `src/modules/deployment/pipelines.service.ts:367` (withOrg → `tx.transaction` savepoint, removeStage):
   - `delete from product_deployment.pipeline_stages where id = $1 and org_id = $2`
   - raw SQL `update product_deployment.pipeline_stages set position = position - 1 where pipeline_id = $1 and position > $2` (via `stx.execute`)
   - Purpose: close the position gap atomically.

Everything else: one statement per transaction. Notably there is NO multi-statement read-then-write guarded transaction for trigger/approve — e.g. the "one active run per stage" check (deployments.service.ts:204) and the insert (:256) are separate transactions (check-then-act race relies on application-level semantics, not DB locks).

### Raw SQL / special patterns

- **Full raw SQL statement:** `src/modules/deployment/secrets.service.ts:101` — `tx.execute(sql`select max(created_at)::text as last_at from audit_events where tenant_id = ${orgId} and action like 'deployment.secret%'`)` — reads the **audit domain's `audit_events` table** (outside the deployment schema) from a withBypass transaction; parameters are bound (no injection), action prefix is a constant.
- **Raw SQL via stx.execute:** `src/modules/deployment/pipelines.service.ts:370` — `update ${pipelineStages} set position = position - 1 where ...` — identifier-interpolated drizzle table + bound params (safe).
- **sql`` fragments** (safe, bound params): `count(*)::int` aggregates (several sites); `sql`${deployments.status} in ('pending','gated','rolling')`` status lists (deployments.service.ts:204,226; environments.service.ts:197; pipelines.service.ts:184,358,403); `sql`${pipelines.status} <> 'archived'`` (deployments.service.ts:738; summary.service.ts:33); `sql`(coalesce((rollout_state ->> 'lastTickAt')::timestamptz, updated_at)) < $1`` (deployments.service.ts:657); filter aggregates in secrets stats (secrets.service.ts:91) and summary (summary.service.ts:45); interval arithmetic `(${rotatedAt} + (${rotationIntervalDays} || ' days')::interval)` (secrets.service.ts:281).
- **onConflict upserts:** environments.service.ts:87/104 `onConflictDoNothing` on (org_id, name); pipelines.service.ts:97/108 `onConflictDoNothing` on (org_id, name); secrets.service.ts:135/150 `onConflictDoUpdate` on (environment_id, key) with `version = version + 1`; settings.service.ts:70/82 `onConflictDoUpdate` on org_id.
- **Row-level locks / advisory locks / SKIP LOCKED:** none in this module. Zero occurrences.
- **`db.root` / `db.root.transaction` / `db.withSerializable`:** zero call sites. `db.check()` used once (health).
- **RLS-sensitive (withBypass — RLS bypassed, needs the org predicate by hand):**
  - `deployments.service.ts:657` — cross-org stale-run scan; has NO org predicate (intentional: worker reconciles all orgs); reads deployments across tenants.
  - `secrets.service.ts:101` — bypass used for the audit-domain table; org scoping is by bound `tenant_id = ${orgId}` param.
  - `secrets.service.ts:281` — cross-org secret-expiry scan; no org predicate (intentional: worker).
  - `deployment.worker.ts:111` — cross-org `selectDistinct(orgId)`; no org predicate (intentional).
  - `deployment.worker.ts:123` — per-org `delete deployment_events where org_id = $1` inside bypass; **re-adds the org predicate explicitly** (correctly safe).
  - NB: the read-then-write flows (approve gate, trigger, pause/resume) span multiple withOrg transactions — each statement is tenant-scoped, but there is no cross-statement atomicity.

### Totals
- call sites: 76 (withOrg: 70, withBypass: 5, root: 0, root.transaction: 0, check: 1)
- ops: reads ~56, writes ~19, read+write 1 (pipelines.service.ts:255)
- files with DB access: deployment.module.ts, deployment.worker.ts, deployments.service.ts, environments.service.ts, pipelines.service.ts, releases.service.ts, secrets.service.ts, settings.service.ts, summary.service.ts (9 of 17 module files; controllers, workflow, gate-evaluator, rollout, plans, schema, module def otherwise have none)
- tables touched: product_deployment.pipelines, pipeline_stages, environments, deployments, deployment_events, secrets, deployment_settings, plus audit_events (raw SQL from secrets.stats)


## corporate — DB call-site inventory

Module: `src/modules/corporate/` (NestJS + Drizzle, read-only audit — no code modified).
All 10 files importing `DbService` verified genuine (each imports from `common/infra/db/db.service` and injects it). Zero call sites use `withOrg` / `withBypass` / `withSerializable` — **every corporate-module DB call runs on `db.root`, i.e. with NO tenant/RLS context** (company surfaces, not org surfaces; guarded app-side by `ContentStaffGuard` / L2 scopes / staff roles). One `root.transaction` boundary exists. No row-level locks, no advisory locks.

Schema → table names (from `public.schema.ts`, `email/schema.ts`):
`contact_submissions`, `newsletter_subs`, `career_jobs`, `career_applications`, `content_posts`, `content_revisions`, `corporate_content_staff`, `newsletter_campaigns`, `newsletter_campaign_sends`, `email_suppressions`, `email_deliveries`.

### Call sites

#### content.service.ts (16)
- `src/modules/corporate/content.service.ts:26` — root — tables: `content_posts` — read — in-tx: no — list(): all posts (or published-only), ordered, limit 500
- `src/modules/corporate/content.service.ts:41` — root — tables: `content_posts` — read — in-tx: no — upsert(): lookup by slug
- `src/modules/corporate/content.service.ts:45` — root — tables: `content_posts` — write — in-tx: no — upsert(): update post on slug hit (NOT atomic with snapshot at :310 or the :41 lookup)
- `src/modules/corporate/content.service.ts:73` — root — tables: `content_posts` — write — in-tx: no — upsert(): insert new post, `onConflictDoNothing(slug)`
- `src/modules/corporate/content.service.ts:109` — root — tables: `content_posts` — write — in-tx: no — publish(): set status=published, timestamps
- `src/modules/corporate/content.service.ts:135` — root — tables: `content_posts` — write — in-tx: no — schedule(): set publishAt
- `src/modules/corporate/content.service.ts:151` — root — tables: `content_posts` — write — in-tx: no — archive(): status=archived, clear publishAt
- `src/modules/corporate/content.service.ts:168` — root — tables: `content_posts` — write — in-tx: no — unpublish(): status=draft, clear publishAt
- `src/modules/corporate/content.service.ts:186` — root — tables: `content_revisions` — read — in-tx: no — revisions(): list versions desc, limit 100
- `src/modules/corporate/content.service.ts:197` — root — tables: `content_revisions` — read — in-tx: no — restore(): fetch one revision by postId+version
- `src/modules/corporate/content.service.ts:207` — root — tables: `content_posts` — write — in-tx: no — restore(): overwrite current fields from revision, RETURNING
- `src/modules/corporate/content.service.ts:226` — root — tables: `content_posts` — write — in-tx: no — publishDue(): worker pass, mass-update due drafts → published; set clause uses raw `sql\`coalesce(...)\``
- `src/modules/corporate/content.service.ts:252` — root — tables: `content_posts` — read — in-tx: no — publishedBySlug(): slug + status=published lookup
- `src/modules/corporate/content.service.ts:261` — root — tables: `content_posts` — read — in-tx: no — publishedList(): published posts desc, limit ≤100
- `src/modules/corporate/content.service.ts:272` — root — tables: `content_posts` — read — in-tx: no — preview(): staff draft preview by slug
- `src/modules/corporate/content.service.ts:294` — root — tables: `content_posts` — read — in-tx: no — require(): internal fetch-or-404 by slug
- `src/modules/corporate/content.service.ts:302` — root — tables: `content_revisions` — read — in-tx: no — nextVersion(): raw `sql\`coalesce(max(version),0)::int\`` aggregate (RACE: non-atomic next-version; overlapping saves could collide, mitigated by onConflictDoNothing at :310)
- `src/modules/corporate/content.service.ts:310` — root — tables: `content_revisions` — write — in-tx: no — snapshotRevision(): insert immutable revision, `onConflictDoNothing(postId,version)`

#### careers.service.ts (14)
- `src/modules/corporate/careers.service.ts:42` — root — tables: `career_jobs` — read — in-tx: no — publishedJobs(): published jobs desc, limit 200
- `src/modules/corporate/careers.service.ts:52` — root — tables: `career_jobs` — read — in-tx: no — publishedJobBySlug(): slug + published lookup
- `src/modules/corporate/careers.service.ts:66` — root — tables: `career_jobs` — read — in-tx: no — listJobs(): staff list all jobs
- `src/modules/corporate/careers.service.ts:84` — root — tables: `career_jobs` — read — in-tx: no — upsertJob(): lookup by slug
- `src/modules/corporate/careers.service.ts:86` — root — tables: `career_jobs` — write — in-tx: no — upsertJob(): update on slug hit, RETURNING
- `src/modules/corporate/careers.service.ts:109` — root — tables: `career_jobs` — write — in-tx: no — upsertJob(): insert, `onConflictDoNothing(slug)`
- `src/modules/corporate/careers.service.ts:140` — root — tables: `career_jobs` — read — in-tx: no — setJobStatus(): fetch for status change
- `src/modules/corporate/careers.service.ts:144` — root — tables: `career_jobs` — write — in-tx: no — setJobStatus(): update status/publishedAt
- `src/modules/corporate/careers.service.ts:178` — root — tables: `career_jobs` — read — in-tx: no — submitApplication(): validate jobSlug is a published job
- `src/modules/corporate/careers.service.ts:194` — root — tables: `career_applications` — write — in-tx: no — submitApplication(): insert application row
- `src/modules/corporate/careers.service.ts:229` — root — tables: `career_applications`, `career_jobs` — read — in-tx: no — listApplications(): RAW SQL select with join + filters + pagination (parameterized)
- `src/modules/corporate/careers.service.ts:239` — root — tables: `career_applications`, `career_jobs` — read — in-tx: no — listApplications(): RAW SQL count for pagination
- `src/modules/corporate/careers.service.ts:253` — root — tables: `career_applications` — read — in-tx: no — applicationById(): single-row staff lookup
- `src/modules/corporate/careers.service.ts:259` — root — tables: `career_applications` — read — in-tx: no — transitionApplication(): fetch for transition validation
- `src/modules/corporate/careers.service.ts:270` — root — tables: `career_applications` — write — in-tx: no — transitionApplication(): update status/notes (validated against transition table)

#### contact-inbox.service.ts (5)
- `src/modules/corporate/contact-inbox.service.ts:54` — root — tables: `contact_submissions` — write — in-tx: no — intake(): insert public contact submission
- `src/modules/corporate/contact-inbox.service.ts:105` — root — tables: `contact_submissions` — read — in-tx: no — list(): RAW SQL select with status/search filters + pagination (parameterized, `ilike` search on email/name/company)
- `src/modules/corporate/contact-inbox.service.ts:113` — root — tables: `contact_submissions` — read — in-tx: no — list(): RAW SQL count for pagination
- `src/modules/corporate/contact-inbox.service.ts:122` — root — tables: `contact_submissions` — read — in-tx: no — transition(): fetch for transition validation
- `src/modules/corporate/contact-inbox.service.ts:133` — root — tables: `contact_submissions` — write — in-tx: no — transition(): update status/notes/repliedAt

#### newsletter.service.ts (33)
- `src/modules/corporate/newsletter.service.ts:45` — root — tables: `newsletter_subs` — read — in-tx: no — subscribe(): lookup by email
- `src/modules/corporate/newsletter.service.ts:52` — root — tables: `newsletter_subs` — write — in-tx: no — subscribe(): re-pending existing row with fresh token hashes
- `src/modules/corporate/newsletter.service.ts:63` — root — tables: `newsletter_subs` — write — in-tx: no — subscribe(): insert pending subscriber, `onConflictDoNothing(email)`
- `src/modules/corporate/newsletter.service.ts:70` — root — tables: `newsletter_subs` — write — in-tx: no — subscribe(): lost-insert-race path — refresh confirm token hash (RACE-PRONE but intentional)
- `src/modules/corporate/newsletter.service.ts:93` — root — tables: `newsletter_subs` — read — in-tx: no — confirm(): lookup by sha256(token) + pending
- `src/modules/corporate/newsletter.service.ts:101` — root — tables: `newsletter_subs` — write — in-tx: no — confirm(): flip to confirmed, clear confirm token hash
- `src/modules/corporate/newsletter.service.ts:120` — root — tables: `newsletter_subs` — read — in-tx: no — unsubscribeByToken(): lookup by sha256(token)
- `src/modules/corporate/newsletter.service.ts:137` — root — tables: `newsletter_campaign_sends` — read — in-tx: no — unsubscribeBySendToken(): lookup by raw per-send token
- `src/modules/corporate/newsletter.service.ts:150` — root — tables: `newsletter_subs` — write — in-tx: no — markUnsubscribed(): set status=unsubscribed
- `src/modules/corporate/newsletter.service.ts:156` — root — tables: `email_suppressions` — write — in-tx: no — markUnsubscribed(): insert suppression, `onConflictDoNothing(email)` (NOT atomic with :150)
- `src/modules/corporate/newsletter.service.ts:175` — root — tables: `newsletter_subs` — read — in-tx: no — listSubscribers(): RAW SQL select with filters + pagination (parameterized)
- `src/modules/corporate/newsletter.service.ts:183` — root — tables: `newsletter_subs` — read — in-tx: no — listSubscribers(): RAW SQL count
- `src/modules/corporate/newsletter.service.ts:192` — root — tables: `newsletter_subs` — read — in-tx: no — exportCsv(): full export (limit 50k) of email/status/confirmedAt
- `src/modules/corporate/newsletter.service.ts:206` — root — tables: `newsletter_subs` — read — in-tx: no — subscriberData(): GDPR export lookup by email
- `src/modules/corporate/newsletter.service.ts:222` — root — tables: `newsletter_subs` — write — in-tx: no — deleteSubscriber(): GDPR erasure (DELETE + RETURNING id)
- `src/modules/corporate/newsletter.service.ts:245` — root — tables: `newsletter_campaigns` — write — in-tx: no — createCampaign(): insert draft campaign
- `src/modules/corporate/newsletter.service.ts:265` — root — tables: `newsletter_campaigns` — write — in-tx: no — updateCampaign(): update draft campaign, RETURNING
- `src/modules/corporate/newsletter.service.ts:293` — root — tables: `newsletter_subs`, `email_suppressions` — read — in-tx: no — scheduleCampaign(): RAW SQL recipient snapshot (confirmed + not suppressed) — read BEFORE the :302 transaction, not inside it
- `src/modules/corporate/newsletter.service.ts:302` — root.transaction — tables: `newsletter_campaigns`, `newsletter_campaign_sends` — write — in-tx: yes — scheduleCampaign(): THE transaction boundary (see below)
- `src/modules/corporate/newsletter.service.ts:330` — root — tables: `newsletter_campaigns` — write — in-tx: no — cancelCampaign(): flip to cancelled
- `src/modules/corporate/newsletter.service.ts:345` — root — tables: `newsletter_campaigns` — read — in-tx: no — listCampaigns(): staff list, limit 200
- `src/modules/corporate/newsletter.service.ts:350` — root — tables: `newsletter_campaign_sends` — read — in-tx: no — campaignDetail(): RAW SQL group-by status counts
- `src/modules/corporate/newsletter.service.ts:362` — root — tables: `newsletter_campaigns` — write — in-tx: no — processCampaigns(): RAW SQL mass-update scheduled→sending where due
- `src/modules/corporate/newsletter.service.ts:366` — root — tables: `newsletter_campaigns` — read — in-tx: no — processCampaigns(): fetch in-flight campaign ids
- `src/modules/corporate/newsletter.service.ts:379` — root — tables: `newsletter_campaigns` — read — in-tx: no — sendBatch(): fetch campaign row, bail if not `sending`
- `src/modules/corporate/newsletter.service.ts:384` — root — tables: `newsletter_campaign_sends` — read — in-tx: no — sendBatch(): claim next batch of `queued` sends (limit 50; NO row lock — a concurrent worker could double-claim; the bullmq worker runs concurrency:1)
- `src/modules/corporate/newsletter.service.ts:406` — root — tables: `newsletter_campaign_sends` — write — in-tx: no — sendBatch(): mark send `sent` (per-email, NOT atomic with the actual SMTP send or :410)
- `src/modules/corporate/newsletter.service.ts:410` — root — tables: `newsletter_campaigns` — write — in-tx: no — sendBatch(): increment sentCount via raw `sql\`sent_count + 1\`` (counter races are add-safe)
- `src/modules/corporate/newsletter.service.ts:417` — root — tables: `newsletter_campaign_sends` — write — in-tx: no — sendBatch(): mark send failed / skipped_suppressed
- `src/modules/corporate/newsletter.service.ts:422` — root — tables: `newsletter_campaigns` — write — in-tx: no — sendBatch(): increment failedCount via raw sql (only on real failures)
- `src/modules/corporate/newsletter.service.ts:431` — root — tables: `newsletter_campaign_sends` — read — in-tx: no — sendBatch(): remaining queued count via raw `sql\`count(*)\``
- `src/modules/corporate/newsletter.service.ts:437` — root — tables: `newsletter_campaigns` — write — in-tx: no — sendBatch(): completion flip to `sent` when queue drains
- `src/modules/corporate/newsletter.service.ts:453` — root — tables: `newsletter_campaigns` — read — in-tx: no — requireCampaign(): fetch-or-404

#### suppression.service.ts (5)
- `src/modules/corporate/suppression.service.ts:39` — root — tables: `email_suppressions` — read — in-tx: no — isSuppressed(): id lookup by email, limit 1
- `src/modules/corporate/suppression.service.ts:49` — root — tables: `email_suppressions` — write — in-tx: no — suppress(): insert, `onConflictDoNothing(email)`
- `src/modules/corporate/suppression.service.ts:56` — root — tables: `newsletter_subs` — write — in-tx: no — suppress(): RAW SQL update flipping subscriber to unsubscribed (NOT atomic with :49)
- `src/modules/corporate/suppression.service.ts:70` — root — tables: `email_suppressions` — read — in-tx: no — list(): staff list, desc, limit ≤1000
- `src/modules/corporate/suppression.service.ts:74` — root — tables: `email_suppressions` — write — in-tx: no — resolve(): set resolvedAt, RETURNING id

#### email/email.service.ts (2)
- `src/modules/corporate/email/email.service.ts:109` — root — tables: `email_suppressions` — read — in-tx: no — isSuppressed(): RAW SQL id lookup by email (with in-process 60s-ish cache in front)
- `src/modules/corporate/email/email.service.ts:131` — root — tables: `email_deliveries` — write — in-tx: no — recordDelivery(): insert delivery-audit row (sent/failed/skipped); insert errors are swallowed/logged by caller, never fatal

#### feeds.service.ts (2)
- `src/modules/corporate/feeds.service.ts:23` — root — tables: `content_posts` — read — in-tx: no — recentPosts(): 25 most recent published posts (RSS/Atom/JSON feeds)
- `src/modules/corporate/feeds.service.ts:124` — root — tables: `content_posts` — read — in-tx: no — sitemap(): published post slugs + updatedAt, limit 1000

#### content.controller.ts (3)
- `src/modules/corporate/content.controller.ts:184` — root — tables: `corporate_content_staff` — read — in-tx: no — listStaff(): full grant list (platform operators)
- `src/modules/corporate/content.controller.ts:195` — root — tables: `corporate_content_staff` — write — in-tx: no — grant(): insert staff grant, `onConflictDoNothing(accountId)`
- `src/modules/corporate/content.controller.ts:217` — root — tables: `corporate_content_staff` — write — in-tx: no — revoke(): delete grant by accountId

#### content-staff.guard.ts (1)
- `src/modules/corporate/content-staff.guard.ts:25` — root — tables: `corporate_content_staff` — read — in-tx: no — canActivate(): per-request grant check for L1 principals (runs on EVERY guarded route)

#### corporate.module.ts (1)
- `src/modules/corporate/corporate.module.ts:52` — check — tables: none — n/a — in-tx: no — health check registration `() => db.check()` (no SQL table)

Files with NO DbService call sites: `careers.service.ts` n/a (has), `corporate.worker.ts` (delegates to services), `dto.ts`, `inbox.controller.ts` (delegates to services), `public.controller.ts` (delegates to services), `email/templates.ts`, `email/transports.ts`, `email/email-transport.port.ts`, `email/schema.ts`, `public.schema.ts`.

### Transaction boundaries

Only ONE explicit transaction in the whole module:

**TX-1 — `newsletter.service.ts:302` (`this.db.root.transaction`) in `scheduleCampaign()`**
- `tx.update(newsletterCampaigns)` — set status=`scheduled`, scheduledAt, recipientCount, updatedAt
- loop over recipient rows: `tx.insert(newsletterCampaignSends).values({...}).onConflictDoNothing()` — one queued send row per recipient with a per-send unsubscribe token (bare `onConflictDoNothing()` with NO target — relies on unique(campaign_id, subscriber_id))
- ⚠️ The recipient snapshot itself (RAW SQL at :293) is read BEFORE the transaction, not inside it — a subscriber confirming mid-schedule is missed (or unsubscribing mid-schedule still gets queued; the worker's per-send suppression path at send time and :417 `skipped_suppressed` catch it)

Everything else is tx-less: each method does a sequence of independent `db.root` statements, so read-then-write pairs are NOT atomic. Notable non-atomic multi-statement flows:
- `upsert()` content: lookup (:41) → update/insert (:45/:73) → revision snapshot (:310) — version computed via non-atomic max+1 (:302 content.service)
- `restore()`: fetch revision (:197) → nextVersion (:302) → update (:207) → snapshot (:310)
- `subscribe()`: lookup (:45) → update/insert (:52/:63) with a deliberate lost-race recovery (:70)
- `markUnsubscribed()`: update newsletter_subs (:150) → insert email_suppressions (:156)
- `sendBatch()`: actual SMTP send happens BETWEEN the fetch (:384) and the status writes (:406/:410) — a worker crash between send and mark-sent causes a double-send on retry (send rows are per-batch unique; no idempotency guard on the provider side)
- `suppress()`: insert suppression (:49) → raw update newsletter_subs (:56)
- All `audit.add(...)` calls: separate module (AuditService, `src/common/audit/audit.service.ts`) — its writes are OUTSIDE every transaction and fire after the fact

### Raw SQL / special patterns

- **RAW `.execute(sql\`...\`)` — 10 sites** (all parameterized via drizzle `sql` template, no string concatenation):
  - `careers.service.ts:229` — paginated applications list with `career_jobs` join (status + slug filters)
  - `careers.service.ts:239` — applications count for pagination
  - `contact-inbox.service.ts:105` — submissions list, `ilike` search over email/name/company; user `q` has `%`/`_` stripped before interpolation
  - `contact-inbox.service.ts:113` — submissions count
  - `newsletter.service.ts:175` — subscribers list (status filter + email like)
  - `newsletter.service.ts:183` — subscribers count
  - `newsletter.service.ts:293` — campaign recipient snapshot: `newsletter_subs` anti-join `email_suppressions` (unresolved only)
  - `newsletter.service.ts:350` — per-status send counts (group by)
  - `newsletter.service.ts:362` — mass-update scheduled→sending where due (`scheduled_at <= now()`)
  - `email.service.ts:109` — suppression id lookup
  - `suppression.service.ts:56` — `update newsletter_subs ... where email=... and status <> 'unsubscribed'`
- **Raw `sql` fragments inside the query builder (parameterized):**
  - `content.service.ts:226` — `sql\`coalesce(published_at, now())\`` in publishDue set clause
  - `content.service.ts:302` — `sql\`coalesce(max(version),0)::int\`` aggregate
  - `newsletter.service.ts:410`, `:422` — `sql\`${sentCount} + 1\`` / `sql\`${failedCount} + 1\`` counter increments
  - `newsletter.service.ts:431` — `sql\`count(*)\::int\`` in select
- **`onConflict` upserts — 8 sites:** content :73 (slug), content :310 (postId+version), careers :109 (slug), newsletter :63 (email), newsletter :156 (email), newsletter :302-tx (bare, no target), suppression :49 (email), content.controller :195 (accountId)
- **Row-level locks:** none (no `forUpdate`/`forShare` anywhere)
- **Advisory locks:** none
- **RLS-sensitive:** the module is RLS-blind by design — 100% of access is via `db.root` with no tenant context; isolation is enforced app-side (`ContentStaffGuard` grant check per request, L2 `*` scopes + super_admin role checks, staff-role gates on controllers). All tables here are company/public surfaces with no `organization_id`.

### Totals

- call sites: 82 (withOrg: 0, withBypass: 0, root: 80, root.transaction: 1, check: 1)
- transaction boundaries: 1 (`newsletter.service.ts:302`)
- raw-SQL `.execute`: 10 sites (plus 5 builder-embedded raw fragments)
- onConflict upserts: 8


## organizations — DB call-site inventory

Read-only audit of `src/modules/organizations/` (NestJS + Drizzle). All `.root` hits verified as `DbService` (every file imports `DbService` from `../../common/infra/db/db.service`). Controllers (`org.controller.ts`, `org-*.controller.ts`), `org-purge.worker.ts`, and `organizations.module.ts` (except the health check) issue **zero** direct DB calls — all DB access goes through the services below. No `*.spec.ts`/`*.test.ts` files exist in the module.

Table-name map (from `schema.ts`): `orgMemberships`→`org_memberships`, `orgInvites`→`org_invites`, `projects`→`projects`, `productEntitlements`→`product_entitlements`, `orgSettings`→`org_settings`, `orgGroups`→`org_groups`, `orgGroupMembers`→`org_group_members`, `orgServiceAccounts`→`org_service_accounts`, `orgDeletions`→`org_deletions`. Cross-module/legacy: `legacyTenants`→`tenants` (Python-owned DDL), `legacyApiKeys`→`api_keys` (Python-owned, no RLS), `accounts`→`accounts` (identity module), `audit_events` (shared Tier-0 hash chain, Python-owned DDL, no RLS).

Note on `in-tx`: per `DbService`, **every** `withOrg`/`withBypass` call wraps its callback in a Postgres transaction with transaction-local GUCs; `root.transaction` is an explicit transaction. `db.root` direct statements are **not** in a transaction.

### Call sites

#### entitlements.service.ts
- `src/modules/organizations/entitlements.service.ts:83` — withOrg — tables: `product_entitlements` — read — in-tx: yes — reads entitlement status for (org, product) in `getState`
- `src/modules/organizations/entitlements.service.ts:94` — withOrg — tables: `product_entitlements` — read — in-tx: yes — lists all entitlement rows for org in `listForOrg`
- `src/modules/organizations/entitlements.service.ts:99` — withOrg — tables: `product_entitlements` — read — in-tx: yes — reads single entitlement row for (org, product) in `getFor`
- `src/modules/organizations/entitlements.service.ts:182` — withOrg — tables: `product_entitlements` — write — in-tx: yes — upserts entitlement row (`onConflictDoUpdate` on `(org_id, product)`) in `transition`

#### invites.service.ts
- `src/modules/organizations/invites.service.ts:70` — withOrg — tables: `org_memberships` (+ `accounts` via raw subquery `select id from accounts where email = ...`) — read — in-tx: yes — checks whether invited email already holds a membership (guard in `create`)
- `src/modules/organizations/invites.service.ts:93` — withOrg — tables: `org_invites` — read — in-tx: yes — counts pending invites against cap (guard in `create`)
- `src/modules/organizations/invites.service.ts:117` — withOrg — tables: `org_invites` — read — in-tx: yes — lists invites (limit 500) in `list`
- `src/modules/organizations/invites.service.ts:127` — withOrg — tables: `org_invites` — read — in-tx: yes — reads single invite by id in `detail`
- `src/modules/organizations/invites.service.ts:138` — withOrg — tables: `org_invites` — read — in-tx: yes — loads invite for revocation checks in `revoke`
- `src/modules/organizations/invites.service.ts:149` — withOrg — tables: `org_invites` — write — in-tx: yes — marks invite revoked (sets `revoked_at`) in `revoke`
- `src/modules/organizations/invites.service.ts:171` — withOrg — tables: `org_invites` — read — in-tx: yes — loads invite for resend checks in `resend`
- `src/modules/organizations/invites.service.ts:190` — withOrg — tables: `org_invites` — write — in-tx: yes — rotates token hash, resets attempts, bumps `resend_count`, guarded by `where id = ? and token_hash = ?` (concurrency race becomes a visible conflict) in `resend`
- `src/modules/organizations/invites.service.ts:219` — withOrg — tables: `org_invites` — read — in-tx: yes — loads invite for extend checks in `extend`
- `src/modules/organizations/invites.service.ts:233` — withOrg — tables: `org_invites` — write — in-tx: yes — pushes invite expiry in `extend`
- `src/modules/organizations/invites.service.ts:254` — withBypass — tables: `org_invites` — read — in-tx: yes — loads invite by id+hash pre-membership in `redeem` (justified: caller is not a member yet; filtered by unguessable id)
- `src/modules/organizations/invites.service.ts:300` — withOrg — tables: `org_invites` — write — in-tx: yes — single-use claim (`accepted_at` set, conditional on still-null `accepted_at`/`revoked_at`) in `redeem`
- `src/modules/organizations/invites.service.ts:336` — withBypass — tables: `org_invites` — read — in-tx: yes — public preview read in `preview` (justified: pre-membership; filtered by id + hash)
- `src/modules/organizations/invites.service.ts:372` — withOrg — tables: `org_invites` — write — in-tx: yes — inserts new invite row in private `insert`
- `src/modules/organizations/invites.service.ts:408` — withOrg — tables: `org_invites` — read — in-tx: yes — finds usable invite for (org, email) in private `pendingFor`
- `src/modules/organizations/invites.service.ts:419` — root — tables: `org_invites` — write — in-tx: no — increments `attempts` counter in private `registerAttempt` (**RLS-sensitive**: `org_invites` is RLS-FORCED and `db.root` sets no tenant context — per the file's own comment at line 296, an unscoped statement on this table matches 0 rows, so failed-redeem attempt counting may be silently ineffective)

#### memberships.service.ts
- `src/modules/organizations/memberships.service.ts:99` — withOrg — tables: `org_memberships`, `accounts` (inner join) — read — in-tx: yes — enriched member inventory page in `listMembers`
- `src/modules/organizations/memberships.service.ts:123` — withOrg — tables: `org_memberships`, `accounts` — read — in-tx: yes — total member count for the inventory in `listMembers`
- `src/modules/organizations/memberships.service.ts:131` — withOrg — tables: `org_group_members`, `org_groups` — read — in-tx: yes — group memberships per member in `listMembers`
- `src/modules/organizations/memberships.service.ts:190` — withOrg — tables: `org_memberships` — read — in-tx: yes — members by status in `summary`
- `src/modules/organizations/memberships.service.ts:197` — withOrg — tables: `org_invites` — read — in-tx: yes — pending-invite count in `summary`
- `src/modules/organizations/memberships.service.ts:210` — withOrg — tables: `org_service_accounts` — read — in-tx: yes — service accounts by status in `summary`
- `src/modules/organizations/memberships.service.ts:214` — withOrg — tables: `org_groups` — read — in-tx: yes — group count in `summary`
- `src/modules/organizations/memberships.service.ts:215` — withOrg — tables: `product_entitlements` — read — in-tx: yes — seat-bearing entitlements for utilization in `summary`
- `src/modules/organizations/memberships.service.ts:240` — withBypass — tables: `org_memberships` — read — in-tx: yes — cross-org membership lookup for login org picker in `listForAccount` (justified: memberships span orgs; filtered by `account_id`)
- `src/modules/organizations/memberships.service.ts:248` — withOrg — tables: `product_entitlements`, `org_memberships` — read+write — in-tx: yes — `addMember`: locks seat-bearing entitlement rows `FOR UPDATE`, checks current membership + active count, asserts capacity, then upserts membership (`onConflictDoUpdate` on `(account_id, org_id)`), all in one TX
- `src/modules/organizations/memberships.service.ts:334` — withOrg — tables: `org_memberships` — read — in-tx: yes — checks exactly-one-active-owner before demoting in `changeRole`
- `src/modules/organizations/memberships.service.ts:342` — withOrg — tables: `org_memberships` — write — in-tx: yes — updates member role in `changeRole` (partial unique index `uq_one_active_owner_per_org` is the concurrency backstop; 23505 translated to 409)
- `src/modules/organizations/memberships.service.ts:386` — withOrg — tables: `org_memberships` — write — in-tx: yes — suspends member (sets status/suspended_at/suspended_by) in `suspendMember`
- `src/modules/organizations/memberships.service.ts:414` — withOrg — tables: `org_memberships` — write — in-tx: yes — reactivates suspended member in `reactivateMember`
- `src/modules/organizations/memberships.service.ts:448` — withOrg — tables: `org_memberships`, `org_group_members` — write — in-tx: yes — `removeMember`: marks membership `removed` + deletes group memberships in one TX
- `src/modules/organizations/memberships.service.ts:478` — withOrg — tables: `org_memberships`, `org_group_members` — write — in-tx: yes — `leaveOrg`: marks membership `removed` + deletes group memberships in one TX
- `src/modules/organizations/memberships.service.ts:497` — withOrg — tables: `org_memberships` — read — in-tx: yes — loads single membership in `getMember`
- `src/modules/organizations/memberships.service.ts:513` — withBypass — tables: `org_memberships` — read — in-tx: yes — guard-path role lookup in `getRole` (also fires the throttled `last_active_at` heartbeat)
- `src/modules/organizations/memberships.service.ts:535` — withOrg — tables: `org_memberships` — write — in-tx: yes — throttled `last_active_at` heartbeat in `touchLastActive` (fire-and-forget, errors swallowed)
- `src/modules/organizations/memberships.service.ts:550` — withOrg — tables: `org_memberships` — read — in-tx: yes — counts active owners in `assertAnotherOwnerRemains`

#### org-access.service.ts
- `src/modules/organizations/org-access.service.ts:147` — root.transaction — tables: `tenants`, `org_memberships`, `org_settings` — write — in-tx: yes — `insertOrgWithOwner`: sets `app.current_tenant` transaction-locally via raw `set_config` SQL (+ statement/idle timeouts), inserts Python-owned `tenants` row, owner membership, and (team only) eager `org_settings` row — one atomic TX
- `src/modules/organizations/org-access.service.ts:182` — withBypass — tables: `org_memberships` — read — in-tx: yes — counts active owner memberships for abuse cap in `assertOwnershipCapacity` (justified: spans orgs; filtered by `account_id`)
- `src/modules/organizations/org-access.service.ts:206` — withBypass — tables: `tenants` — read — in-tx: yes — reads tenant names for the caller's orgs in `listContexts` (justified: cross-org, ids come from the filtered membership query)

#### org-info.ts
- `src/modules/organizations/org-info.ts:20` — root — tables: `tenants` — read — in-tx: no — raw-SQL read of the Python-owned tenant row (`id, name, slug, created_at, features->>'deleted'`) in `getOrgBrief`; also used by `getOrgName` (no RLS on `tenants`)

#### org-audit.service.ts
- `src/modules/organizations/org-audit.service.ts:81` — root — tables: `audit_events` — read — in-tx: no — raw-SQL paginated audit query in `query` (explicit `tenant_id` filter; `audit_events` has no RLS)
- `src/modules/organizations/org-audit.service.ts:88` — root — tables: `audit_events` — read — in-tx: no — raw-SQL count in `query`
- `src/modules/organizations/org-audit.service.ts:101` — root — tables: `audit_events` — read — in-tx: no — raw-SQL bounded SIEM export in `export`
- `src/modules/organizations/org-audit.service.ts:134` — root — tables: `audit_events` — read — in-tx: no — raw-SQL distinct actions by frequency in `filterFacets`
- `src/modules/organizations/org-audit.service.ts:137` — root — tables: `audit_events` — read — in-tx: no — raw-SQL distinct resource types in `filterFacets`

#### org-groups.service.ts
- `src/modules/organizations/org-groups.service.ts:43` — withOrg — tables: `org_groups`, `org_group_members` (left join) — read — in-tx: yes — lists groups with member counts in `list`
- `src/modules/organizations/org-groups.service.ts:63` — withOrg — tables: `org_groups` — read — in-tx: yes — reads single group in `get`
- `src/modules/organizations/org-groups.service.ts:69` — withOrg — tables: `org_group_members` — read — in-tx: yes — counts group members in `get`
- `src/modules/organizations/org-groups.service.ts:80` — withOrg — tables: `org_groups` — write — in-tx: yes — inserts group (`onConflictDoNothing` on `(org_id, name)`) in `create`
- `src/modules/organizations/org-groups.service.ts:117` — withOrg — tables: `org_groups` — write — in-tx: yes — renames/re-describes group in `update` (23505 on `(org_id, name)` translated to 409)
- `src/modules/organizations/org-groups.service.ts:149` — withOrg — tables: `org_group_members`, `org_groups` — write — in-tx: yes — `remove`: deletes group members then the group in one TX
- `src/modules/organizations/org-groups.service.ts:165` — withOrg — tables: `org_group_members`, `accounts`, `org_memberships` — read — in-tx: yes — lists group members with identity + role in `listMembers`
- `src/modules/organizations/org-groups.service.ts:187` — withOrg — tables: `org_group_members` — write — in-tx: yes — inserts group member (`onConflictDoNothing` on `(group_id, account_id)`) in `addMember`
- `src/modules/organizations/org-groups.service.ts:210` — withOrg — tables: `org_group_members` — write — in-tx: yes — deletes group member in `removeMember`

#### org-lifecycle.service.ts
- `src/modules/organizations/org-lifecycle.service.ts:79` — withOrg — tables: `org_deletions` — write — in-tx: yes — inserts/updates deletion request (`onConflictDoUpdate` on `org_id`) in `requestDeletion`
- `src/modules/organizations/org-lifecycle.service.ts:99` — withOrg — tables: `org_invites` — write — in-tx: yes — revokes all pending invites org-wide in `requestDeletion`
- `src/modules/organizations/org-lifecycle.service.ts:104` — root — tables: `api_keys` — write — in-tx: no — revokes org API keys in `requestDeletion` (`api_keys` is Python-owned, no RLS; explicit `tenant_id` filter — documented dual-write seam)
- `src/modules/organizations/org-lifecycle.service.ts:110` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — voids all service-account tokens org-wide (nulls `token_hash`/`token_prefix`/`token_expires_at`) in `requestDeletion`
- `src/modules/organizations/org-lifecycle.service.ts:140` — withOrg — tables: `org_deletions` — write — in-tx: yes — marks deletion cancelled in `cancelDeletion`
- `src/modules/organizations/org-lifecycle.service.ts:174` — withOrg — tables: `org_memberships` — read — in-tx: yes — exports memberships in `exportOrgData`
- `src/modules/organizations/org-lifecycle.service.ts:175` — withOrg — tables: `org_invites` — read — in-tx: yes — exports invites in `exportOrgData`
- `src/modules/organizations/org-lifecycle.service.ts:176` — withOrg — tables: `projects` — read — in-tx: yes — exports projects in `exportOrgData`
- `src/modules/organizations/org-lifecycle.service.ts:180` — root — tables: `audit_events` — read — in-tx: no — raw-SQL read of trailing audit window (limit 1000, explicit `tenant_id` filter) in `exportOrgData`
- `src/modules/organizations/org-lifecycle.service.ts:213` — withBypass — tables: `org_deletions` — read — in-tx: yes — cross-org scan for due purges in `purgeDue` (justified: explicitly administrative, cross-tenant)
- `src/modules/organizations/org-lifecycle.service.ts:245` — withOrg — tables: `studio_project_keys`, `product_deployment.deployment_events`, `product_deployment.deployments`, `product_deployment.pipeline_stages`, `product_deployment.pipelines`, `product_deployment.secrets`, `product_deployment.environments`, `published_configs`, `webhook_deliveries`, `webhooks`, `notifications`, `org_group_members`, `org_groups`, `org_service_accounts`, `org_settings`, `projects`, `org_invites`, `org_memberships`, `product_entitlements` — write — in-tx: yes — `purge`: 15 raw-SQL deletes (first group) + 4 drizzle deletes (second group), one atomic TX (audit rows deliberately retained)
- `src/modules/organizations/org-lifecycle.service.ts:269` — root — tables: `tenants` — write — in-tx: no — marks the Python-owned tenant row deleted via `jsonb_set(features, '{deleted}', 'true')` in `purge` (documented dual-write seam)
- `src/modules/organizations/org-lifecycle.service.ts:274` — withOrg — tables: `org_deletions` — write — in-tx: yes — marks deletion `purged` in `purge`
- `src/modules/organizations/org-lifecycle.service.ts:303` — withOrg — tables: `org_memberships` — read+write — in-tx: yes — `transferOwnership`: demote current owner → promote target → verify exactly-one-active-owner, one TX (the partial unique index is the per-statement backstop)
- `src/modules/organizations/org-lifecycle.service.ts:383` — withOrg — tables: `org_deletions` — read — in-tx: yes — reads deletion row in private `deletionRow`

#### org-service-accounts.service.ts
- `src/modules/organizations/org-service-accounts.service.ts:54` — withOrg — tables: `org_service_accounts` — read — in-tx: yes — lists service accounts in `list`
- `src/modules/organizations/org-service-accounts.service.ts:61` — withOrg — tables: `org_service_accounts` — read — in-tx: yes — reads single service account in `get`
- `src/modules/organizations/org-service-accounts.service.ts:78` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — inserts service account with token hash in `create`
- `src/modules/organizations/org-service-accounts.service.ts:111` — withOrg — tables: `org_service_accounts` — read — in-tx: yes — loads service account for rotation in `rotateToken`
- `src/modules/organizations/org-service-accounts.service.ts:123` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — swaps token hash, guarded by `where id = ? and token_hash = ?` (concurrent rotate loses visibly) in `rotateToken`
- `src/modules/organizations/org-service-accounts.service.ts:159` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — revokes token (nulls hash/prefix/expiry) in `revokeToken`
- `src/modules/organizations/org-service-accounts.service.ts:178` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — disables service account and voids token in `disable`
- `src/modules/organizations/org-service-accounts.service.ts:198` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — re-enables service account in `enable`
- `src/modules/organizations/org-service-accounts.service.ts:217` — withOrg — tables: `org_service_accounts` — write — in-tx: yes — deletes service account in `remove`
- `src/modules/organizations/org-service-accounts.service.ts:244` — withBypass — tables: `org_service_accounts` — read — in-tx: yes — AuthGuard lookup by token hash in `validateByHash` (justified: authentication precedes org context; filtered by globally-unique unguessable hash)
- `src/modules/organizations/org-service-accounts.service.ts:259` — withBypass — tables: `org_service_accounts` — write — in-tx: yes — fire-and-forget `token_last_used_at` telemetry in `validateByHash` (errors swallowed)

#### org-settings.service.ts
- `src/modules/organizations/org-settings.service.ts:83` — root — tables: `tenants` — read — in-tx: no — raw-SQL read of `region, retention_days` for the profile in `profile` (`tenants` has no RLS)
- `src/modules/organizations/org-settings.service.ts:141` — root — tables: `tenants` — write — in-tx: no — renames org via the dual-write seam in `update`
- `src/modules/organizations/org-settings.service.ts:150` — root — tables: `tenants` — read — in-tx: no — raw-SQL read of `region, retention_days` for diffing in `update`
- `src/modules/organizations/org-settings.service.ts:179` — root — tables: `tenants` — write — in-tx: no — updates region/retention via the dual-write seam in `update`
- `src/modules/organizations/org-settings.service.ts:204` — withOrg — tables: `projects` — read — in-tx: yes — validates the default project is active in the org in `update`
- `src/modules/organizations/org-settings.service.ts:255` — withOrg — tables: `org_settings` — write — in-tx: yes — upserts presentation settings (`onConflictDoUpdate` on `org_id`) in `update`
- `src/modules/organizations/org-settings.service.ts:282` — withOrg — tables: `org_settings` — write — in-tx: yes — lazy row creation (`onConflictDoNothing` on `org_id`, returning) in `ensureRow`
- `src/modules/organizations/org-settings.service.ts:292` — withOrg — tables: `org_settings` — read — in-tx: yes — fallback read when the lazy insert hit the conflict path in `ensureRow`

#### projects.service.ts
- `src/modules/organizations/projects.service.ts:18` — withOrg — tables: `projects` — read — in-tx: yes — lists projects (optionally including archived) in `list`
- `src/modules/organizations/projects.service.ts:22` — withOrg — tables: `projects` — read — in-tx: yes — reads single project in `get`
- `src/modules/organizations/projects.service.ts:36` — withOrg — tables: `projects` — write — in-tx: yes — inserts project (`onConflictDoNothing` on `(org_id, name)`) in `create`
- `src/modules/organizations/projects.service.ts:72` — withOrg — tables: `projects` — write — in-tx: yes — renames/re-describes project in `update`
- `src/modules/organizations/projects.service.ts:99` — withOrg — tables: `projects` — write — in-tx: yes — archives project (sets `archived_at`/`archived_by`) in `archive`
- `src/modules/organizations/projects.service.ts:121` — withOrg — tables: `projects` — write — in-tx: yes — unarchives project in `unarchive`

#### organizations.module.ts
- `src/modules/organizations/organizations.module.ts:81` — check — tables: none — health check — in-tx: n/a — `healthRegistry.register('organizations', () => db.check())`

### Transaction boundaries

Every `withOrg`/`withBypass` block is its own transaction (per `DbService`); multi-statement atomic blocks are:

- `src/modules/organizations/org-access.service.ts:147` (root.transaction, `insertOrgWithOwner`): raw `set_config` (timeouts + `app.current_tenant`) + inserts `tenants` row + owner `org_memberships` row + (team only) `org_settings` row — all one TX; tenant context is set manually transaction-locally since this runs on `root`
- `src/modules/organizations/memberships.service.ts:248` (withOrg, `addMember`): reads seat-bearing `product_entitlements` rows `FOR UPDATE` + reads current membership + counts active memberships + capacity assert + upserts `org_memberships` — one TX (the seat wall and the grant are atomic)
- `src/modules/organizations/memberships.service.ts:448` (withOrg, `removeMember`): marks `org_memberships` row `removed` + deletes its `org_group_members` rows — one TX
- `src/modules/organizations/memberships.service.ts:478` (withOrg, `leaveOrg`): same two-statement shape as `removeMember` — one TX
- `src/modules/organizations/org-groups.service.ts:149` (withOrg, `remove`): deletes `org_group_members` rows + deletes the `org_groups` row — one TX
- `src/modules/organizations/org-lifecycle.service.ts:245` (withOrg, `purge`): 15 raw-SQL deletes + 4 drizzle deletes across 18 tables/schemas — one TX (audit rows deliberately retained outside the erase)
- `src/modules/organizations/org-lifecycle.service.ts:303` (withOrg, `transferOwnership`): demote current owner to admin + promote target to owner + verify exactly-one-active-owner — one TX

Deliberately non-atomic multi-step flows (separate transactions; atomicity comes from idempotent upserts, conditional updates, or the DB unique index, not from one TX):
- invite `create`: membership check (:70) + pending-count (:93) + pendingFor (:408) + insert (:372) are 4 separate TXs (guards are advisory; `org_invites` has no uniqueness guard on pending per email — races can double-issue until the cap guard)
- invite `revoke`/`resend`/`extend`: read-check TX (:138/:171/:219) then a separate write TX (:149/:190/:233); concurrency is handled by the hash-guarded conditional update only in `resend` (:190)
- invite `redeem`: `withBypass` read (:254) → `addMember` (own withOrg TX) → `withOrg` claim (:300) — 3 separate TXs; membership insert is idempotent (upsert on `(account_id, org_id)`), single-use is enforced by the conditional claim
- `requestDeletion`: `org_deletions` upsert (:79) + entitlement transitions (each own TX) + invite revoke (:99) + `api_keys` revoke (:104) + SA token void (:110) are all separate statements/TXs — a crash mid-flow leaves a partially-applied deletion (deletion row exists, purge is the eventual-consistency mechanism)
- `purge` is followed by separate `root` update of `tenants` (:269) and a separate `withOrg` update of `org_deletions` (:274) — outside the erase TX
- `changeRole`: owner pre-check (:334) + role update (:342) are 2 separate TXs; the exactly-one-owner invariant is held by the partial unique index `uq_one_active_owner_per_org`, not by the transaction
- `summary`/`listMembers`/`exportOrgData` issue 3/5/7 separate read TXs respectively — reads are not point-in-time consistent with each other

### Raw SQL / special patterns

- Raw SQL via `tx.execute(sql`...`)` inside transactions:
  - `org-access.service.ts:148-150` — `set_config('statement_timeout'/'idle_in_transaction_session_timeout'/'app.current_tenant', ...)` to establish the tenant context manually inside the `root.transaction` (the only place that sets RLS context outside `withOrg`/`withBypass`)
  - `org-lifecycle.service.ts:246-260` — 15 `delete from ... where org_id = ?` raw deletes across `studio_project_keys`, `product_deployment.*` (5 tables), `published_configs`, `webhook_deliveries`, `webhooks`, `notifications`, `org_group_members`, `org_groups`, `org_service_accounts`, `org_settings` inside the purge TX (tables outside the module's drizzle schema)
- Raw SQL via `db.root.execute(sql`...`)` (no TX):
  - `org-info.ts:20` (`tenants` read), `org-settings.service.ts:83,150` (`tenants` region/retention reads), `org-lifecycle.service.ts:180` (`audit_events` export read), `org-audit.service.ts:81,88,101,134,137` (all `audit_events` reads) — all raw SQL is hand-written with parameter binding; no string-interpolated identifiers
- Row-level locks: exactly one — `memberships.service.ts` inside `addMember` (:270): `select ... from product_entitlements ... .for('update')` serializes concurrent seat-wall checks per org. No `FOR NO KEY UPDATE` anywhere.
- Advisory locks (`pg_advisory_*`): none.
- Upserts (`onConflictDoUpdate`): `entitlements.service.ts:196` on `(org_id, product)`; `memberships.service.ts:289` on `(account_id, org_id)`; `org-lifecycle.service.ts:83` on `org_id` (deletion re-request); `org-settings.service.ts:259` on `org_id`.
- Inserts with `onConflictDoNothing`: `org-groups.service.ts:84` on `(org_id, name)`; `org-groups.service.ts:191` on `(group_id, account_id)`; `org-access.service.ts:172` on `org_settings.org_id`; `projects.service.ts:40` on `(org_id, name)`; `org-settings.service.ts:286` on `org_settings.org_id`.
- RLS-sensitive spots:
  - `invites.service.ts:419` — `db.root.update(org_invites)` with no tenant context on an RLS-FORCED table; per the file's own comment (line 296) an unscoped statement on `org_invites` matches 0 rows, so failed-redeem attempt counting may silently never apply (attempt-cap lockout could be ineffective)
  - `invites.service.ts:254,336` (`redeem`/`preview` withBypass reads) and `org-service-accounts.service.ts:244` (`validateByHash` withBypass read) carry explicit in-code justifications for bypass — all filtered by unguessable id/hash
  - `org-lifecycle.service.ts:104` (`root.update(api_keys)`) and `org-settings.service.ts:141,179` / `org-lifecycle.service.ts:269` (`root` writes to `tenants`) target Python-owned tables with no RLS; tenant filtering is explicit app-level predicates (the documented dual-write seam)
  - `org-audit.service.ts` reads (`:81,:88,:101,:134,:137`) hit `audit_events` via `root` — no RLS on that table; every query carries an explicit `tenant_id = $1` predicate

### Totals

- call sites: 99 (withOrg: 74, withBypass: 9, root: 14, root.transaction: 1, check: 1)
- by file: entitlements.service.ts 4 · invites.service.ts 16 · memberships.service.ts 19 · org-access.service.ts 3 · org-info.ts 1 · org-audit.service.ts 5 · org-groups.service.ts 9 · org-lifecycle.service.ts 13 · org-service-accounts.service.ts 11 · org-settings.service.ts 8 · projects.service.ts 6 · organizations.module.ts 1 (check)
- transaction boundaries (multi-statement): 7 — `insertOrgWithOwner`, `addMember`, `removeMember`, `leaveOrg`, group `remove`, `purge`, `transferOwnership`
- raw SQL statements: `org-access.service.ts:148-150` (set_config), `org-lifecycle.service.ts:246-260` (purge deletes), `org-info.ts:20`, `org-settings.service.ts:83,150`, `org-lifecycle.service.ts:180`, `org-audit.service.ts:81,88,101,134,137`
- row locks: 1 (`FOR UPDATE` in `addMember`); advisory locks: 0


## lifecycle — DB call-site inventory

Area: `src/modules/lifecycle/` (read-only audit; code not modified).
Table name map used: `legal_holds`→`legal_holds`, `purge_tasks`→`purge_tasks`, `tombstones`→`tombstones`, `export_requests`→`export_requests`, `data_access_records`→`data_access_records`, `retention_policies`→`retention_policies`, `conversations`→`conversations`, `messages`→`messages`, `runs`→`runs`, `artifacts`→`artifacts`, `memory_items`→`memory_items`, `tenants`→`tenants` (legacy schema). All call sites verified against injected `DbService`.

### Call sites

#### src/modules/lifecycle/lifecycle.service.ts
- L32 · `withOrg` · `legal_holds` · write · in-tx: yes · placeHold: insert + RETURNING
- L61 · `withOrg` · `legal_holds` · write · in-tx: yes · releaseHold: update status='released' for active hold
- L82 · `withBypass` · `purge_tasks` · write · in-tx: yes · releaseHold re-arm: parked `blocked` tasks → `in_progress`/`check_holds`. **RLS-sensitive**: bypass writes a tenant-scoped table with no tenant predicate other than explicit `organization_id` filter
- L106 · `withOrg` · `legal_holds` · read · in-tx: yes · listHolds: latest 100
- L128 · `withOrg` · `conversations`, `messages`, `runs` · read · in-tx: yes · createExport: per conversation, read conversation + up to 200 messages + 50 runs for manifest snapshot
- L146 · `withOrg` · `export_requests` · write · in-tx: yes · createExport: insert request row (state='ready') + RETURNING
- L182 · `withOrg` · `export_requests` · read+write · in-tx: yes · downloadExport: select row, then conditional update (first-download token bind via `isNull(download_token_hash)` predicate, or download_count increment)
- L246 · `withOrg` · `export_requests` · read · in-tx: yes · listExports: latest 50
- L261 · `withBypass` · `data_access_records` · write · in-tx: yes · recordAccess: insert data-access record. **RLS-sensitive**: cross-tenant sink written via bypass (by design)
- L279 · `withBypass` · `tombstones` · read · in-tx: yes · tombstoneFor: lookup by (resource_type, resource_id)
- audit calls (placeHold, releaseHold, createExport, downloadExport, enqueuePurge, stepTombstone) → `AuditService.add` = `root.transaction` on `audit_events` (see common/audit section)

#### src/modules/lifecycle/retention-purge.service.ts
- L57 · `withOrg` · `retention_policies` · write · in-tx: yes · upsertPolicy: insert + `onConflictDoUpdate` on (organization_id, resource_type, retention_class)
- L89 · `withOrg` · `artifacts`+`retention_policies`→`purge_tasks` · write · in-tx: yes · sweepRetention: `tx.execute(sql`…`)` raw SQL — INSERT INTO purge_tasks SELECT from artifacts join retention_policies, dedup guard. **Raw SQL**
- L119 · `withOrg` · `conversations`+`tenants`→`purge_tasks` · write · in-tx: yes · sweepConversationRetention: raw SQL INSERT…SELECT into purge_tasks. **Raw SQL**
- L148 · `withBypass` · `tenants` · read · in-tx: yes · sweepAllRetention: select all tenant ids
- L172 · `withOrg` · `purge_tasks` · write · in-tx: yes · enqueuePurge: insert + RETURNING
- L206 · `withBypass` · `purge_tasks` · write · in-tx: yes · tick finally: unlock (locked_at=NULL)
- L219 · `withBypass` · `purge_tasks` · read+write · in-tx: yes · claimOne: `SELECT … FOR UPDATE SKIP LOCKED` oldest pending/in_progress (incl. stale lease), then update → in_progress + locked_at. **FOR UPDATE SKIP LOCKED row lock**
- L271 · `withBypass` · `purge_tasks` · write · in-tx: yes · advance: on blocked_by_legal_hold → state='blocked', step='check_holds'
- L279 · `withBypass` · `purge_tasks` · write · in-tx: yes · advance: on other errors → state='failed', lastError (4k)
- L289 · `withBypass` · `purge_tasks` · write · in-tx: yes · toStep: update step/state/finishedAt/evidence
- L310 · `withOrg` · `legal_holds` · read · in-tx: yes · stepCheckHolds: active, unexpired, org-or-scoped hold lookup
- L337 · `withOrg` · `conversations` OR `artifacts` · write · in-tx: yes · stepMarkUnavailable: set status='deleted' (conversations) or state='retiring' (artifacts)
- L350 · `withOrg` · `outbox_events` · write · in-tx: yes · stepEmitDerivedDeletion: `recordOutboxEvent(tx, …)` — durable deletion event in SAME tx (invariant 7)
- L366 · `withOrg` · `artifacts` · read · in-tx: yes · stepPurgeObjects: select batch of 100 artifact object keys; conversation scope uses raw SQL subquery over `run_events`/`checkpoints`/`tool_effects`. **Raw SQL (subquery)**
- L400 · `withBypass` · `artifacts` · write · in-tx: yes · stepPurgeObjects per-object: after storage delete, update artifact state='purged'. **RLS-sensitive**: bypass writes tenant table (uses eq on id only)
- L417 · `withOrg` · `messages`, `memory_items` · write · in-tx: yes · stepPurgeContent: DELETE messages + soft-delete memory_items (deleted_at)
- L430 · `withBypass` · `tombstones` · write · in-tx: yes · stepTombstone: insert + `onConflictDoNothing`. **RLS-sensitive**: cross-org readable sink via bypass
- L457 · `withOrg` · `purge_tasks` · read · in-tx: yes · getPurgeTask: select by id
- L468 · `withBypass` · `tombstones` · read · in-tx: yes · assertNotTombstoned: typed-410 lookup

### Transaction boundaries
1. lifecycle.service.ts L32 `withOrg` — single `legal_holds` insert + RETURNING. (audit append happens in a *separate* `root.transaction` afterwards)
2. L61/L82 releaseHold — TWO transactions: (a) `withOrg` legal_holds update; (b) `withBypass` purge_tasks re-arm update. Not atomic across both
3. L106, L246, L457 — read-only single-statement `withOrg`
4. L128 — `withOrg` read tx: manifest snapshot (conversations + messages + runs reads in one consistent snapshot)
5. L146 — `withOrg` write tx: single `export_requests` insert
6. L182 — `withOrg` read+write tx: select export row, check expiry, conditional update (token bind or download_count++)
7. L261/L279 — single-statement `withBypass` txs (insert data_access_records; select tombstones)
8. retention-purge L57/L172 — single-statement `withOrg` upsert/insert
9. L89/L119 — single-statement `withOrg` raw-SQL INSERT…SELECT sweep
10. L219 claimOne — single `withBypass` tx: SKIP LOCKED select + lock update (claim)
11. L350 stepEmitDerivedDeletion — `withOrg` tx: `outbox_events` insert only (inv7: durable event paired with the fact)
12. L417 stepPurgeContent — `withOrg` tx: messages DELETE + memory_items UPDATE atomic together
13. L430 stepTombstone — single-statement `withBypass` tombstone insert; audit.append separate `root.transaction`

### Raw SQL / special patterns
- Raw SQL: L89/L119 (sweeps via `tx.execute(sql…)` on `tx` inside `withOrg`); L366 (raw subquery on run_events/checkpoints/tool_effects)
- `FOR UPDATE SKIP LOCKED`: L219 claimOne
- Advisory locks: none in lifecycle itself (advisory lock lives in audit.service)
- `onConflictDoUpdate`: L57 (retention_policies true upsert); `onConflictDoNothing`: L430 (tombstones)
- RLS-sensitive `withBypass` on tenant tables: L82 (purge_tasks), L400 (artifacts), L430/L468 (tombstones), L261 (data_access_records)

### Totals
- call sites: 10 (withOrg: 7, withBypass: 3, root: 0, root.transaction: 0) [lifecycle.service.ts]
- call sites: 19 (withOrg: 11, withBypass: 8, root: 0, root.transaction: 0) [retention-purge.service.ts]
- combined lifecycle area: 29 call sites (withOrg: 18, withBypass: 11, root: 0, root.transaction: 0, check: 0)

## config-publish — DB call-site inventory

Area: `src/modules/config-publish/` (read-only audit; code not modified).
Table name map used: `published_configs`, `config_drafts`, `config_notifications` (PK on (config_id, satellite_key)). All call sites verified against injected `DbService`.

### Call sites

#### src/modules/config-publish/config-publish.service.ts
- L92 · `withOrg` · `published_configs` · read+write · in-tx: yes · publish: `pg_advisory_xact_lock(hashtext('cfg:{org}:{scope}:{product}'))` → select max version → insert version row. **Advisory lock (tx-scoped, serializes concurrent publishes per config key)**
- L171 · `withOrg` · `config_drafts` · write · in-tx: yes · publishDraft: delete draft only if payload_hash still matches (concurrent-edit guard); errors swallowed (`.catch(() => undefined)`)
- L244 · `withOrg` · `config_drafts` · write · in-tx: yes · saveDraft: insert + `onConflictDoUpdate` on (org_id, scope, product)
- L289 · `withOrg` · `config_drafts` · read · in-tx: yes · getDraft
- L296 · `withOrg` · `config_drafts` · read · in-tx: yes · listDrafts
- L300 · `withOrg` · `config_drafts` · write · in-tx: yes · deleteDraft: delete + RETURNING id
- L325 · `withOrg` · `published_configs` · read · in-tx: yes · latest: newest version for key
- L341 · `withOrg` · `published_configs` · read · in-tx: yes · version: one version for key
- L360 · `withOrg` · `published_configs` · read · in-tx: yes · history: page of versions + `count(*)` — note: two separate statements inside one tx, read-consistent
- L422 · `withOrg` · `published_configs` · read · in-tx: yes · overview: full-table org read (latest-by-key computed in JS)
- L441 · `root` · `config_notifications` · read · in-tx: **no** · overview: unacked count grouped by config_id. Single statement on root, NO RLS context
- L486 · `withOrg` · `published_configs` · read · in-tx: yes · bootstrap: full org read, latest-by-key in JS
- L530 · `withOrg` · `published_configs` · read · in-tx: yes · since: versions > sinceVersion, limit+1
- L561 · `root` · `config_notifications` · write · in-tx: **no** · fanout: insert per active satellite + `onConflictDoNothing`. Single statement on root, NO RLS context
- L574 · `root` · `config_notifications` · write · in-tx: **no** · renotify: same insert + `onConflictDoNothing`. Single statement on root
- L594 · `root` · `config_notifications` · write · in-tx: **no** · ack: update acked_at where unacked. Single statement on root — **lost-update race possible on concurrent double-ack** (harmless: idempotent timestamp)
- L602 · `root` · `config_notifications` · read · in-tx: **no** · pendingFor: satellite's pending work queue
- L632 · `root` · `config_notifications` · read · in-tx: **no** · deliveryStatus: notifications for one config
- L664 · `withBypass` · `config_notifications` + `published_configs` · write · in-tx: yes · retentionSweep: raw SQL — delete acked notifications older than window; delete versions ranked > retention per (org, scope, product) via window function. **Raw SQL (two DELETE statements in one tx)**
- L716 · `withBypass` · `published_configs` · read · in-tx: yes · findConfigById: by uuid

#### src/modules/config-publish/config-publish.module.ts
- L32 · `check` · — · health-check closure registration (`healthRegistry.register('config-publish', () => db.check())`); `db` is DbService from DI

### Transaction boundaries
1. L92 publish — `withOrg` tx: advisory lock + max-version select + version insert (atomic version bump). audit/event/fanout happen OUTSIDE this tx
2. L171 publishDraft delete — single-statement `withOrg` delete tx (concurrent-edit safe predicate)
3. L244 saveDraft — single-statement `withOrg` upsert tx
4. L664 retentionSweep — single `withBypass` tx: two raw SQL deletes (notifications, versions) atomic together
5. All reads (L289, L296, L300, L325, L341, L360, L422, L486, L530, L716) — single-statement txs; history (L360) does versions+count in one read-consistent tx
6. L441, L561, L574, L594, L602, L632 — root single statements, NOT in transactions, NO RLS

### Raw SQL / special patterns
- Raw SQL: L92 `tx.execute(sql`select pg_advisory_xact_lock…`)`; L664 two `DELETE` statements via `tx.execute(sql…)`; `count(*)` in L360 via drizzle sql template
- Advisory lock: L92 (tx-scoped `pg_advisory_xact_lock(hashtext('cfg:…'))` — version-number serialization per config key)
- `onConflictDoUpdate`: L244 (config_drafts); `onConflictDoNothing`: L561/L574 (config_notifications dedup)
- No `FOR UPDATE SKIP LOCKED` in this area
- RLS flag: all `config_notifications` access uses `db.root` (bypasses RLS — table keyed by satellite, intentionally global); publish/draft/config reads are `withOrg`

### Totals
- call sites: 21 (withOrg: 12, withBypass: 2, root: 6, root.transaction: 0, check: 1)

## staff — DB call-site inventory

Area: `src/modules/staff/` (read-only audit; code not modified).
Table name map used: `staff_impersonations`, `platform_staff`, `accounts`, `oauth_sessions`, `tenants`, `org_memberships`, `audit_events`, `billing.spend_events`. All call sites verified against injected `DbService` (`this.db` in controller; `private readonly db` in services).

### Call sites

#### src/modules/staff/staff-impersonation.service.ts
- L57 · `root` · `oauth_sessions` · write · in-tx: **no** · start: insert session row for impersonation. Not atomic with staff_impersonations insert below (crash between = orphaned session row; sweepExpiredSessions exists for expiry path)
- L87 · `root` · `staff_impersonations` · write · in-tx: **no** · start: insert impersonation record + RETURNING id
- L111 · `root` · `staff_impersonations` · read · in-tx: **no** · revoke: select by id
- L117 · `root` · `oauth_sessions` · write · in-tx: **no** · revoke: set revoked_at by sid
- L118 · `root` · `staff_impersonations` · write · in-tx: **no** · revoke: set revoked_at. **Not atomic with L117**: session could be revoked while impersonation row stays active on crash
- L132 · `root` · `staff_impersonations`+`oauth_sessions` · read · in-tx: **no** · sweepExpiredSessions: raw SQL select of expired-but-unrevoked pairs (limit 100). **Raw SQL**
- L140 · `root` · `oauth_sessions` · write · in-tx: **no** · sweepExpiredSessions: per-row revoke update (loop, one statement per row)
- L147 · `root` · `staff_impersonations` · read · in-tx: **no** · listActive: active (unrevoked, unexpired) list

#### src/modules/staff/platform-staff.admin.ts
- L105 · `root` · `platform_staff` · write · in-tx: **no** · revoke: update revoked_at + reason
- L123 · `root` · `platform_staff` LEFT JOIN `accounts` · read · in-tx: **no** · list: staff bindings + email/displayName
- L140 · `root` · `platform_staff` · write · in-tx: **no** · upsert: insert + `onConflictDoUpdate` on account_id (re-grant resets revoked_at)
- L151 · `root` · `platform_staff` · read · in-tx: **no** · findByPk
- L156 · `root` · `platform_staff` · read · in-tx: **no** · countActiveSuperAdmins: count(*) super_admin unrevoked unexpired — **TOCTOU**: checked before revoke at L105 in separate statement (last-admin guard could race concurrent revokes)

#### src/modules/staff/staff.controller.ts
- L123 · `root` · `accounts`, `tenants`, `oauth_sessions`, `billing.spend_events` · read · in-tx: **no** · overview: raw SQL single SELECT with 4 subquery counts. **Raw SQL**
- L153 · `root` · `tenants`, `org_memberships` · read · in-tx: **no** · searchOrgs: raw SQL search (LIKE on id/slug/name + member count subquery), limit 25. **Raw SQL**
- L167 · `root` · `tenants` · read · in-tx: **no** · orgDetail: select tenant by id (drizzle select; `sql` interpolation for id compare)
- L206 · `root` · `tenants` · write · in-tx: **no** · setFeatures: raw SQL `UPDATE tenants SET features = features || …::jsonb`. **Raw SQL**, jsonb merge-patch, 16 KiB cap in code
- L257 · `root` · `audit_events` · read · in-tx: **no** · auditQuery: raw SQL filtered select with nullable param predicates, limit/offset capped. **Raw SQL**

#### src/modules/staff/staff.module.ts
- L41 · `check` · — · health-check closure registration (`healthRegistry.register('staff', () => db.check())`)

### Transaction boundaries
- None: every staff-area call site is a single statement on `db.root`, no `withOrg`/`withBypass`/`root.transaction` used anywhere in this area

### Raw SQL / special patterns
- Raw SQL: staff.controller L123 (overview counts), L153 (org search), L206 (tenants features update), L257 (audit_events query); staff-impersonation L132 (expiry sweep select)
- No locks (advisory/row-level) in this area
- `onConflictDoUpdate`: platform-staff.admin L140
- RLS flag: staff area uses `db.root` EXCLUSIVELY — never sets tenant context. All staff tables are global/identity-plane by design, but `accounts`/`tenants`/`oauth_sessions` reads bypass RLS (staff-only routes, PlatformStaffGuard-gated)
- Integrity notes: impersonation start (L57+L87) and revoke (L117+L118) each split identity across two non-atomic root statements; last-super_admin check (L156) races the revoke update (L105)

### Totals
- call sites: 19 (withOrg: 0, withBypass: 0, root: 18, root.transaction: 0, check: 1)

## common — DB call-site inventory

Area: `src/common/` incl. `audit/`, `auth/`, `http/`, `infra/outbox/` (read-only audit; code not modified). Schema files (`platform-staff.schema.ts`, `outbox/schema.ts`, `idempotency-records.ts` table def) excluded as schema; `db.service.ts` excluded per instructions. All call sites verified against injected/passed `DbService`.

### Call sites

#### src/common/audit/audit.service.ts (hash-chained audit trail — Tier-0)
- L148 · `root.transaction` · `audit_events` · read+write · in-tx: **yes** · add: (1) `tx.execute(sql`select pg_advisory_xact_lock(hashtext('neryva_audit_chain'))`)` — **transaction-scoped advisory lock serializes all chain appends**; (2) raw SQL select predecessor `event_hash` ordered by (created_at, id) desc; (3) raw SQL insert with prev_hash/event_hash. **Raw SQL**. Hash-chain ordering dependency: predecessor is selected in canonical (created_at, id) order — the exact order verify_chain walks; ties cannot fork the chain. Cross-writer byte-compatible with the Python runtime (canonical JSON + canonicalUtcIso)
- L191 · `root` · `audit_events` · read · in-tx: **no** · verifyChain: raw SQL select window (limit 500), recompute hashes in JS. **Raw SQL**
- RLS flag: raw SQL on root with no tenant predicate — `audit_events` is a global shared chain by design (tenant_id is a column, not an RLS filter here)

#### src/common/auth/auth.guard.ts
- L222 · `root` · `api_keys` · read · in-tx: **no** · L2 key resolution: select by key_hash + revoked=false
- L258 · `root` · `api_keys` · write · in-tx: **no** · fire-and-forget `usage_count + 1` / `last_used_at = now()` update (`.catch(() => undefined)`), runs every L2 request. **Hot-path write on every API-key request**

#### src/common/auth/platform-staff.directory.ts
- L51 · `root` · `platform_staff` · read · in-tx: **no** · resolve: select binding by account_id (authority behind 60s Redis cache)

#### src/common/http/idempotency-records.ts (DB idempotency authority)
- `claimIdempotency(tx, …)` / `completeIdempotency(tx, …)` / `failIdempotency(tx, …)` — take `tx: NodePgDatabase` from the CALLER's transaction (no direct DbService call; by design they execute inside the command's tx): insert `idempotency_records` + `onConflictDoNothing` (claim), select (replay check), update (status transitions IN_PROGRESS→SUCCEEDED/FAILED_*). `onConflictDoNothing` on composite PK (organization_id, principal_id, endpoint_family, idempotency_key). Fail-closed on invisible-row PK race
- L165 · `withBypass` · `idempotency_records` · write · in-tx: yes · purgeExpiredIdempotencyRecords: delete where expires_at < now()

#### src/common/infra/outbox/consumer.ts (inbox dedup contract)
- L58 · `withBypass` · `inbox_events` · read+write · in-tx: yes · claimInbox: insert (consumer_name, event_id) + `onConflictDoNothing` → claimed; else select → skip (PROCESSED) / busy (fresh PROCESSING) / reclaim stale → update. **RLS-sensitive**: inbox is cross-org by design; stale claim = crashed worker
- L96 · `withBypass` · `inbox_events` · write · in-tx: yes · completeInbox: update → PROCESSED + resultRef
- L105 · `withBypass` · `inbox_events` · write · in-tx: yes · failInbox: update → FAILED + lastError (4k)

#### src/common/infra/outbox/dispatcher.ts (outbox claim-publish machine)
- L110 · `withBypass` · `outbox_events` · read · in-tx: yes · updateOldestAge: raw SQL age-of-oldest-pending gauge (only on empty-claim path)
- L120 · `withBypass` · `outbox_events` · read+write · in-tx: yes · claimBatch: `SELECT … FOR UPDATE SKIP LOCKED` (PENDING/RETRY_WAIT, due, FIFO by created_at,eventId uuidv7 tie-break, limit batch) + update → CLAIMED. **FOR UPDATE SKIP LOCKED**
- L148 · `withBypass` · `outbox_events` · write · in-tx: yes · recoverStaleClaims: CLAIMED past lease → PENDING (crash recovery)
- L238 · `withBypass` · `outbox_events` · write · in-tx: yes · markPublished: → PUBLISHED (+published_at, claimed_at NULL)
- L247 · `withBypass` · `outbox_events` · write · in-tx: yes · markRetryWait: → RETRY_WAIT (attempt++, next_attempt_at = now + exp-backoff+jitter)
- L269 · `withBypass` · `outbox_events` · write · in-tx: yes · requeueBusy: → RETRY_WAIT short delay, attempt count untouched (busy-inbox requeue, not a failure)
- L278 · `withBypass` · `outbox_events` · write · in-tx: yes · markDeadLetter: → DEAD_LETTER
- L288 · `withBypass` · `outbox_events` · write · in-tx: yes · replayDeadLetter: DEAD_LETTER → PENDING (operator replay)
- `recordOutboxEvent(tx, …)` (outbox.service.ts) — takes caller tx, single `outbox_events` insert, PENDING; must run in the fact's own tx (invariant 7)

#### Other common files
- No DbService DB call sites in: kernel.module.ts (import only), http/ (except idempotency-records), observability/, config/, crypto/, events/, guardrails/, ids/, infra/clock.ts, infra/queue.service.ts, infra/redis.service.ts, infra/storage/, policy/ (guards read via other services), model-aliases.ts, health.controller.ts (uses registry check closures, not DbService directly)

### Transaction boundaries
1. audit.service L148 — `root.transaction`: advisory lock + predecessor read + insert = ONE atomic chain append; ordering serialized by `pg_advisory_xact_lock`
2. dispatcher claimBatch L120 — `withBypass` tx: SKIP LOCKED select + CLAIMED update atomic (exactly-one claimer across replicas)
3. consumer claimInbox L58 — `withBypass` tx: insert-on-conflict-donothing + select + conditional update atomic (exactly-one side-effect owner)
4. consumer completeInbox L96 / failInbox L105 — single-statement `withBypass` txs
5. dispatcher mark* / replayDeadLetter L238/L247/L269/L278/L288 — single-statement `withBypass` txs
6. dispatcher recoverStaleClaims L148 — single-statement `withBypass` tx
7. idempotency purge L165 — single-statement `withBypass` tx
8. auth.guard L222/L258, directory L51, audit verify L191 — root single statements, no tx

### Raw SQL / special patterns
- Raw SQL: audit.service L148 (3 statements: advisory lock, predecessor select, insert); audit.service L191 (verify select); dispatcher L110 (outbox age select)
- Advisory locks: `pg_advisory_xact_lock(hashtext('neryva_audit_chain'))` (audit); `pg_advisory_xact_lock` on config key hash (config-publish publish, see its section)
- `FOR UPDATE SKIP LOCKED`: dispatcher claimBatch L120; purge claimOne L219 (lifecycle)
- Row-level locks: none other than the two SKIP LOCKED claims
- `onConflictDoNothing`: idempotency claim; inbox claim; tombstone insert; config_notifications fanout
- `onConflictDoUpdate`: retention_policies upsert; config_drafts saveDraft; platform_staff re-grant
- Hash-chain ordering dependency: audit append serialized via advisory lock; predecessor = latest (created_at, id) — deterministic across engine+Python writers; never update/delete audit rows (append-only)
- RLS-sensitive `withBypass`: all outbox/inbox dispatcher-consumer traffic (by design, cross-tenant machine); idempotency purge; lifecycle bypass writes noted in lifecycle section. Outbox row carries `organization_id` column; consumers must enforce tenant scope on their own queries (consumer.ts contract)


## Small-module DB call-site inventory (read-only audit, 2026-09-26)

Areas covered: `src/modules/webhooks/`, `src/modules/keys/`, `src/modules/console/`,
`src/modules/studio-furniture/`, `src/modules/notifications/`, `src/scripts/`.
All `*.ts` except `*.spec.ts` / `*.test.ts`; schema files used only for SQL-name resolution.

Table-name resolution (SQL names from `pgTable(...)`):
- `webhooks` → `webhooks` · `webhookDeliveries` → `webhook_deliveries` (`src/modules/webhooks/schema.ts`)
- `legacyApiKeys` → `api_keys` · `legacyAuditEvents` → `audit_events` (`src/common/infra/db/legacy-schema.ts`; Python-owned DDL, **no RLS**)
- `studioProjectKeys` → `studio_project_keys` (`src/modules/studio-furniture/schema.ts`)
- `notifications` → `notifications` (`src/modules/notifications/schema.ts`)
- `consoleAnnouncements` → `console_announcements` (`src/modules/console/announcements.schema.ts`; global platform table)
- `assistantTemplates` → `assistant_templates` (`src/modules/assistants/schema.ts`; global, PK slug+version)
- `projects` → `projects` · `spendEvents` → `spend_events` · `runs` → `runs` (other modules' schemas, read here)

Legend: method = `withOrg` | `withBypass` | `root` | `root.transaction` | `check`.
in-tx = yes means the statement runs inside a `withOrg`/`withBypass`/`root.transaction` callback;
no means a single top-level statement on `db.root`.

---

## webhooks — DB call-site inventory

Source: `src/modules/webhooks/webhooks.service.ts` (+ health check in `webhooks.module.ts`).
All DB access via injected `DbService` (`private readonly db: DbService`), verified by import.

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| webhooks.service.ts:87 | withOrg | `webhooks` | write | yes | `create`: INSERT new webhook row (encrypted secret envelope) RETURNING |
| webhooks.service.ts:113 | withOrg | `webhooks` | read | yes | `list`: SELECT org's webhooks ordered by createdAt desc |
| webhooks.service.ts:146 | withOrg | `webhooks` | write | yes | `update`: UPDATE webhook row (url/events/description/status) RETURNING |
| webhooks.service.ts:163 | withOrg | `webhooks` | write | yes | `remove`: DELETE webhook by id+orgId |
| webhooks.service.ts:176 | withOrg | `webhook_deliveries` | read | yes | `deliveries`: SELECT paged delivery rows for one webhook |
| webhooks.service.ts:197 | withBypass | `webhook_deliveries` | read+write | yes | `sweepStrandedDeliveries`: RAW SQL `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING id, attempts` — cross-org stranded-delivery claim |
| webhooks.service.ts:238 | withOrg | `webhooks` | write | yes | `rotateSecret`: UPDATE secretEnvelope+updatedAt |
| webhooks.service.ts:274 | withOrg | `webhooks` | read | yes | `dispatch`: SELECT active webhooks for the org |
| webhooks.service.ts:285 | withOrg | `webhook_deliveries` | write | yes | `dispatch`: INSERT one pending delivery row per subscribed target RETURNING id |
| webhooks.service.ts:301 | withOrg | `webhook_deliveries` | write | yes | `dispatch`: UPDATE delivery row to failed when BullMQ enqueue throws (park for sweep) |
| webhooks.service.ts:325 | withBypass | `webhook_deliveries` | read | yes | `attemptDelivery` (worker): SELECT delivery row by id — cross-org queue drain |
| webhooks.service.ts:334 | withBypass | `webhooks` | read | yes | `attemptDelivery`: SELECT parent webhook row by delivery.webhookId |
| webhooks.service.ts:396 | withOrg | `webhook_deliveries` | write | yes | `scheduleRetry`: UPDATE attempts/status/lastError/nextAttemptAt after failed attempt |
| webhooks.service.ts:407 | withOrg | `webhook_deliveries` | write | yes | `finishDelivery`: UPDATE final status (delivered/dead) + optional deliveredAt |
| webhooks.service.ts:423 | withOrg | `webhooks` | read | yes | `require`: SELECT webhook by id+orgId (existence guard, 404 if missing) |
| webhooks.module.ts:30 | check | — | read | no | Health registration: `healthRegistry.register('webhooks', () => db.check())` |

### Transaction boundaries

Every boundary below wraps exactly **one** drizzle/raw statement (no multi-statement transactions in this module):
- `:87` TX = [INSERT `webhooks`]. Note: audit row for `webhook.created` is written by `AuditService` in a *separate* call after commit.
- `:113` TX = [SELECT `webhooks`].
- `:146` TX = [UPDATE `webhooks`]. Preceded by `require()` (`:423`, its own TX) — read-then-write across two transactions (TOCTOU window: row could be deleted between check and update; `update` returns `updated[0]` unguarded).
- `:163` TX = [DELETE `webhooks`]. Also preceded by a separate `require()` TX.
- `:176` TX = [SELECT `webhook_deliveries`]. Preceded by separate `require()` TX.
- `:197` TX (withBypass) = [RAW SQL claim: UPDATE `webhook_deliveries` … FOR UPDATE SKIP LOCKED RETURNING id, attempts]. Re-enqueue loop (`enqueueDelivery` → BullMQ) happens *after* commit, per claimed row; failures only logged. Justification comment cites cross-org reconciliation, org-scoped per row.
- `:238` TX = [UPDATE `webhooks`]. Preceded by separate `require()` TX.
- `:274` TX = [SELECT `webhooks`] (dispatch fan-out targets).
- `:285` TX = [INSERT `webhook_deliveries`] per target (loop of one-statement TXs, not atomic across targets).
- `:301` TX = [UPDATE `webhook_deliveries`] (enqueue-failure parking).
- `:325` TX (withBypass) = [SELECT `webhook_deliveries` by id].
- `:334` TX (withBypass) = [SELECT `webhooks` by id].
- `:396` TX = [UPDATE `webhook_deliveries`] (retry scheduling).
- `:407` TX = [UPDATE `webhook_deliveries`] (terminal status).
- `:423` TX = [SELECT `webhooks` by id+orgId LIMIT 1].

### Raw SQL / special patterns

- **Raw SQL** `:197`: `tx.execute(sql`…`)` — `UPDATE webhook_deliveries … FOR UPDATE SKIP LOCKED … RETURNING id, attempts`. Only raw-SQL site in webhooks.
- **Row-level locks**: `FOR UPDATE SKIP LOCKED` in `:197` (concurrent sweep/worker claim fencing; deterministic jobId dedups any raced re-enqueue).
- **Advisory locks**: none.
- **onConflict**: none.
- **RLS-sensitive**: `:197`, `:325`, `:334` use `withBypass` (cross-org worker drains; each carries an inline justification comment). All `withOrg` sites predicate on `orgId`.

### Totals

- call sites: 16 (withOrg: 12, withBypass: 3, root: 0, root.transaction: 0, check: 1)

---

## keys — DB call-site inventory

Source: `src/modules/keys/keys.service.ts` (+ health check in `keys.module.ts`).
All DB access via injected `DbService`, verified by import. Also imports `legacyApiKeys`/`legacyAuditEvents`
(Python-owned, no RLS) and `studioProjectKeys` (engine-owned).

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| keys.service.ts:58 | withOrg | `api_keys` | read | yes | `list`: SELECT org's keys ordered by created_at desc, limit 200 |
| keys.service.ts:109 | withOrg | `api_keys` | write | yes | `issue`: INSERT new key row (sha256 hash only, no raw secret) RETURNING id |
| keys.service.ts:141 | withOrg | `studio_project_keys` | write | yes | `issue` (K-2): INSERT project binding with `.onConflictDoNothing()` when projectId given |
| keys.service.ts:150 | withOrg | `api_keys` | read | yes | `revoke`: SELECT key id (existence check) |
| keys.service.ts:156 | withOrg | `api_keys` | write | yes | `revoke`: UPDATE revoked=true + updated_at |
| keys.service.ts:193 | root | `api_keys` | read | no | `validateByHash`: SELECT by key_hash (satellite/runtime auth lookup, no tenant context) — RLS-SENSITIVE |
| keys.service.ts:218 | withOrg | `api_keys` | read | yes | `update`: SELECT key row (existence + not-revoked check) |
| keys.service.ts:239 | withOrg | `api_keys` | write | yes | `update`: UPDATE name/scopes patch |
| keys.service.ts:254 | withOrg | `api_keys` | read | yes | `rotate`: SELECT key row (existence + not-revoked check) |
| keys.service.ts:262 | withOrg | `api_keys` | write | yes | `rotate`: UPDATE key_hash/prefix/usage_count (old secret dies immediately) |
| keys.service.ts:291 | withOrg | `api_keys` | read | yes | `detail`: SELECT full key row |
| keys.service.ts:299 | withOrg | `studio_project_keys` | read | yes | `detail`: SELECT binding by apiKeyId (Promise.all with audit read) |
| keys.service.ts:300 | root | `audit_events` | read | no | `detail`: SELECT key.% actions for this keyId, limit 50 — RLS-SENSITIVE (root read, cross-org capable) |
| keys.service.ts:329 | withBypass | `api_keys` | read | yes | `notifyExpiringKeys`: cross-org scan of non-revoked keys expiring before horizon |
| keys.module.ts:26 | check | — | read | no | Health registration: `healthRegistry.register('keys', () => db.check())` |

Additional: `validateManyHashes` loops `validateByHash` sequentially for up to 200 hashes → up to 200 sequential `root` SELECTs on `api_keys` (fan-out, N+1-style, but auth-path by design).

### Transaction boundaries

Every boundary wraps exactly **one** statement:
- `:58` TX = [SELECT `api_keys`].
- `:109` TX = [INSERT `api_keys` RETURNING id]. Audit `key.created` written after commit (separate).
- `:141` TX = [INSERT `studio_project_keys` … ON CONFLICT DO NOTHING] (only when projectId supplied at issue time).
- `:150` TX = [SELECT `api_keys` id]. Existence check.
- `:156` TX = [UPDATE `api_keys` revoked=true]. Separate TX from `:150` (read-then-write across two TXs). Also emits `KeyRevoked` event + notification after.
- `:218` TX = [SELECT `api_keys`].
- `:239` TX = [UPDATE `api_keys` SET patch]. Separate TX from `:218`.
- `:254` TX = [SELECT `api_keys`].
- `:262` TX = [UPDATE `api_keys` SET key_hash/prefix/usage_count]. Separate TX from `:254`; emits `KeyRevoked` (rotation kind) after commit.
- `:291` TX = [SELECT `api_keys` LIMIT 1].
- `:299` TX = [SELECT `studio_project_keys` LIMIT 1] (parallel with the root audit read `:300`).
- `:329` TX (withBypass) = [SELECT `api_keys` (id,name,tenant_id,expires_at) WHERE revoked=false AND expires_at <= horizon]. Per-row `notifyOrgRoles` calls happen after commit.

### Raw SQL / special patterns

- **Raw SQL**: none (`sql` not used in this file).
- **Row-level locks**: none. **Advisory locks**: none.
- **onConflict**: `:141` `.onConflictDoNothing()` on the `studio_project_keys` insert at issue time (idempotent binding).
- **RLS-sensitive**: `:193` root read on `api_keys` by hash (runtime auth hot path — no tenant context; `api_keys` has no RLS, so the hash predicate is the only isolation); `:300` root read on `audit_events` (no tenant predicate on the audit row itself — isolation rests on the preceding withOrg key lookup); `:329` withBypass cross-org scan (daily worker). `validateByHash` throws 400 on malformed hash (fail-closed input validation).

### Totals

- call sites: 15 (withOrg: 11, withBypass: 1, root: 2, root.transaction: 0, check: 1)

---

## console — DB call-site inventory

Sources: `audit-query.service.ts`, `console-home.service.ts`, `onboarding.service.ts`, `status.service.ts`
(+ health check in `console.module.ts`). No DB usage in `manifest-registry.service.ts`,
`route-bijection.service.ts`, `summary-provider.registry.ts`, the two `summaries/`, or the controllers
(they delegate to these services or other modules). All `this.db` hits verified against `DbService` injection.

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| audit-query.service.ts:91 | root | `audit_events` | read | no | `query`: cursor-paginated SELECT of the shared audit chain with actor/action/date filters — RLS-SENSITIVE (root read, explicit tenant_id predicate only; `audit_events` has no RLS) |
| console-home.service.ts:181 | root | `tenants` | read | no | `orgName`: RAW SQL `select name from tenants where id = ${orgId} limit 1` — RLS-SENSITIVE (raw SQL via root) |
| onboarding.service.ts:51 | withOrg | `projects` | read | yes | `state`: SELECT 1 non-archived project (create_project step) |
| onboarding.service.ts:52 | root | `api_keys` | read | no | `state`: SELECT 1 non-revoked key for org (create_api_key step) — RLS-SENSITIVE (explicit tenant_id filter only) |
| onboarding.service.ts:53 | withOrg | `spend_events` | read | yes | `state`: SELECT 1 spend event (first_usage step) |
| onboarding.service.ts:58 | withOrg | `runs` | read | yes | `state`: SELECT earliest COMPLETED standard/test run (activation truth F3) |
| status.service.ts:59 | root | `console_announcements` | read | no | `activeAnnouncements`: SELECT rows in the active window, limit 20 (global table, no tenant scope) |
| status.service.ts:78 | root | `console_announcements` | write | no | `createAnnouncement`: INSERT announcement row RETURNING (staff-gated at controller) |
| status.service.ts:96 | root | `console_announcements` | write | no | `resolveAnnouncement`: UPDATE severity=resolved + close window |
| console.module.ts:68 | check | — | read | no | Health registration: `healthRegistry.register('console', () => db.check())` |

### Transaction boundaries

- `onboarding.state` runs **four parallel single-statement TXs** (`:51`, `:52` is root/no-tx, `:53`, `:58`) plus entitlement lookups via `EntitlementsService` (organizations module, out of scope). The four reads are point-in-time independent — no atomic snapshot across them.
- `audit-query.query` `:91`: single root SELECT (no transaction at all).
- `console-home.orgName` `:181`: single raw-SQL root execute (no transaction).
- `status` `:59`/`:78`/`:96`: each a single root statement (no transactions).

### Raw SQL / special patterns

- **Raw SQL**: `console-home.service.ts:181` — `this.db.root.execute<{ name: string }>(sql`select name from tenants where id = ${orgId} limit 1`)` (parameterized, single-row org-name lookup).
- **SQL fragments (not raw execute)**: `audit-query.service.ts` builds `sql` fragments inside drizzle `.where()`: `LIKE … ESCAPE '\'` action-prefix filter with wildcard escaping (`escapeActionLikePrefix`), and the composite cursor predicate `(created_at < $1 OR (created_at = $1 AND id < $2))`.
- **Row-level locks**: none. **Advisory locks**: none. **onConflict**: none.
- **RLS-sensitive**: `:91` (audit_events via root — tenant isolation is the explicit `tenant_id` predicate; the table has no RLS); `:181` (raw SQL on `tenants` via root — membership pre-checked in `home()` before the call); `:52` (api_keys via root). `console_announcements` is a global platform table (no org column) — root access is by design.

### Totals

- call sites: 10 (withOrg: 3, withBypass: 0, root: 6, root.transaction: 0, check: 1)

---

## studio-furniture — DB call-site inventory

Source: `src/modules/studio-furniture/keys.service.ts` (+ health check in `agent-studio.module.ts`).
All DB access via injected `DbService`, verified by import. No DB usage in `summary.service.ts`,
`plans.ts` (static), `studio.controller.ts`.

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| keys.service.ts:38 | root | `api_keys` | read | no | `list`: SELECT org's keys (id/name/revoked/last_used_at) by tenant_id — RLS-SENSITIVE (table has no RLS; explicit tenant filter is the isolation) |
| keys.service.ts:48 | withOrg | `studio_project_keys` | read | yes | `list`: SELECT org's key→project bindings |
| keys.service.ts:56 | withOrg | `projects` | read | yes | `list`: SELECT project id/name for bound projectIds (skipped when none) |
| keys.service.ts:77 | root | `api_keys` | read | no | `bind`: SELECT key id+revoked by id+tenant_id (key must exist, be alive, belong to org) — RLS-SENSITIVE |
| keys.service.ts:91 | withOrg | `projects` | read | yes | `bind`: SELECT project id by id+orgId (project must exist in org) |
| keys.service.ts:98 | withOrg | `studio_project_keys` | write | yes | `bind`: INSERT binding with `.onConflictDoUpdate(target: [orgId, apiKeyId])` — re-bind moves the key |
| keys.service.ts:120 | withOrg | `studio_project_keys` | write | yes | `unbind`: DELETE binding by orgId+apiKeyId RETURNING id (404 if none) |
| agent-studio.module.ts:49 | check | — | read | no | Health registration: `healthRegistry.register('studio-furniture', () => db.check())` |

### Transaction boundaries

- `list`: three sequential single-statement reads — `:38` (root, no tx), `:48` TX = [SELECT `studio_project_keys`], `:56` TX = [SELECT `projects`]. No atomic snapshot across the three.
- `bind`: `:77` (root, no tx) key check → `:91` TX = [SELECT `projects`] → `:98` TX = [INSERT … ON CONFLICT DO UPDATE `studio_project_keys`]. Check-then-act across three separate transactions; the upsert itself is atomic (single statement).
- `unbind`: `:120` TX = [DELETE `studio_project_keys` RETURNING id]. Audit `studio.key_unbound` written after commit (separate).

### Raw SQL / special patterns

- **Raw SQL**: none. **Row-level locks**: none. **Advisory locks**: none.
- **onConflict**: `:98` `.onConflictDoUpdate({ target: [studioProjectKeys.orgId, studioProjectKeys.apiKeyId], set: { projectId, boundBy } })` — re-binding an already-bound key atomically moves it to the new project.
- **RLS-sensitive**: `:38` and `:77` read `api_keys` via `root` because the Python-owned table has no RLS — isolation is the explicit `tenant_id` predicate in application code. `:77` additionally predicates on the key id.

### Totals

- call sites: 8 (withOrg: 5, withBypass: 0, root: 2, root.transaction: 0, check: 1)

---

## notifications — DB call-site inventory

Source: `src/modules/notifications/notifications.service.ts` (+ health check in `notifications.module.ts`).
All DB access via injected `DbService`, verified by import. **Every data call site uses `db.root`**
(no withOrg/withBypass anywhere in this module). No DB usage in `notifications.controller.ts`.

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| notifications.service.ts:317 | root | `notifications` | write | no | `notifyAccount`: INSERT one in-app notification row (+ optional email for warn/error) — never throws; RLS-SENSITIVE (cross-org writer, no tenant context) |
| notifications.service.ts:442 | root | `notifications` | read | no | `list`: SELECT account's notifications (optional unread-only), order by createdAt desc, limit 200 — RLS-SENSITIVE (accountId predicate only) |
| notifications.service.ts:451 | root | `notifications` | write | no | `markRead`: UPDATE readAt for one notification scoped by id+accountId — RLS-SENSITIVE |
| notifications.service.ts:458 | root | `notifications` | write | no | `markAllRead`: UPDATE readAt for all unread rows of the account — RLS-SENSITIVE |
| notifications.service.ts:465 | root | `notifications` | read | no | `unreadCount`: SELECT up to 500 unread ids, count in JS — RLS-SENSITIVE |
| notifications.module.ts:27 | check | — | read | no | Health registration: `healthRegistry.register('notifications', () => db.check())` |

Additional: `notifyOrgRoles` fans out via `memberships.listMembers` (organizations module) then one `notifyAccount` (root INSERT) per target member — N+1 writes by design (deduped roles).

### Transaction boundaries

None — every call site is a single top-level `root` statement with no transaction wrapper. The INSERT in
`notifyAccount` and the email send are not atomic (email failure is caught and swallowed by design; the
in-app row always lands).

### Raw SQL / special patterns

- **Raw SQL**: none. **Row-level locks**: none. **Advisory locks**: none. **onConflict**: none.
- **RLS-sensitive (whole module)**: all five data call sites use `db.root`, so Postgres RLS (if ever enabled on `notifications`) is bypassed; tenant/account isolation rests entirely on explicit `accountId` predicates in application code. `markRead`/`markAllRead`/`list`/`unreadCount` all scope by `accountId`; `notifyAccount` takes the target accountId as a parameter from internal callers only (event handlers, other services) — there is no user-supplied row targeting.

### Totals

- call sites: 6 (withOrg: 0, withBypass: 0, root: 5, root.transaction: 0, check: 1)

---

## scripts — DB call-site inventory

Source: `src/scripts/sync-template-registry.impl.ts` (release job; entry shim `sync-template-registry.ts` has no DB).
Constructs `DbService` directly (`const db = new DbService()` at `:111` — no Nest DI; `db.onModuleDestroy()` in `finally`).

### Call sites

| File:line | Method | Tables | Op | In-tx | Description |
|---|---|---|---|---|---|
| sync-template-registry.impl.ts:117 | root | `assistant_templates` | read | no | Per-entry: SELECT hash WHERE slug+version (idempotency / immutability check) |
| sync-template-registry.impl.ts:131 | root | `assistant_templates` | write | no | Per-entry: INSERT new template row (slug, version, status, family, definition, bindings, eval_ref, release_policy, hash, min_engine_schema) |
| sync-template-registry.impl.ts:111 | — | — | — | — | `new DbService()` construction (not a query call site; recorded for completeness) |

Additional: `audit.add({ action: 'template.registry_synced', … })` after each insert writes to `audit_events` via `AuditService` (`src/common/audit/` — outside the six areas, not inventoried here). All registry validation (hash, payload, schema version) happens *before* any DB touch; `--dry-run` performs zero writes.

### Transaction boundaries

None — the select-then-insert per entry is two separate root statements with no transaction (fail-loud on hash mismatch; reruns are idempotent via the pre-check). Not atomic across entries: a mid-run crash leaves earlier entries synced (safe — rerun resumes).

### Raw SQL / special patterns

- **Raw SQL**: none. **Row-level locks**: none. **Advisory locks**: none. **onConflict**: none (idempotency via explicit pre-SELECT).
- **RLS-sensitive**: no — `assistant_templates` is a global table (no org column); root access is by design for a release job.

### Totals

- call sites: 2 (withOrg: 0, withBypass: 0, root: 2, root.transaction: 0, check: 0)

---

## Grand totals (six areas)

- call sites: 57 — withOrg: 31, withBypass: 4, root: 17, root.transaction: 0, check: 5
- Every `withOrg`/`withBypass` block in these areas wraps exactly **one** drizzle/raw statement — there are no multi-statement transactions here.
- No `root.transaction` call sites, no `withSerializable` call sites (zero repo-wide per background), no advisory locks.
- Raw SQL: 2 sites — webhooks `:197` (`FOR UPDATE SKIP LOCKED` claim sweep), console-home `:181` (org-name lookup on `tenants`). SQL fragments (not execute): audit-query `:91`.
- `onConflict`: 2 sites — keys `:141` (DoNothing), studio-furniture `:98` (DoUpdate).
- RLS-sensitive hotspots: notifications module (all 5 data sites on `root`); `api_keys`/`audit_events` root reads (Python-owned tables have no RLS — isolation is explicit `tenant_id`/hash predicates); webhooks `withBypass` worker drains (justified inline).


## assistants — DB call-site inventory

Read-only audit of `src/modules/assistants/` (NestJS + Drizzle + PostgreSQL). All 36 non-test `.ts` files checked; 11 files touch `DbService` (all verified via `DbService` import + constructor injection — no false positives). No `withSerializable`, no `db.check()`, no `db.root.transaction(...)` call sites anywhere in the module.

SQL table-name resolution (drizzle table object → SQL table):
- `assistants` → `assistants`, `assistantVersions` → `assistant_versions`, `policySnapshots` → `policy_snapshots`, `assistantRollouts` → `assistant_rollouts`, `runManifests` → `run_manifests`, `assistantTemplates` → `assistant_templates`, `assistantInstalls` → `assistant_installs`, `controlBlocks` → `control_blocks` (module `schema.ts`)
- `modelCatalogEntries` → `model_catalog_entries`, `modelCostEntries` → `model_cost_entries`, `providerCredentials` → `provider_credentials`, `providerEnablements` → `provider_enablements`, `templatePlatformBlocks` → `template_platform_blocks`, `toolCatalog` → `tool_catalog`
- Cross-module tables touched: `conversations` → `conversations`, `runs` → `runs` (conversations/schema), `evalRuns` → `eval_runs`, `evalDatasets` → `eval_datasets` (knowledge/eval.schema), `documents` → `documents`, `chunks` → `chunks`, `embeddings` → `embeddings` (knowledge/schema), `publishedConfigs` → `published_configs` (config-publish), `outboxEvents` → `outbox_events` (common/infra/outbox), `usage_ledger_entries`, `audit_events` (raw SQL only).

### Call sites

#### assistants.service.ts (28 call sites)

- `src/modules/assistants/assistants.service.ts:140` — withOrg — tables: `assistants`, `assistant_versions` — write — in-tx: yes — create(): inserts assistant row + DRAFT (version=0) version row atomically
- `src/modules/assistants/assistants.service.ts:198` — withOrg — tables: `assistants` — write — in-tx: yes — create(): bare-create path, single assistant insert
- `src/modules/assistants/assistants.service.ts:227` — withOrg — tables: `assistants` — read — in-tx: yes — get(): fetch one assistant by id
- `src/modules/assistants/assistants.service.ts:235` — withOrg — tables: `assistants` — read — in-tx: yes — list(): org assistants ordered by updated_at, capped
- `src/modules/assistants/assistants.service.ts:268` — withOrg — tables: `conversations`, `assistants` — read+write — in-tx: yes — remove(): probe active conversations, delete archived/deleted conversations, delete assistant — one TX (P5-B12)
- `src/modules/assistants/assistants.service.ts:334` — withOrg — tables: `assistants` — write — in-tx: yes — setDisabled(): set/clear kill-switch columns (disabled_at/by/reason)
- `src/modules/assistants/assistants.service.ts:406` — withOrg — tables: `assistant_versions` — write — in-tx: yes — createVersion(): insert DRAFT version row (version=0 sentinel; 23505 → typed 409)
- `src/modules/assistants/assistants.service.ts:478` — withOrg — tables: `assistants` — read — in-tx: yes — updateDraft(): read active_version_id to rebase draft lineage
- `src/modules/assistants/assistants.service.ts:486` — withOrg — tables: `assistant_versions` — write — in-tx: yes — updateDraft(): optimistic-concurrency guarded draft UPDATE (id + DRAFT + expected hash)
- `src/modules/assistants/assistants.service.ts:577` — withOrg — tables: `eval_runs`, `runs`, `assistant_versions` — read+write — in-tx: yes — discardDraft(): probe eval_runs / non-test runs (refuse 409), delete pinned test runs, delete draft row
- `src/modules/assistants/assistants.service.ts:674` — withOrg — tables: `documents` — read — in-tx: yes — getKnowledgeHealth(): states of pinned document ids
- `src/modules/assistants/assistants.service.ts:702` — withOrg — tables: `chunks`, `embeddings` — read — in-tx: yes — getKnowledgeHealth(): RAW SQL embedding-coverage aggregate per pinned (document_version, model) via VALUES join
- `src/modules/assistants/assistants.service.ts:761` — withOrg — tables: `assistant_versions` — read — in-tx: yes — getVersion(): fetch version by id
- `src/modules/assistants/assistants.service.ts:770` — withOrg — tables: `assistant_versions` — read — in-tx: yes — listVersions(): versions of an assistant, capped
- `src/modules/assistants/assistants.service.ts:827` — withOrg — tables: `assistant_versions`, `policy_snapshots`, `assistants` (+ `assistant_installs`, `assistant_templates`, `eval_runs`, `tool_catalog`, `model_catalog_entries` via helpers) — read+write — in-tx: yes — publish(): advisory-locked publish TX — advisory xact lock, no-op/BLOCK/required-check gates, manifest resolution, insert PUBLISHED version + policy snapshot, move active_version_id
- `src/modules/assistants/assistants.service.ts:915` — withOrg — tables: `assistants`, `assistant_versions` — read+write — in-tx: yes — retire(): advisory-locked TX — active-pointer guard, status → RETIRED (guarded UPDATE detects concurrent retire)
- `src/modules/assistants/assistants.service.ts:994` — withOrg — tables: `assistant_versions`, `policy_snapshots`, `assistants` (+ helper reads as publish) — read+write — in-tx: yes — rollback(): advisory-locked TX — rollback-as-new-publish with rollback_of lineage
- `src/modules/assistants/assistants.service.ts:1050` — withOrg — tables: `policy_snapshots` — read — in-tx: yes — getSnapshot(): fetch snapshot by id
- `src/modules/assistants/assistants.service.ts:1064` — withOrg — tables: `assistant_versions`, `policy_snapshots` — read — in-tx: yes — getSnapshotForVersion(): content-addressed snapshot (version hash match) — one TX
- `src/modules/assistants/assistants.service.ts:1162` — withOrg — tables: `assistant_installs` — read — in-tx: yes — resolveTemplateDataset(): install row for `template:<slug>@<version>` dataset name
- `src/modules/assistants/assistants.service.ts:1177` — withOrg — tables: `eval_datasets` — read — in-tx: yes — resolveTemplateDataset(): eval dataset id by name
- `src/modules/assistants/assistants.service.ts:1223` — withOrg — tables: `eval_runs` — read — in-tx: yes — getVersionProvenance(): latest completed non-shadow eval decision
- `src/modules/assistants/assistants.service.ts:1450` — withOrg — tables: `tool_catalog` — read — in-tx: yes — assertToolPins(): org tool rows for schema-hash pin validation
- `src/modules/assistants/assistants.service.ts:1504` — withOrg — tables: `assistant_versions`, `policy_snapshots` — read+write — in-tx: yes — ensureVersionSnapshot(): idempotent snapshot synthesis — probe by (version, hash), resolve manifest, insert on-conflict-do-nothing
- `src/modules/assistants/assistants.service.ts:1685` — withOrg — tables: `assistant_versions`, `policy_snapshots` — read — in-tx: yes — auditDegradedBypass(): read committed snapshot pins for degraded-bypass audit
- `src/modules/assistants/assistants.service.ts:1888` — withBypass — tables: `assistants` — read — in-tx: yes — sweepDegradedAssistants(): RAW SQL cross-org select of overdue degraded rows (`for update skip locked`)
- `src/modules/assistants/assistants.service.ts:1915` — withBypass — tables: `assistants` — read — in-tx: yes — sweepDegradedAssistants(): RAW SQL cross-org select of due-soon (<24h) degraded rows (`for update skip locked`)
- `src/modules/assistants/assistants.service.ts:1931` — withBypass — tables: `assistants` — write — in-tx: yes — sweepDegradedAssistants(): RAW SQL per-candidate `update assistants set degraded_alerted_at = now()` (guarded by `is null`)

#### burn-rate.service.ts (5)

- `src/modules/assistants/burn-rate.service.ts:66` — root — tables: `assistant_rollouts`, `usage_ledger_entries` — read — in-tx: no — sweepCandidates(): RAW SQL cross-org sweep of active production/default rollouts in orgs with spend in last hour (worker entry point, no tenant ctx)
- `src/modules/assistants/burn-rate.service.ts:120` — root — tables: `audit_events` — read — in-tx: no — suppressedByManualResume(): RAW SQL latest `assistant.auto_rollback` audit for (tenant, assistant) — tenant filtered in SQL, no RLS ctx
- `src/modules/assistants/burn-rate.service.ts:130` — withOrg — tables: `assistant_rollouts` — read — in-tx: yes — suppressedByManualResume(): newest ACTIVE rollout created_at for the assistant
- `src/modules/assistants/burn-rate.service.ts:167` — withOrg — tables: `usage_ledger_entries` — read — in-tx: yes — checkAndMaybeRollback(): two RAW SQL sums (last hour / last 24h cost) — the dollar the quota wall reads
- `src/modules/assistants/burn-rate.service.ts:216` — withOrg — tables: `assistants`, `assistant_rollouts` — read+write — in-tx: yes — checkAndMaybeRollback(): verify assistant exists + guarded UPDATE of active (production, default) rollout → paused

#### control-blocks.service.ts (3)

- `src/modules/assistants/control-blocks.service.ts:31` — withOrg — tables: `control_blocks` — read — in-tx: yes — list(): org control blocks, capped 200
- `src/modules/assistants/control-blocks.service.ts:71` — withOrg — tables: `control_blocks` — read+write — in-tx: yes — set(): twin-dedupe probe (findActiveBlock) + insert block
- `src/modules/assistants/control-blocks.service.ts:107` — withOrg — tables: `control_blocks` — write — in-tx: yes — clear(): delete block by (id, org)

#### fleet.staff.controller.ts (5)

- `src/modules/assistants/fleet.staff.controller.ts:59` — root — tables: `template_platform_blocks` — write — in-tx: no — kill(): insert platform block, onConflictDoNothing (global table, staff surface, idempotent)
- `src/modules/assistants/fleet.staff.controller.ts:83` — root — tables: `template_platform_blocks` — write — in-tx: no — release(): update block set lifted_at/lifted_by where slug + lifted_at null
- `src/modules/assistants/fleet.staff.controller.ts:106` — root — tables: `template_platform_blocks` — read — in-tx: no — listBlocks(): all platform blocks ordered by created_at, capped
- `src/modules/assistants/fleet.staff.controller.ts:119` — withBypass — tables: `assistant_installs` — read — in-tx: yes — installs(): RAW SQL cross-org install-base inventory by slug (+ optional template_version), audited read
- `src/modules/assistants/fleet.staff.controller.ts:151` — root — tables: `audit_events` — read — in-tx: no — syncs(): RAW SQL last 50 `template.registry_synced` audit events (global chain table)

#### manifest-resolution.service.ts (1)

- `src/modules/assistants/manifest-resolution.service.ts:449` — root — tables: `model_catalog_entries` — read — in-tx: no — resolveModelRef(): active platform catalog rows to qualify bare model aliases (called from resolveForPublish, which runs inside publish/ensureVersionSnapshot TXs — but this read executes via db.root OUTSIDE the caller's TX)
- (tx-internal reads in resolveForPublish: `resolveToolBindings` reads `tool_catalog`; `resolveKnowledgePins`/`pinSource` read knowledge `knowledge_config` via ConfigPublishService + `documents`, `chunks`, `embeddings`; `resolveTemplateRef` reads `assistant_installs` + `assistant_templates` — all on the caller's tx)

#### model-catalog.service.ts (6)

- `src/modules/assistants/model-catalog.service.ts:110` — root — tables: `model_catalog_entries` — write — in-tx: no — upsertEntry(): insert + onConflictDoUpdate on (provider, model_id)
- `src/modules/assistants/model-catalog.service.ts:154` — root — tables: `model_catalog_entries` — read — in-tx: no — listEntries(status): filtered by status
- `src/modules/assistants/model-catalog.service.ts:156` — root — tables: `model_catalog_entries` — read — in-tx: no — listEntries(): unfiltered, capped 500
- `src/modules/assistants/model-catalog.service.ts:166` — root — tables: `model_catalog_entries` — write — in-tx: no — setEntryStatus(): update status by id
- `src/modules/assistants/model-catalog.service.ts:204` — root — tables: `published_configs` — read — in-tx: no — availableFor(): org's `knowledge_config` payload for residency pin — tenant-owned table read via db.root (org-filtered predicate, NO RLS tenant context) ⚠
- `src/modules/assistants/model-catalog.service.ts:262` — root — tables: `model_catalog_entries` — read — in-tx: no — platformFacts(): active platform provider/model pairs for GAP-09 reason splitting

#### model-cost.service.ts (5)

- `src/modules/assistants/model-cost.service.ts:71` — root — tables: `model_cost_entries` — write — in-tx: no — upsertPoint(): insert + onConflictDoUpdate on (provider, model, effective_from)
- `src/modules/assistants/model-cost.service.ts:108` — root — tables: `model_cost_entries` — read — in-tx: no — listPoints(provider): filtered by provider
- `src/modules/assistants/model-cost.service.ts:114` — root — tables: `model_cost_entries` — read — in-tx: no — listPoints(): all, capped 500
- `src/modules/assistants/model-cost.service.ts:134` — root — tables: `model_cost_entries` — read — in-tx: no — listActivePoints(): latest effective unretired point per provider/model (app-side dedupe)
- `src/modules/assistants/model-cost.service.ts:164` — root — tables: `model_cost_entries` — write — in-tx: no — retirePoint(): set retired_at by id
- (`ModelCostService.latestForRunPricing` is a static taking the caller's `tx` — reads `model_cost_entries` inside the conversations commitRunResult TX; no direct DbService call)

#### provider-credentials.service.ts (9)

- `src/modules/assistants/provider-credentials.service.ts:137` — withOrg — tables: `provider_credentials` — write — in-tx: yes — create(): insert sealed credential (23505 → typed conflict via mapCredentialUniqueViolation)
- `src/modules/assistants/provider-credentials.service.ts:191` — withOrg — tables: `provider_credentials` — write — in-tx: yes — rotate(): guarded UPDATE of sealed material where id + org + status ≠ 'revoked' (race-safe authority)
- `src/modules/assistants/provider-credentials.service.ts:212` — withOrg — tables: `provider_credentials` — read — in-tx: yes — rotate(): pre-check existence for error message only
- `src/modules/assistants/provider-credentials.service.ts:263` — withOrg — tables: `provider_credentials` — read — in-tx: yes — revoke(): pre-check select (404 / already-revoked)
- `src/modules/assistants/provider-credentials.service.ts:281` — withOrg — tables: `provider_credentials` — write — in-tx: yes — revoke(): terminal UPDATE → status 'revoked' (+ compromised flag)
- `src/modules/assistants/provider-credentials.service.ts:324` — withOrg — tables: `provider_credentials` — read — in-tx: yes — list(): org credentials (view-mapped, sealed material excluded)
- `src/modules/assistants/provider-credentials.service.ts:338` — withOrg — tables: `provider_enablements` — read — in-tx: yes — listEnablements(): org provider enablements
- `src/modules/assistants/provider-credentials.service.ts:351` — withOrg — tables: `provider_enablements` — write — in-tx: yes — setEnablement(): insert + onConflictDoUpdate on (organization_id, provider)
- `src/modules/assistants/provider-credentials.service.ts:393` — withOrg — tables: `provider_credentials` — read — in-tx: yes — providerFacts(): active credential providers (+ delegates to listEnablements)

#### rollouts.service.ts (3)

- `src/modules/assistants/rollouts.service.ts:83` — withOrg — tables: `assistants`, `assistant_installs`, `template_platform_blocks`, `assistant_versions`, `control_blocks`, `eval_runs`, `assistant_rollouts` — read+write — in-tx: yes — setRelease(): promote TX — raw-SQL assistant existence probe, install slug lookup, platform-block check, per-variant PUBLISHED/version-block/eval-gate checks, pause current active pointer at address, insert new active rollout (23505 → concurrent-promote 409)
- `src/modules/assistants/rollouts.service.ts:202` — withOrg — tables: `assistant_rollouts` — write — in-tx: yes — pause(): update active pointer(s) → paused (returns count)
- `src/modules/assistants/rollouts.service.ts:238` — withOrg — tables: `assistant_rollouts` — read — in-tx: yes — get(): latest rollout row for (assistant, environment, channel)

#### templates.service.ts (11)

- `src/modules/assistants/templates.service.ts:119` — root — tables: `assistant_templates` — read — in-tx: no — get(slug, version): registry row by slug+version (global table, no RLS)
- `src/modules/assistants/templates.service.ts:129` — root — tables: `assistant_templates` — read — in-tx: no — get(slug): all versions of slug (latest picked in app)
- `src/modules/assistants/templates.service.ts:148` — withOrg — tables: `assistant_installs` — read — in-tx: yes — resolveInstallTemplate(): install row for assistant
- `src/modules/assistants/templates.service.ts:153` — root — tables: `assistant_templates` — read — in-tx: no — resolveInstallTemplate(): registry definition_hash for install
- `src/modules/assistants/templates.service.ts:171` — withOrg — tables: `assistant_installs` — read — in-tx: yes — resolveAssistantChannels(): install row for channel bindings
- `src/modules/assistants/templates.service.ts:176` — root — tables: `assistant_templates` — read — in-tx: no — resolveAssistantChannels(): registry bindings column
- `src/modules/assistants/templates.service.ts:213` — root — tables: `template_platform_blocks` — read — in-tx: no — install(): platform kill check pre-install (blocks new installs slug-wide)
- `src/modules/assistants/templates.service.ts:255` — withOrg — tables: `control_blocks`, `assistants`, `assistant_versions`, `assistant_installs`, `outbox_events` — read+write — in-tx: yes — install(): atomic install TX — org template-block check, insert assistant + DRAFT version + install, write `template.install_provisioning` outbox event in same TX
- `src/modules/assistants/templates.service.ts:356` — root — tables: `assistant_templates` — read — in-tx: no — listTemplates(): full registry (family='test' filtered in app)
- `src/modules/assistants/templates.service.ts:367` — withOrg — tables: `assistant_installs` — read — in-tx: yes — listInstalls(): org installs
- `src/modules/assistants/templates.service.ts:476` — withOrg — tables: `documents` — read — in-tx: yes — evaluateCompatibilityBatch(): READY-document count probe for knowledge-requiring templates (also delegates: toolCatalog.list → `tool_catalog`; modelCatalog.platformFacts → `model_catalog_entries`; configPublish.latest → `published_configs` in another module)

#### tool-catalog.service.ts (4)

- `src/modules/assistants/tool-catalog.service.ts:452` — withOrg — tables: `tool_catalog` — write — in-tx: yes — upsert(): insert + onConflictDoUpdate on (organization_id, name) (sealed credential stored via envelopeEncrypt)
- `src/modules/assistants/tool-catalog.service.ts:540` — withOrg — tables: `tool_catalog` — read — in-tx: yes — list(): enabled-only by default, capped 200
- `src/modules/assistants/tool-catalog.service.ts:552` — withOrg — tables: `tool_catalog` — read — in-tx: yes — get(): row by (org, name)
- `src/modules/assistants/tool-catalog.service.ts:569` — withOrg — tables: `tool_catalog` — write — in-tx: yes — setEnabled(): guarded update (404 on miss), audited

### Transaction boundaries

- **create TX** (`assistants.service.ts:140`): insert `assistants` → insert `assistant_versions` (DRAFT v=0). Atomic identity+draft; audit events written outside TX.
- **remove TX** (`assistants.service.ts:268`): select `conversations` (active probe) → delete `conversations` (archived/deleted) → delete `assistants`.
- **discardDraft TX** (`assistants.service.ts:577`): select `eval_runs` (provenance probe) → select `runs` (non-test probe) → delete `runs` (test only) → delete `assistant_versions` (draft).
- **publish TX** (`assistants.service.ts:827`): `pg_advisory_xact_lock('assistant:{id}')` → selects on `assistant_versions` → manifest resolution (`tool_catalog`, `documents`, `chunks`, `embeddings` via caller tx; `model_catalog_entries` via **db.root, outside TX**; `assistant_installs`, `assistant_templates` via caller tx) → no-op/BLOCK/required-check gates (raw SQL on `assistants`/`assistant_versions`/`policy_snapshots`, `assistant_installs`/`assistant_templates`, `eval_runs`) → insert `assistant_versions` (PUBLISHED) → insert `policy_snapshots` → update `assistants` (active_version_id, degraded columns).
- **retire TX** (`assistants.service.ts:915`): advisory xact lock → select `assistants` (active-pointer guard) → guarded update `assistant_versions` → RETIRED.
- **rollback TX** (`assistants.service.ts:994`): same shape as publish TX, with rollback_of lineage and parent_version_id = target.
- **getSnapshotForVersion TX** (`assistants.service.ts:1064`): select `assistant_versions` → select `policy_snapshots` (hash match).
- **ensureVersionSnapshot TX** (`assistants.service.ts:1504`): select `assistant_versions` → select `policy_snapshots` (idempotence probe) → manifest resolution → insert `policy_snapshots` on-conflict-do-nothing on (assistant_version_id, hash).
- **setRelease TX** (`rollouts.service.ts:83`): raw-SQL `select 1 from assistants` → select `assistant_installs` → select `template_platform_blocks` → per variant: select `assistant_versions`, findActiveBlock on `control_blocks`, select `eval_runs` → update `assistant_rollouts` (pause current at address) → insert `assistant_rollouts` (active).
- **install TX** (`templates.service.ts:255`): findActiveTemplateBlock on `control_blocks` → insert `assistants` → insert `assistant_versions` (DRAFT) → insert `assistant_installs` → insert `outbox_events` (template.install_provisioning, same TX per invariant 7).
- **set TX** (`control-blocks.service.ts:71`): findActiveBlock probe on `control_blocks` → insert `control_blocks`.
- **checkAndMaybeRollback cost TX** (`burn-rate.service.ts:167`): two raw SQL cost sums on `usage_ledger_entries` (1h, 24h).
- **checkAndMaybeRollback pause TX** (`burn-rate.service.ts:216`): select `assistants` (existence) → guarded update `assistant_rollouts` → paused.
- **sweep overdue TX** (`assistants.service.ts:1888`, withBypass): raw SQL `select ... from assistants ... for update skip locked` (degraded_until past).
- **sweep due-soon TX** (`assistants.service.ts:1915`, withBypass): raw SQL select with `for update skip locked` (degraded within 24h, never alerted).
- **sweep mark-alerted TX** (`assistants.service.ts:1931`, withBypass): raw SQL guarded `update assistants set degraded_alerted_at = now()`.
- **installs inventory TX** (`fleet.staff.controller.ts:119`, withBypass): single raw SQL cross-org select on `assistant_installs`.
- All other withOrg calls are single-statement transactions (insert/select/update/delete inside one TX each).

### Raw SQL / special patterns

- **Raw SQL (`.execute(sql`...`)`)**:
  - `burn-rate.service.ts:66` — db.root: cross-org sweep over `assistant_rollouts` + `usage_ledger_entries`
  - `burn-rate.service.ts:120` — db.root: latest auto_rollback audit for (tenant, assistant) on `audit_events`
  - `burn-rate.service.ts:167` — tx (withOrg): two cost-sum queries on `usage_ledger_entries`
  - `assistants.service.ts:702` — tx (withOrg): chunk/embedding coverage aggregate on `chunks`+`embeddings` (VALUES join)
  - `assistants.service.ts:829, 917, 996` — tx (withOrg): `pg_advisory_xact_lock(hashtext('assistant:{id}'))` (publish/retire/rollback serialization)
  - `assistants.service.ts:1888, 1915` — tx (withBypass): cross-org selects on `assistants` with `for update skip locked`
  - `assistants.service.ts:1931` — tx (withBypass): guarded `update assistants set degraded_alerted_at = now()`
  - `assistants.service.ts:2027` (rejectNoOpPublish) — tx: active-hash/manifest-hash join across `assistants`/`assistant_versions`/`policy_snapshots`
  - `release-gate.ts:90, 113` (evaluatePublishGate, called inside publish/rollback TX): release_policy join `assistant_installs`×`assistant_templates`; latest eval decision on `eval_runs` keyed by content hash
  - `rollouts.service.ts:83` — tx (withOrg): `select 1 from assistants where id = ... and organization_id = ...`
  - `fleet.staff.controller.ts:119` — tx (withBypass): cross-org inventory select on `assistant_installs`
  - `fleet.staff.controller.ts:151` — db.root: `select ... from audit_events where action = 'template.registry_synced'`
- **Row-level locks**: `for update skip locked` in the two sweep selects (`assistants.service.ts:1888, 1915`) — worker claim pattern. No other `FOR UPDATE`.
- **Advisory locks**: `pg_advisory_xact_lock` per assistant id in publish/retire/rollback (`assistants.service.ts:829, 917, 996`) — serializes concurrent lifecycle transitions; xact-scoped (released at commit).
- **onConflict upserts**: `fleet.staff.controller.ts:62` (doNothing on platform block insert); `model-catalog.service.ts:123` (doUpdate on (provider, model_id)); `model-cost.service.ts:83` (doUpdate on (provider, model, effective_from)); `provider-credentials.service.ts:360` (doUpdate on (organization_id, provider)); `tool-catalog.service.ts:485` (doUpdate on (organization_id, name)); `assistants.service.ts:1585` (doNothing on (assistant_version_id, hash) — concurrent snapshot synthesis).
- **RLS-sensitive**:
  - db.root reads on documented GLOBAL tables (no RLS by design): `assistant_templates`, `model_catalog_entries`, `model_cost_entries`, `template_platform_blocks`, `audit_events` — all carry explicit "global table, no tenant context" comments.
  - ⚠ `model-catalog.service.ts:204` — tenant-owned `published_configs` read via **db.root** (org_id predicate in SQL, but no RLS tenant context) for the residency pin.
  - ⚠ `burn-rate.service.ts:66, 120` — cross-org reads via db.root (sweep + audit lookup); worker-scoped by design but unscoped at the SQL layer.
  - `assistants.service.ts:1888/1915/1931`, `fleet.staff.controller.ts:119` — cross-org via withBypass (the audited narrow lane); sweep is org-scopable via optional input filter.
  - `manifest-resolution.service.ts:449` — `model_catalog_entries` read via db.root happens OUTSIDE the caller's publish TX (global read, no atomicity with the publish commit).
  - publish/rollback guards: `evaluatePublishGate` and `rejectNoOpPublish` join `assistant_installs`×`assistant_templates` and `assistants` inside the tenant TX (RLS applies); `rollouts.service.ts:83` raw-SQL assistant existence probe carries an explicit `organization_id` predicate.
- **Cross-module DB notes**: assistants.service calls `configPublish.latest` (→ `published_configs` in config-publish module) and `modelCatalog.listEntries` (→ db.root) during publish; `templates.service` compatibility reads `tool_catalog` + `model_catalog_entries` + `published_configs` across services. `ModelCostService.latestForRunPricing` is called with the conversations module's TX (no direct DbService use).

### Totals

- call sites: 80 (withOrg: 52, withBypass: 4, root: 24, root.transaction: 0, check: 0, withSerializable: 0)
- files with DB access: 11 of 36 non-test files
- distinct SQL tables touched: `assistants`, `assistant_versions`, `policy_snapshots`, `assistant_rollouts`, `assistant_templates`, `assistant_installs`, `control_blocks`, `template_platform_blocks`, `model_catalog_entries`, `model_cost_entries`, `provider_credentials`, `provider_enablements`, `tool_catalog`, `conversations`, `runs`, `eval_runs`, `eval_datasets`, `documents`, `chunks`, `embeddings`, `published_configs`, `outbox_events`, `usage_ledger_entries`, `audit_events` (24)
- raw SQL sites: 13 (incl. 3 advisory locks)
- advisory locks: 3 (publish/retire/rollback on `assistant:{id}`)
- row-level locks: 2 (`for update skip locked` sweep selects)
- onConflict upserts: 6


## conversations — DB call-site inventory

Module: `src/modules/conversations/` (62 call sites; all files verified to inject `DbService`).
Table-name map (drizzle object → SQL): `conversations`→`conversations`, `conversationParticipants`→`conversation_participants`, `messages`→`messages`, `runs`→`runs`, `runEvents`→`run_events`, `conversationSummaries`→`conversation_summaries`, `messageFeedback`→`message_feedback`, `conversationShares`→`conversation_shares`, `escalations`→`escalations`, `runIdempotency`→`run_idempotency` (no direct call sites), `approvals`→`approvals`, `toolEffects`→`tool_effects`, `checkpoints`→`checkpoints`, `memoryProposals`→`memory_proposals`. Cross-module tables also touched: `outbox_events`, `run_manifests`, `idempotency_records`, `assistants`, `assistant_versions`, `policy_snapshots`, `tool_catalog`, `control_blocks`, `artifacts`, `provider_credentials`, `provider_enablements`, `model_catalog_entries`, `model_cost_entries`, `quota_reservations`, `usage_ledger_entries`, `product_entitlements`.

### Call sites

#### escalations.service.ts (6 — all withOrg, in-tx)
- `escalations.service.ts:47` · withOrg · `escalate` · tables `conversations` (read FOR UPDATE), `escalations` (read+write) · in-tx yes · op read+write — Lock conversation row, replay-check open WAITING/CLAIMED escalation, insert `escalations` row (composeBrief reads transcript in-TX), set conversation status escalated, insert `run_events` row.
- `escalations.service.ts:205` · withOrg · `listQueue` · `escalations` read · in-tx yes · op read — List open escalations for org (queue view).
- `escalations.service.ts:216` · withOrg · `get` · `escalations` read · in-tx yes · op read — Fetch one escalation by id.
- `escalations.service.ts:249` · withOrg · `transitionToClaimed` · `escalations` read (FOR UPDATE)+write · in-tx yes · op read+write — CAS-style claim: lock row, verify state=WAITING (replay if already claimed by same agent), set CLAIMED + outbox_events `conversation.escalation.claimed`.
- `escalations.service.ts:300` · withOrg · `resolve` · `escalations` + `conversations` read+write · in-tx yes · op read+write — CLAIMED→RESOLVED; resume auto-responder (conversation status→active).
- `escalations.service.ts:395` · withOrg · `agentReply` · `messages` write, `conversations` read (FOR UPDATE) · in-tx yes · op read+write — Human-agent reply insert; conversation row locked for sequence allocation.

#### conversations.service.ts (25 — 24 withOrg in-tx, 1 withBypass in-tx)
- `conversations.service.ts:127` · withOrg · `createConversation` · `assistants` raw-SQL read, `conversations` + `conversation_participants` write · in-tx yes · op read+write — Raw SQL existence check on `assistants`, then insert `conversations` + `conversation_participants`.
- `conversations.service.ts:171` · withOrg · `getConversation` · `conversations` read · in-tx yes · op read.
- `conversations.service.ts:191` · withOrg · `listConversations` · `conversations` read · in-tx yes · op read.
- `conversations.service.ts:209` · withOrg · `setConversationStatus` · `conversations` write · in-tx yes · op write.
- `conversations.service.ts:308` · withOrg · `acceptMessage` · **RUN-ACCEPTANCE TX** (see Transaction boundaries) · in-tx yes · op read+write.
- `conversations.service.ts:948` · withOrg · `regenerateMessage` · `messages` read, `runs` write, `conversations` write · in-tx yes · op read+write — Regeneration acceptance: new run row + supersede pointer on old message + conversation version bump (idempotent claim inside).
- `conversations.service.ts:1175` · withOrg · `editMessage` · `messages` read+write, `runs` write, `conversations` write · in-tx yes · op read+write — User message edit: mark original edited, insert replacement message + new run, bump version.
- `conversations.service.ts:1448` · withOrg · `listMessages` · `messages` read · in-tx yes · op read.
- `conversations.service.ts:1466` · withOrg · `getRun` · `runs` read · in-tx yes · op read.
- `conversations.service.ts:1480` · withOrg · `listRuns` · `runs` read · in-tx yes · op read.
- `conversations.service.ts:1527` · withOrg · `commitRunResult` · **COMMIT-RUN-RESULT TX** (see Transaction boundaries) · in-tx yes · op read+write.
- `conversations.service.ts:1839` · withOrg · `listApprovals` · `approvals` read · in-tx yes · op read.
- `conversations.service.ts:1885` · withOrg · `extendApproval` · `approvals` write · in-tx yes · op write — Extend approval expiry window.
- `conversations.service.ts:1929` · withOrg · `setPinned` · `messages` write · in-tx yes · op write — Pin/unpin a message.
- `conversations.service.ts:1984` · withOrg · `createShare` · `conversations` read, `conversation_shares` write · in-tx yes · op read+write — Create public share link (validates conversation first).
- `conversations.service.ts:2021` · withOrg · `listShares` · `conversation_shares` read · in-tx yes · op read.
- `conversations.service.ts:2043` · withOrg · `revokeShare` · `conversation_shares` write · in-tx yes · op write — Revoke a share (soft-disable).
- `conversations.service.ts:2096` · withBypass · `resolvePublicShare` · `conversation_shares` + `conversations` + `messages` read · in-tx yes · op read — **RLS-sensitive**: public share resolution runs with RLS bypass (unauthenticated reader); scoping enforced by share token, not tenant context.
- `conversations.service.ts:2161` · withOrg · `setTitle` · `conversations` write · in-tx yes · op write.
- `conversations.service.ts:2203` · withOrg · `recordFeedback` · `messages` read, `message_feedback` write (onConflict) · in-tx yes · op read+write — Upsert message rating.
- `conversations.service.ts:2282` · withOrg · `consecutiveNegativeStreak` · `message_feedback` JOIN `messages` raw-SQL read · in-tx yes · op read — Raw SQL streak query over last N feedback rows.
- `conversations.service.ts:2308` · withOrg · `cancelRun` · `runs` read+write, `run_events` write, `approvals` write, `quota_reservations` raw-SQL write · in-tx yes · op read+write — Cancel run: insert `run_events` cancel row, runs→CANCELED, settleRunQuota→RELEASED, cancel pending approvals.
- `conversations.service.ts:2427` · withOrg · `failRunForBudget` · `runs` read (FOR UPDATE)+write, `run_events` write · in-tx yes · op read+write — Budget-kill: runs→FAILED + terminal event.
- `conversations.service.ts:2528` · withOrg · `listRunEvents` · `run_events` read · in-tx yes · op read.
- `conversations.service.ts:2576` · withOrg · `streamRunEvents` · `runs` + `run_events` read · in-tx yes · op read — SSE poll tick: each poll opens its own short TX reading run row + new events after cursor.

#### mcp-authority.service.ts (31 — 28 withOrg in-tx, 2 withBypass in-tx, 1 root tx-less)
- `mcp-authority.service.ts:107` · withOrg · `acquireOrRenewRunLease` · `runs` read (FOR UPDATE)+write · in-tx yes · op read+write — **Lease CAS**: lock run row, verify expectedEpoch + owner match, bump leaseEpoch, set owner/expiry/heartbeat. `runs.version` deliberately NOT bumped (fencing domain).
- `mcp-authority.service.ts:151` · withOrg · `releaseRunLease` · `runs` read (FOR UPDATE)+write · in-tx yes · op read+write — Epoch-checked lease release (clears owner/expiry).
- `mcp-authority.service.ts:183` · withOrg · `getRun` · `runs` read · in-tx yes · op read.
- `mcp-authority.service.ts:249` · withOrg · `failRun` · `runs` read+write, `run_events` write, `quota_reservations` raw-SQL write · in-tx yes · op read+write — Run failure: insert terminal event, runs→FAILED, raw SQL release RESERVED quota rows.
- `mcp-authority.service.ts:378` · withOrg · `appendRunEvents` · `runs` read (FOR UPDATE)+write, `run_events` write (onConflictDoNothing on (run_id, event_id)) · in-tx yes · op read+write — Append durable run events with idempotent dedup; bumps runs.lastEventSequence.
- `mcp-authority.service.ts:503` · withOrg · `listRunEvents` · `run_events` read · in-tx yes · op read.
- `mcp-authority.service.ts:529` · withOrg · `createApprovalRequest` · `approvals` write, `runs` read (FOR UPDATE)+write, `messages` read · in-tx yes · op read+write — Create approval + mark run awaiting approval.
- `mcp-authority.service.ts:632` · withOrg · `requestHumanHandoff` (pt1) · `runs` read · in-tx yes · op read — Validate run for handoff.
- `mcp-authority.service.ts:649` · withOrg · `requestHumanHandoff` (pt2) · `conversations` read · in-tx yes · op read — Validate conversation for handoff.
- `mcp-authority.service.ts:723` · withOrg · `putRunArtifact` · `artifacts` write · in-tx yes · op write — Register run artifact (claim-check pointer).
- `mcp-authority.service.ts:764` · withOrg · `getToolCredential` · `runs` + `policy_snapshots` + `tool_catalog` read · in-tx yes · op read — Resolve tool credential binding from pinned snapshot.
- `mcp-authority.service.ts:851` · withOrg · `getModelCredential` · `runs` + `policy_snapshots` + `provider_enablements` + `provider_credentials` read · in-tx yes · op read — Resolve model credential incl. BYOK source.
- `mcp-authority.service.ts:975` · withOrg · `getLatestCheckpoint` · `checkpoints` + `artifacts` read · in-tx yes · op read.
- `mcp-authority.service.ts:1035` · withOrg · `getApprovalState` · `approvals` read · in-tx yes · op read.
- `mcp-authority.service.ts:1082` · withOrg · `decideApproval` · `approvals` read (FOR UPDATE)+write, `runs` write, `quota_reservations` raw-SQL write · in-tx yes · op read+write — Approval decision CAS: lock approval, verify PENDING + window, write decision, resume/deny run, raw SQL release quota on denial.
- `mcp-authority.service.ts:1398` · withBypass · `sweepExpiredApprovals` (claim phase) · `approvals` raw-SQL read FOR UPDATE SKIP LOCKED · in-tx yes · op read — **RLS-sensitive**: cross-org sweep claims overdue PENDING approvals with SKIP LOCKED (safe under concurrent sweep replicas).
- `mcp-authority.service.ts:1416` · withBypass · `sweepExpiredApprovals` (per-approval TX) · `approvals` + `runs` + `quota_reservations` raw-SQL read+write · in-tx yes · op read+write — Per approval: re-verify FOR UPDATE, approvals→EXPIRED, runs→CANCELED (terminal_reason approval_expired), release quota_reservations, expire sibling PENDING approvals. withBypass because claimed rows may span orgs.
- `mcp-authority.service.ts:1566` · withOrg · `submitMemoryProposal` · `memory_proposals` write · in-tx yes · op write.
- `mcp-authority.service.ts:1634` · withOrg · `authorizeToolCall` · `runs` + `policy_snapshots` + `tool_catalog` + `assistant_versions` + `assistants` read, `tool_effects` write · in-tx yes · op read+write — Tool authorization: pinned binding resolve + dedup, record `tool_effects` authorization row.
- `mcp-authority.service.ts:1899` · withOrg · `recordToolOutcome` · `tool_effects` write · in-tx yes · op write.
- `mcp-authority.service.ts:1950` · withOrg · `saveCheckpointRef` · `checkpoints` write · in-tx yes · op write.
- `mcp-authority.service.ts:2010` · withOrg · `getRunArtifact` (pt1) · `artifacts` read · in-tx yes · op read.
- `mcp-authority.service.ts:2022` · withOrg · `getRunArtifact` (pt2) · `checkpoints` + `tool_effects` raw-SQL read · in-tx yes · op read — Ownership check via UNION ALL raw SQL (checkpoint or tool-effect must reference the artifact).
- `mcp-authority.service.ts:2150` · root · `activeModelCatalogRows` · `model_catalog_entries` read · in-tx **no** · op read — Bare-root read of `model_catalog_entries` (catalog has no RLS; tx-less single statement).
- `mcp-authority.service.ts:2276` · withOrg · `getAuthorizedRunContext` · `runs` + `policy_snapshots` + `messages` + `assistant_versions` + `conversation_summaries` + `tool_catalog` + `control_blocks` read · in-tx yes · op read — Assemble pinned run context (7-table read).
- `mcp-authority.service.ts:2760` · withOrg · `pinnedVersionIdsForRun` (pt1) · `runs` read · in-tx yes · op read.
- `mcp-authority.service.ts:2771` · withOrg · `pinnedVersionIdsForRun` (pt2) · `policy_snapshots` read · in-tx yes · op read.
- `mcp-authority.service.ts:2785` · withOrg · `runActorAccountId` (pt1) · `runs` read · in-tx yes · op read.
- `mcp-authority.service.ts:2796` · withOrg · `runActorAccountId` (pt2) · `messages` read · in-tx yes · op read.
- `mcp-authority.service.ts:2852` · withOrg · `recordRetrievalEvent` · `run_events` write (onConflictDoNothing on (run_id, event_id)) · in-tx yes · op write — Insert retrieval citation event; callable with an existing tx or opens its own.
- `mcp-authority.service.ts:2876` · withOrg · `saveConversationSummary` · `conversations` read, `conversation_summaries` write (onConflict) · in-tx yes · op read+write — Idempotent summary insert keyed (conversation_id, source_sequence); digest mismatch → conflict.

### Transaction boundaries

**T1 — Run acceptance** (`acceptMessage`, conversations.service.ts:308; body `executeStartMessage` + idempotency helpers). One withOrg TX does, in order:
1. `claimIdempotency` — insert `idempotency_records` … onConflictDoNothing + select (replay short-circuit).
2. select `conversations` **FOR UPDATE** (serializes sequence allocation + one-active-turn).
3. `assertAssistantRunnable` — raw SQL select on `assistants` (+ rollout raw SQL on `assistant_versions`/`policy_snapshots` in `pinExplicitVersion`/`pickVersionPin`).
4. `nextMessageSequence` — raw SQL `select coalesce(max(sequence),0)+1 from messages where conversation_id=…`.
5. insert `messages` (user message).
6. insert `runs` state=ACCEPTED (unique-violation guard on `uq_runs_one_active_per_conversation` → 409).
7. `reserveQuota` — select `product_entitlements`; raw SQL counts over `usage_ledger_entries` + `quota_reservations`; insert `quota_reservations` (state=RESERVED, dimension='requests', 15-min TTL). REL-4.3: reservation commits with the run or not at all.
8. `insertRunManifest` — insert `run_manifests`.
9. `recordOutboxEvent` — insert `outbox_events` (`run.created`, same trace id).
10. `completeIdempotency` — update `idempotency_records` with response.
11. update `conversations` (version+1).
Tables in TX: `idempotency_records`, `conversations`, `assistants`, `assistant_versions`, `policy_snapshots`, `messages`, `runs`, `product_entitlements`, `usage_ledger_entries`, `quota_reservations`, `run_manifests`, `outbox_events`.

**T2 — CommitRunResult** (`commitRunResult`, conversations.service.ts:1527). One withOrg TX:
1. select `runs` **FOR UPDATE**; replay short-circuit if already COMPLETED; lease-epoch + run-version CAS checks.
2. select `conversations` **FOR UPDATE**; `nextMessageSequence` raw SQL.
3. Raw SQL reads on `run_events` (retrieval citations event '5', media event '13'); select `artifacts` ownership check per media ref.
4. insert `messages` (assistant reply); conditional update `messages` set superseded_by (regeneration pointer).
5. insert `run_events` (`run.completed`); update `runs` → COMPLETED (result_message_id, version+1); update `conversations` version+1.
6. `settleRunQuota` — raw SQL `update quota_reservations set state='COMMITTED', committed_at=now() where run_id=… and state='RESERVED'`.
7. `ModelCostService.latestForRunPricing(tx,…)` — select `model_cost_entries` (exact provider/model, effective, not retired); select `provider_credentials` (BYOK source); insert `usage_ledger_entries` (`usage_event_id='commit:<runId>'`, idempotency_key `commit-usage:<runId>`) — **skipped for test/eval runs and when totalTokens=0**.
8. `recordOutboxEvent` — insert `outbox_events` (`run.completed`).
Tables in TX: `runs`, `conversations`, `run_events`, `messages`, `artifacts`, `quota_reservations`, `model_cost_entries`, `provider_credentials`, `usage_ledger_entries`, `outbox_events`.

**T3 — Approval expiry sweep** (`sweepExpiredApprovals`, mcp-authority.service.ts:1398/1416). Two withBypass TXs: (a) claim: raw SQL `select … from approvals where … PENDING and expires_at<=now() … FOR UPDATE SKIP LOCKED`; (b) per approval: re-select `approvals` FOR UPDATE, update →EXPIRED; select `runs` FOR UPDATE, update →CANCELED; raw SQL release `quota_reservations`; select+update sibling PENDING `approvals` →EXPIRED. RLS bypass is load-bearing (cross-org worker).

**T4 — Run failure / cancel / approval-deny quota release**: `failRun` (249), `cancelRun` (2308), `decideApproval` (1082) each do run-state transition + `run_events` insert + `settleRunQuota`/raw SQL `update quota_reservations set state='RELEASED' … where state='RESERVED'` in the SAME withOrg TX.

**T5 — Lease acquire/release** (107/151): select `runs` FOR UPDATE + epoch/owner CAS + update lease columns, single TX each.

**T6 — Escalation lifecycle**: `escalate` (47) — conversation FOR UPDATE + open-escalation check + insert `escalations` + status flip + `run_events`; `transitionToClaimed` (249) — escalation FOR UPDATE + CLAIMED + outbox event; `resolve` (300) — RESOLVED + conversation→active.

**T7 — SSE poll** (2576): each poll tick is its own short withOrg TX (read `runs`, read new `run_events` after cursor).

### Raw SQL / special patterns
- Raw SQL via `tx.execute(sql\`…\`)`: conversations.service.ts:128-129 (`assistants` existence), :583-589 (version/snapshot pin), :629/642 (usage + spend aggregates), :677-680 (`settleRunQuota`), :756-757 (Redis hold? no — raw SQL quota hold select), :770 (rollout), :821 (active run check), :1029 (sequence bound), :1582/1608 (run_events citations/media), :2283 (feedback streak), :2636-2637 (nextMessageSequence). mcp-authority.service.ts:312 (failRun quota release), :453 onConflictDoNothing (runEvents), :1309 (decideApproval quota release), :1399/1419/1427/1452/1458/1466/1509/1517 (sweep), :2023 (artifact ownership union).
- Row-level locks (`.for('update')` = FOR UPDATE): escalations 52/254/305/347/401/447; conversations.service 214 (setConversationStatus), 365 (accept), 963 (regenerate), 1192 (edit), 1532/1568 (commit), 2313 (cancel), 2432 (failRunForBudget); mcp-authority 112/156 (lease), 254 (failRun), 383 (appendRunEvents), 544 (createApprovalRequest), 1087/1158 (decideApproval). Plus raw-SQL FOR UPDATE in the sweep.
- `onConflict` upserts: `appendRunEvents` (453) + `recordRetrievalEvent` → onConflictDoNothing (run_id, event_id); `recordFeedback` → upsert; `saveConversationSummary` → onConflict; claimIdempotency → onConflictDoNothing.
- Lease CAS: acquireOrRenewRunLease / releaseRunLease (epoch+owner compare under FOR UPDATE; version deliberately not bumped).
- RLS-sensitive: `resolvePublicShare` (2096 withBypass — unauthenticated path), `sweepExpiredApprovals` (1398/1416 withBypass — cross-org worker).
- No advisory locks in conversations module (Redis holds are advisory but out-of-band); no `db.check()` call sites; no `root.transaction`; one bare `root` read (2150).

### Totals
- call sites: 62 (withOrg: 58, withBypass: 3, root: 1, root.transaction: 0, check: 0)

## billing — DB call-site inventory

Module: `src/modules/billing/` (51 call sites; all files verified to inject `DbService`).
Table-name map: `usageLedgerEntries`→`usage_ledger_entries`, `quotaReservations`→`quota_reservations`, `providerReconciliationRuns`→`provider_reconciliation_runs`, `billingWebhookInbox`→`billing_webhook_inbox`, `billingCredits`→`billing_credits`, `billingCreditApplications`→`billing_credit_applications`, `billingBudgets`→`billing_budgets`, `billingInvoiceLines`→`billing_invoice_lines`, `billingAdjustments`→`billing_adjustments`, `spendEvents`→`billing.spend_events` (pgSchema 'billing'), `billingInvoices`→`billing.billing_invoices`, `priceCatalog`→`billing.price_catalog`. Cross-module: `tenants` (legacy), `projects`, `product_entitlements`.

### Call sites

#### anomaly.service.ts (1)
- `anomaly.service.ts:43` · withBypass · `scan` · `billing.spend_events` raw-SQL read · in-tx yes · op read — **RLS-sensitive**: cross-org 30-day daily cost rollup for anomaly detection (admin read).

#### billing-credits.service.ts (10 — 9 withOrg in-tx, 1 withBypass in-tx)
- `billing-credits.service.ts:39` · withOrg · `grantCredit` · `billing_credits` write · in-tx yes · op write — Insert credit grant.
- `billing-credits.service.ts:66` · withOrg · `listCredits` · `billing_credits` read · in-tx yes · op read.
- `billing-credits.service.ts:81` · withOrg · `balance` · `billing_credits` read · in-tx yes · op read — Sum remaining credit.
- `billing-credits.service.ts:129` · withOrg · `returnCreditFromInvoice` · `billing_credit_applications` read+write, `billing_credits` write · in-tx yes · op read+write — Void path: restore `remaining_usd` and delete application rows.
- `billing-credits.service.ts:292` · withOrg · `createAdjustment` · `billing_adjustments` write · in-tx yes · op write — Insert credit/debit note.
- `billing-credits.service.ts:328` · withOrg · `createBudget` · `billing_budgets` write · in-tx yes · op write.
- `billing-credits.service.ts:355` · withOrg · `listBudgets` · `billing_budgets` read · in-tx yes · op read.
- `billing-credits.service.ts:368` · withOrg · `deleteBudget` · `billing_budgets` write · in-tx yes · op write.
- `billing-credits.service.ts:381` · withBypass · `evaluateBudgets` (scan) · `billing_budgets` read · in-tx yes · op read — **RLS-sensitive**: hourly worker scans ALL orgs' budgets.
- `billing-credits.service.ts:405` · withOrg · `evaluateBudgets` (per-budget) · `billing_budgets` write · in-tx yes · op write — Per-org TX updates budget alert state after threshold evaluation.
- (tx-passing helpers, no direct DbService call — run inside callers' TX: `buildLineItems` raw SQL on `billing.spend_events` → insert `billing_invoice_lines`; `buildUsageLedgerLineItems` on `usage_ledger_entries` → insert `billing_invoice_lines`; `applyAdjustments` → insert `billing_invoice_lines`; `applyToInvoice` → update `billing_credits` + insert `billing_credit_applications`.)

#### billing-cycle.service.ts (2 — 1 withBypass in-tx, 1 withOrg in-tx)
- `billing-cycle.service.ts:41` · withBypass · `runForPreviousMonth` · `billing.spend_events` + `usage_ledger_entries` raw-SQL read · in-tx yes · op read — **RLS-sensitive**: cross-org union of satellite spend + ledger rows for previous-month invoice discovery.
- `billing-cycle.service.ts:91` · withOrg · `draftOne` · **INVOICE-DRAFT TX** (see Transaction boundaries) · in-tx yes · op read+write.

#### billing-extension.controller.ts (3 — all withOrg in-tx)
- `billing-extension.controller.ts:106` · withOrg · `listAdjustments` · `billing_adjustments` read · in-tx yes · op read.
- `billing-extension.controller.ts:144` · withOrg · `invoiceLines` · `billing_invoice_lines` read · in-tx yes · op read.
- `billing-extension.controller.ts:172` · withOrg · `usageExport` · `billing.spend_events` raw-SQL read · in-tx yes · op read — NDJSON export (10k row cap).

#### billing-reconciliation.service.ts (4 — 1 withOrg in-tx, 3 withBypass in-tx)
- `billing-reconciliation.service.ts:37` · withOrg · `runConsistencyPass` · `provider_reconciliation_runs` write, `usage_ledger_entries` raw-SQL read + write · in-tx yes · op read+write — Insert recon run; raw SQL finds orphan negatives + net-quantity mismatches, marks rows `reconciliationState='discrepant'`; updates run row with counts.
- `billing-reconciliation.service.ts:107` · withBypass · `ingestWebhook` · `billing_webhook_inbox` write (onConflict) · in-tx yes · op write — **Webhook inbox**: idempotent insert of provider webhook (dedupe on event key).
- `billing-reconciliation.service.ts:142` · withBypass · `markWebhookProcessed` · `billing_webhook_inbox` write · in-tx yes · op write.
- `billing-reconciliation.service.ts:151` · withBypass · `markWebhookRequiresReconciliation` · `billing_webhook_inbox` write · in-tx yes · op write.

#### billing.worker.ts (1)
- `billing.worker.ts:77` · withBypass · budget-eval job callback · `billing.spend_events` raw-SQL read · in-tx yes · op read — Month-to-date spend total per org/product for budget threshold checks (cross-org).

#### invoices.service.ts (5 — all withOrg in-tx)
- `invoices.service.ts:32` · withOrg · `list` · `billing.billing_invoices` read · in-tx yes · op read.
- `invoices.service.ts:41` · withOrg · `get` · `billing.billing_invoices` read · in-tx yes · op read.
- `invoices.service.ts:74` · withOrg · `createDraft` (existence check) · `billing.billing_invoices` read · in-tx yes · op read — Non-void existing draft for period → return as-is.
- `invoices.service.ts:92` · withOrg · `createDraft` (upsert) · `billing.billing_invoices` write (onConflictDoUpdate on (org_id, product, period_start)) · in-tx yes · op write — Insert draft or reset voided row to draft.
- `invoices.service.ts:148` · withOrg · `transition` · `billing.billing_invoices` write · in-tx yes · op write — draft→issued→paid / void state machine.

#### price-catalog.service.ts (3 — 2 root tx-less, 1 root.transaction in-tx)
- `price-catalog.service.ts:76` · root · `lookup` · `billing.price_catalog` read · in-tx **no** · op read — Cached effective-price lookup (tx-less single statement; catalog has no RLS).
- `price-catalog.service.ts:96` · root · `list` · `billing.price_catalog` read · in-tx **no** · op read.
- `price-catalog.service.ts:128` · root.transaction · `addVersion` · `billing.price_catalog` raw-SQL write + write · in-tx yes · op write — **TX on root (no RLS)**: raw SQL closes current effective row (`effective_to=…`), then inserts new price version — atomic version rotation.

#### quota.service.ts (1)
- `quota.service.ts:221` · withBypass · `reconcileMonth` · `billing.spend_events` raw-SQL read · in-tx yes · op read — **RLS-sensitive**: cross-org month-to-date aggregates resynced into Redis quota counters (DB read only; writes go to Redis).

#### spend-ingest.service.ts (3 — 1 withOrg in-tx, 2 root tx-less)
- `spend-ingest.service.ts:197` · withOrg · `ingest` · `billing.spend_events` write (onConflictDoNothing on (source, event_id)) · in-tx yes · op write — Satellite spend ingest with idempotent dedupe.
- `spend-ingest.service.ts:237` · root · `precheck` · `tenants` (legacy) read · in-tx **no** · op read — Bare-root org existence check (Python-owned table, no RLS; explicit id filters).
- `spend-ingest.service.ts:245` · root · `precheck` · `projects` read · in-tx **no** · op read — Bare-root project→org mapping (no RLS; explicit id filters).

#### stripe.service.ts (1)
- `stripe.service.ts:176` · withBypass · `handleEvent` · `billing.billing_invoices` write · in-tx yes · op write — **RLS-sensitive**: Stripe webhook marks invoice paid (status CAS draft/issued→paid). Note: does NOT go through `billing_webhook_inbox` — direct invoice update keyed by webhook metadata.

#### trial-expiry.service.ts (1)
- `trial-expiry.service.ts:32` · withBypass · `sweep` · `product_entitlements` read · in-tx yes · op read — **RLS-sensitive**: cross-org trial-expiry scan.

#### usage-ledger.service.ts (8 — 5 withOrg in-tx, 3 withBypass in-tx)
- `usage-ledger.service.ts:43` · withOrg · `append` · `usage_ledger_entries` write (onConflict) · in-tx yes · op write — Append ledger entry (idempotent).
- `usage-ledger.service.ts:109` · withOrg · `correct` · `usage_ledger_entries` read+write · in-tx yes · op read+write — Correction: insert reversal entry + mark original corrected.
- `usage-ledger.service.ts:160` · withOrg · `listForRun` · `usage_ledger_entries` read · in-tx yes · op read.
- `usage-ledger.service.ts:171` · withOrg · `netQuantity` · `usage_ledger_entries` raw-SQL read · in-tx yes · op read — `coalesce(sum(quantity),0)` by usage kind.
- `usage-ledger.service.ts:190` · withOrg · `reserve` · `quota_reservations` raw-SQL read + write · in-tx yes · op read+write — **Quota reservation**: `select pg_advisory_xact_lock(hashtext('quota:<org>:<dim>'))` (tx-scoped advisory lock serializes concurrent reserves), raw SQL sums active RESERVED rows, limit check, insert `quota_reservations` RESERVED.
- `usage-ledger.service.ts:229` · withBypass · `commit` · `quota_reservations` write · in-tx yes · op write — **CAS**: RESERVED→COMMITTED (0 rows → 409 conflict).
- `usage-ledger.service.ts:243` · withBypass · `release` · `quota_reservations` write · in-tx yes · op write — **CAS**: RESERVED→RELEASED (0 rows → 409).
- `usage-ledger.service.ts:258` · withBypass · `expireLapsed` · `quota_reservations` write · in-tx yes · op write — Reclaim: RESERVED→EXPIRED where `expires_at <= now()` (worker sweep).

#### usage-query.service.ts (7 — all withOrg in-tx)
- `usage-query.service.ts:79` · withOrg · `overview` (products) · `billing.spend_events` read · in-tx yes · op read — Per-product cost/events/token aggregates.
- `usage-query.service.ts:104` · withOrg · `overview` (projects) · `billing.spend_events` read · in-tx yes · op read — Per-project breakdown for queried products.
- `usage-query.service.ts:157` · withOrg · `rollup` · `billing.spend_events` read · in-tx yes · op read.
- `usage-query.service.ts:186` · withOrg · `ledgers` · `billing.spend_events` read · in-tx yes · op read.
- `usage-query.service.ts:229` · withOrg · `dailySeries` · `billing.spend_events` read · in-tx yes · op read.
- `usage-query.service.ts:257` · withOrg · `countByKind` · `billing.spend_events` read · in-tx yes · op read.
- `usage-query.service.ts:275` · withOrg · `periodTotal` · `billing.spend_events` read · in-tx yes · op read.

#### billing.module.ts (1)
- `billing.module.ts:73` · check · health registry registration `() => db.check()` · op n/a — Liveness probe only.

### Transaction boundaries

**T1 — Invoice draft** (`draftOne`, billing-cycle.service.ts:91). One withOrg TX:
1. select `billing.billing_invoices` (idempotency: existing non-void period invoice → null).
2. insert `billing.billing_invoices` (status=draft, total 0).
3. `credits.buildLineItems(tx,…)` — raw SQL aggregates `billing.spend_events` → insert `billing_invoice_lines`.
4. `credits.buildUsageLedgerLineItems(tx,…)` — aggregates `usage_ledger_entries` → insert `billing_invoice_lines` (agents-product leg).
5. `credits.applyAdjustments(tx,…)` — insert `billing_invoice_lines` for credit/debit notes.
6. `credits.applyToInvoice(tx,…)` — select+update `billing_credits` (decrement remaining), insert `billing_credit_applications`.
7. update `billing.billing_invoices` set total_usd.
Tables in TX: `billing.billing_invoices`, `billing.spend_events`, `billing_invoice_lines`, `usage_ledger_entries`, `billing_adjustments`, `billing_credits`, `billing_credit_applications`.

**T2 — Quota reservation lifecycle** (atomicity-critical):
- `reserve` (190, withOrg): advisory xact lock → sum check → insert RESERVED (all one TX).
- `commit` (229) / `release` (243) (withBypass): single-statement CAS updates RESERVED→COMMITTED/RELEASED with `.returning()`; zero rows → 409.
- `expireLapsed` (258, withBypass): bulk RESERVED→EXPIRED where expired.
- Cross-module participants: conversations-side `settleRunQuota` (raw SQL COMMITTED/RELEASED in T2 of conversations), `failRun`/`decideApproval`/sweep releasing to RELEASED, run-acceptance inserting RESERVED. **Note**: reservation insert happens in the conversations module's run-acceptance TX (withOrg), while commit/release/expire run withBypass — state column is the cross-TX coordination point.

**T3 — Billing webhook inbox** (billing-reconciliation.service.ts:107/142/151): `ingestWebhook` withBypass inserts `billing_webhook_inbox` with onConflict dedupe; `markWebhookProcessed` / `markWebhookRequiresReconciliation` flip status. **Gap flag**: `stripe.service.ts:176` handles Stripe webhooks WITHOUT the inbox (direct invoice update) — no dedupe record for payment events.

**T4 — Price version rotation** (`addVersion`, price-catalog.service.ts:128): `db.root.transaction` — raw SQL `update billing.price_catalog set effective_to=…` (close current) + drizzle insert of new version. No RLS (staff-managed catalog).

**T5 — Consistency pass** (`runConsistencyPass`, 37): withOrg TX inserts `provider_reconciliation_runs`, runs 3 raw-SQL audits over `usage_ledger_entries`, marks discrepant rows, updates the run row with counts — audit + findings commit atomically.

**T6 — Invoice create/transition** (invoices.service.ts:74/92/148): read-then-upsert (onConflictDoUpdate on (org_id, product, period_start)) and status-machine update are separate TXs (check-then-act across two withOrg calls — benign: upsert is conflict-safe; transition re-reads via `get`).

### Raw SQL / special patterns
- Raw SQL via `tx.execute(sql\`…\`)`: anomaly.service.ts:43 (cross-org spend rollup); billing-cycle.service.ts:41 (spend+ledger union); billing-extension.controller.ts:172 (usage export); billing-reconciliation.service.ts:37 (3 audit queries); billing.worker.ts:77 (budget spend total); price-catalog.service.ts:128 (close price version); quota.service.ts:221 (quota resync aggregates); usage-ledger.service.ts:171 (net quantity), :190 (advisory lock + reserved sum); billing-credits.service.ts buildLineItems (spend aggregates).
- `onConflict` upserts: spend-ingest (197) onConflictDoNothing (source, event_id); invoices createDraft (92) onConflictDoUpdate (org_id, product, period_start); usage-ledger append (43); webhook inbox ingest (107).
- **Advisory lock**: usage-ledger.service.ts:190 `select pg_advisory_xact_lock(hashtext('quota:<orgId>:<dimension>'))` — TX-scoped, serializes concurrent reserves per (org, dimension). (Comment notes a previous `sum(...) FOR UPDATE` was invalid SQL — aggregates can't take FOR UPDATE.)
- **Lease CAS**: quota commit/release (229/243) — `where id=… and state='RESERVED'` + returning-length check → 409 on stale state.
- RLS-sensitive (withBypass, cross-org/admin): anomaly scan, budget eval scan, cycle discovery, webhook inbox ×3, worker budget spend, quota reconcile, stripe handleEvent, trial sweep, quota commit/release/expireLapsed.
- Bare `root` reads (no RLS, no TX): price-catalog lookup/list (76/96), spend-ingest precheck on `tenants`/`projects` (237/245) — both justified in comments (no-RLS tables, explicit id filters).
- `db.check()` — health only (billing.module.ts:73). No `withSerializable` call sites.

### Totals
- call sites: 51 (withOrg: 32, withBypass: 13, root: 4, root.transaction: 1, check: 1)


## DB Call-Site Inventory — identity module

Repo: `~/workspace/neryva/neryva-engine` · `src/modules/identity/` · RESEARCH ONLY (no code changed)
Schema → SQL table names verified in `src/modules/identity/schema.ts`.
`db.withSerializable` hits: **0** (method does not exist on DbService).

### GRAND TOTAL: 96 call sites

| Method | Count |
|---|---|
| `db.root` | 90 |
| `db.root.transaction` | 4 |
| `db.withOrg` | 0 |
| `db.withBypass` | 1 |
| `db.check` | 1 |
| **Total** | **96** |

Per-file: account-actions 5 · account-deletion 8 · accounts 7 · credentials 2 · email-change 1 · email-code 6 · identity-public 3 · identity.module 2 · mfa 12 · oidc-adapter 32 · onboarding 2 · password 4 · social-account 12 = **96 ✓**

Table-key (schema object → SQL table): `accounts`→`accounts`, `accountOnboarding`→`account_onboarding`, `accountCredentials`→`account_credentials`, `accountRecoveryCodes`→`account_recovery_codes`, `accountIdentities`→`account_identities`, `oauthClients`→`oauth_clients`, `oauthSessions`→`oauth_sessions`, `oauthRefreshTokens`→`oauth_refresh_tokens`, `oauthGrants`→`oauth_grants`, `oidcPayloads`→`oidc_payloads`, `emailLoginCodes`→`email_login_codes`, `accountActionTokens`→`account_action_tokens`.
Cross-module tables (raw SQL): `notifications` (notifications module, platform-plane/no RLS), `org_group_members`, `org_memberships` (organizations module, tenant-scoped/RLS).

Read/write: R = read, W = write. "In tx" = the statement itself executes inside a DB transaction. (tx.* statements inside a `root.transaction`/`withBypass` callback are not db-method call sites and are not counted.)

### Per-file call sites

#### account-actions.service.ts — 5 (root×5)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| account-actions.service.ts:52 | root | `issue` | account_action_tokens | W (update, void old tokens) | no |
| account-actions.service.ts:58 | root | `issue` | account_action_tokens | W (insert) | no |
| account-actions.service.ts:89 | root | `consume` | account_action_tokens | W (update `.where(usedAt IS NULL).returning` — atomic single-use consume) | no |
| account-actions.service.ts:102 | root | `registerFailedAttempt` | account_action_tokens | W (update `attempts+1` via sql fragment) | no |
| account-actions.service.ts:112 | root | `findLive` (private) | account_action_tokens | R | no |

#### account-deletion.service.ts — 8 (root×7, withBypass×1)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| account-deletion.service.ts:76 | root | `request` | accounts | W (update: set deletedAt) | no |
| account-deletion.service.ts:109 | root | `cancel` | accounts | W (update: clear deletedAt) | no |
| account-deletion.service.ts:131 | root | `purgeDue` | accounts | R (due rows) | no |
| account-deletion.service.ts:159 | root | `purge` (private) | oauth_grants | W (delete; no FK to accounts) | no |
| account-deletion.service.ts:160 | root | `purge` (private) | notifications (cross-module) | W (raw SQL delete; notifications is platform-plane, no RLS) | no |
| account-deletion.service.ts:163 | withBypass | `purge` (private) | org_group_members, org_memberships (cross-module, tenant-scoped) | W (2 raw SQL deletes in one tx) | **yes** |
| account-deletion.service.ts:167 | root | `purge` (private) | accounts | W (delete; ON DELETE CASCADE takes credentials, recovery codes, identities, codes, sessions) | no |
| account-deletion.service.ts:183 | root | `deletionRow` (private) | accounts | R (deletedAt) | no |

#### accounts.service.ts — 7 (root×7)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| accounts.service.ts:23 | root | `findByEmail` | accounts | R | no |
| accounts.service.ts:28 | root | `findById` | accounts | R | no |
| accounts.service.ts:46 | root | `upsertByEmail` | accounts | W (insert onConflictDoNothing target: `accounts.email`) | no |
| accounts.service.ts:77 | root | `markLoginSuccess` | accounts | W (update lastLoginAt) | no |
| accounts.service.ts:82 | root | `markEmailVerified` | accounts | W (update emailVerifiedAt) | no |
| accounts.service.ts:89 | root | `updateDisplayName` | accounts | W (update) | no |
| accounts.service.ts:102 | root | `revokeAllSessions` | accounts | W (update sessionsRevokedAt kill-switch) | no |

#### credentials.service.ts — 2 (root×2)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| credentials.service.ts:59 | root | `getPasswordHash` | account_credentials | R (kind='password', revokedAt IS NULL) | no |
| credentials.service.ts:69 | root | `setPasswordHash` | account_credentials | W (insert onConflictDoUpdate target: (account_id, kind), targetWhere kind='password') | no |

#### email-change.service.ts — 1 (root.transaction×1)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| email-change.service.ts:134 | root.transaction | `confirm` | accounts | W (update email/emailVerifiedAt via tx; loser of citext-unique race surfaces as conflict) | **yes** |

#### email-code.service.ts — 6 (root×6)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| email-code.service.ts:45 | root | `issue` | email_login_codes | W (update: consume old codes) | no |
| email-code.service.ts:50 | root | `issue` | email_login_codes | W (delete: purge consumed/expired) | no |
| email-code.service.ts:59 | root | `issue` | email_login_codes | W (insert) | no |
| email-code.service.ts:75 | root | `verify` | email_login_codes | R (newest 20, hash compare in app) | no |
| email-code.service.ts:97 | root | `consume` | email_login_codes | W (update `.where(consumedAt IS NULL).returning` — atomic single-use) | no |
| email-code.service.ts:107 | root | `registerFailedAttempt` | email_login_codes | W (update `attempts+1` via sql fragment) | no |

#### identity-public.service.ts — 3 (root×3)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| identity-public.service.ts:28 | root | `isSessionActive` | oauth_sessions | R | no |
| identity-public.service.ts:43 | root | `isSessionActive` | accounts | R (status + sessionsRevokedAt kill-switch) | no |
| identity-public.service.ts:62 | root | `isActiveServiceClient` | oauth_clients | R | no |

#### identity.module.ts — 2 (check×1, root×1)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| identity.module.ts:78 | check | constructor (healthRegistry.register) | — (raw PG health query) | R | no |
| identity.module.ts:136 | root | `seedFirstPartyClients` (private, onModuleInit) | oauth_clients | W (insert onConflictDoUpdate target: `oauth_clients.client_id`) | no |

#### mfa.service.ts — 12 (root×9, root.transaction×3)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| mfa.service.ts:48 | root | `enroll` | account_credentials | W (update pending enrollment) | no |
| mfa.service.ts:53 | root | `enroll` | account_credentials | W (insert kind='totp_pending') | no |
| mfa.service.ts:91 | root.transaction | `activate` | account_credentials + accounts | W (tx: delete totp_pending row; insert kind='totp' onConflictDoUpdate target (account_id,kind), targetWhere kind='totp' — partial unique index; update accounts.mfa_level='totp') | **yes** |
| mfa.service.ts:139 | root.transaction | `disable` | account_credentials + account_recovery_codes + accounts | W (tx: delete totp row; delete totp_pending row; delete unused recovery codes; update accounts.mfa_level='none') | **yes** |
| mfa.service.ts:175 | root | `mintProof` | account_credentials | W (update lastUsedAt) | no |
| mfa.service.ts:187 | root.transaction | `regenerateRecoveryCodes` | account_recovery_codes | W (tx: delete all + insert 10 fresh) | **yes** |
| mfa.service.ts:244 | root | `verifyLoginFactor` | account_credentials | W (update lastUsedAt) | no |
| mfa.service.ts:252 | root | `status` | accounts | R (mfaLevel) | no |
| mfa.service.ts:255 | root | `status` | account_recovery_codes | R (count unused) | no |
| mfa.service.ts:270 | root | `activeCredential` (private) | account_credentials | R (kind='totp', revokedAt IS NULL) | no |
| mfa.service.ts:279 | root | `pendingCredential` (private) | account_credentials | R (kind='totp_pending') | no |
| mfa.service.ts:308 | root | `tryConsumeRecoveryCode` (private) | account_recovery_codes | W (update `.where(usedAt IS NULL).returning` — atomic single-use consume) | no |

#### oidc/oidc-adapter.ts — 32 (root×32)
Anonymous adapter closures (`adapterFor(name)` → upsert/find/findByUid/consume/destroy/revokeByGrantId) plus private helpers. All `self.db.root` / `this.db.root`, none in a tx.
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| oidc-adapter.ts:82 | root | `adapterFor` → `find` (Session) | oidc_payloads | R | no |
| oidc-adapter.ts:86 | root | `adapterFor` → `find` (GrantCode) | oauth_grants | R | no |
| oidc-adapter.ts:103 | root | `adapterFor` → `find` (RefreshToken) | oauth_refresh_tokens | R | no |
| oidc-adapter.ts:119 | root | `adapterFor` → `find` (RefreshToken full payload) | oidc_payloads | R | no |
| oidc-adapter.ts:140 | root | `adapterFor` → `find` (default) | oidc_payloads | R | no |
| oidc-adapter.ts:155 | root | `adapterFor` → `findByUid` | oidc_payloads | R (raw sql `payload->>'uid'` jsonb lookup) | no |
| oidc-adapter.ts:174 | root | `adapterFor` → `consume` (GrantCode) | oauth_grants | W (update consumedAt) | no |
| oidc-adapter.ts:180 | root | `adapterFor` → `consume` (default) | oidc_payloads | W (update consumedAt) | no |
| oidc-adapter.ts:191 | root | `adapterFor` → `destroy` (RefreshToken) | oauth_refresh_tokens | W (update revokedAt) | no |
| oidc-adapter.ts:195 | root | `adapterFor` → `destroy` (RefreshToken) | oidc_payloads | W (delete) | no |
| oidc-adapter.ts:200 | root | `adapterFor` → `destroy` (GrantCode) | oauth_grants | W (delete) | no |
| oidc-adapter.ts:203 | root | `adapterFor` → `destroy` (default) | oidc_payloads | W (delete) | no |
| oidc-adapter.ts:210 | root | `adapterFor` → `revokeByGrantId` | oauth_refresh_tokens | W (update revokedAt by grantId) | no |
| oidc-adapter.ts:211 | root | `adapterFor` → `revokeByGrantId` | oidc_payloads | W (delete by grantId) | no |
| oidc-adapter.ts:220 | root | `findClient` | oauth_clients | R | no |
| oidc-adapter.ts:256 | root | `syncSessionRow` (private) | oauth_sessions | W (insert onConflictDoUpdate target: `oauth_sessions.sid`) | no |
| oidc-adapter.ts:266 | root | `revokeSession` (private) | oauth_sessions | R | no |
| oidc-adapter.ts:267 | root | `revokeSession` (private) | oidc_payloads | W (delete Session payload) | no |
| oidc-adapter.ts:268 | root | `revokeSession` (private) | oauth_sessions | W (update revokedAt) | no |
| oidc-adapter.ts:288 | root | `sessionUidForRefreshToken` (private) | oidc_payloads | R | no |
| oidc-adapter.ts:307 | root | `isTokenNewerThanRevocation` (private) | accounts | R (sessionsRevokedAt kill-switch check) | no |
| oidc-adapter.ts:324 | root | `upsertRefreshToken` (private) | oauth_refresh_tokens | R (prev expiry for cap) | no |
| oidc-adapter.ts:331 | root | `upsertRefreshToken` (private) | oauth_refresh_tokens | R (existing expiry for cap) | no |
| oidc-adapter.ts:338 | root | `upsertRefreshToken` (private) | oauth_refresh_tokens | W (insert onConflictDoUpdate target: `oauth_refresh_tokens.jti`) | no |
| oidc-adapter.ts:354 | root | `upsertRefreshToken` (private) | oauth_refresh_tokens | W (mark rotatedFrom consumed) | no |
| oidc-adapter.ts:362 | root | `consumeRefreshTokenWithReuseDetection` (private) | oauth_refresh_tokens | R | no |
| oidc-adapter.ts:374 | root | `consumeRefreshTokenWithReuseDetection` (private, reuse path) | oauth_refresh_tokens | W (update revokedAt+retiredAt by familyId — family revocation) | no |
| oidc-adapter.ts:380 | root | `consumeRefreshTokenWithReuseDetection` (private, reuse path) | oauth_sessions | W (update revokedAt by sessionUid) | no |
| oidc-adapter.ts:400 | root | `consumeRefreshTokenWithReuseDetection` (private, normal path) | oauth_refresh_tokens | W (update consumedAt) | no |
| oidc-adapter.ts:408 | root | `resolveAccountForSessionUid` (private) | oauth_sessions | R | no |
| oidc-adapter.ts:419 | root | `upsertOidcPayload` (private) | oidc_payloads | W (insert onConflictDoUpdate target: (model, id)) | no |
| oidc-adapter.ts:429 | root | `upsertGrantCode` (private) | oauth_grants | W (insert; no conflict clause — PKCE codeHash PK, races fail) | no |

#### onboarding.service.ts — 2 (root×2)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| onboarding.service.ts:90 | root | `stateFor` | account_onboarding | R | no |
| onboarding.service.ts:125 | root | `complete` | account_onboarding | W (insert onConflictDoUpdate target: `account_onboarding.account_id`; first-wins `welcome_completed_at` via `coalesce(..., excluded.welcome_completed_at)`) | no |

#### password.service.ts — 4 (root×4)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| password.service.ts:233 | root | `listSessions` | oauth_sessions | R (unrevoked, 50 latest) | no |
| password.service.ts:253 | root | `revokeSession` | oauth_sessions | W (update `.where(sid, accountId, revokedAt IS NULL).returning`) | no |
| password.service.ts:287 | root | `revokeRefreshTokensForSession` (private) | oidc_payloads | R (raw sql `payload->>'sessionUid' = ...` jsonb lookup) | no |
| password.service.ts:295 | root | `revokeRefreshTokensForSession` (private) | oauth_refresh_tokens | W (update revokedAt where jti IN (...)) | no |

#### social/social-account.service.ts — 12 (root×12)
| file:line | method | enclosing fn | table(s) | R/W | in tx |
|---|---|---|---|---|---|
| social-account.service.ts:48 | root | `resolve` | account_identities | R (by provider+subject) | no |
| social-account.service.ts:54 | root | `resolve` | accounts | R | no |
| social-account.service.ts:59 | root | `resolve` | account_identities | W (update lastUsedAt/email) | no |
| social-account.service.ts:68 | root | `resolve` | accounts | R (by email, verified-email link) | no |
| social-account.service.ts:79 | root | `resolve` | accounts | W (insert onConflictDoNothing target: `accounts.email`) | no |
| social-account.service.ts:93 | root | `resolve` | accounts | R (race fallback after lost insert) | no |
| social-account.service.ts:116 | root | `linkIdentity` (private) | account_identities | W (insert onConflictDoUpdate target: (provider, subject)) | no |
| social-account.service.ts:141 | root | `listIdentities` | account_identities | R | no |
| social-account.service.ts:158 | root | `unlink` | account_identities | R | no |
| social-account.service.ts:166 | root | `unlink` | accounts | R | no |
| social-account.service.ts:168 | root | `unlink` | account_identities | R (remaining identities, lockout guard) | no |
| social-account.service.ts:178 | root | `unlink` | account_identities | W (delete) | no |

### Totals verification

Per-file: 5 + 8 + 7 + 2 + 1 + 6 + 3 + 2 + 12 + 32 + 2 + 4 + 12 = **96**.
By method: root 90 + root.transaction 4 + withOrg 0 + withBypass 1 + check 1 + withSerializable 0 = **96 ✓**

### Transaction boundaries (all 5)

1. **email-change.service.ts:134** `confirm` (`root.transaction`) — writes: `accounts` (email, emailVerifiedAt, updatedAt) for one row. Single-row atomic update; the citext-unique email race surfaces as a catch → 409. Nothing else in the tx.
2. **mfa.service.ts:91** `activate` (`root.transaction`) — writes: `account_credentials` (delete kind='totp_pending'; insert kind='totp' with partial-unique upsert), `accounts` (mfaLevel='totp'). Enrollment promotion is atomic.
3. **mfa.service.ts:139** `disable` (`root.transaction`) — writes: `account_credentials` (delete 'totp' + 'totp_pending' rows), `account_recovery_codes` (delete unused), `accounts` (mfaLevel='none'). MFA teardown is atomic.
4. **mfa.service.ts:187** `regenerateRecoveryCodes` (`root.transaction`) — writes: `account_recovery_codes` (delete all + insert 10). Old codes die atomically with the new set.
5. **account-deletion.service.ts:163** `purge` (`withBypass`) — writes: `org_group_members`, `org_memberships` (raw deletes, both tenant-scoped → bypass justified in comment: cross-tenant admin purge).

Notable **non-transactional multi-statement flows** (race-handled by unique constraints / atomic single statements instead):
- `accounts.service.upsertByEmail`: insert-onConflictDoNothing(accounts.email) + separate read; race loser re-reads.
- `social-account.service.resolve`: insert accounts + `linkIdentity` (separate insert into account_identities) — not atomic; identity-link race covered by (provider, subject) unique upsert.
- `oidc-adapter.upsertRefreshToken`: 2 reads + insert-upsert + optional update — rotation expiry capping (`clampRefreshExpiresAt`) is computed in JS across statements; no row lock.
- Token/code single-use consumes (`account-actions.consume:89`, `email-code.consume:97`, `mfa.tryConsumeRecoveryCode:308`, `password.revokeSession:253`) use single-statement `UPDATE ... WHERE <null-sentinel> RETURNING` — atomic at the statement level.

### Raw SQL / locks / upserts / PG-specific

- **Raw `sql` queries**: account-deletion.service.ts:160 (`delete from notifications where account_id = ...`), :164–165 (`delete from org_group_members ...`, `delete from org_memberships ...` — inside withBypass tx). All three are hand-written DELETEs on tables with no drizzle import in this module; `notifications`/`org_*` are cross-module.
- **Raw sql fragments in builder**: `attempts+1` increments (account-actions:102, email-code:107); jsonb `->>` lookups (oidc-adapter:155 `payload->>'uid'`, password.service:287 `payload->>'sessionUid'`); onboarding:141 `coalesce(welcome_completed_at, excluded.welcome_completed_at)` (PG upsert `excluded`).
- **FOR UPDATE row locks**: none. **pg_advisory locks**: none.
- **onConflict** (all PostgreSQL): accounts.service:52 `onConflictDoNothing` (target `accounts.email`); social-account:87 `onConflictDoNothing` (target `accounts.email`); credentials:72 `onConflictDoUpdate` (target (account_id, kind), targetWhere kind='password'); mfa:96 `onConflictDoUpdate` (target (account_id, kind), targetWhere kind='totp' — matches PARTIAL unique index excluding webauthn); onboarding:136 `onConflictDoUpdate` (target account_id, first-wins stamp); oidc-adapter:259 (target `oauth_sessions.sid`), :349 (target `oauth_refresh_tokens.jti`), :422 (target (model, id)); identity.module:147 (target `oauth_clients.client_id`); social-account:125 (target (provider, subject)).
- **PG-specific types/behavior**: `citext` email columns (case-insensitive unique, extension-created); `timestamptz` stored as µs-string in app (`mode: 'string'`); `jsonb` payloads with `->>` operator; `excluded.*` in upserts; uuid PKs (`gen_random_uuid()` v4 default); envelope-encrypted secret blobs (`enc:v1:` in `account_credentials.envelope`, `oauth_clients.secret_envelope`) — note `accountCredentials.secret` is a plain text column holding the argon2id PHC hash, envelope is a separate jsonb column.

### Cross-module table access

- `notifications` (notifications module): account-deletion.service.ts:160 raw delete — table is platform-plane (no RLS), safe.
- `org_group_members`, `org_memberships` (organizations module): account-deletion.service.ts:164–165 raw deletes inside `withBypass` — tenant-scoped; bypass is the documented, justified path (purge sweeps the account out of every org at once).

### RLS-sensitive paths

Identity schema header (`schema.ts:19`): **all identity tables are platform-plane — NOT tenant-scoped, no RLS** ("accounts are the company's credential store; the engine is the only writer"). Every `db.root` call on identity-owned tables is deliberate and documented in-code (e.g. onboarding.service.ts:91 "Justification (db.root)", accountOnboarding schema comment).
- Zero `db.withOrg` uses in the module — nothing is tenant-scoped.
- The single `withBypass` (account-deletion:163) is the honest cross-tenant delete of org tables.
- **MongoDB-migration flag**: there is no RLS on these tables to lose — identity is account-keyed (`eq(accountId)`), so the migration risk is the *cross-module* deletes (org tables), not missing tenant filters. One caveat: `purge`'s raw `delete from notifications` relies on the platform-plane (no-RLS) posture; if notifications ever gains tenant scoping, that statement must move into the withBypass tx.
- Reuse tripwire (`oidc-adapter.ts:374/380`) revokes a whole family by `familyId` + session by `sessionUid` — no tenant key involved; behavior is identical under MongoDB.

### Files importing/injecting DbService but never calling it

**None.** All 13 files that import/inject DbService contain ≥1 call site:
account-actions.service.ts, account-deletion.service.ts, accounts.service.ts, credentials.service.ts, email-change.service.ts, email-code.service.ts, identity-public.service.ts, identity.module.ts, mfa.service.ts, oidc/oidc-adapter.ts, onboarding.service.ts, password.service.ts, social/social-account.service.ts.
(Test file `onboarding.service.test.ts` references `db.root` only in comments/fixtures — no real call sites; other test files don't touch DbService.)

### Table list (identity module, SQL names)

`accounts`, `account_onboarding`, `account_credentials`, `account_recovery_codes`, `account_identities`, `oauth_clients`, `oauth_sessions`, `oauth_refresh_tokens`, `oauth_grants`, `oidc_payloads`, `email_login_codes`, `account_action_tokens`.


## DB Call-Site Inventory — `src/modules/knowledge/`

### Grand total

| Method | Count |
|---|---|
| `db.withOrg` | 60 |
| `db.withBypass` | 11 |
| `db.root` | 0 |
| `db.root.transaction` | 0 |
| `db.check()` | 0 |
| `db.withSerializable` | 0 |
| **TOTAL** | **71** |

Per-file: analytics.query.service.ts 1 · artifacts.service.ts 10 · connectors.service.ts 17 (16 withOrg + 1 withBypass) · eval.service.ts 20 · ingestion.service.ts 10 (all withBypass) · memory.service.ts 8 · retrieval.service.ts 5. Sum: 1+10+17+20+10+8+5 = **71** ✓. All 71 run inside a transaction (withOrg/withBypass always open a PG transaction). Zero callers of `db.root`, `db.check()`, `db.withSerializable` anywhere in the module.

Note: multi-statement blocks inside one `withOrg`/`withBypass` callback count as one call site; nested `withOrg` inside a `withOrg` callback (eval `startRun`'s outbox write, `completeRun`'s audit calls) is not a new `db.*` call — audit writes go through AuditService's own DbService, not counted here.

### Table list (module schema objects → SQL tables)

`src/modules/knowledge/schema.ts` → SQL:
- artifacts→`artifacts`, uploadSessions→`upload_sessions`, documents→`documents`, documentVersions→`document_versions`, chunks→`chunks`, embeddings→`embeddings`, retrievalAcl→`retrieval_acl`, memoryItems→`memory_items`, externalPrincipals→`external_principals`, externalIdentityLinks→`external_identity_links`, documentSourceAcls→`document_source_acls`

`src/modules/knowledge/connectors.schema.ts` → SQL:
- connectorAccounts→`connector_accounts`, connectorOAuthApps→`connector_oauth_apps`, connectorDocuments→`connector_documents`

`src/modules/knowledge/eval.schema.ts` → SQL:
- evalDatasets→`eval_datasets`, evalCases→`eval_cases`, evalRuns→`eval_runs`, runJudgments→`run_judgments`, evalCaseExecutions→`eval_case_executions`

Cross-module schema objects used (see "Cross-module table access"):
- `identity/schema`: accounts→`accounts`; `conversations/mcp.schema`: memoryProposals→`memory_proposals`; `lifecycle/lifecycle.schema`: legalHolds→`legal_holds`; `organizations/schema`: orgSettings→`org_settings`; `assistants/schema`: assistants→`assistants`, assistantVersions→`assistant_versions`, policySnapshots→`policy_snapshots`, assistantInstalls→`assistant_installs`, assistantTemplates→`assistant_templates`; `assistants/tool-catalog.schema`: toolCatalog→`tool_catalog`; `conversations/schema`: runs→`runs`; `common/infra/outbox/schema`: outboxEvents→`outbox_events`

---

### Call sites

Legend: R=read, W=write, B=both; TX = inside withOrg/withBypass transaction (always yes here).

#### analytics.query.service.ts — 1 (all withOrg)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 22 | withOrg | `rollups` | `analytics_rollups` (raw SQL `tx.execute`, 2 variants: with/without kind filter) | R | yes |

#### artifacts.service.ts — 10 (all withOrg)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 102 | withOrg | `createUploadSession` (verify re-ingest target) | `documents` select | R | yes |
| 123 | withOrg | `createUploadSession` (slug clash check) | `documents` select | R | yes |
| 160 | withOrg | `createUploadSession` (create) | `artifacts` insert + `upload_sessions` insert — atomic pair | W | yes |
| 216 | withOrg | `completeUploadSession` | `upload_sessions` select+update, `artifacts` select+update (verify-then-release; storage head-object check between) | B | yes |
| 260 | withOrg | `getUploadSession` | `upload_sessions` select | R | yes |
| 270 | withOrg | `listDocuments` | `documents`, `document_versions` (raw SQL w/ correlated max-version subquery) | R | yes |
| 293 | withOrg | `renameDocumentSourceSlug` | `documents` select + clash select + update (read-check-write in one TX) | B | yes |
| 364 | withOrg | `getDocumentPreview` | raw SQL gated auth check on `documents`+`artifacts`+`retrieval_acl`; select `documents`, `document_versions`, `chunks`; raw SQL count on `chunks` | R | yes |
| 442 | withOrg | `retireDocument` | `documents` select + update (tombstone to `retired`) | B | yes |
| 492 | withOrg | `dereference` | `artifacts` select | R | yes |

#### connectors.service.ts — 17 (16 withOrg + 1 withBypass)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 132 | withOrg | `link` | `connector_accounts` insert / onConflictDoUpdate | W | yes |
| 175 | withOrg | `list` | `connector_accounts` select | R | yes |
| 198 | withOrg | `setState` | `connector_accounts` update | W | yes |
| 223 | withOrg | `sync` (fresh account row) | `connector_accounts` select | R | yes |
| 267 | withOrg | `sync` (cursor update) | `connector_accounts` update (cursor, last_synced_at, state, last_error) | W | yes |
| 306 | withOrg | `ingestConnectorDocument` (mapping lookup) | `connector_documents` select | R | yes |
| 320 | withOrg | `ingestConnectorDocument` (stage into pipeline) | `artifacts` insert + `upload_sessions` insert (state UPLOADED) | W | yes |
| 357 | withOrg | `tombstoneExternalDocument` | `connector_documents` select; `documents` update (state retired); `document_source_acls` delete | B | yes |
| 380 | withBypass | `dueAccounts` | `connector_accounts` select — **cross-org sweep** (no org predicate; worker path) | R | yes |
| 464 | withOrg | `persistBundle` | `connector_accounts` update (sealed credential bundle) | W | yes |
| 482 | withOrg | `createOAuthApp` | `connector_oauth_apps` insert / onConflictDoUpdate | W | yes |
| 508 | withOrg | `listOAuthApps` | `connector_oauth_apps` select | R | yes |
| 516 | withOrg | `deleteOAuthApp` | `connector_oauth_apps` delete | W | yes |
| 520 | withOrg | `getOAuthApp` | `connector_oauth_apps` select | R | yes |
| 534 | withOrg | `authorizeUrl` | `connector_accounts` select | R | yes |
| 574 | withOrg | `handleOAuthCallback` | `connector_accounts` select (+ `persistBundle`→464 and `setState`→198 are separate withOrg calls after the provider HTTP exchange) | R | yes |
| 604 | withOrg | `recordError` | `connector_accounts` update (state error, last_error) | W | yes |

#### eval.service.ts — 20 (all withOrg)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 148 | withOrg | `createDataset` | `eval_datasets` insert (bare `onConflictDoNothing()`) | W | yes |
| 195 | withOrg | `addCases` | raw SQL max(sequence) on `eval_cases` + looped `eval_cases` inserts (sequence assigned in TX) | B | yes |
| 217 | withOrg | `listDatasets` | `eval_datasets` select | R | yes |
| 237 | withOrg | `listCases` | `eval_datasets` select + raw SQL count on `eval_cases` + `eval_cases` select (paged) | R | yes |
| 294 | withOrg | `updateCase` | `eval_cases` update | W | yes |
| 346 | withOrg | `deleteCase` | `eval_cases` delete (cascades to `eval_case_executions`) | W | yes |
| 382 | withOrg | `deleteDataset` | `eval_datasets` select + raw SQL count on `eval_runs` (refuse-if-referenced) + `eval_datasets` delete | B | yes |
| 431 | withOrg | `exportDataset` | `eval_datasets` + `eval_cases` selects | R | yes |
| 538 | withOrg | `importDataset` | `eval_datasets` select + raw SQL max(sequence) on `eval_cases` + looped `eval_cases` inserts | B | yes |
| 641 | withOrg | `promoteCandidateCase` | `eval_datasets` selects ×2, `eval_cases` select, raw SQL max(sequence), `eval_cases` insert + delete (copy-then-delete in one TX) | B | yes |
| 724 | withOrg | `rejectCandidateCase` | `eval_datasets` select + `eval_cases` delete | B | yes |
| 790 | withOrg | `startRun` | `assistant_versions` select (cross-module), `eval_datasets` select, `policy_snapshots`⋈`assistant_versions` select (cross-module), `eval_runs` insert, `outbox_events` insert via `recordOutboxEvent(tx)` (cross-module, same TX) — pin + run + outbox event atomic | B | yes |
| 906 | withOrg | `detectModelDrift` (assistant row) | `assistants` select (cross-module) | R | yes |
| 921 | withOrg | `detectModelDrift` (pin row) | `policy_snapshots`⋈`assistant_versions` select (cross-module) | R | yes |
| 995 | withOrg | `startShadowEval` (dedup check) | raw SQL select on `eval_runs` (24h window) | R | yes |
| 1020 | withOrg | `resolveTemplateDataset` (install row) | `assistant_installs` select (cross-module; private helper called by startShadowEval) | R | yes |
| 1035 | withOrg | `resolveTemplateDataset` (dataset row) | `eval_datasets` select | R | yes |
| 1047 | withOrg | `listRuns` | `eval_runs` select | R | yes |
| 1069 | withOrg | `completeRun` | reads: `eval_runs`, `assistant_versions`, `eval_datasets`, `assistant_installs`, `assistant_templates`, `tool_catalog` (cross-module), `policy_snapshots`, raw SQL on `eval_case_executions`⋈`runs`⋈`policy_snapshots` (cross-module); writes: `eval_runs` update (state/results/score/provenance/decision) — all decision inputs read + final write in ONE TX | B | yes |
| 1630 | withOrg | `evaluateRetrieval` | `eval_cases` select (calls `retrieval.searchKnowledge` separately — counted in retrieval.service.ts) | R | yes |

Note: `run_judgments` and `eval_case_executions` are never written by this module (judgments/executions are written by the Studio eval-worker through other paths); `run_judgments` has no call site at all in the module.

#### ingestion.service.ts — 10 (all withBypass; worker path, RLS bypass + cleared tenant context)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 105 | withBypass | `claimOne` | `upload_sessions` select `.for('update', { skipLocked: true })` + update `locked_at` — **cross-org claim** (no org predicate; stale-lock reclaim) | B | yes |
| 129 | withBypass | `releaseLock` | `upload_sessions` update (`locked_at=null`) | W | yes |
| 152 | withBypass | `scanStage` | `upload_sessions` update + `artifacts` update (scan_status/state, QUARANTINED or SCANNING) | W | yes |
| 170 | withBypass | `scannerOrThrow` | raw SQL `select object_key from artifacts` | R | yes |
| 183 | withBypass | `extractStage` | `upload_sessions` update (state EXTRACTING) | W | yes |
| 197 | withBypass | `indexStage` | reads: `documents` select `.for('update')`, `document_versions` select; writes: `documents` insert (onConflictDoNothing→uq_documents_source_artifact), `connector_documents` insert (onConflictDoNothing), `document_versions` insert (bare onConflictDoNothing), `chunks` delete+insert (idempotent rebuild), `embeddings` insert, `upload_sessions` update (state INDEXING). Full index build atomic. | B | yes |
| 353 | withBypass | `readyStage` | `upload_sessions` update (READY); `documents` update (state ready, embedding_model) + select; `retrieval_acl` insert (org visibility row); via `applySourceAcl`: `document_source_acls` delete, `external_principals` onConflictDoUpdate, `external_identity_links` insert, `accounts` select (cross-module) | B | yes |
| 402 | withBypass | `readyStage` (version list for audit) | `document_versions` select | R | yes |
| 514 | withBypass | `fail` | `upload_sessions` update (FAILED) + `documents` update (state failed; deliberately misses re-ingest version sessions) | W | yes |
| 531 | withBypass | `fetchObjectText` | raw SQL select from `artifacts` (object_key, content types) | R | yes |

Note: all withBypass call sites manually re-assert `organization_id` from the session row (except `claimOne` line 105, which intentionally scans cross-org). Org ownership is NOT enforced by RLS here.

#### memory.service.ts — 8 (all withOrg)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 71 | withOrg | `readMemoryPolicy` (private; called by decide/create/updateMemory/purgeByContent via applyScrubPolicy) | `org_settings` select (cross-module; `preferences` JSON) — fail-open to legacy | R | yes |
| 148 | withOrg | `decide` | `memory_proposals` select+update (decision) (cross-module), `memory_items` insert (with vector + model stamp) | B | yes |
| 263 | withOrg | `list` | `memory_items` select (deletedAt IS NULL + scope filters) | R | yes |
| 294 | withOrg | `create` | `memory_items` insert (user-authored, embedded) | W | yes |
| 360 | withOrg | `updateMemory` | `memory_items` update (content + re-embed + model stamp) | W | yes |
| 429 | withOrg | `purgeByContent` (legal-hold gate) | `legal_holds` select (cross-module) | R | yes |
| 453 | withOrg | `purgeByContent` (tombstone) | raw SQL `UPDATE memory_items SET deleted_at/invalid_at ... WHERE id IN (SELECT ... ilike ... LIMIT 1000) RETURNING id` — single atomic capped update | W | yes |
| 490 | withOrg | `softDelete` | `memory_items` update (deletedAt+invalidAt tombstone) | W | yes |

#### retrieval.service.ts — 5 (all withOrg)

| Line | Method | Function | Tables (SQL) | R/W | TX |
|---|---|---|---|---|---|
| 269 | withOrg | `searchKnowledge` | raw SQL: vector legs over `embeddings`⋈`chunks`⋈`document_versions`⋈`documents`⋈`artifacts` with `<=>` cosine-distance scoring + tenant/ACL/pin/model filters in the same WHERE; FTS legs over `chunks`⋈... with `websearch_to_tsquery`+`ts_rank_cd`; ACL predicate references `retrieval_acl`, `document_source_acls`, `external_identity_links`, `external_principals` | R | yes |
| 447 | withOrg | `searchApprovedMemories` | raw SQL on `memory_items` with `<=>` ordering + model-scope filter; top-up via `listApprovedMemoriesForScopes` (line 528 call site) | R | yes |
| 528 | withOrg | `listApprovedMemoriesForScopes` (private) | `memory_items` select (recency, scope OR-list) | R | yes |
| 559 | withOrg | `listApprovedMemories` | `memory_items` select (org/conversation scope) | R | yes |
| 592 | withOrg | `grantDocumentAccess` | `retrieval_acl` insert (bare `onConflictDoNothing()`) | W | yes |

---

### Transaction boundaries (atomic write sets)

Every withOrg/withBypass callback = one PG transaction. Multi-table atomic writes:
- `createUploadSession` (artifacts:160): `artifacts`+`upload_sessions` inserts.
- `completeUploadSession` (artifacts:216): read `upload_sessions`+`artifacts`, update both.
- `ingestConnectorDocument` (connectors:320): `artifacts`+`upload_sessions` inserts.
- `tombstoneExternalDocument` (connectors:357): `connector_documents` read; `documents` update + `document_source_acls` delete.
- `sync` cursor update (connectors:267): `connector_accounts` update — separate TX from the per-doc inserts (not atomic across the sync).
- `scanStage` (ingestion:152): `upload_sessions`+`artifacts` updates.
- `indexStage` (ingestion:197): `documents`+`document_versions`+`chunks`+`embeddings`+`connector_documents`+`upload_sessions` — one large atomic index build; version-append serialized by `FOR UPDATE` on `documents`.
- `readyStage` (ingestion:353): `upload_sessions`+`documents` updates + `retrieval_acl` insert + source-ACL replace (`document_source_acls` delete, `external_principals` upsert, `external_identity_links` insert).
- `fail` (ingestion:514): `upload_sessions`+`documents` updates.
- `claimOne` (ingestion:105): claim-select + `locked_at` update (lease under SKIP LOCKED row lock).
- `addCases` (eval:195) / `importDataset` (eval:538): max(sequence)+1 read + N `eval_cases` inserts — sequence assignment serialized by the TX (concurrent inserts serialize on transaction commit ordering; no explicit lock).
- `promoteCandidateCase` (eval:641): read source/target datasets, max(sequence), insert promoted case, delete candidate — atomic.
- `deleteDataset` (eval:382): run-count guard + `eval_datasets` delete.
- `startRun` (eval:790): pin resolution reads + `eval_runs` insert + `outbox_events` insert — atomic.
- `completeRun` (eval:1069): all decision reads (runs/versions/datasets/installs/templates/tool_catalog/snapshots/executions) + `eval_runs` update — atomic; guarded by `state in ('pending','running')` on the update.
- `decide` (memory:148): `memory_proposals` read+update + `memory_items` insert — atomic.
- `purgeByContent` (memory:453): single `UPDATE ... RETURNING` (no select-then-update race).
- `renameDocumentSourceSlug` (artifacts:293), `retireDocument` (artifacts:442): read-check-write on `documents` in one TX.
- `link` (connectors:132), `createOAuthApp` (connectors:482): upserts — atomic single statements.
- Single-table writes: `setState`, `recordError`, `persistBundle` (connectors:198/604/464), `updateCase` (eval:294), `deleteCase` (eval:346), `createDataset` (eval:148), `updateMemory`/`softDelete`/`create`/`list` (memory), `grantDocumentAccess` (retrieval:592), `getDocumentPreview`/`listDocuments`/`dereference`/`getUploadSession` (artifacts — reads), `dueAccounts` (connectors:380 — cross-org read).

### Raw SQL usage (`tx.execute(sql`...`))`

19 raw-SQL executions (all inside withOrg/withBypass TX, none are bare-pool):
- analytics.query.service.ts:24,33 — `select ... from analytics_rollups` (2 variants).
- artifacts.service.ts:271 — `select ... from documents d` + correlated `max(dv.version)` on `document_versions`; 367 — ACL gate join `documents`/`artifacts`/`retrieval_acl` (+`buildSourceAclFilter` EXISTS on `document_source_acls`); 407 — `count(*)` on `chunks`.
- eval.service.ts:196,547,682 — `select coalesce(max(sequence),0)+1 from eval_cases`; 246 — `count(*)` on `eval_cases`; 391 — `count(*)` on `eval_runs`; 996 — `select 1 from eval_runs ... is_shadow ... interval '24 hours'`; 1272 — `select distinct ps.hash ... from eval_case_executions ece join runs r join policy_snapshots ps` (cross-module).
- ingestion.service.ts:171,532 — `select ... from artifacts` (parameterized `::uuid`).
- memory.service.ts:455 — `update memory_items set deleted_at/invalid_at ... where id in (select ... ilike ... limit 1000) returning id`.
- retrieval.service.ts:317 — vector leg (`1 - (e.embedding <=> ...::vector)` select + `order by ... <=>`); 339 — FTS leg (`ts_rank_cd(c.fts, websearch_to_tsquery('english', ...))`); 452 — `select ... from memory_items ... order by embedding <=> ...::vector`.

### FOR UPDATE row locks
- ingestion.service.ts:117 — `claimOne`: `.for('update', { skipLocked: true })` on `upload_sessions` (claim lease; concurrent workers skip).
- ingestion.service.ts:221 — `indexStage`: `.for('update')` on `documents` (serializes concurrent version appends to the same document; comment A4-11).

### pg_advisory locks
- None in the module.

### onConflict upserts (conflict key → SQL unique constraint)
- connectors:144 — `onConflictDoUpdate` target `(organization_id, provider, display_name)` → `uq_connector_accounts_org_provider_name`.
- connectors:493 — `onConflictDoUpdate` target `(organization_id, provider)` → `uq_connector_oauth_apps_org_provider`.
- eval:153 — bare `onConflictDoNothing()` (no target).
- ingestion:237 — `onConflictDoNothing` target `(source_artifact_id)` → `uq_documents_source_artifact`.
- ingestion:269 — `onConflictDoNothing` target `(organization_id, connector_account_id, external_id)` → `uq_connector_documents_account_external`.
- ingestion:296 — bare `onConflictDoNothing()` on `document_versions` (no target).
- ingestion:389 — bare `onConflictDoNothing()` on `retrieval_acl` (no target).
- ingestion:479 — `onConflictDoUpdate` target `(organization_id, provider, external_id)` → `uq_external_principals_org_provider_external`.
- ingestion:496 — `onConflictDoNothing` target `(organization_id, provider, external_id)` → `uq_external_identity_links`.
- ingestion:507 — `onConflictDoNothing` target `(document_id, provider, external_id)` → `uq_document_source_acls`.
- retrieval:603 — bare `onConflictDoNothing()` on `retrieval_acl` (no target).

### Vector / pgvector usage
- `embeddings.embedding` — `vector(1536)` custom type (schema.ts, `customType`, `toDriver` emits `[1,2,...]` literal). Similarity operator `<=>` (cosine distance) in retrieval.service.ts:320 (`1 - (e.embedding <=> v::vector)` score) and :331 (`order by e.embedding <=> v::vector`). **No HNSW/IVFFLAT index exists on `embeddings`** (migrations define none) — vector leg is a sequential scan bounded by ACL predicates.
- `memory_items.embedding` — `vector(1536)` custom type. `<=>` in retrieval.service.ts:462. HNSW cosine index exists: migration 0038 `CREATE INDEX ix_memory_items_embedding ON memory_items USING hnsw (embedding vector_cosine_ops)` (no lists/ef parameters — defaults).
- `EMBEDDING_DIMENSIONS = 1536`, `EMBEDDING_MODEL = 'local-lexical-v1'` (schema.ts).
- Model-space scoping: every vector leg constrains `e.model` / `embedding_model` to the query's effective embedding model (P0 BUG-1 rule); NULL-model legacy rows still participate.
- PG FTS: `chunks.fts` tsvector generated column (`to_tsvector('english', text)`), GIN index `ix_chunks_fts` (0038); lexical leg uses `websearch_to_tsquery('english', ...)` + `ts_rank_cd` (retrieval:342,348).

### PostgreSQL-specific behavior
- `vector(1536)` pgvector columns + `<=>` cosine distance + HNSW index (above); tsvector GIN + `websearch_to_tsquery`/`ts_rank_cd`; `gen_random` not used in module (uuidv7 app-side).
- `FOR UPDATE ... SKIP LOCKED` lease claim (ingestion:117); plain `FOR UPDATE` serialization (ingestion:221).
- `::uuid` / `::int` casts in raw SQL; `ilike ... escape '\'`; `update ... returning id`; `select coalesce(max(...),0)+1` sequence computation.
- jsonb columns: `upload_sessions.connector_ref`/`source_acl`, `chunks.source_range`, `memory_items.source_ref`, `eval_runs.provenance/results`, `eval_cases.input/expected/rubric`, `connector_accounts.config/cursor/credentials_sealed`.
- Drizzle-generated DDL constraints relied on: `uq_documents_source_artifact`, `uq_document_versions_doc_version` (unique (document_id, version)), `uq_documents_org_slug` (unique (organization_id, source_slug)), `uq_external_principals_org_provider_external`, `uq_connector_documents_account_external`.

### Cross-module table access (reads unless noted)
- ingestion.service.ts: `identity.accounts` (read, 491) — email→account lookup inside `applySourceAcl`.
- memory.service.ts: `conversations.mcp.memory_proposals` (read+write, 149/161), `lifecycle.lifecycle.legal_holds` (read, 429), `organizations.org_settings` (read, 71).
- eval.service.ts: `assistants.assistants` (906), `assistants.assistant_versions` (790, 1069), `assistants.policy_snapshots` (790, 921, 1069), `assistants.assistant_installs` (1020, 1069), `assistants.assistant_templates` (1069), `assistants.tool_catalog` (1069), `conversations.runs` (raw SQL join, 1272), `common/infra/outbox.outbox_events` (write via `recordOutboxEvent(tx)`, 790).
- retrieval.service.ts: none beyond knowledge schema (ACL predicate touches knowledge-schema tables only).
- analytics.query.service.ts: `analytics_rollups` raw SQL (no drizzle object in module — table belongs to another module's domain).
- artifacts/connectors services: knowledge-schema only.

### RLS-sensitive paths (RLS silently inactive — matters for MongoDB migration)
This module never calls `db.root`, so all tenant reads go through `db.withOrg` (RLS enforced) except:
1. **ingestion.service.ts — all 10 withBypass sites**: `claimOne` (105) scans `upload_sessions` with NO `organization_id` predicate (cross-org worker by design). All other stages filter by `session.organizationId` explicitly in WHERE clauses (`eq(documents.organizationId, session.organizationId)` etc.). Raw SQL at 171/532 parameterizes only `id`, but `id` is a UUID primary key — no org assertion on the read itself (org context comes from the session row). **Migration risk: the explicit `organization_id = session.organizationId` predicates must survive as document-level filters in Mongo; `claimOne` becomes a cross-tenant collection scan by design.**
2. **connectors.service.ts:380 `dueAccounts` (withBypass)**: cross-org read of `connector_accounts` (state=active, provider filter) — no org predicate by design (worker sweep). **Mongo: must remain a cross-tenant query; per-doc org scoping happens downstream in `sync` via withOrg.**
3. **Cross-org join in eval.service.ts:1272 raw SQL**: filters `eval_case_executions` by `organization_id` explicitly — safe if preserved.
4. **Everything else is withOrg**: tenant context is set by DbService; WHERE clauses also carry `organization_id` predicates redundantly (defense in depth — good for migration since most queries are already explicit-org filters).
5. `evalRuns`/`evalDatasets`/`evalCases` delete-cascade behavior (`deleteCase`→`eval_case_executions`, `deleteDataset` blocked while runs exist) relies on FK cascades — must be re-implemented in Mongo migration.

### Files importing/injecting DbService but never calling it
- None. All 7 files that import `DbService` call it at least once: analytics.query.service.ts (1), artifacts.service.ts (10), connectors.service.ts (17), eval.service.ts (20), ingestion.service.ts (10), memory.service.ts (8), retrieval.service.ts (5).
- (Note: `embedding.service.ts`, `connectors.worker.ts`, `connectors.controller.ts`, `knowledge.controller.ts`, `knowledge.module.ts`, `harness-parity.controller.ts`, `connectors.schema.ts`, `eval.schema.ts`, `schema.ts` do not import/inject DbService.)

### Verification
withOrg 60 + withBypass 11 + root 0 + root.transaction 0 + check 0 + withSerializable 0 = **71**; per-file 1+10+17+20+10+8+5 = **71** ✓


## DB Call-Site Inventory — satellites / channels / workers

RESEARCH ONLY. No code changed. Repo: `~/workspace/neryva/neryva-engine`.
DbService surface (`src/common/infra/db/db.service.ts`): `db.root` (direct Drizzle, no tenant/RLS),
`db.root.transaction(fn)` (manual PG tx), `db.withOrg(orgId, fn)` (PG tx + `app.current_tenant` RLS),
`db.withBypass(fn)` (PG tx + `app.engine_bypass=on`, tenant cleared), `db.check()` (raw PG health query),
`db.withSerializable(fn)` (serializable retry helper).

### Grand total: 96 call sites

| Method | Count |
|---|---|
| `db.root` | 35 |
| `db.withOrg` | 40 |
| `db.withBypass` | 20 |
| `db.check()` | 1 |
| `db.root.transaction` | 0 |
| `db.withSerializable` | 0 |

Per-file: channels.service 10, ingest.service 5, outbound.service 5, templates.service 3,
widget.service 6, revocation-log 3, satellite-activity 2, satellite-incidents 9,
satellite-registry 14, satellite-sweeper 7, satellites.module 1, accepted-run-sweep 1,
analytics-rollup 6, approval-expiry-sweep 1, eval-executor 5, eval-scoring 4, llm-judge 2,
memory-proposer 1, model-drift 1, reembed 3, run-dispatch 5, run-watchdog 1,
template-provisioning 1.
Sum: 10+5+5+3+6+3+2+9+14+7+1+1+6+1+5+4+2+1+1+3+5+1+1 = 96. ✓
Method split: root 35 (3+2+9+14+7), withOrg 40 (8+1+5+3+3+5+4+2+1+2+5+1),
withBypass 20 (2+4+3+1+6+1+1+1+1), check 1. 35+40+20+1 = 96. ✓

Legend: TX=YES means the statement runs inside a PG transaction (withOrg/withBypass open one;
db.root statements are single-statement, no transaction). Table names are real SQL names.
"cross" = cross-module table/service access (section below).

---

### Call sites — src/modules/channels/channels.service.ts (10)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 101 | withOrg | create | channel_accounts | both | YES | select count (cap check) + insert in one TX; audit outside TX |
| 145 | withOrg | get | channel_accounts | read | YES | single-row by id |
| 153 | withOrg | list | channel_accounts | read | YES | org-scoped, limit 200 |
| 184 | withOrg | update | channel_accounts | write | YES | update + returning |
| 216 | withOrg | deactivate | channel_accounts, channel_sessions | write | YES | suspend account (destroys sealed creds) + revoke all its widget sessions — one atomic TX |
| 267 | withOrg | rotateCredentials | channel_accounts | write | YES | update credentials/status |
| 338 | withOrg | verifyCredentials | channel_accounts | write | YES | update health/status |
| 409 | withBypass | getByIdForIngest | channel_accounts | read | YES | exact-id read for webhook ingest; bypass justified in comment (signature already authenticated) |
| 428 | withBypass | getByPublicKey | channel_accounts | read | YES | exact public-key read for anonymous widget plane (capability = `nk_live_` key); moved off db.root by G1 fix because channel_accounts is FORCE RLS |
| 560 | withOrg | assertAssistantRoutable | assistants | read | YES | cross-module table (assistants module); also calls TemplatesService.resolveAssistantChannels |

### Call sites — src/modules/channels/ingest.service.ts (5)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 84 | withBypass | acceptWebhook | channel_events, outbox_events | write | YES | durable ingest: insert channel_event (onConflictDoNothing, dedup) + recordOutboxEvent in SAME TX (invariant 7) |
| 139 | withBypass | handle | channel_accounts, channel_events | read | YES | resolve account + stored event by exact ids from trusted outbox event |
| 265 | withBypass | handleMessage | channel_identities, conversations, channel_message_links | both | YES | identity upsert + raw-SQL conversations lookup + inbound-link insert; NESTED TX: calls ConversationsService.createConversation + acceptMessage (own withOrg TXs = savepoints; inner withOrg re-sets app.current_tenant/engine_bypass GUCs on the same connection) |
| 363 | withOrg | handleStatus | channel_message_links, message_receipts | both | YES | select link → update delivery state → insert receipt (outbound delivered/read) |
| 399 | withBypass | settle | channel_events | write | YES | processed/quarantined settlement |

### Call sites — src/modules/channels/outbound.service.ts (5)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 112 | withOrg | handleMessageCreated | messages, conversations, channel_accounts, channel_message_links, channel_identities | both | YES | reads message+conv+account (via loadBinding), deliverMessage does claim insert into channel_message_links |
| 147 | withOrg | handleEscalationNote | conversations, channel_accounts, channel_message_links | both | YES | loadBinding reads; claim insert via deliverMessage (escalation id as deterministic anchor) |
| 194 | withOrg | handleRunTerminal | messages, conversations, channel_accounts, artifacts, channel_message_links | both | YES | reads final message + binding + artifact (presignArtifact); claim insert/update via deliverMessage/deliverMedia |
| 448 | withOrg | markLink | channel_message_links | write | YES | mark skipped/failed |
| 460 | withOrg | externalUserIdFor | channel_identities | read | YES | single-row projection |

### Call sites — src/modules/channels/templates.service.ts (3)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 46 | withOrg | create | channel_accounts, channel_message_templates | both | YES | verify account exists, then insert template (onConflictDoNothing) |
| 95 | withOrg | list | channel_message_templates | read | YES | org (+optional account) filter, limit 100 |
| 108 | withOrg | setStatus | channel_message_templates | write | YES | status update + returning |

### Call sites — src/modules/channels/widget.service.ts (6)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 86 | withBypass | mintSession | channel_identities, channel_sessions | write | YES | insert identity + session (token hash at rest) in one TX |
| 125 | withBypass | resolveSession | channel_sessions | both | YES | select by token hash + sliding-TTL update in one TX |
| 201 | withOrg | ensureConversation | conversations | read | YES | raw SQL: `select status from conversations where id=… and organization_id=…` |
| 220 | withBypass | ensureConversation | channel_sessions | write | YES | backfill conversation_id on session |
| 236 | withOrg | assertRunInSession | runs | read | YES | raw SQL: `select conversation_id from runs where id=… and organization_id=…` |
| 257 | withOrg | markSessionRead | messages, message_receipts | both | YES | raw-SQL select recent assistant messages + per-row insert receipt (onConflictDoNothing) |

### Call sites — src/modules/satellites/revocation-log.service.ts (3)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 52 | root | record | revocation_events | write | NO | single insert |
| 79 | root | since | revocation_events | read | NO | cursor-paginated select ((occurred_at,id) > cursor) |
| 99 | root | between | revocation_events | read | NO | time-window select |

### Call sites — src/modules/satellites/satellite-activity.service.ts (2)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 101 | root | touch | satellite_counters | write | NO | fire-and-forget upsert (void … .catch): onConflictDoUpdate target satellite_key; best-effort counter bump |
| 109 | root | row | satellite_counters | read | NO | single-row read |

### Call sites — src/modules/satellites/satellite-incidents.service.ts (9)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 35 | root | open | satellite_incidents | write | NO | insert (autoResolve path: opened+resolved same row) |
| 47 | root | open | satellite_incidents | write | NO | dedup: update detail/last_seen on existing open incident |
| 53 | root | open | satellite_incidents | write | NO | insert new open incident |
| 66 | root | resolve | satellite_incidents | write | NO | update resolved_at for open rows |
| 75 | root | unresolved | satellite_incidents | read | NO | open row for (key, kind) |
| 84 | root | listFor | satellite_incidents | read | NO | |
| 94 | root | listOpen | satellite_incidents | read | NO | |
| 104 | root | recent | satellite_incidents | read | NO | |
| 112 | root | openCount | satellite_incidents | read | NO | count(*) |

### Call sites — src/modules/satellites/satellite-registry.service.ts (14)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 79 | root | seed | satellites | write | NO | insert … onConflictDoNothing(target: key) |
| 85 | root | list | satellites | read | NO | |
| 89 | root | get | satellites | read | NO | single-row by key |
| 112 | root | statusView | satellite_incidents | read | NO | raw SQL: open-incident counts grouped by satellite_key |
| 181 | root | register | satellites | write | NO | upsert onConflictDoUpdate(target: key, set: values) |
| 234 | root | quarantine | satellites | write | NO | status update |
| 256 | root | release | satellites | write | NO | status update |
| 280 | root | drain | satellites | write | NO | status update |
| 302 | root | resume | satellites | write | NO | status update |
| 326 | root | retire | satellites | write | NO | status update |
| 391 | root | heartbeat | satellites | write | NO | update liveness + heartbeat_count = heartbeat_count + 1 |
| 407 | root | heartbeat | satellite_heartbeats | write | NO | insert heartbeat sample (separate statement from 391 — NOT atomic) |
| 467 | root | history | satellite_heartbeats | read | NO | |
| 478 | root | recentHistory | satellite_heartbeats | read | NO | fleet window |

### Call sites — src/modules/satellites/satellite-sweeper.worker.ts (7)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 115 | root | transitionLiveness | satellites | read | NO | |
| 133 | root | transitionLiveness | satellites | write | NO | liveness update (read at 115 + write at 133 are separate statements, no TX) |
| 181 | root | detectConfigDrift | config_notifications, satellites | read | NO | raw SQL join; cross-module table (config-publish), documented import-cycle seam |
| 212 | root | detectConfigDrift | config_notifications, satellites | read | NO | raw SQL: still-backlogged set |
| 219 | root | detectConfigDrift | satellite_incidents | read | NO | raw SQL: open config_drift incidents |
| 232 | root | pruneSamples | satellite_heartbeats | write | NO | delete older than retention, returning id |
| 241 | root | pruneRevocations | revocation_events | write | NO | delete older than retention, returning id |

### Call sites — src/modules/satellites/satellites.module.ts (1)

| Line | Method | Fn | Tables | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 33 | check | constructor | — (raw `select` health probe) | n/a | NO | healthRegistry registers `() => db.check()`; the only db.check() in scope |

### Call sites — src/workers/accepted-run-sweep.worker.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 44 | withBypass | tick | runs, outbox_events | both | YES | select stale ACCEPTED runs `FOR UPDATE SKIP LOCKED` (drizzle `.for('update',{skipLocked:true})`) + recordOutboxEvent per row in one TX — claim-and-requeue |

### Call sites — src/workers/analytics-rollup.consumer.ts (6)

All withBypass, one TX each, all "both" (single raw `INSERT INTO analytics_rollups … SELECT … ON CONFLICT (…) DO UPDATE`):

| Line | Fn | Source tables read | Notes |
|---|---|---|---|
| 60 | recomputeCsat | message_feedback | conflict (organization_id, kind, period_start, scope) DO UPDATE metrics |
| 80 | recomputeOutcomes | runs | + jsonb_build_object aggregates |
| 99 | recomputeUsage | usage_ledger_entries | cross-module read (billing) |
| 123 | recomputeAssistantCsat | conversations, message_feedback | per-assistant scope |
| 153 | recomputeAssistantOutcomes | conversations, runs, escalations | |
| 191 | recomputeAssistantUsage | conversations, runs, usage_ledger_entries | |

### Call sites — src/workers/approval-expiry-sweep.worker.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 55 | withBypass | tick | approvals | read | YES | raw SQL: distinct org ids with PENDING expired approvals (limit 500); per-org settlement delegated to authority.sweepExpiredApprovals (FOR UPDATE SKIP LOCKED there) |

### Call sites — src/workers/eval-executor.consumer.ts (5)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 62 | withOrg | handle | eval_runs | read | YES | policy-snapshot pin lookup |
| 78 | withOrg | handle | eval_runs, eval_cases, eval_case_executions | both | YES | claim TX: update run→running + select cases + idempotent insert executions + re-read pendings |
| 123 | withOrg | handle | assistant_versions | read | YES | raw SQL assistant_id lookup (cross-module table) |
| 161 | withOrg | handle | eval_case_executions | write | YES | pin conversation/run ids (called in dispatch loop, outside the claim TX) |
| 185 | withOrg | markExecutionFailed | eval_case_executions | write | YES | mark failed + reason |

(Cross-module service calls: ConversationsService.createConversation + acceptMessage — outside any DB TX here, unlike ingest.)

### Call sites — src/workers/eval-scoring.consumer.ts (4)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 64 | withOrg | handle | eval_case_executions | read | YES | find open execution for run |
| 94 | withOrg | scoreResponse | eval_cases, messages | read | YES | expected + message content (typed drizzle select — deliberate, pg-types jsonb note) |
| 127 | withOrg | settle | eval_case_executions | write | YES | verdict update |
| 143 | withOrg | maybeCompleteEvalRun | eval_case_executions | read | YES | remaining executions; hands off to evalService.completeRun (cross-module) |

### Call sites — src/workers/llm-judge.consumer.ts (2)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 55 | withOrg | handle | runs, messages | read | YES | bounded transcript (input + result message only) |
| 123 | withOrg | handle | run_judgments | write | YES | insert onConflictDoNothing — uq_run_judgments_run(run_id), redelivery is a no-op |

### Call sites — src/workers/memory-proposer.consumer.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 37 | withOrg | handle | messages, memory_proposals | both | YES | raw SQL: select content from messages; raw SQL insert into memory_proposals on conflict (organization_id, proposal_ref) do nothing |

### Call sites — src/workers/model-drift.worker.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 53 | withBypass | tick | assistants | read | YES | raw SQL: active-version assistants (cross-module table); per-assistant checkAssistant follows |

### Call sites — src/workers/reembed.worker.ts (3)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 52 | withBypass | tick | documents | read | YES | raw SQL: distinct org ids (knowledge module table) |
| 81 | withOrg | reembedOrg | documents | read | YES | pending docs for target model |
| 109 | withOrg | reembedDocument | chunks, document_versions, documents, embeddings | both | YES | atomic per-document swap TX: raw-SQL chunk read → insert embeddings (onConflictDoNothing, uq_embeddings_chunk(chunk_id,model)) → parity count check → update documents.embedding_model → raw-SQL delete stale-model embeddings |

### Call sites — src/workers/run-dispatch.consumer.ts (5)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 114 | withOrg | recordResumeEvent | run_events | write | YES | insert lifecycle/resume event |
| 213 | withOrg | tracedStartRun | run_manifests | read | YES | read trace_id from manifest (cross-module table, assistants) |
| 240 | withOrg | currentConversationVersion | conversations | read | YES | raw SQL: select version (cross-module table) |
| 262 | withOrg | getAgentApprovalPolicy | assistant_versions | read | YES | toolPolicy read (cross-module table) |
| 286 | withOrg | markDispatched | runs, run_events, outbox_events | both | YES | select runs `.for('update')` (row lock, no skip-locked) → insert run_events → update runs ACCEPTED→DISPATCHED → recordOutboxEvent, all one TX |

### Call sites — src/workers/run-watchdog.worker.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 62 | withBypass | tick | runs, policy_snapshots | read | YES | raw SQL join with `FOR UPDATE OF r SKIP LOCKED`; per-candidate failRunForBudget called outside the TX (cross-module service) |

### Call sites — src/workers/template-provisioning.consumer.ts (1)

| Line | Method | Fn | Tables (SQL) | R/W | TX | Notes |
|---|---|---|---|---|---|---|
| 56 | withOrg | handle | assistant_installs, assistant_templates, assistant_versions, assistants, tool_catalog, documents, eval_datasets, eval_cases | both | YES | one big provisioning TX: read install/template/draft/assistant (assistants module) + tool pins (tool_catalog) + knowledge seeds (documents) → insert eval_datasets (onConflictDoNothing, uq_eval_datasets_org_name) → insert eval_cases (plain insert, no conflict clause) |

---

### Transaction boundaries (multi-statement atomic units)

| # | Location | Boundary | Tables written/read atomically |
|---|---|---|---|
| 1 | channels.service create:101 | withOrg TX | count(channel_accounts) + insert channel_accounts (cap check + create atomic) |
| 2 | channels.service deactivate:216 | withOrg TX | update channel_accounts (suspend, destroy creds) + update channel_sessions (revoke all) |
| 3 | ingest acceptWebhook:84 | withBypass TX | insert channel_events + insert outbox_events (fact + announcement, invariant 7) |
| 4 | ingest handleMessage:265 | withBypass TX | upsert channel_identities + select channel_identities + raw read conversations + insert channel_message_links; nested ConversationsService withOrg TXs run as savepoints inside |
| 5 | ingest handleStatus:363 | withOrg TX | select channel_message_links → update delivery state → insert message_receipts |
| 6 | widget mintSession:86 | withBypass TX | insert channel_identities + insert channel_sessions |
| 7 | widget resolveSession:125 | withBypass TX | select channel_sessions + sliding-TTL update |
| 8 | widget markSessionRead:257 | withOrg TX | raw read messages + N× insert message_receipts |
| 9 | outbound handleMessageCreated:112 / handleRunTerminal:194 / handleEscalationNote:147 | withOrg TX each | reads (messages, conversations, channel_accounts[, artifacts]) + claim insert/update channel_message_links |
| 10 | eval-executor claim:78 | withOrg TX | update eval_runs → select eval_cases → idempotent insert eval_case_executions → re-read pendings |
| 11 | run-dispatch markDispatched:286 | withOrg TX | select runs FOR UPDATE → insert run_events → update runs → insert outbox_events |
| 12 | accepted-run-sweep tick:44 | withBypass TX | select runs FOR UPDATE SKIP LOCKED → N× insert outbox_events |
| 13 | reembedDocument:109 | withOrg TX | read chunks/document_versions/documents → insert embeddings → parity check → update documents → delete stale embeddings |
| 14 | template-provisioning handle:56 | withOrg TX | reads (assistant_installs, assistant_templates, assistant_versions, assistants, tool_catalog, documents) → insert eval_datasets → insert eval_cases |
| 15 | analytics rollups ×6 | withBypass TX each | single-statement INSERT…SELECT…ON CONFLICT DO UPDATE (read sources + write analytics_rollups atomically by construction) |
| 16 | memory-proposer handle:37 | withOrg TX | raw read messages + raw insert memory_proposals loop |
| 17 | llm-judge excerpt:55 | withOrg TX | read runs + 2× read messages (bounded transcript) |

NOT in a transaction (db.root, statement-level only): all 35 satellite call sites. Notable non-atomic pairs:
satellite-registry heartbeat:391 (update satellites) + :407 (insert satellite_heartbeats) are two separate
statements — a crash between them leaves the counter bumped with no sample row.
satellite-sweeper transitionLiveness:115 (read) + :133 (write) — read-modify-write without a lock/TX.
satellite-incidents open:47 does a select (via unresolved():75) then an update — two call sites, no TX.

### Raw SQL usage (`tx.execute(sql\`…\`)` / `db.root.execute`)

| Location | Statement shape |
|---|---|
| satellite-registry statusView:112 | select satellite_key, count(*) from satellite_incidents where resolved_at is null group by satellite_key |
| satellite-sweeper detectConfigDrift:181,212 | select … from config_notifications cn join satellites s … (unacked backlog) |
| satellite-sweeper detectConfigDrift:219 | select distinct satellite_key from satellite_incidents where kind='config_drift' and resolved_at is null |
| widget ensureConversation:201 | select status from conversations where id=…::uuid and organization_id=…::uuid |
| widget assertRunInSession:236 | select conversation_id from runs where id=…::uuid and organization_id=…::uuid |
| widget markSessionRead:257 | select id from messages where conversation_id=… and organization_id=… and role='assistant' … limit 50 |
| ingest handleMessage:299 | select id from conversations where organization_id=… and channel_binding->>'channel_identity_id'=… and status='active' |
| eval-executor handle:123 | select assistant_id from assistant_versions where id=…::uuid |
| memory-proposer handle:38 | select content from messages where id=…::uuid |
| memory-proposer handle:48 | insert into memory_proposals … on conflict (organization_id, proposal_ref) do nothing |
| model-drift tick:54 | select … from assistants a where a.active_version_id is not null and a.disabled_at is null … |
| reembed tick:53 | select distinct organization_id from documents … (org scan) |
| reembed reembedDocument:110 | select c.id, c.text from chunks c join document_versions dv join documents d … |
| reembed reembedDocument:150 | parity: select count(c.id), count(e.id) from chunks … left join embeddings … |
| reembed reembedDocument:169,178 | select distinct model … ; delete from embeddings e using chunks c, document_versions dv … |
| run-dispatch currentConversationVersion:241 | select version from conversations where id=…::uuid and organization_id=…::uuid |
| run-watchdog tick:63 | select r.id, r.organization_id from runs r join policy_snapshots ps … for update of r skip locked |
| approval-expiry-sweep tick:55 | select distinct organization_id from approvals where state='PENDING' and expires_at <= now() |
| analytics rollups ×6 | insert into analytics_rollups (…) select … from <source> … on conflict (organization_id, kind, period_start, scope) do update |

### FOR UPDATE row locks

- accepted-run-sweep:44 — drizzle `.for('update', { skipLocked: true })` on runs (claim-and-requeue; concurrent sweepers skip each other's rows).
- run-dispatch markDispatched:286 — drizzle `.for('update')` on runs (no skip-locked; serializes redelivery of the same run).
- run-watchdog:63 — raw `for update of r skip locked` on runs r (join policy_snapshots).
- approval-expiry-sweep:55 — raw read has NO lock here; the FOR UPDATE SKIP LOCKED settlement lives in the MCP authority service (`sweepExpiredApprovals`), called per org outside this TX.

### pg_advisory locks

None in scope. (Adjacent: `src/common/audit/audit.service.ts:149` uses `pg_advisory_xact_lock(hashtext('neryva_audit_chain'))` for the audit hash chain — outside this inventory's scope.)

### onConflict upserts (conflict key)

| Location | Form | Key |
|---|---|---|
| satellite-registry seed:79 | onConflictDoNothing | target: satellites.key |
| satellite-registry register:184 | onConflictDoUpdate | target: satellites.key |
| satellite-activity touch:104 | onConflictDoUpdate | target: satelliteCounters.satelliteKey |
| ingest acceptWebhook:96 | onConflictDoNothing (no explicit target) | uq_channel_events_account_event (channel_account_id, external_event_id) — webhook replay dedup |
| ingest handleMessage:283 | onConflictDoUpdate | target [channel_identities.channelAccountId, channel_identities.externalUserId] = uq_channel_identities_account_user |
| ingest handleMessage:355 | onConflictDoNothing | uq_channel_links_account_external (channel_account_id, external_message_id) — inbound dedup anchor |
| ingest handleStatus:393 | onConflictDoNothing | uq_message_receipts_message_account_state (message_id, channel_account_id, state) |
| outbound deliverMessage:285,371 | onConflictDoNothing | uq_channel_links_outbound_message (message_id) — claim-before-send; double delivery cannot double-claim |
| templates create:69 | onConflictDoNothing | uq_channel_templates_account_name (channel_account_id, name, language) |
| widget markSessionRead:281 | onConflictDoNothing | uq_message_receipts_message_account_state |
| llm-judge handle:138 | onConflictDoNothing | uq_run_judgments_run (run_id) — redelivery no-op |
| reembed reembedDocument:142 | onConflictDoNothing | uq_embeddings_chunk (chunk_id, model) — re-inserts idempotent |
| template-provisioning seedEvalDataset:161 | onConflictDoNothing | uq_eval_datasets_org_name (organization_id, name) |
| template-provisioning seedEvalDataset | plain insert eval_cases (no conflict clause) | — |
| eval-executor claim:101 | onConflictDoNothing | uq_eval_case_executions_case_attempt (eval_run_id, case_id, attempt) |
| memory-proposer:48 (raw) | on conflict do nothing | uq_memory_proposals_org_ref (organization_id, proposal_ref) |
| analytics rollups ×6 (raw) | on conflict (organization_id, kind, period_start, scope) do update | metrics = excluded.metrics, computed_at = now() |

### PostgreSQL-specific behavior in scope

- jsonb operators in raw SQL: `channel_binding->>'channel_identity_id'` (ingest:299), `ps.budget_policy->>'wall_clock_seconds'` (run-watchdog:63), `jsonb_build_object` aggregates (analytics rollups).
- `::uuid` / `::timestamptz` / `::date` / `::int` casts in raw SQL; `gen_random_uuid()` used as id default inside analytics rollup INSERT…SELECT.
- `sql`${satellites.heartbeatCount} + 1`` counter increment (registry:391); same pattern in satellite-activity touch.
- drizzle `.for('update', { skipLocked: true })` (accepted-run-sweep).
- GUC-based tenancy: `set_config('app.current_tenant', …, true)` / `set_config('app.engine_bypass', …, true)` per TX (db.service.ts); per-TX `statement_timeout`/`idle_in_transaction_session_timeout` (10s/30s defaults).
- No `db.root.transaction(...)` manual transactions and no `db.withSerializable(...)` calls anywhere in scope (withSerializable is defined at db.service.ts:119, zero callers).

### Cross-module table access

| Reader | Foreign table (owner module) |
|---|---|
| channels.service assertAssistantRoutable:560 | assistants (assistants) — also calls TemplatesService.resolveAssistantChannels (assistants) |
| ingest handleMessage:265/299 | conversations (conversations); calls ConversationsService + RetentionPurgeService (lifecycle) |
| widget ensureConversation:201, sendMessage, escalate | conversations (conversations); escalations (conversations) via EscalationsService |
| widget assertRunInSession:236 / markSessionRead:257 | runs, messages (conversations) |
| outbound handleMessageCreated:112, handleRunTerminal:194 | messages, conversations (conversations); artifacts (knowledge) |
| outbound externalUserIdFor:460 | channel_identities is own-module (channels) |
| satellite-sweeper detectConfigDrift:181,212 | config_notifications (config-publish) — documented import-cycle seam |
| eval-executor handle:123 | assistant_versions (assistants); calls ConversationsService (conversations) |
| eval-scoring scoreResponse:94 | messages (conversations); calls EvalService.completeRun (knowledge) |
| llm-judge handle:55 | runs, messages (conversations) |
| memory-proposer handle:37 | messages (conversations); writes memory_proposals (knowledge/mcp-authority) |
| model-drift tick:53 | assistants (assistants) |
| reembed ×3 | documents, chunks, document_versions, embeddings (knowledge) |
| run-dispatch:213/240/262 | run_manifests, assistant_versions (assistants); conversations (conversations); writes runs, run_events (conversations) |
| run-watchdog tick:62 | runs (conversations); policy_snapshots (assistants); calls ConversationsService.failRunForBudget |
| accepted-run-sweep tick:44 | runs (conversations) |
| approval-expiry-sweep tick:55 | approvals (conversations/mcp-authority); calls MCP authority sweepExpiredApprovals |
| analytics rollups ×6 | message_feedback, runs, escalations, conversations (conversations); usage_ledger_entries (billing) |
| template-provisioning handle:56 | assistants, assistant_versions, assistant_installs, assistant_templates, tool_catalog (assistants); documents (knowledge); writes eval_datasets, eval_cases (knowledge) |
| all channels services | audit.add → AuditService (common) writes audit_events outside the DB TX (not part of these call sites) |
| ingest acceptWebhook:84, run-dispatch markDispatched:286, accepted-run-sweep:44 | recordOutboxEvent(tx, …) → outbox_events (common outbox) written INSIDE the caller's TX |

### RLS-sensitive paths (db.root on tenant-owned tables)

None in scope. All 35 `db.root` call sites touch satellite-plane tables
(`satellites`, `satellite_heartbeats`, `satellite_incidents`, `satellite_counters`,
`revocation_events`), which are global engine-owned tables: no `organization_id` column,
no RLS policies. `db.root` is the correct vehicle there.

Tenant-owned tables (`channel_*`, `conversations`, `runs`, `messages`, `assistants`, …) are
only ever reached via `withOrg` (RLS tenant context) or `withBypass` (explicit bypass + cleared
tenant). Notable history: channels.service getByPublicKey was moved OFF `db.root` onto
`withBypass` (G1 fix) because `channel_accounts` carries FORCE RLS and root sets neither
tenant nor bypass — worth preserving in a MongoDB migration, where there is no RLS backstop:
every raw-SQL statement in scope already carries explicit `organization_id = …` predicates
(good), but the safety net that RLS provides for drizzle-builder queries (e.g. sweeper-style
or forgotten-predicate bugs) will not exist — each query's tenant predicate must be audited.

Nested-context hazard: ingest.service handleMessage:265 runs a `withBypass` PG transaction
and, inside the callback, calls ConversationsService.createConversation/acceptMessage, which
open their own `withOrg` transactions. Drizzle nests these as savepoints on the SAME
connection, and `withOrg`'s `set_config(..., true)` applies transaction-locally — i.e. the
inner call flips `app.current_tenant`/`app.engine_bypass` for the remainder of the OUTER
bypass transaction. Flag for review; no other call site in scope nests db entry points.

### Files that import/inject DbService but never call db.* directly

- `src/workers/outbox-dispatcher.worker.ts` — injects `DbService` (ctor `private readonly db`) but
  never calls db.root/withOrg/withBypass/check; it only passes the instance through:
  `purgeExpiredIdempotencyRecords(this.db)` (:121). (Whether the helper itself calls db
  methods is outside this scope — helper lives in common.)
- `src/modules/satellites/satellites.module.ts` — DOES call (db.check at :33); listed here only
  to pre-empt the question.

Workers in `src/workers/` that do not use DbService at all (no import): degraded-sweep.worker.ts,
human-loop-notify.consumer.ts, lifecycle-webhook.consumer.ts, run-cancel.consumer.ts,
usage-ledger.consumer.ts, webhook-delivery-sweep.worker.ts.

### Table list — SQL names for schema objects touched in these areas

Satellites (src/modules/satellites/satellite.schema.ts):
satellites, satellite_heartbeats, satellite_incidents, satellite_counters, revocation_events

Channels (src/modules/channels/schema.ts):
channel_accounts, channel_identities, channel_sessions, channel_message_links,
channel_events, channel_message_templates, message_receipts

Cross-module tables touched:
assistants, assistant_versions, assistant_installs, assistant_templates, tool_catalog,
policy_snapshots, run_manifests (assistants); conversations, messages, runs, run_events,
approvals, escalations, message_feedback (conversations/mcp); documents, document_versions,
chunks, embeddings, memory_proposals, eval_runs, eval_datasets, eval_cases,
eval_case_executions, run_judgments (knowledge); config_notifications (config-publish);
usage_ledger_entries (billing); outbox_events (common outbox); analytics_rollups
(raw-SQL only, no drizzle schema object; read by src/modules/knowledge/analytics.query.service.ts)

### Caveats

- Table attribution for single-expression callbacks (e.g. channels.service list:153,
  widget ensureConversation:220) was verified by reading the continuation lines; each
  multi-line statement is counted once.
- channels.service.ts:416 is a comment mentioning `db.root` (G1 fix note) — not a call site, excluded.
- `recordOutboxEvent(tx, …)` writes to outbox_events inside the caller's transaction;
  attributed above wherever it appears in a call site's TX.
- Cross-module *service* calls (ConversationsService, EscalationsService, RetentionPurgeService,
  EvalService, TemplatesService, MCP authority, audit) perform their own DB access outside
  these call sites and are not inventoried here — noted per site where they occur.



## 5. Transaction boundaries (atomicity-critical)

These are the multi-statement transactions whose atomicity the MongoDB design must preserve. Single-statement `withOrg` calls (the majority) are trivially atomic in either database.

### Run lifecycle (`src/modules/conversations/`)
- **T1 — Run acceptance** (`conversations.service.ts:308`, withOrg): idempotency claim (`idempotency_records`) → `conversations` SELECT FOR UPDATE → assistant/version pin (raw SQL on `assistants`, `assistant_versions`, `policy_snapshots`) → `nextMessageSequence` (raw SQL) → insert `messages` → insert `runs` (unique guard `uq_runs_one_active_per_conversation`) → quota reservation (`product_entitlements` read, raw-SQL aggregates on `usage_ledger_entries` + `quota_reservations`, insert RESERVED) → insert `run_manifests` → insert `outbox_events` (`run.created`) → idempotency complete → `conversations` version bump. 12 tables, one TX.
- **T2 — CommitRunResult** (`conversations.service.ts:1527`, withOrg): `runs` SELECT FOR UPDATE (+ replay short-circuit) → `conversations` FOR UPDATE → raw-SQL `run_events` citation/media reads → insert `messages` → insert `run_events` (`run.completed`) → `runs` → COMPLETED → quota settle (raw SQL `quota_reservations` → COMMITTED) → pricing (`model_cost_entries`, `provider_credentials` reads; insert `usage_ledger_entries`) → `outbox_events` (`run.completed`).
- **T3 — Approval expiry sweep** (`mcp-authority.service.ts:1398/1416`, withBypass ×2): claim (`approvals` … FOR UPDATE SKIP LOCKED) then per-approval: re-verify FOR UPDATE → EXPIRED, `runs` → CANCELED, quota release, sibling approvals → EXPIRED.
- **T4 — Failure/cancel/deny quota release**: `failRun`, `cancelRun`, `decideApproval` each do run-state transition + `run_events` insert + quota → RELEASED in one withOrg TX.
- **T5 — Lease CAS** (`acquireOrRenewRunLease` / `releaseRunLease`): `runs` FOR UPDATE + epoch/owner compare + lease-column update; `runs.version` deliberately NOT bumped (fencing domain).
- **T6 — Escalation lifecycle** (`escalations.service.ts:47/249/300`): conversation FOR UPDATE + escalation insert + status flip + `run_events`; claim CAS; resolve.

### Assistant lifecycle (`src/modules/assistants/`)
- **publish / retire / rollback** (`assistants.service.ts:827/915/994`, withOrg): `pg_advisory_xact_lock('assistant:{id}')` serializes concurrent lifecycle transitions; publish inserts PUBLISHED `assistant_versions` + `policy_snapshots` and moves `active_version_id` atomically.
- **Template install** (`templates.service.ts:255`, withOrg): control-block check → insert `assistants` + DRAFT `assistant_versions` + `assistant_installs` + `outbox_events` (invariant: outbox row in the same TX as the fact).
- **Release promotion** (`rollouts.service.ts:83`, withOrg): per-variant PUBLISHED/version-block/eval-gate checks → pause current `assistant_rollouts` pointer → insert new active rollout (23505 → concurrent-promote 409).

### Billing (`src/modules/billing/`)
- **Invoice draft** (`billing-cycle.service.ts:91`, withOrg): insert `billing.billing_invoices` (draft) → aggregate `billing.spend_events` + `usage_ledger_entries` → insert `billing_invoice_lines` → apply adjustments → apply credits (`billing_credits` decrement + `billing_credit_applications` insert) → set invoice total.
- **Quota reserve** (`usage-ledger.service.ts:190`, withOrg): `pg_advisory_xact_lock(hashtext('quota:<org>:<dim>'))` → sum active RESERVED → limit check → insert RESERVED. Commit/release/expire are single-statement CAS updates (`state='RESERVED'` predicate, 0 rows → 409) running **withBypass** — the `state` column is the cross-TX coordination point between the conversations run-acceptance TX (withOrg insert) and the billing worker (withBypass transitions).
- **Price version rotation** (`price-catalog.service.ts:128`, `db.root.transaction`): raw SQL closes current `billing.price_catalog` row (`effective_to=…`) + inserts new version. No RLS (staff-managed catalog).

### Platform infrastructure (`src/common/`)
- **Audit append** (`audit.service.ts:148`, `db.root.transaction`): `pg_advisory_xact_lock(hashtext('neryva_audit_chain'))` → predecessor `event_hash` read (canonical `(created_at, id)` order) → hash-chained insert. Append-only; cross-writer byte-compatible with the Python runtime.
- **Outbox claim** (`outbox/dispatcher.ts:120`, withBypass): `SELECT … FOR UPDATE SKIP LOCKED` (PENDING/RETRY_WAIT, due, FIFO) + update → CLAIMED, one TX. Recover/markPublished/markRetryWait/markDeadLetter/replay are single-TX state transitions.
- **Inbox dedup** (`outbox/consumer.ts`, withBypass): insert-on-conflict, inspect existing state, reclaim stale processing atomically.
- **Idempotency records** (`http/idempotency-records.ts:165`, withBypass): claim/complete helpers.

### Organizations (`src/modules/organizations/`)
- **Org create** (`org-access.service.ts:147`, `db.root.transaction`): manually sets `app.current_tenant` via `set_config`, then inserts `tenants` + owner `org_memberships` + `org_settings` atomically.
- **Seat-wall** (`…`): entitlement lock + capacity check + membership upsert in one TX (the module's only FOR UPDATE).
- **18-table org purge**, group deletion, ownership transfer, member removal — each atomic.

### Identity (`src/modules/identity/`, all `db.root` — platform-plane, no RLS)
- **email-change confirm**, **mfa activate/disable/regenerateRecoveryCodes**, **account-deletion purge** (the single `withBypass` in the module — cross-tenant delete with raw SQL on `notifications`, `org_group_members`, `org_memberships`).
- Non-atomic but race-safe flows: `upsertByEmail`, social `resolve`, refresh-token rotation rely on unique constraints / atomic `UPDATE … WHERE <null-sentinel> RETURNING` consumes.

### Knowledge (`src/modules/knowledge/`)
- **Upload claim** (`ingestion.service.ts:105/117`, withBypass): cross-org scan + `FOR UPDATE SKIP LOCKED` lease claim on `upload_sessions`; version appends serialized with FOR UPDATE on `documents`.
- **eval `completeRun`**: decision + write in one TX guarded by `state in ('pending','running')`; `deleteCase` cascades to `eval_case_executions`.

### Config-publish, deployment, corporate
- **config-publish publish** (`config-publish.service.ts:92`, withOrg): `pg_advisory_xact_lock` by config key → max-version read → immutable version insert.
- **deployment stage add/remove**: select-next-position + insert via nested savepoint; delete + reposition atomically.
- **corporate newsletter** (`newsletter.service.ts:302`, `db.root.transaction`): campaign status update + queued `newsletter_sends` inserts.

### Satellites / channels / workers (`src/modules/satellites/`, `src/modules/channels/`, `src/workers/`)
- 96 call sites: withOrg 40, withBypass 20, root 35, check 1. All 35 `root` sites touch global engine-owned satellite tables (no `organization_id`, no RLS); tenant tables go only through `withOrg`/`withBypass`.
- 17 transaction boundaries: cap-check+insert, deactivate, webhook ingest fact+outbox, widget session mint/resolve, claim-and-requeue sweeps, eval claim, dispatch state machine, reembed atomic swap, template provisioning.
- Locks: `FOR UPDATE SKIP LOCKED` (accepted-run-sweep, run-watchdog raw SQL), plain `FOR UPDATE` (markDispatched). No `pg_advisory` in scope.
- **Nested-transaction hazard (flagged):** `channels/ingest.service.ts:265` runs `withBypass` and calls `ConversationsService.createConversation/acceptMessage` inside the callback — their inner `withOrg` transactions become savepoints on the same connection and flip `app.current_tenant`/`app.engine_bypass` for the rest of the outer bypass TX.
- Non-atomic pairs: heartbeat update + insert are separate statements; sweeper liveness read/write has no lock/TX.

## 6. Raw SQL, locks, and PostgreSQL-specific behavior

### `pg_advisory_xact_lock` (4 sites — all TX-scoped, released at commit)
| Site | Lock key | Purpose |
|---|---|---|
| `src/common/audit/audit.service.ts:148` | `hashtext('neryva_audit_chain')` | Serialize hash-chain appends globally |
| `src/modules/billing/usage-ledger.service.ts:190` | `hashtext('quota:<org>:<dim>')` | Serialize concurrent quota reserves per (org, dimension) |
| `src/modules/assistants/assistants.service.ts:829/917/996` | `'assistant:{id}'` | Serialize publish/retire/rollback per assistant |
| `src/modules/config-publish/config-publish.service.ts:92` | config key hash | Serialize publish per configuration key |

MongoDB has no advisory locks — each becomes a distributed-lock (Redis, already in the stack) or a transactional findOneAndUpdate CAS.

### `FOR UPDATE` row locks
- Conversations: run acceptance, commit, lease acquire/release, approval create/decide, escalations (claim/resolve/reply), cancel, budget-kill.
- Assistants: degraded-assistant sweep (`SKIP LOCKED`), approval-style sweep in mcp-authority (`SKIP LOCKED`).
- Knowledge: upload-session claim (`SKIP LOCKED`), document version appends.
- Organizations: seat-capacity check (single site).
- Outbox dispatcher: claim batch (`SKIP LOCKED`).
- Billing: none (uses advisory lock + CAS instead).

### Raw SQL (`tx.execute(sql`…`)` / `db.root.execute`)
Concentrated in: cost/spend aggregates (billing, burn-rate), audit chain (predecessor select + insert), outbox age gauge, embedding-coverage aggregate (assistants), feedback streak (conversations), sequence allocation (`nextMessageSequence`), artifact-ownership UNION (mcp-authority), FTS rank queries (knowledge), price-version close (billing), tenant/org existence prechecks (billing spend-ingest), corporate email suppression/delivery stats, staff overview counts. All parameterized; no string-interpolated identifiers observed.

### `onConflict` upserts (representative)
`fleet.staff.controller.ts:62` doNothing (platform block slug); `model-catalog.service.ts:123` doUpdate (provider, model_id); `model-cost.service.ts:83` doUpdate (provider, model, effective_from); `provider-credentials.service.ts:351` doUpdate (organization_id, provider); `tool-catalog.service.ts:452` doUpdate (organization_id, name); `assistants.service.ts:1585` doNothing (version/hash); `invoices.service.ts:92` doUpdate (org_id, product, period_start); `spend-ingest.service.ts:197` doNothing (source, event_id); `billing_webhook_inbox` dedupe (event key); `run_events` doNothing (run_id, event_id); `idempotency_records` doNothing; `message_feedback` upsert; `conversation_summaries` upsert; `account_onboarding` doUpdate (account_id).

### PostgreSQL-only features in use
- **RLS** (the entire `withOrg` lane — 406 sites).
- **pgvector**: `embeddings.embedding` and `memory_items.embedding` are `vector(1536)`; `<=>` cosine distance in retrieval; exactly one ANN index (HNSW cosine on `memory_items`); `embeddings` has no vector index (sequential scan fallback).
- **Full-text search**: `chunks.fts` tsvector GIN + `websearch_to_tsquery` / `ts_rank_cd`.
- **Schemas**: `product_deployment.*`, `billing.*` via `pgSchema`.
- **Hash-chain audit**: `pg_advisory_xact_lock` + ordered predecessor select.
- **`excluded.*`** in onboarding upsert; `uuidv7` event ids; jsonb `->>` fragments in OIDC lookups; `statement_timeout` / `idle_in_transaction_session_timeout` set inside the org-create TX.

## 7. RLS-sensitive paths (MongoDB migration risks)

These are the sites where PostgreSQL RLS is load-bearing or its absence is deliberate — each needs an explicit decision in the MongoDB design.

1. **Zero-`withOrg` platform modules** (no RLS by schema design; `db.root` is deliberate): `identity` (90 root sites — accounts/credentials/OIDC are the company's credential store), `corporate` (83 root sites — company surfaces), `staff` (18 root sites), `notifications` (5 root sites). Migration: these become unscoped collections; the risk is *accidentally* adding tenant scoping, not missing it.
2. **Tenant-owned table via `db.root`**: `model-catalog.service.ts:204` reads `published_configs` (tenant-owned) through `db.root` with only an org predicate — no RLS context. In MongoDB this pattern must carry the org filter explicitly (it does today, but the safety net is gone).
3. **Dead RLS path**: `organizations/invites.service.ts:419` updates RLS-forced `org_invites` through `db.root`; the source's own comment notes unscoped access matches zero rows — failed invite-redeem attempt counting is silently ineffective today.
4. **`withBypass` cross-org sweeps** (RLS bypass is load-bearing): approval expiry sweep, degraded-assistant sweep, burn-rate sweep, budget evaluation, billing cycle discovery, trial expiry, quota reconcile/expire, retention purges, webhook stranded-delivery sweep, outbox dispatcher/consumer, inbox dedup. All audited reads or state-machine transitions; each must remain cross-tenant-capable.
5. **Unauthenticated `withBypass` read**: `conversations.service.ts:2096` `resolvePublicShare` — scoping enforced by share token, not tenant context.
6. **Stripe webhook** (`billing/stripe.service.ts:176`, withBypass): marks invoices paid **without** going through `billing_webhook_inbox` — payment events have no dedupe record (gap vs. the reconciliation inbox path).
7. **Split-brain hazards** (separate transactions that must stay consistent): newsletter SMTP send before mark-sent (double-send on crash/retry); subscriber status vs suppression rows; key revoke/update/rotate read-then-write; console onboarding point-in-time reads; staff impersonation start/revoke two-statement splits; last-super-admin check-then-act.

## 8. Appendix A — Direct `drizzle-orm` imports (query builders outside schema/`DbService`)

120 non-schema, non-test files import query-building operators directly from `drizzle-orm`. Any MongoDB abstraction must cover these operators or the call sites must be rewritten. Format: `file:line :: imported operators`.

Operator frequency across the 120 files: `eq` 100 · `and` 87 · `sql` 79 · `desc` 41 · `isNull` 29 · `inArray` 19 · `asc` 14 · `or` 13 · `lte` 12 · `lt` 6 · `gte` 6 · `ne` 5 · `gt` 5 · `isNotNull` 4 · `count` 2 · `like` 1 · `ilike` 1.

79 of the 120 files import the raw `sql` tag — the migration-sensitive core (hand-written PostgreSQL fragments).

```
src/common/audit/audit.service.ts:3 :: sql
src/common/auth/auth.guard.ts:5 :: and, eq, sql
src/common/auth/platform-staff.directory.ts:1 :: eq
src/common/http/idempotency-records.ts:3 :: and, eq, lt
src/common/infra/outbox/consumer.ts:1 :: and, eq
src/common/infra/outbox/dispatcher.ts:1 :: and, asc, eq, inArray, lte, sql
src/modules/assistants/assistants.service.ts:1 :: and, desc, eq, inArray, ne, sql
src/modules/assistants/burn-rate.service.ts:2 :: and, desc, eq, sql
src/modules/assistants/control-blocks.service.ts:1 :: and, eq, isNull, or, sql
src/modules/assistants/fleet.staff.controller.ts:3 :: and, desc, eq, isNull, sql
src/modules/assistants/manifest-resolution.service.ts:1 :: and, desc, eq
src/modules/assistants/model-catalog.service.ts:1 :: and, eq
src/modules/assistants/model-cost.service.ts:1 :: and, desc, eq, isNull, lte, sql
src/modules/assistants/provider-credentials.service.ts:1 :: and, eq, ne
src/modules/assistants/release-gate.ts:1 :: sql
src/modules/assistants/rollouts.service.ts:1 :: and, desc, eq, sql
src/modules/assistants/template-blocks.schema.ts:1 :: sql
src/modules/assistants/templates.service.ts:1 :: and, desc, eq, isNull
src/modules/assistants/tool-catalog.service.ts:1 :: and, desc, eq
src/modules/billing/anomaly.service.ts:2 :: sql
src/modules/billing/billing-credits.service.ts:1 :: and, asc, eq, gt, isNull, or, sql
src/modules/billing/billing-cycle.service.ts:1 :: sql
src/modules/billing/billing-extension.controller.ts:3 :: sql
src/modules/billing/billing-reconciliation.service.ts:1 :: and, eq, sql
src/modules/billing/billing.worker.ts:14 :: sql
src/modules/billing/invoices.service.ts:1 :: and, eq
src/modules/billing/price-catalog.service.ts:1 :: and, desc, eq, isNull, or, sql
src/modules/billing/quota.service.ts:2 :: sql
src/modules/billing/spend-ingest.service.ts:2 :: inArray
src/modules/billing/stripe.service.ts:3 :: and, eq, inArray, sql
src/modules/billing/trial-expiry.service.ts:1 :: and, isNotNull, lt, eq
src/modules/billing/usage-ledger.service.ts:2 :: and, eq, sql
src/modules/billing/usage-query.service.ts:2 :: and, eq, gte, lte, sql
src/modules/channels/channels.service.ts:1 :: and, desc, eq, sql
src/modules/channels/ingest.service.ts:1 :: and, eq, sql
src/modules/channels/outbound.service.ts:1 :: and, eq
src/modules/channels/templates.service.ts:1 :: and, desc, eq
src/modules/channels/widget.service.ts:1 :: and, eq, sql
src/modules/config-publish/config-publish.service.ts:2 :: and, desc, eq, gt, inArray, isNull, sql
src/modules/console/audit-query.service.ts:1 :: and, desc, eq, gte, lte, lt, sql
src/modules/console/console-home.service.ts:2 :: sql
src/modules/console/onboarding.service.ts:1 :: and, eq, inArray, isNull
src/modules/console/status.service.ts:1 :: and, desc, eq, gte, isNull, lte, or
src/modules/conversations/conversations.service.ts:1 :: and, asc, desc, eq, gt, inArray, isNull, ne, sql
src/modules/conversations/escalations.service.ts:1 :: and, asc, desc, eq, inArray, sql
src/modules/conversations/mcp-authority.service.ts:2 :: and, asc, desc, eq, gt, inArray, isNull, or, sql
src/modules/corporate/careers.service.ts:1 :: and, desc, eq, sql
src/modules/corporate/contact-inbox.service.ts:1 :: eq, sql
src/modules/corporate/content-staff.guard.ts:1 :: eq
src/modules/corporate/content.controller.ts:3 :: eq
src/modules/corporate/content.service.ts:1 :: and, desc, eq, isNotNull, lte, sql
src/modules/corporate/email/email.service.ts:2 :: sql
src/modules/corporate/feeds.service.ts:2 :: desc, eq
src/modules/corporate/newsletter.service.ts:1 :: and, desc, eq, sql
src/modules/corporate/suppression.service.ts:1 :: desc, eq, sql
src/modules/deployment/deployment.worker.ts:2 :: and, eq, lt
src/modules/deployment/deployments.service.ts:1 :: and, desc, eq, inArray, sql
src/modules/deployment/environments.service.ts:1 :: and, desc, eq, ne, sql
src/modules/deployment/pipelines.service.ts:1 :: and, eq, ne, sql
src/modules/deployment/releases.service.ts:1 :: and, desc, eq, gte, inArray
src/modules/deployment/secrets.service.ts:1 :: and, eq, isNotNull, lte, or, sql
src/modules/deployment/settings.service.ts:1 :: eq
src/modules/deployment/summary.service.ts:2 :: and, eq, gte, sql
src/modules/identity/account-actions.service.ts:1 :: and, eq, isNull, sql
src/modules/identity/account-deletion.service.ts:1 :: and, eq, lte, sql
src/modules/identity/accounts.service.ts:1 :: eq
src/modules/identity/credentials.service.ts:2 :: and, eq, isNull
src/modules/identity/email-change.service.ts:1 :: eq
src/modules/identity/email-code.service.ts:2 :: and, desc, eq, isNotNull, isNull, lt, or, sql
src/modules/identity/identity-public.service.ts:1 :: eq, or
src/modules/identity/mfa.service.ts:1 :: and, eq, isNull
src/modules/identity/oidc/oidc-adapter.ts:2 :: and, eq, sql
src/modules/identity/onboarding.service.ts:1 :: eq, sql
src/modules/identity/password.service.ts:1 :: and, desc, eq, inArray, isNull, sql
src/modules/identity/social/social-account.service.ts:1 :: and, eq
src/modules/keys/keys.service.ts:2 :: and, desc, eq, like, lte
src/modules/knowledge/analytics.query.service.ts:1 :: sql
src/modules/knowledge/artifacts.service.ts:2 :: and, asc, desc, eq, sql
src/modules/knowledge/connectors.service.ts:1 :: and, eq, inArray
src/modules/knowledge/eval.service.ts:1 :: and, asc, desc, eq, sql
src/modules/knowledge/ingestion.service.ts:1 :: and, asc, desc, eq, inArray, lte, or, isNull, sql
src/modules/knowledge/memory.service.ts:1 :: and, desc, eq, isNull, or, sql
src/modules/knowledge/retrieval.service.ts:1 :: and, desc, eq, isNull, or, sql
src/modules/lifecycle/lifecycle.service.ts:1 :: and, desc, eq, isNull
src/modules/lifecycle/retention-purge.service.ts:1 :: and, asc, eq, inArray, isNull, lte, or, sql
src/modules/notifications/notifications.service.ts:1 :: and, desc, eq, isNull
src/modules/organizations/entitlements.service.ts:1 :: and, eq
src/modules/organizations/invites.service.ts:2 :: and, desc, eq, isNull, sql
src/modules/organizations/memberships.service.ts:1 :: and, asc, count, eq, ilike, inArray, or, sql
src/modules/organizations/org-access.service.ts:2 :: inArray, sql, and, eq
src/modules/organizations/org-audit.service.ts:2 :: sql
src/modules/organizations/org-groups.service.ts:1 :: and, asc, count, eq
src/modules/organizations/org-info.ts:1 :: sql
src/modules/organizations/org-lifecycle.service.ts:1 :: and, eq, lte, sql
src/modules/organizations/org-service-accounts.service.ts:2 :: and, desc, eq
src/modules/organizations/org-settings.service.ts:1 :: and, eq, isNull, sql
src/modules/organizations/projects.service.ts:1 :: and, asc, eq, isNull
src/modules/satellites/revocation-log.service.ts:1 :: and, asc, gt, sql
src/modules/satellites/satellite-activity.service.ts:1 :: eq, sql
src/modules/satellites/satellite-incidents.service.ts:1 :: and, desc, eq, isNull
src/modules/satellites/satellite-registry.service.ts:1 :: and, asc, desc, eq, gte, sql
src/modules/satellites/satellite-sweeper.worker.ts:3 :: eq, lt, sql
src/modules/staff/platform-staff.admin.ts:2 :: and, eq, isNull, sql
src/modules/staff/staff-impersonation.service.ts:3 :: and, desc, eq, isNull, sql
src/modules/staff/staff.controller.ts:3 :: sql
src/modules/studio-furniture/keys.service.ts:1 :: and, eq, inArray
src/modules/webhooks/webhooks.service.ts:1 :: and, desc, eq, sql
src/scripts/sync-template-registry.impl.ts:2 :: and, eq
src/workers/accepted-run-sweep.worker.ts:2 :: and, eq, sql
src/workers/analytics-rollup.consumer.ts:2 :: sql
src/workers/approval-expiry-sweep.worker.ts:2 :: sql
src/workers/eval-executor.consumer.ts:2 :: and, eq, inArray, isNull, sql
src/workers/eval-scoring.consumer.ts:2 :: and, eq
src/workers/llm-judge.consumer.ts:3 :: and, eq
src/workers/memory-proposer.consumer.ts:2 :: eq, sql
src/workers/model-drift.worker.ts:2 :: sql
src/workers/reembed.worker.ts:2 :: and, eq, sql
src/workers/run-dispatch.consumer.ts:1 :: and, eq, sql
src/workers/run-watchdog.worker.ts:2 :: sql
src/workers/template-provisioning.consumer.ts:1 :: and, eq
```

## 9. Appendix B — Files that reference `DbService` but never call it

| File | Usage |
|---|---|
| `src/common/kernel.module.ts` | Imports, provides, and exports `DbService` (DI wiring). No calls. |
| `src/workers/outbox-dispatcher.worker.ts` | Injects `DbService`, passes it to `purgeExpiredIdempotencyRecords(this.db)`; no direct `db.*` calls. |
| `src/transport/mcp/mcp.module.ts` | Mentions `DbService` in a comment only (provides it directly to avoid a BillingModule cycle). |
| `src/scripts/sync-template-registry.ts` | Mentions `DbService` in a comment only. |

Module constructors that only register `db.check()` health probes (counted as `check` call sites, not queries): `deployment.module.ts:68`, `corporate` module, `organizations` module, `config-publish` module, `staff` module, `billing.module.ts:73`, `identity.module.ts`, `webhooks`, `keys`, `console`, `studio-furniture`, `notifications` modules.

## 10. Verification method and known limitations

1. **Independent workers** inventoried each module, verifying every hit against the `DbService` import + constructor injection — ruling out false positives from other `db` objects.
2. **Independent reconciliation**: mechanical grep counts were diffed against every worker file at the `file:line` level, then per-directory. **Final result: exact agreement on all five methods** — withOrg 446/446, withBypass 96/96, root 296/296, root.transaction 8/8, check 13/13.
   - 7 comment-only `db.root` mentions excluded (e.g. `organizations/invites.service.ts:296` — literally "NOT this.db.root"; `identity/schema.ts:75`; `assistants/control-blocks.service.ts:127`).
   - 1 test-file hit excluded (`identity/onboarding.service.test.ts:6`).
   - 2 line-attribution differences in assistants (worker pointed at the adjacent line of the same call site: `templates.service.ts:118→119`, `:354→356`).
   - **corporate**: worker summary said 80 root sites; the file actually lists **83** (summary arithmetic corrected; total 82 → **85**).
   - **lifecycle**: worker summary said withOrg 18 / withBypass 11; the sites are actually **withOrg 17 / withBypass 12** (total unchanged at 29; verified against source — `lifecycle.service.ts:82` is genuinely `withBypass`).
3. **Limitations**: line numbers refer to `main` @ `6a92168` (2026-09-26) and will drift; `db.root` multi-line statements are counted once (statement-level); transaction-boundary tables list the tables touched inside the TX but delegate reads via tx-passing helpers are noted where the worker traced them.
