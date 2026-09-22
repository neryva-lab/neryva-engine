# Builder page — assembly (LOCKED until C01–C14 are SIGNED OFF)

> The builder creates no new design. It places finished components into the shell proven by `design/03-builder/*.svg`:
> top bar (← Fleet, name, Draft pill, autosave, Engine Room) · left rail checklist · center Agent Map
> (fixed topology — Purpose → Context assembly → Brain → Response → Ship, side nodes Knowledge/Memory/Guardrails/Tools/Evaluation)
> · right inspector mount · bottom single-action bar (computed next-best-action, blocked-but-tappable scrolls to first issue).

## Entry gate (all required)

- [ ] C05–C14 SPECs all SIGNED OFF. (C01 SIGNED OFF 2026-09-17 with the circuit shell live;
  C02 SIGNED OFF 2026-09-17 with the Purpose composer + samples + first draft-write pipeline;
  C03 SIGNED OFF 2026-09-17 with the Brand satellite + voice section + shared save/conflict modules;
  C04 SIGNED OFF 2026-09-17 with the Brain satellite + policy inspector + credentials plane + dedicated detail section.)
- [x] C08 open question (memory `user` scope) resolved and recorded — code is the
  record: picker omits it, caps checker refuses it (tested), wire mapper
  translates `org→organization` and surfaces engine `user` read-only
  (`useAgentAuthoring.ts:38`, `setup-caps.ts:146-147`, `agent-payload.ts:158,305-311`).
- [ ] C06 open question (tool-name regex) resolved and recorded.
- [ ] Node-status mapping table complete (ready / needs-attention / skipped / info / error ← every component state assigned exactly one; shadow→info, drift→attention, compromised→error).
- [ ] Next-best-action derivation order written (no-assistant → purpose → model → knowledge-processing → tools-invalid → try → eval-required → ship-blocked → ship-ready).

## Assembly outputs ( produced here, not in component passes)

- `builder-map.md`: node → component → inspector section wiring + status derivation per node.
- Builder shell: live since C01 (`/agent-studio/agents/new` origin + `/agent-studio/agents/$agentId/build`
  circuit, full-bleed via `isBuilderPath`). Assembly docks the rail checklist, edge-`+`
  attach, run animation, and prefilled-map variants into it — no shell rework.
  The stale `design/01-start/` start-screen reference is retired: origin mode IS the start.
- Operate page (C15) stays a separate surface per C15 binds.
- Full interaction contract: `BUILD_PLAN.md` (FINAL) — constrained circuit, Blender
  dual-edit contract, typed satellites, shortcut map. Assembly implements what the
  plan defers (rules 5–10, run overlay, keyboard completion, perf audit).

## Rule

- Mismatches found at assembly go BACK to the component SPEC. No page-level improvisation.
