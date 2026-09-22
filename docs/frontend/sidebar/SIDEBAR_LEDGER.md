# Sidebar Restructure Ledger — whole-Studio dynamic navigation (BUILD LEDGER, 2026-09-17)

> Status: LEDGER (plan locked, zero code changed). Parent: `SIDEBAR_CEO_REPORT.md` (the why).
> This file is the how. Scope: the ENTIRE agent-studio shell — agents work waits on this foundation.
> Order lock: Phase 0 → 4 below. No phase starts until the previous gate is green.
> Conventions: paths relative to `console/neryva-website/`; engine paths relative to repo `neryva_studio/`.

## 0. Locked inputs (do not re-decide)

- 7 domains: Dashboard · Chat · Agents · Libraries · Insights · Platform · Settings (report §5).
- Libraries members: Documents · Sources · Memory · Datasets · Tools · Providers & Models.
- Agents members: Overview (`/agents/overview`, NEW) · All agents (`/agents`, unchanged list) ·
  Templates · Conversations · Evaluations.
- Vocabulary lock, scope classes, used-by lock, three don't-builds (`../agent_flow/ORGANIZATION.md`, `../agent_flow/components/README.md`).
- Light theme committed (shell verified token-driven; sweep the 1 hardcode in Phase 1).
- Builder routes render full-bleed (both rails suppressed, `← Agents` return); dirtyGuard gates rail nav.

## 1. Route→domain map (normative — the R1 test enforces exactly this)

Existing roots keep their URLs. `*` = new route in this program.

| Route | Domain | Secondary item |
|---|---|---|
| `/agent-studio/dashboard` | Dashboard | — (it is the home) |
| `/agent-studio/chat` | Chat | — (single surface) |
| `/agent-studio/agents` | Agents | All agents |
| `/agent-studio/agents/overview` * | Agents | Overview |
| `/agent-studio/agents/$agentId` | Agents | All agents (prefix; detail is not its own item) |
| `/agent-studio/agents/$agentId/edit` | — | FULL-BLEED (no rails) |
| `/agent-studio/agents/new` * | — | FULL-BLEED (no rails). NOTE: no such route exists today (verified — creation is modal/state; `/agents/$agentId` would swallow "new" as a param). Static route takes precedence in TanStack; add it explicitly |
| `/agent-studio/templates` | Agents | Templates |
| `/agent-studio/conversations` (+ `?chat=`) | Agents | Conversations (query ignored by matcher) |
| `/agent-studio/evaluations` (+ future run detail) | Agents | Evaluations |
| `/agent-studio/knowledge` | Libraries | Documents |
| `/agent-studio/knowledge/overview` * (its design pass) | Libraries | — (domain lands on Documents until then, per R6) |
| `/agent-studio/knowledge/sources` * | Libraries | Sources |
| `/agent-studio/memory` * | Libraries | Memory |
| `/agent-studio/datasets` * | Libraries | Datasets |
| `/agent-studio/tools` | Libraries | Tools |
| `/agent-studio/models` | Libraries | Providers & Models |
| `/agent-studio/analytics` | Insights | Analytics |
| `/agent-studio/usage` | Insights | Usage |
| `/agent-studio/activity` | Insights | Activity |
| `/agent-studio/integrations` (+ `/webhooks` child) | Platform | Integrations (prefix covers webhooks; webhooks ALSO listed as its own item → same route appears once in secondary with parent chain shown) |
| `/agent-studio/channels` | Platform | Channels |
| `/agent-studio/approvals` | Platform | Approvals |
| `/agent-studio/blocks` * | Platform | Blocks |
| `/agent-studio/compliance` | Platform | Compliance (incl. audit log; audit deep-link contract below) |
| `/agent-studio/teams` | Platform | Members (renamed ex-Teams; route UNCHANGED) |
| `/agent-studio/api` | Platform | API explorer |
| `/agent-studio/settings/*` (6 existing) | Settings | Profile · Workspace · Roles (renamed ex-Team; route UNCHANGED) · Billing · Security · API keys |

Rules: renames are LABELS only — zero route renames (Teams/Team routes untouched). One route = exactly
one domain (R1 test). Detail routes inherit their parent's item (longest-prefix). Query strings never
affect matching. Audit deep-link contract: `/compliance?entity=<type>:<id>&event=<name>` (new
acceptance item on every `org`-scoped confirmation; Compliance reads and applies the filter).

## 2. nav.json v2 schema (single source of truth — R1)

`src/neryva_data/products/agent_studio/nav.json` shape (TS type in `StudioShell/nav-config.ts`;
no zod in console — validation is a vitest suite, §7):

```ts
type NavDomain = {
  key: 'dashboard' | 'chat' | 'agents' | 'libraries' | 'insights' | 'platform' | 'settings';
  label: string; icon: DomainIcon;           // 7 domain icons, rail only
  landing: string;                            // domain click target (R6: first secondary item; Dashboard/Chat land on themselves)
  items: Array<{
    label: string; to: string;                // `to` = route path (NOT a second copy — must equal a route in routes.tsx)
    match?: string;                           // prefix override; default = longest-prefix of `to`
    badge?: 'count' | 'attention';            // badge KIND only — values come from hooks, never the JSON
    roles?: OrgRole[];                        // absent = all roles (visible-with-explanation when denied)
  }>;
};
```

Laws: sidebar, rail, breadcrumbs, ⌘K Navigate section ALL derive from this file (one registry,
Coreola/Kickoff pattern). `to` values are asserted against the route table in tests — a nav entry
pointing at a non-route fails CI. Badges carry kinds, never numbers. Role arrays mirror backend
`@Roles`; the consistency test (§7) pins them together.

## 3. Component plan (exact files)

CONSTRAINT (user directive, locked): there is ALWAYS exactly one sidebar. No rail + secondary
columns, no slide-over second panel. The single 264px sidebar keeps its current styling EXACTLY
(same container, same tokens, same dark language — zero retheme); only its NAV REGION swaps
content by level. Chrome persists across levels: brand row, search input, footer (user card,
banners). Precedent: Atlassian contextual sidebar nest ("covers the main sidebar") + Jira
project-centric sidebar; top bar keeps universal actions (search/create), per Atlassian nav audit.

NEW (`src/sections/pages/products/agent-studio/StudioShell/`):
- `nav-config.ts` — types + `resolveDomain(pathname, config)` (longest-prefix) + `resolveItem` +
  `resolveLevel(pathname, config)` → `{ level: 1 | 2, domain }` + unit-testable pure functions, zero JSX.
- `SidebarDomains.tsx` — LEVEL 1: 7 domain rows (icon + label + aggregate-attention badge slot).
  Dashboard/Chat navigate directly; the other five drill (navigate to landing AND swap level in one
  action). Recent chats block below (level-1 only). `aria-label="Studio sections"`.
- `SidebarSection.tsx` — LEVEL 2: back row (`‹ All sections` — names the destination, never a bare
  chevron) + domain title/subtitle + item list w/ badges + provisioning footer slot.
  `aria-label="<Domain>"`, `aria-current="page"` on the item.
- `useNavBadges.ts` — badge VALUES per item kind (counts, attention flags) + per-domain aggregates
  (level-1 rows show the domain's roll-up, e.g. Agents "3"), React Query backed, calm staleness;
  returns null while loading (never layout-shifting skeletons in nav).
- `useSidebarPrefs.ts` — collapse + mobile drawer prefs, localStorage (`neryva.sidebar.*`,
  window-guarded like `ACTIVE_ORG_KEY` precedent — Vite SPA, no SSR, no cookie needed).
- `BuilderChrome.tsx` — full-bleed builder frame (top bar + `← Agents` + Draft pill + autosave slot +
  Advanced-editor entry), used ONLY by builder routes (sidebar hidden entirely — zero sidebars there,
  consistent with the one-sidebar law).

MODIFIED:
- `StudioShell.tsx` — composes ONE sidebar (level 1 ⇄ level 2 swap) + topbar (breadcrumb
  `Domain / Page`, ⌘K hint, org switcher, actions) + content; derives level/domain/item from
  pathname + config on EVERY render (cold-load safe — no client state in the derivation path);
  hides the sidebar on builder routes; keeps banners, palette (extends Navigate section from
  config), footer minus Upgrade card (→ Billing page). Logo becomes a link → Dashboard (the
  missing out-path; VibeWeek pitfall closed).
- `AgentStudioShell.tsx` — passes v2 config; keeps session/org/status wiring untouched.
- `router/routes.tsx` — ADDITIVE ONLY this program: `/agents/new`, `/agents/overview`,
  `/knowledge/sources`, `/memory`, `/datasets`, `/blocks` (+ `/knowledge/overview` in its pass).
  No existing route touched.
- `nav.json` — v1 → v2 shape (domains with items; old group shape deleted in the same commit as
  the shell switch — no dual readers). §2 schema stands unchanged (it was already domain-based).
- Styles: ADDITIVE ONLY — slide container (`overflow: hidden`), back-row style, level-transition
  keyframes. No token changes, no retheme, existing dark language untouched.

## 4. Swap behavior spec (what "dynamic" means, exhaustively — ONE sidebar, two levels)

1. Derivation: `pathname → resolveLevel → {level, domain, item}` runs on every location change AND
   first paint (cold-load: `/blocks` renders level 2 Platform/Blocks with zero prior state).
2. Swap: the sidebar's NAV REGION cross-slides (translateX ±12px + fade, 200ms, existing
   `ease.premium`; `prefers-reduced-motion` → instant) between level 1 (domains) and level 2
   (section items). Chrome never moves: brand row, search, footer, topbar, content `<Outlet/>` all
   persist. One sidebar before, during, and after — at no point do two nav columns coexist.
3. Drill (R6): domain row click navigates to that domain's `landing` AND swaps to level 2 in one
   action. Dashboard/Chat rows navigate with no swap (single surfaces). Never select-and-show-nothing.
4. Back: level-2 back row (`‹ All sections`) returns to level 1 WITHOUT navigating away (route
   unchanged — it is a chrome action, not a destination). Logo → Dashboard (navigates).
5. Focus + announcement: on swap, focus moves to the back control (level 2) or the active domain
   row (level 1); an `aria-live="polite"` region announces "Agents section" (once per swap, never
   per render).
6. Esc precedence (locked): modal open → modal consumes · mobile drawer open → closes drawer ·
   desktop level 2 with focus outside inputs → back to level 1 · otherwise nothing. In that order.
7. Builder entry: sidebar unmounts, `BuilderChrome` mounts, topbar shows `← Agents` + agent name.
   Builder exit returns to the originating domain (stored `returnTo`, default Agents Overview).
8. Dirty guard: builder's `useBuilderState` dirty flag feeds `useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: dirty })` with the existing confirm-modal pattern (custom UI, NOT window.confirm). Covers domain rows, back row, section items, breadcrumbs, palette, back/forward — every sidebar control navigates via `Link`, so the blocker intercepts all of them. `enableBeforeUnload` covers reload/tab-close (browser dialog — only acceptable exception).
9. Badges: values load async; null-safe (no badge until data); attention badges dot+count, never color-only. Level-1 domain rows show ROLLED-UP attention (sum of their section's flags).
10. Role-denied items: rendered visible + disabled styling + explanation popover + request path (locked). Never hidden, never silent. Same on both levels.
11. Collapse: whole-sidebar collapse persists per account; <1280px auto-collapse (research bound); mobile = drawer (same single-sidebar content) + bottom tabs (top-frequency destinations) + breadcrumbs.
12. Search: sidebar input filters the CURRENT level (substring, existing behavior carried over); ⌘K stays global. No overlap by construction.
13. Empty levels impossible: level 1 always has 7 domains; single-surface domains carry zero
   items by design (`single: true`); every OTHER domain ships ≥1 item (R1 test asserts non-empty +
   landing resolvability). Implemented in `nav-config.ts` + `nav-config.test.ts` (12 green).

## 5. Cold-load matrix (R7 — part of phase gates, not optional)

| Land on | Expect |
|---|---|
| `/agent-studio/blocks` (new) | Platform rail + Blocks item + breadcrumb Platform / Blocks |
| `/agent-studio/agents/abc-uuid/edit` | Full-bleed builder, no rails, `← Agents` |
| `/agent-studio/conversations?chat=x` | Agents rail + Conversations item (query ignored) |
| `/agent-studio/integrations/webhooks` | Platform rail + Integrations parent chain + Webhooks item |
| `/agent-studio/settings/team` | Settings rail + Roles item (renamed label, same route) |
| `/agent-studio/teams` | Platform rail + Members item |
| unknown `/agent-studio/nope` | Nearest 404 inside shell with rail intact (never chromeless dead end) |

## 6. Accessibility spec (locks with the build)

- `nav` landmarks: rail `aria-label="Product domains"`, secondary `aria-label="<Domain> navigation"` (never two generic "navigation" landmarks).
- `aria-current="page"` on the active item AND `aria-current="true"` on the active domain; location exposed in text (breadcrumb), never color-only.
- Full keyboard operability (Tab order rail → secondary → content; Enter activates; Esc closes drawer/mobile and returns focus); visible focus rings; focus moved to content heading on domain switch (announced via `aria-live` polite region for badge/attention changes only — not every render).
- Contrast-checked status dots (locked token sheet); reduced-motion honored.

## 7. Test plan (files + assertions)

- `nav-config.test.ts` (vitest, pure): longest-prefix resolution incl. `$agentId`-style dynamics, query-string immunity, unknown-path fallback (first domain? NO — explicit fallback: Dashboard with breadcrumb showing the path; fallback-to-first hides errors), trailing-slash tolerance.
- `nav-coverage.test.ts` (THE R1 test): every route in `routes.tsx` maps to exactly one domain; every nav `to` equals a real route; every domain non-empty with resolvable landing; no duplicate `to` across domains (webhooks exception: listed once, parent chain derived).
- `role-map.test.ts`: frontend `roles` arrays ⊇/⊆ backend `@Roles` per route family (flags drift in either direction for human review — warn, don't auto-pass).
- Component tests (jsdom + testing-library): cold-load matrix (§5) via memory router; dirty-guard flows (dirty→rail click→modal→stay/leave; clean→no modal; reload→beforeunload); collapse persistence round-trip; badge null-safety.
- Manual gates per phase: keyboard-only pass, 1280px + 390px viewports, reduced-motion on, viewer/developer/admin role matrix, fresh-org click-through.

## 8. Phase execution (from report §6, file-level)

- **P1 skeleton**: add §3 NEW files (behind existing shell — build alongside, no behavior change) → swap `StudioShell` composition → migrate `nav.json` → wire badges/prefs → gates (§7 first 4 bullets + R7 matrix green).
- **P2 homes**: `/agents/overview` route + Overview page (mock exists) → Template-card blocked state → Knowledge Overview in its pass → Dashboard roll-up + R3 headers.
- **P3 surfaces**: `/datasets` (read-only over existing list read) → `/blocks` (CRUD split per lock + computed status) → `/memory` (scope-aware + proposals + DSR entry link) → empty-state-as-reassurance for all three.
- **P4 wiring**: Webhooks/Settings promotions → capability gating + role-map test → scoped filter kept + ⌘K create actions + Upgrade move.
- Rollback: additive construction, one switch commit per phase → `git revert` per phase. No feature flag (flag would fork the shell — higher risk than revert).

## 9. Risks mapped (R1–R12 → where each dies)

R1 mapping test (§7) · R2 full-bleed + dirtyGuard (§4.5) · R3 header boundary (§1 Agents/Dashboard rows; P2) · R4 resolved pre-build (Members vs Roles, §1) · R5 header split (Activity live feed vs Compliance immutable record — P2 acceptance) · R6 landing rule (§4.3 + test) · R7 cold matrix (§5 + gates) · R8 two-mechanism mobile (§4.8) · R9 7-icon strategy (§3) · R10 scoped filter kept (§4 behavior) · R11 empty states (P3) · R12 palette create (P4).

## 10. Implementation record (built 2026-09-17, branch `backend-integration`)

P1 skeleton — DONE: `nav-config.ts` (pure resolvers + `isBuilderPath` exact matcher +
`isDenied`/`deniedCopy`) · `nav.json` v2 (7 domains, current 19 entries mapped) ·
`SidebarDomains`/`SidebarSection` · `useSidebarPrefs` (derived pin, no effect) ·
`useNavBadges` (null-safe shell) · `useDirtyGuard` + AgentEditor wiring · StudioShell
recomposition (level swap, focus/announce, Esc precedence, breadcrumb, collapse, full-bleed
edit route, upgrade card removed) · `studioIcons.ts` (+`blocks: Ban`) · mapping/coverage/unit
tests (nav-config 12, nav-coverage R1, role-map).
P2 homes — DONE: `/agents/overview` route + Overview view (health strip, needs-attention
queue, recents, template/model asides — Blocked card deferred to P3 WITH its data) ·
`AssistantSummary` lifecycle passthrough (no N+1) · shared `useFleetHealth` (AgentsView
refactored onto it, same query keys) · template install-blocked card state (org blocks,
computed expiry; Blocks link live).
P3 surfaces — DONE: `/datasets` (read-only + origin derivation + Evaluations link) ·
`/blocks` (govern-gated CRUD, computed Active/Expired, reassurance empty state) ·
`/memory` (org/user/assistant tabs, visibility/expiry, delete w/ confirm, Compliance DSR link,
conversation-scope note) · nav entries + routes.
P4 wiring — DONE: Webhooks promoted · Blocks `roles: [owner,admin]` + denied-row rendering +
role-map drift test · palette indexes new destinations + New-agent entry (→ list, where New
lives until the builder route ships) · Upgrade card removed (Billing already hosts UpgradeModal).

Gates evidence: `tsc -b` clean · eslint clean on touched surface · vitest 30 files / 215 tests
green · `vite build` succeeds (49s; pre-existing >500KB chunk warnings untouched).
Flake log: NotificationsPopover timing test failed once under parallel load, passes solo and on
rerun — pre-existing (file untouched by this program), same class as the engine outbox flake.

DEFERRED (explicit, none dropped): D6 label renames (Teams→Members, Team→Roles — one-liners
gated on sign-off) · `/knowledge/sources` + `/knowledge/overview` (Knowledge design pass) ·
badge VALUES (null-safe shell proven; wire with per-section data) · proposals queue (no list
read exists — decision mutation only) · platform template-blocks read (staff surface; org rows
+ install-409 path cover v1) · `/agents/new` + full BuilderChrome (builder program) ·
`../agent_flow/main.md`/mock rename sweep (IMPL_PLAN Phase 1) · `main_design/` F1–F7 diagram fixes (IMPL_PLAN
Phase 0).

Manual QA checklist (needs a running engine + browser, not executable headlessly): cold-load
matrix (§5) per domain · role matrix (viewer/developer/admin, incl. denied Blocks row) ·
dirty-guard flows (dirty→rail/sidebar/palette/back-button/back-key/reload) · collapse persist +
1280px/390px + reduced-motion · keyboard-only pass · fresh-org click-through of
overview/datasets/blocks/memory.

## 11. Verification log (this ledger)

- TanStack Router `^1.144.0` (`package.json:19`); `useBlocker({shouldBlockFn, withResolver, enableBeforeUnload})` current API (official docs, fetched 2026-09-17); NO existing blocker usage (grep) — dirty guard is greenfield.
- Code-based routing (all `createRoute` in `routes.tsx`) — no file-based layout mechanics; single-shell-derives-domain chosen over route-tree surgery (fewer moved URLs, reversible).
- localStorage precedent with window guard (`OrgContext.tsx:74-176`); Vite SPA = no SSR flash concern, cookies unnecessary.
- `/agents/new` confirmed ABSENT (grep) with `$agentId` param-collision hazard → explicit static route in §1.
- No zod in console (`package.json` grep) → TS types + vitest validation, not schema lib. vitest 5 + jsdom present.
- Config-driven consensus: Coreola (one registry → sidebar/breadcrumbs/abilities/code-splitting), Kickoff (longest-prefix SectionResolver + Pest-tested), MakerKit (zod-validated nav config), vue-admin (route `meta` driving sidebar/breadcrumb/cache) — pattern triangulated, adapted to code-based TanStack (config asserts against routes rather than generating them, since routes carry components/guards).
