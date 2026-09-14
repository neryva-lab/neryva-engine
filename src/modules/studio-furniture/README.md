# studio-furniture (`src/modules/studio-furniture`)

**Purpose:** project-key binding furniture inside the engine (ledger
agent-studio S-1…S-4): entitlement plans, the summary card, org-level
studio views, project-scoped key bindings, runtime pointers. This is NOT the Agent Studio runtime — canonical runtime is `products/agent-studio/` (Temporal + TS), canonical MCP contract is `products/neryva_mcp/neryva-mcp-contract/`, canonical frontend is `../console/neryva-website/` (Vite React, UI `/agent-studio/*`). Distinct from
the agent-runtime satellite (ADR-006): the runtime serves `/v1` +
`/surfaces`; this module is the product REGISTRATION the console renders.

**Routes:** `/console/studio-furniture/**` (L1 + membership; entitlement
semantics 403 `entitlement_required` / 402 `past_due` per the access-model;
trial start is owner/billing + step-up MFA). Org context: `X-Neryva-Org`.

**Tables (engine-owned, eng-0006, RLS per org_id):** `studio_project_keys` —
the key→project BINDING. Key rows stay Python-owned (`api_keys`) until
handover A-1; one authority per fact.

**Flag:** `MODULES__AGENT_STUDIO_ENABLED` (requires console + billing).

**Semantics:**
- Plans: `studio-team` (14-day trial, capped) / `studio-enterprise`
  (uncapped, no self-serve trial) — limits feed the quota engine
- Summary (`S-3`): conversations 7d + projects + month spend from the
  engine metering plane; resolution/guardrail KPIs arrive with the runtime
  observability feed (A-3/A-4) — per-row empty fallback, never fake data
- Keys: read-only listing of org keys (Python-owned table, explicit tenant
  filter) + engine-owned project bindings; spend under a bound key carries
  the project id (S-5 closes with A-3)
- Pointers: deep links to runtime-served surfaces from the manifest's
  satellite base URLs — evaluations/policies homestead there until/if ever
  moved into the engine

**Public interface:** `AgentStudioSummary` (registers into the console's
summary registry at boot, replacing the interim built-in),
`StudioKeysService`.
