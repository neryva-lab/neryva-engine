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
