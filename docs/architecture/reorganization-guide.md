# Final Reorganization Guide v4 — Current Tree → Aligned Monorepo

**Date:** 2026-08-23 (v4 — rewritten for the tree as it exists NOW, after the owner's manual moves; embeds ADR-004's decisions)
**⚠️ CURRENT STATE (verified):** `.git` still lives at `products/neryva_agent_studio/.git`. Every folder already moved to the root (`console/`, `corporate/`, `contracts/`, `ops/`, `docs/`, `data/`, `evals/`, `sdks/`, `products/agent-studio/widget`) is **outside the repository and unversioned** (119 deletions inside the studio repo). The 103-file implementation batch is still uncommitted. Stage 0–1 below recover all of it — nothing has been lost.

## Target tree (per ADR-004 + Amendment 1: one engine, ONE web app, no other backend)

```
neryva_studio/
├── architecture/                  ← plans of record (unchanged)
├── engine/                        ← products/neryva_agent_studio/backend (Stage 2)
│   └── app/… (platform services; products/*; corporate/* per ADR-004)
├── console/                       ← DEPRECATED (ADR-004 Am.1): captured into git here, its feature
│                                    modules port into the web app's /studio/** area, then deleted.
│                                    ⚠️ UNVERSIONED until Stage 1 — deleting it now = permanent loss.
├── products/agent-studio/widget/  ✓
├── corporate/
│   ├── neryva-website/            ← THE one web app (marketing + /platform + /studio, /deployment areas)
│   └── neryva_backend/            ← deprecated; retired after the corporate module reaches parity (ADR-004 §8)
├── contracts/  sdks/  ops/  evals/  data/  docs/   ← already at root ✓
├── .github/  README.md  AGENTS.md  CHANGELOG.md  pyproject.toml
└── package.json  pnpm-*  tsconfig.json  eslint.config.js  docker-compose.yml  …
```

## Stage 0 — Commit the implementation batch (only the batch; NOT the deletions)

```bash
cd products/neryva_agent_studio
git add backend .github .gitignore CHANGELOG.md
git commit -m "feat: wave-0 fixes, optimizations, shadow mode, policy simulation"
git push origin main
```
(The deletion entries for moved folders stay uncommitted — they resolve as renames in Stage 1.)

## Stage 1 — Promote the repo to the root and adopt the manual moves (ONE commit)

```bash
cd ../..
mv products/neryva_agent_studio/.git .git
# lift the studio root files up (everything except backend/):
mv products/neryva_agent_studio/{AGENTS.md,README.md,CHANGELOG.md,package.json,package-lock.json,pnpm-lock.yaml,pnpm-workspace.yaml,tsconfig.json,eslint.config.js,docker-compose.yml} .
mv products/neryva_agent_studio/.github .
mv products/neryva_agent_studio/.gitignore .
mv products/neryva_agent_studio/.dockerignore . 2>/dev/null; mv products/neryva_agent_studio/.env.example . 2>/dev/null; mv products/neryva_agent_studio/.env.dev . 2>/dev/null
ls products/neryva_agent_studio        # GATE: must contain ONLY `backend`
git add -A
git status --porcelain | grep -c "^R"  # hundreds of renames paired (frontend→console, ops→ops, …)
git status --porcelain | grep -iE "node_modules|/dist/|credentials|\.env$"   # GATE: empty
git commit -m "chore: promote repo to org root; adopt reorg (console/, corporate/, products/agent-studio, shared dirs at root)"
```

## Stage 2 — The engine takes its place

```bash
git mv products/neryva_agent_studio/backend engine
rmdir products/neryva_agent_studio
git commit -m "chore: engine/ — the single backend (ADR-003/004)"
```

## Stage 3 — Alignment commit (rename imports + configs — all verified against the real files)

```bash
# Python imports (backend.app -> engine.app):
grep -rl 'backend\.app' engine --include='*.py' | while read f; do sed -i 's/backend\.app/engine.app/g' "$f"; done
# Root pyproject (STAYS at root — sbom job, hatchling packages, pytest testpaths):
sed -i 's/packages = \["backend"\]/packages = ["engine"]/; s/backend\.app/engine.app/g; s|\["backend/tests"\]|["engine/tests"]|' pyproject.toml
# CI — paths AND bare words (`ruff check backend`, `mypy backend`):
sed -i 's|backend/|engine/|g; s|ruff check backend|ruff check engine|; s|mypy backend|mypy engine|' .github/workflows/ci.yml
sed -i 's|backend/|engine/|g' .github/workflows/evals.yml
# Docker images (COPY lines reference the old folder):
sed -i 's|COPY backend ./backend|COPY engine ./engine|; s|Shares the backend base|Shares the engine base|' ops/docker/backend.Dockerfile ops/docker/worker.Dockerfile
# Frontends — workspace entries are UNQUOTED:
sed -i 's|^- frontend$|- console|; s|^- widget$|- products/agent-studio/widget|' pnpm-workspace.yaml
sed -i 's|"frontend/|"console/|g; s|widget/vite|products/agent-studio/widget/vite|g; s|widget/src|products/agent-studio/widget/src|g' package.json
# .gitignore db patterns:
sed -i 's|/backend/|/engine/|g; s|backend/\[0-9a-f\]|engine/[0-9a-f]|g' .gitignore
```

GATES (all before `git commit -m "refactor: align tree — engine/, console/, products/agent-studio/widget; backend.app->engine.app"`):
```bash
python -m compileall -q engine
PYTHONPATH=. python -c "from engine.app.main import app; print(len(app.openapi()['paths']))"   # 103
PYTHONPATH=. python -m pytest engine/tests/test_import_health.py -q
pnpm install && pnpm build:frontend && pnpm build:widget
grep -rn "backend\.app" engine --include="*.py" | wc -l                                        # 0
grep -rn "backend" .github/workflows/ci.yml .github/workflows/evals.yml ops/docker/*.Dockerfile pnpm-workspace.yaml pyproject.toml | wc -l   # 0
```

## Stage 4 — Corporate plane into git (ADR-004 dispositions)

```bash
rm -rf corporate/neryva-website/.git corporate/neryva_backend/.git    # histories stay on their remotes
printf '# DEPRECATED — retiring after the engine corporate module reaches parity (ADR-004 §7)\n' > corporate/neryva_backend/DEPRECATED.md
git add corporate
git status --porcelain corporate | grep -iE "credentials|\.env$|\.env\.|/logs/"   # GATE: empty
git status --porcelain corporate | wc -l   # far below 52k (node_modules excluded)
git commit -m "chore: absorb corporate plane; neryva_backend marked deprecated pending retirement (ADR-004)"
```

## Stage 5 — Orientation docs

Root `README.md` org map (tree above + "one engine; ONE web app = corporate/neryva-website (marketing + /platform + product areas); console/ deprecated donor, deleted after /studio parity; neryva_backend deprecated"), `console/DEPRECATED.md` note ("donor for /studio/** per ADR-004 Am.1"), rewrite `Neryva/docs/REPO_MAP.md`.

## Not done here (deliberately)

- The engine `corporate` module, portal `/platform` area, and neryva_backend retirement → `frontend-and-portal-plan.md` build order.
- Product backends never leave the engine; product frontends are separate apps per product (ADR-004 D2).
- No history rewriting; absorbed folders' histories remain on their GitHub remotes.
