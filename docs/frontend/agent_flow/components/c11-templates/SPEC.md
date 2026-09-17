# C11. Templates — SPEC (STATUS: NOT STARTED — MODEL RESOLVED 2026-09-17)

> Design position: origin mode (gallery lives inside the builder per locked decision). Depends on: C01–C10 (repair checklist points at them).
> Governing mental model (resolved — every design decision below must be consistent with it):
> **Template = contract. Pins = fulfillment. Eval = proof.**
> A template is portable across orgs, so it may contain ONLY portable things. Everything org-specific
> (credentials, document versions, approvals, model reachability) is fulfillment that happens per org,
> and eval proves the fulfillment worked. Any design that asks the user to retype contract content, or to
> supply unfulfillable content (a secret inside a template, a pin to another org's document), is wrong.

## Engine binds (verified 2026-09-17)

- Registry: **20 templates** (`products/agent-studio/templates/registry.json`), all `min_engine_schema: 2`. Observed status: stable|beta. Observed families: sales, support, ops, research, brand, personal, channel. Registry is source of truth — counts/families bind to reads, never hardcoded.
- Entry shape (read from the real entries): `slug, version, hash, status, family, min_engine_schema, definition{model_policy, context_policy, tool_policy, knowledge_policy, guardrail_policy, instructions?, model_params?, budget_policy?}, bindings{tools.required[]:{name, built_in?, effect_class?, approval_requirement?, when_to_use?}, knowledge.required[]:{slugs}, notes}, eval_ref{evaluators[]:{name, version, kind, checks[]}}, release_policy{release_policy_version, required[], thresholds{}, critical_failures[]}`.
- Install TX (`templates.service.ts:224-323`): validates definition like a hand draft (422 on failure) → pre-resolves tool pins (**422 here on unknown/disabled tool, before any row exists**) → checks platform block (409 if slug or slug@version blocked) → inserts assistant (name default = slug, 2–128, 409 on collision) + DRAFT v0 (definition copied verbatim, instructions may be null) + install row (`slug`, `templateVersion`) + provisioning outbox → audit `template.installed`. **Active pointer untouched: install can never go live.**
- Install description is auto-set (`Installed from template slug@version`).
- Compatibility: advisory ONLY, exactly 4 codes (`required_tool_missing`, `required_model_capability_missing`, `provider_credential_missing`, `knowledge_source_missing`), status COMPATIBLE/INCOMPATIBLE (`templates.service.ts:399-470`).
- List rows carry `installed` (bool) + `update_available` (none|minor|major) (`templates.service.ts:66-108,327-337`).
- Seeded eval dataset id: `template:<slug>@<version>` (`assistants.service.ts:1056`).
- Snapshot keeps `templateRef{slug, version, definition_hash}`; drift UI compares installs.templateVersion + templateRef against the registry (no engine work needed).
- Declared `channels` bindings render read-only until channels ship (locked).
- Template **never** contains: credentials, document version pins, approvals, usability promises. Template **never** does: publish, go live, auto-migrate on update.

## Install-time outcome matrix (every row needs a designed UI state)

| # | Outcome | Engine signal | UI must do |
|---|---|---|---|
| I1 | Success | 201 + assistant/version/install | Close overlay, open prefilled map + `slug@version` badge + repair checklist |
| I2 | Name taken | 409 `assistant name already taken…` | Same one-tap rename as C01, overlay stays, nothing created |
| I3 | Template platform-blocked | 409 `template slug@version is blocked (reason)…` | Whisper with the reason + pick-another-template path. NOT retryable by the user |
| I4 | Tool pin unresolvable | 422 (unknown/disabled tool) | Whisper naming the tool + two paths: ask admin to enable, or pick another template. Nothing created |
| I5 | Definition invalid | 422 registry-definition failure | Treat as registry bug: error copy + report path, no user fix offered (user cannot fix a template) |
| I6 | Schema too new | client-side `min_engine_schema` check | Disabled card + reason BEFORE click (never a post-click failure) |
| I7 | Provisioning async starts | outbox event, builder opens immediately | Provisioning banner (copying → draft → tools → knowledge → eval seeds); nodes show provisioning state; draft editable meanwhile |
| I8 | Provisioning fails durably | dead-letter after retries | Banner: what failed (tool gap vs seed gap) + Retry + View requirements. Draft editable; publish blocked until resolved |

## Repair checklist matrix (the product — post-install org-binding gap)

Each requirement × fulfillment-state → exactly one row state. Nothing prefilled is ever re-asked.

- **Knowledge** (`bindings.knowledge.required[]` slugs): seed provisioned→done · no READY doc at org→map (upload/rename/connector, C05) · doc present but coverage incomplete→progress + degraded path (C05/P0) · doc quarantined/failed→retry/remove (C05). Template CANNOT name document versions — only slugs.
- **Tools** (`bindings.tools.required[]`): pin resolved→done · drift→re-pin (C06) · disabled→enable/admin (C06) · missing credential→connect/notify (C04) · approval required→approve/request (C06). `when_to_use` renders as helper copy on the row.
- **Models** (`definition.model_policy.allowed_models`): reachable→nothing to do (no chooser forced) · partially reachable→pick among usable · none reachable→per-reason fixes (C04; residency has no user fix — explain + route to admin) · compromised credential→derived reason row (C04).
- **Credentials**: caller is owner/admin→inline connect (C04) · otherwise→notify-owners (C04). Never a dead button.
- **Instructions**: present→editable (C02) · absent (template allowed null)→Purpose needs-attention, publish will refuse.
- **Eval**: dataset seeded→run it (C10) · seed failed→retry provisioning (I8) · `release_policy.required[]`→each item renders as a required row (C10/C14). **required[] items may be objects** (e.g. `{regression_no_worse_than: 0.02}`), not just strings — render both shapes; do NOT reuse the engine's `join(', ')` message verbatim for objects.
- **Budgets/guardrails/memory/brand**: prefilled → shown as done-with-defaults, tunable (C03/C07/C08/C09). Never repair rows unless invalid.

## Update lifecycle

- `update_available`: none→silent · minor→info badge ("improvements available") · major→attention badge ("new major version"). Banner lives on builder + detail, links the diff (slug, installed_version → latest_version).
- Adoption is MANUAL; runs stay pinned; never auto-migrate.
- Post-install platform block surfaces on operate (new installs refuse, release pointers refuse) — not silent.

## Gallery binds

- Outcome copy + compatibility badge (COMPATIBLE vs INCOMPATIBLE + count, amber, never blocking) + "what you get" counts (tools/knowledge/models/eval) from the BOM, never a data grid. Search + family filters bind to registry reads. Featured curation is static UI config, never presented as engine data.
- `installed` badge routes to the existing assistant's detail (re-clicking Use on an installed slug creates ANOTHER assistant — say so on the confirm, never silently duplicate).
- Re-install (second assistant from same slug) is legitimate — no "already installed" block.

## Design (fill in the C11 pass)

- [ ] Gallery + filters + badges + detail sheet (3 tabs: what it does / what it needs / seed data) with per-requirement fix links.
- [ ] Install stepper (I7 states) + I2–I6 failure whispers + I1 success transition.
- [ ] I8 provisioning-failure banner + retry.
- [ ] Post-install map state: badge + repair checklist wired to C02/C04/C05/C06/C10 rows.
- [ ] Update banners (minor/major wording + adoption action — pending open question 1).

## Open questions (resolve during the C11 pass — banner/action design depends on them)

1. **Update-adoption mechanism UNVERIFIED.** No apply-update endpoint was found in this pass (only `checkUpdates` signals + never-auto-migrate). Before designing the banner's action, verify: does adoption mean re-install-as-new, or is there an update path? Do not design the button until answered.
2. Description editability post-install (auto-set at install; which route edits it?) — minor, verify in pass.
3. Provisioning progress events transport (poll which read? SSE?) — verify in pass so the stepper binds to a real source.

## Exit gate

- Per `../README.md` component gate. All three open questions answered IN this file. Flip status to SIGNED OFF with date.
