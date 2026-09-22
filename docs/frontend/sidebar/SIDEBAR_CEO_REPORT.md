# Studio Sidebar: Current State, Redesign, and Migration Plan

> To: CEO. From: Agent Studio team. Date: 2026-09-17.
> Recommendation up front: **replace the single 19-item sidebar with a 7-domain rail whose
> secondary sidebar is dynamic per section.** No dead URLs, no removed destinations, three new
> destinations the engine already requires. Detail below; every factual claim cites its source file.

## 1. Executive summary

The Studio sidebar works, but it does not scale. It lists **19 destinations flat across 5 groups**,
mixing daily workflows (Agents, Chat) with quarterly administration (Compliance, API explorer) in one
visual tier. Three engine-backed surfaces the product already needs — **Datasets, Blocks, Memory** —
have nowhere to live: none has a route, and engine errors name fixes (browse a dataset, read a block
reason) with no page behind them. Webhooks shows the way out — nested under Integrations, it is the
one destination that already works this way, but it has zero sidebar presence. Six Settings pages
share a single sidebar item.

The redesign keeps every destination, adds the three missing ones, and cuts the maximum
simultaneously visible destinations from **19 to 8**, behind **7 domain landmarks** — while total
destinations honestly grow from 19 to ~31 (listed Settings children, Webhooks, Overviews, new
surfaces). Fewer things to scan, more places that exist. This is the same architecture Intercom
ships for Fin (`Fin AI Agent > Train > Test > Deploy > Analyze`) and Microsoft ships for Copilot
Studio (Build / Preview / Evaluate / Monitor tabs per agent, Analytics section globally). It is the
industry-settled answer to exactly our problem, not an experiment.

Cost: a shell recomposition over existing routes — no endpoint work, no dead URLs, no
repurposed URLs, no data migration. (Overviews are new routes: `/agents/overview` alongside the
untouched fleet list — §5.) Risk is sequencing, not technology. The plan in §6 ships it in four
phases with the product usable after each.

## 2. Current state — exact inventory (verified against source)

Source: `console/neryva-website/src/neryva_data/products/agent_studio/nav.json` (all 135 lines read),
`sections/pages/products/agent-studio/StudioShell/StudioShell.tsx` (all 449 lines read),
`router/routes.tsx` (full route dump).

| Group | Items (label → route) | Count |
|---|---|---|
| Workspace | Dashboard → `/agent-studio/dashboard` · Chat → `/agent-studio/chat` · Agents → `/agent-studio/agents` (+ `/$agentId`, `/$agentId/edit`) · Conversations → `/agent-studio/conversations` · Activity → `/agent-studio/activity` | 5 |
| Knowledge | Knowledge → `/agent-studio/knowledge` · Models → `/agent-studio/models` · Templates → `/agent-studio/templates` · Tools → `/agent-studio/tools` | 4 |
| Insights | Analytics → `/agent-studio/analytics` · Usage → `/agent-studio/usage` · Evaluations → `/agent-studio/evaluations` | 3 |
| Platform | Integrations → `/agent-studio/integrations` (+ child `/integrations/webhooks`) · API explorer → `/agent-studio/api` · Compliance → `/agent-studio/compliance` · Teams → `/agent-studio/teams` · Channels → `/agent-studio/channels` · Approvals → `/agent-studio/approvals` | 6 |
| Settings | Settings → `/agent-studio/settings/profile` (6 child pages exist: profile, workspace, team, billing, security, api-keys) | 1 entry, 6 pages |

Total: **19 entries over 27 content routes (+2 index redirects).** Shell extras: brand row,
sidebar filter input, command palette (⌘K, separate system), up to 5 recent chats (real data),
workspace card, "Upgrade to Scale" card, org switcher, notifications, account menu, entitlement +
status banners, mobile drawer. (Route count hand-tallied from `routes.tsx:294-423` read in full
plus a complete `path:` dump of the file: every section is a leaf route except agents —
`/$agentId`, `/$agentId/edit` — settings — 6 children — and integrations — child
`/integrations/webhooks`. Both index routes are redirects: root → chat, settings → profile.)

What works and is kept: real-data wiring (recents, palette indexing agents/conversations/members/keys),
parent-highlighting for three subtrees, `aria-current`, Escape/scroll-lock drawer, keyboard shortcuts
(C/A/K/`,`), role-gated New-chat button with explanatory copy (the one place gating is done right).

## 3. Diagnosis — ten findings, each triple-checked

| # | Finding | Severity | Proof |
|---|---|---|---|
| F1 | 19 flat landmarks; daily and quarterly tasks share one tier | High | `nav.json:2-123` (counted, not estimated) |
| F2 | **Datasets has no route and no entry** — yet `evaluateVersion` without a dataset returns 422 `install from a template or pass dataset_id explicitly` (`assistants.service.ts:1014-1024`). The template half of that fix exists; the dataset half (browse a dataset to learn its id) does not — the list read exists server-side (`GET eval/datasets`, `harness-parity.controller.ts:50-55`) with zero UI over it | High | routes dump (no `/datasets`); engine cites above |
| F3 | **Blocks has no surface** — `control_blocks` + `template_platform_blocks` refuse installs, publishes, and releases with 409s that name no page (block reasons are operator text with nowhere to be read) | High | routes dump (no `/blocks`); `templates.service.ts:249-254`, `release-gate.ts`, `rollouts.service.ts:119-132` |
| F4 | **Memory has no surface** — `memory_items` (org-scoped, TTL, proposals, DSR delete) is unmanageable in-product | High | routes dump (no `/memory`); `knowledge/schema.ts:205-237` |
| F5 | **Webhooks is nested but invisible in wayfinding** — child of Integrations (`routes.tsx:362-366`), linked in-page (`IntegrationsView.tsx:364-367`), correctly highlighted via prefix match. The pattern works; it is simply the only nested destination and has zero sidebar presence. Kept as precedent FOR the proposal, not a failure | Low (observation) | routes + view cites above |
| F6 | **6 Settings pages, 1 entry** — workspace/team/billing/security/api-keys reachable only from inside Settings (if linked there at all) | Medium | routes dump vs `nav.json:113-122` |
| F7 | **Active-state scheme does not scale** — prefix matching is a hand-maintained 3-item list (`StudioShell.tsx:218-220`); every other section is a leaf route today, so nothing breaks *yet*. The first detail route added anywhere else (knowledge doc, eval run, template version, approval — all on the roadmap) ships unhighlighted unless someone remembers the list. Query-string deep links (`/conversations?chat=`) do highlight (pathname matching) | Medium (latent) | code + routes cited |
| F8 | **No role-gating on nav** — all 19 entries render identically for every role; only the New-chat button checks capability (`StudioShell.tsx:336-359` vs `:417-432`). Under-privileged users can navigate to admin pages and fail at the API instead of being told upfront | Medium | code cited |
| F9 | **Duplicate icons** dilute scanning: Conversations = Channels (`MessagesSquare`), Approvals = Compliance (`ShieldCheck`), Activity = Usage (`Activity`) (`StudioShell.tsx:106-126`) | Low | code cited |
| F10 | **Two overlapping searches + a billboard**: sidebar substring filter and ⌘K palette do overlapping jobs; the "Upgrade to Scale" card sits inside wayfinding (`StudioShell.tsx:390-394`). No collapse control exists at all | Low | code cited |

What this costs the business: every dead end (F2–F4, F6) is a support ticket or a churned evaluation;
ungated admin entries (F8) are an enterprise-trust failure in security reviews; and there is
literally no place to put the next three surfaces the roadmap already requires — the shell, not the
team, is the bottleneck.

## 4. What the industry does (researched 2026-09-17)

- **Intercom Fin** scopes the whole product under `Fin AI Agent >` with lifecycle sections Train
  (Content/Guidance/Tasks) → Test → Deploy → Analyze (Performance/Optimize/Topics/Conversations),
  plus a separate `Knowledge > Sources` library with **per-consumer tabs** (AI Agent / Copilot /
  Help Center). Two-plane thinking (agent config vs shared library) with section-scoped nav.
- **Microsoft Copilot Studio** gives each agent Build (identity/knowledge/tools/model/memory) /
  Preview / Evaluate / Monitor, and a global Analytics section (Summary/Sessions/Topics/CSAT).
  Builders never leave the agent context; observers never enter it.
- **Pattern consensus** (5 independent sources): 5–8 top-level landmarks max; slim primary rail +
  section-scoped secondary sidebar for deep products; top bar for globals (search/account);
  breadcrumbs at depth; group by user intent, never org chart; daily tasks top, administration
  bottom; active state needs two signals; role-gated items stay visible with explanation;
  ⌘K as primary navigation for experts; never promote every module to top level.

## 5. Proposed IA — 7 domains, dynamic secondary sidebar

One sidebar, two levels (locked user directive — never two nav columns, zero retheme of the
shipped dark shell). Level 1 lists the 7 domains (**Dashboard · Chat · Agents · Libraries ·
Insights · Platform · Settings**); tapping a domain **replaces** the sidebar's nav region with
that section's destinations plus a `‹ All sections` back row. Brand row, search, recents (level 1),
footer, and topbar persist as chrome. Builder routes hide the sidebar entirely (full-bleed).
Precedent: Atlassian contextual sidebar nest + Jira project-centric sidebar; universal actions stay
in the top bar.

| Domain | Secondary sidebar (dynamic) | Section home carries |
|---|---|---|
| Dashboard | none (it is the home) | ORG-LEVEL cross-domain roll-up only: needs-you across domains, entitlements, platform health. Never fleet detail (that is Agents Overview's job — boundary locked) |
| Chat | none (single surface, unchanged) | recents + link to the full Conversations list under Agents (act vs investigate, bridged not merged) |
| Agents | Overview · All agents · Templates · Conversations · Evaluations | fleet health ONLY (Live/Draft/Needs-attention/Degraded/Blocked, each a filter), needs-attention queue with per-row fix, recents, shortcuts to Tools/Models/Templates (shortcuts, never ownership — designed: `../agent_flow/builder/agents_overview.svg`) |
| Libraries | Documents · Sources · Memory · Datasets · Tools · Providers & Models | library health (processing/failed/quarantined counts, coverage states). NO ambient used-by matrix (locked): single-entity "N published agents" counts live on detail pages only |
| Insights | Analytics · Usage · Activity | observation only; nothing here mutates an agent. Activity header states it is the live human-readable feed (immutable record lives in Compliance) |
| Platform | Connect: Integrations · Webhooks · Channels / Governance: Approvals · Blocks (new) · Compliance (incl. audit log) / Developer: API explorer (cross-linked to Settings › API keys) | governance; role-gated items visible-with-explanation |
| Settings | Profile · Workspace · Roles (ex-Team) · Billing · Security · API keys | the 6 existing pages, finally addressable. Members (ex-Teams, Platform) = directory/invites/service-accounts; Roles = role changes, suspension, removal — collision resolved by content, not preference |

Locked-name restorations: **Providers & Models** (one entry, two tabs — credentials/enablements are
provider-scoped, catalog/costs model-scoped); **Libraries** (new domain noun — D6). Template-card
blocked state ships with Phase 2/3 (`Install blocked — reason, expiry` + link to Blocks; install
refuses in-TX). Every `org`-scoped confirmation deep-links its pre-filtered audit view
(`/compliance?entity=<type>:<id>&event=<name>` — acceptance item, not optional).
Datasets lives in Libraries AND is one tap from where it is needed: the Evaluations page and the
422 error state deep-link straight into the dataset picker with `returnTo`.

Routing honesty (corrected — an earlier draft repurposed `/agents`; repurposing is a silent semantic
break, worse than a 404): **no URL is repurposed.** `/agents` stays the fleet list; the Overview is
new at `/agents/overview` (static segment — zero collision risk with `/agents/$agentId`). Knowledge
repeats the pattern in its design pass; all other roots keep their routes. Index redirects
(root → chat today, settings → profile) are addressed by decision D4. Datasets/Blocks/Memory need
only reads that already exist (`GET eval/datasets`, control-blocks list, `GET memories`
— `knowledge.controller.ts:194-197`) — no endpoint work; the one possible exception is a
capability read for F8 gating (see gates).
Builder phases (test run, publish), operate, approvals aggregation, scope classes, tokens, and
vocabulary locks from the agent_flow program apply unchanged *inside* sections — this proposal
reorganizes wayfinding, not product semantics.

Behavior rules (locked with this proposal): universal prefix active-matching, replacing the
3-item hand list (fix F7); **route → domain membership declared in `nav.json` as the single source
of truth** (domains don't share prefixes, so membership can't be derived — it must be declared),
with a test asserting every route in `routes.tsx` maps to exactly one domain; capability-gated
entries render visible-with-explanation (fix F8) + a test asserting the frontend role map matches
the backend `@Roles` guards; existing iconography kept (zero retheme — F9 dissolves because
destinations are distributed, max 8 per level); sidebar filter scopes to the current level, global
⌘K stays global; collapse persisted per account; Upgrade card leaves the sidebar for the Billing
page; breadcrumbs `Domain / Page` at all depths; back row never navigates (chrome action), logo
goes to Dashboard; focus moves + announces on swap; Esc precedence modal → drawer → level-up;
section switches preserve nothing but org context; **builder routes hide the sidebar entirely
(full-bleed)** — and the builder `dirtyGuard` gates every sidebar control, not just browser unload;
mobile keeps the single-sidebar drawer + bottom tabs. Full behavior spec: `SIDEBAR_LEDGER.md` §4.

## 6. Migration plan (usable after every phase, no URL breakage)

- **Phase 1 — shell skeleton**: single-sidebar level swap + breadcrumbs over EXISTING routes;
  keep all 19 entries reachable; universal prefix active-matching + collapse + back row + focus/Esc
  rules; nav.json-declared domain mapping + mapping test; builder routes excluded to full-bleed
  (sidebar hidden, dirtyGuard gates all sidebar controls); clicking a domain with no home yet
  navigates to its first secondary item (never select-and-show-nothing). Styling untouched.
  (Fixes F1, F7, F9, F10-partial.)
- **Phase 2 — section homes**: Agents Overview first (designed; new at `/agents/overview`, list
  untouched at `/agents`), then Knowledge Overview; Dashboard takes the org-level roll-up with the
  R3 boundary written into both page headers. Template-card blocked state ships here. (Makes the
  rail destinations real pages. No URLs repurposed, none dead.)
- **Phase 3 — missing destinations**: Datasets (read-only browse over the existing list read),
  Blocks (org manageable / platform read-only + computed Active/Expired), Memory library — each
  with an explicit **empty state as reassurance** ("No blocks affect your organization"), never an
  abandoned room. (Fixes F2–F4; independent shippable slices; no endpoint work.)
- **Phase 4 — promotions & gating**: Webhooks into Platform nav; all 6 Settings children into
  secondary (fix F6); capability-gated rendering everywhere (fix F8); scoped filter kept,
  Upgrade-card moved; ⌘K indexes all new destinations and gains create actions. (Fix F10-remainder.)
- Gates per phase: `typecheck && lint && test` green; route-parity checklist (all §2 routes resolve
  + highlight correctly, **including cold-load deep links with no prior client state**);
  role-matrix pass (viewer/developer/admin see explained, not silent, states); role-map↔guards
  consistency test; fresh-org click-through of every new destination.

## 7. Decisions (answered — sign-off requested, not discussion)

1. **Theme: keep the shipped dark shell — DECIDED.** Refinement and restructure, not a retheme:
   canvas `#0A0A0E`, surfaces `#14141B`, hairlines `#26262F`, accent `#0A84FF` (visual contract
   `sidebar_dynamic.svg` (this folder) rebuilt in these tokens). Standing rule: never ship
   mixed themes across domains. Outstanding: `../agent_flow/builder/agents_overview.svg` is still
   light-tokened — retheme it in Phase 2 alongside its content pass.
2. **Chat stays top-level; Conversations stays under Agents.** Chat = act, Conversations =
   investigate a specific run (usually from an agent). Bridge them: Chat home shows recents + link
   to the full list. Merged neither, unlinked neither.
3. **Approvals in Platform: confirmed.** Governance domain; builder deep-links carry `returnTo`.
4. **Root → Dashboard**, provided the R3 boundary holds (Dashboard genuinely org-level). Rationale:
   this IA positions a builder/governance console, and cross-domain needs-you is its highest-value
   landing. Measurable behaviour change from today's root → chat; Chat stays one click + ⌘K away.
5. **D5 rejected: Tools/Models live in Libraries, not Agents.** The stated need is already met by
   inline attach in the builder; moving org governance into a per-agent section breaks the
   blast-radius law. Agents Overview keeps shortcuts; ownership does not move.
6. **D6 sign-off requested on**: Libraries, Overview, All agents, Members (ex-Teams: directory,
   invites, service accounts — `TeamsView.tsx:115-168`), Roles (ex-Settings › Team: role changes,
   suspension, removal — `SettingsTeam.tsx:34,59-68`). Collision that forced this: two near-identical
   labels on different routes, resolved by content. Naming policy stands for everything after.

## 8. Review resolutions (second review, 2026-09-17 — accepted, corrected, or refuted with proof)

| # | Claim | Disposition |
|---|---|---|
| L1 | Memory-in-Knowledge contradicts own-entry lock | ACCEPTED — Libraries domain; Memory a full destination, never a tab |
| L2 | Knowledge-home "which agents use what" = banned ambient matrix | ACCEPTED — struck; detail-page counts only, per lock |
| L3 | Audit deep-link contract unaddressed | ACCEPTED — `/compliance?entity=<type>:<id>&event=<name>` as acceptance item |
| L4 | Template-card blocked state missing | ACCEPTED (was already in C11 SPEC; now in Phase 2/3) |
| L5 | "Models" drops locked "Providers & Models" | ACCEPTED — name restored with scope rationale |
| L6 | New nouns need D6 run | ACCEPTED — §7.6 list |
| 2a | `/agents/all` repurposing is a silent break | ACCEPTED — `/agents/overview` instead; nothing repurposed |
| 2b | Memory reads self-cited; capability-map drift risk | ACCEPTED as verification: memory reads grounded (`knowledge.controller.ts:194-206`); role-map↔guards test added as gate |
| 2c | 27 vs 28 tally | ACCEPTED — 27, fixed (recount table above) |
| 2d | Headline metric rail-only; Platform dumping ground | ACCEPTED — reframed 19→8 visible / ~31 total; Platform sub-headers; API explorer to Developer + cross-link |
| §3 map | Libraries domain, Datasets caveat, shortcuts-not-ownership | ACCEPTED as written |
| R1–R12 | Declared mapping + test; full-bleed builder + dirtyGuard; R3 boundary; Teams/Members + Roles resolution (content-verified); Activity/Compliance header split; domain→first-item; cold-load gate; mobile two mechanisms; existing iconography kept (F9 dissolves by distribution); scoped filter kept; empty states deliverable; ⌘K create | ACCEPTED — all in §§5–6 above |
| Single-sidebar law | Rail + secondary columns rejected — one 264px sidebar, content swapped by level; zero retheme; builder hides it entirely | ACCEPTED — report §§5–6 + `SIDEBAR_LEDGER.md` §§3–4 rewritten; visual re-cut as `sidebar_dynamic.svg` (this folder) |

## 9. Appendix — verification log (how each §3 claim was checked)

- Sidebar inventory: full read of `nav.json` (135 lines) + `StudioShell.tsx` (449 lines); counts
  hand-tallied (5+4+3+6+1=19).
- Route inventory: `routes.tsx:294-423` read in full plus a complete `path:` dump — 27 content
  routes + 2 redirects; agents/settings/integrations subtrees confirmed; Webhooks confirmed as
  integrations child linked in-page (`IntegrationsView.tsx:364-367`); absence of `/datasets`,
  `/blocks`, `/memory` and all 6 settings children confirmed by targeted grep.
- Engine errors: `assistants.service.ts:1014-1024` (dataset 422), `:1884-1889` (no-op 409),
  `templates.service.ts:249-254` (block 409), `knowledge/schema.ts:205-237` (memory shape),
  `control-blocks.service.ts:14-18` (check-time expiry) — all read firsthand this program.
- Behavior: active-matching (`StudioShell.tsx:218-220`), ungated nav vs gated button
  (`:336-359` vs `:417-432`), icon map (`:106-126`), dual search (`:320-330` + `:440-446`),
  no collapse control (full-file read), Upgrade card (`:390-394`).
- Reads over new destinations confirmed existing: `GET eval/datasets`
  (`harness-parity.controller.ts:50-55`), control-blocks list (`control-blocks.service.ts:29-34`),
  `GET memories` → listMemories + proposals decision (`knowledge.controller.ts:194-206`).
  No endpoint work required for Phase 3 browse surfaces.
- Theme: token-driven shell (`theme.app.*` throughout `StudioShell.styles.ts`; 1 hardcoded hex —
  sweep in Phase 1). Light migration viable before the shell rebuild.
- Teams vs Team resolved by content: `TeamsView` = directory/invites/service-accounts;
  `SettingsTeam` = role changes, suspension, removal → Members vs Roles (§7.6).
- Competitive: Intercom Fin Flywheel + Sources docs, Copilot Studio Build/Monitor/Analytics docs
  (fetched 2026-09-17); pattern sources: DesignPixil, SaaSUI, Raze, UX Patterns Guide, Lollypop.
