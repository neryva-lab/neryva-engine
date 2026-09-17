# Builder page — assembly (LOCKED until C01–C14 are SIGNED OFF)

> The builder creates no new design. It places finished components into the shell proven by `design/03-builder/*.svg`:
> top bar (← Fleet, name, Draft pill, autosave, Engine Room) · left rail checklist · center Agent Map
> (fixed topology — Purpose → Context assembly → Brain → Response → Ship, side nodes Knowledge/Memory/Guardrails/Tools/Evaluation)
> · right inspector mount · bottom single-action bar (computed next-best-action, blocked-but-tappable scrolls to first issue).

## Entry gate (all required)

- [ ] C01–C14 SPECs all SIGNED OFF.
- [ ] C08 open question (memory `user` scope) resolved and recorded.
- [ ] C06 open question (tool-name regex) resolved and recorded.
- [ ] Node-status mapping table complete (ready / needs-attention / skipped / info / error ← every component state assigned exactly one; shadow→info, drift→attention, compromised→error).
- [ ] Next-best-action derivation order written (no-assistant → purpose → model → knowledge-processing → tools-invalid → try → eval-required → ship-blocked → ship-ready).

## Assembly outputs ( produced here, not in component passes)

- `builder-map.md`: node → component → inspector section wiring + status derivation per node.
- Builder shell mock(s): start (Spark, already in `design/01-start/`), empty-scaffold map, prefilled (template) map — reusing `design/03-builder/` as the base.
- Operate page (C15) stays a separate surface per C15 binds.

## Rule

- Mismatches found at assembly go BACK to the component SPEC. No page-level improvisation.
