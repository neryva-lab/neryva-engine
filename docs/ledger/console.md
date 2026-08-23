# Ledger — console (`modules/console`, the control plane)

**Namespace:** `/console/home`, product manifests/summaries, `/console/{product}/**` mounts · **Guard:** L1 + membership + entitlement state · **Spec:** [`dev/control-plane/plan.md`](../dev/control-plane/plan.md), [product-integration](../architecture/console/product-integration.md).
**Current state (verified):** no manifest registry, no console home, no summary framework; the 103-path pinned contract has no ownership tags.

## Phases

### C-1 — Manifest registry
- [ ] In-repo versioned manifests (`engine/products_manifests/*.yaml`: key, version, faces, nav, scopes, entitlement codes, summary route, metering tag, runtime routes)
- [ ] Startup loader; unknown key → 404; satellite deployments register via the same schema ([`inference`](inference.md) pre-registered placeholder)
- **Gate:** registry loads; bijection self-check (K-5) enforces it

### C-2 — Contract composition
- [ ] `x-neryva-owner` on every path; export fails on unowned/unregistered routes; CI bijection check
- **Gate:** contract snapshot carries owners; CI red on deliberate unowned route

### C-3 — Home + summaries
- [ ] `GET /console/home`: org header, project context, product cards = manifest + entitlement state + cached summary (empty-KPI fallback)
- [ ] Card schema fixed (product, status, kpis[], alerts[], primary_cta); **fake-product CI test** so the contract cannot drift
- **Gate:** home renders owned/trial/none/past_due states per access-model

### C-4 — Furniture mount + portal contract
- [ ] `/console/org/**` (from [`organizations`](organizations.md) O-4) mounted into home/nav model
- [ ] The web app's `/platform` area contract frozen (routes ↔ API map in `architecture/frontend-and-portal-plan.md` §2)
- **Gate:** nav/home payload snapshot test; contract re-pin
