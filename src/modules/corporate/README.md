# corporate (`src/modules/corporate`)

**Purpose:** ADR-004 D3 — the engine's corporate module. Phase E-1 ships
the email service (a platform facility: identity login codes and org invites
send through it). Public forms, content admin, and the neryva_backend
retirement land in later phases (P6) — no Express code is ported (ADR-007 D3).

**Routes:** none yet (E-1 is service-only).

**Tables (engine-owned, eng-0001):** email_deliveries (delivery audit).

**Flag:** `MODULES__CORPORATE_ENABLED` (on by default; required by identity).

**Public interface:** `EmailService.sendTemplate({ template, to, vars })` —
templates render from the registry (single chokepoint for outbound bodies),
sends are rate-limited per recipient, every attempt records a delivery row.
Transports: file (dev), Resend, Postmark, none — selected by EMAIL_TRANSPORT.
