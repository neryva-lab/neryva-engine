# console (`src/modules/console`)

**Purpose:** the control plane — the product-manifest registry, `/console/home`
with product cards, and the summary-provider contract (ledger console.md
C-1…C-4). The shell contains ZERO product-specific code: adding a product
adds a manifest in `products_manifests/` and (at stage ga) registers a
summary provider — never shell changes.

**Routes:** `GET /console/home` (L1; org context via X-Neryva-Org header or
the first membership). Every registered product always appears — owned
products show cached cards, un-owned show the brief with a role-derived CTA
(access-model entitlement-state table).

**Tables:** none owned (cards cache in Redis; state comes from
organizations).

**Flag:** `MODULES__CONSOLE_ENABLED` (requires organizations).

**Artifacts owned:**
- `products_manifests/*.yaml` — versioned manifests (key, stage, faces,
  console nav, scopes, entitlement plans, metering tag, runtime routes,
  satellite runtime prefixes). Reviewed like ADRs.
- `scripts/export-openapi.ts` + `scripts/compose-contract.ts` — the
  composed-contract pipeline (C-2'): engine spec + runtime pinned spec →
  one `openapi.composed.v1.json` with `x-neryva-owner` on every path and
  CI-enforced bijection for stage-ga manifests.

**Manifest stage lifecycle:** registered → building → shadow → ga →
deprecated. Bijection with the composed contract is enforced at ga; cards
render from stage `building` onward (deployment.yaml is live at stage
`building` today).

**Public interface:** `ManifestRegistryService` (product registration) and
`SummaryProviderRegistry` (card providers) — product modules register
through these at boot.

## Platform surface (gap C-2/C-3 + O-5/O-6 — the benchmark consoles' furniture)

- **`GET /console/notifications[?unread=true&limit=]`** · **`POST …/:id/read`** · **`POST …/read-all`** — the notification center's read surface, proxied to `modules/notifications` (eng-0011, the single write authority: events → notifications, optional email fan-out). Badge counts, per-account read state.
- **`GET /console/onboarding`** — the first-run checklist (project? key? trial? first usage?) computed live from engine-owned state — OpenAI/Anthropic-style guided setup; no stored flags to drift.
- **`GET /console/org/:orgId/limits`** — per-product quota snapshots joined with entitlement states (benchmark pattern #9: limits attach to the grouping unit, visible where they bind).
- **`GET /console/org/:orgId/audit?actor=&action=&from=&to=&before=&limit=`** — the upgraded audit view: cursor pagination, actor/action-prefix/date filters, capped at 200/page (enterprise day-one).
- **`GET /console/org/:orgId/audit/export`** (owner/admin/billing) — NDJSON compliance export with the same filters; **`…/audit/verify`** — the tamper-evidence view (chain recompute).
- **`GET /console/status`** — the status center: overall posture (operational/degraded/outage), per-component health, satellite liveness from heartbeats, and the active announcement window — statuspage parity inside the console.
- **`POST /console/announcements` / `…/:id/resolve`** — staff-managed announcements (maintenance/incident/notice/product_release), L2 super_admin/operator-gated; resolving closes the window, history preserved (the incident history IS the status page).

New tables: `console_announcements` (eng-0009). The route↔manifest bijection's platform prefixes cover every new namespace — undeclared surface remains impossible.
