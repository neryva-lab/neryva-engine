#Requires -Version 5.1
<#
.SYNOPSIS
  Full Windows-native dev stack (no Docker): infra + migrate + engine + studio + website.

.DESCRIPTION
  Orchestrates:
    1. infra (start-infra.ps1) - Postgres service + Redis/Memurai probe + MinIO binary
    2. migrate (npx pnpm run migrate) - once, creates tables + pgvector extension
    3. concurrently - Engine (:3001), Studio runtime-control inline (:8080), Website (:3000)

  Production/CI stays Docker (ops/docker-compose.yml). This is the Windows
  dev lane only. Uses `npx pnpm` + `npx concurrently` so no global installs needed.

  Ports: engine 3001, studio 8080 (PORT override), web 3000 (Vite proxies
  /engine->:3001, /runtime->:8080 per console/neryva-website/vite.config.ts).

  Engine->Studio dispatch requires NERYVA_RUNTIME_BASE_URL=http://localhost:8080
  in engine .env (empty = run stays ACCEPTED - src/transport/mcp/runtime-control.client.ts).

.PARAMETER SkipInfra
  Skip infra startup (when already up from start-infra.ps1).

.PARAMETER SkipMigrate
  Skip `pnpm run migrate` (when DB already migrated).

.PARAMETER NoWeb
  Don't start website (engine+studio only).

.PARAMETER NoStudio
  Don't start studio runtime-control (engine+web only; runs will stay ACCEPTED).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1
  powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1 -SkipInfra -SkipMigrate
  powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1 -NoWeb
#>
[CmdletBinding()]
param(
  [switch]$SkipInfra,
  [switch]$SkipMigrate,
  [switch]$NoWeb,
  [switch]$NoStudio
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path "$PSScriptRoot/..").Path
$StudioRoot = (Resolve-Path "$PSScriptRoot/../../products/agent-studio" -ErrorAction SilentlyContinue)
if (-not $StudioRoot) { $StudioRoot = Join-Path (Split-Path $Root -Parent) "products/agent-studio" }
$WebRoot = (Resolve-Path "$PSScriptRoot/../../console/neryva-website" -ErrorAction SilentlyContinue)
if (-not $WebRoot) { $WebRoot = Join-Path (Split-Path $Root -Parent) "console/neryva-website" }

function Info($m){ Write-Host "[info] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[warn] $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "=== Neryva full stack (Windows-native) ===" -ForegroundColor White
Write-Host "Root: $Root" -ForegroundColor DarkGray
if ($StudioRoot -and (Test-Path $StudioRoot)) { Write-Host "Studio: $StudioRoot" -ForegroundColor DarkGray }
if ($WebRoot -and (Test-Path $WebRoot)) { Write-Host "Web: $WebRoot" -ForegroundColor DarkGray }
Write-Host ""

# -- 0. Preflight: .env ----------------------------------------------------
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  Bad ".env not found at $envFile - copy from .env.example and fill DATABASE_URL, REDIS_URL, S3_*, etc."
  Write-Host "  Copy-Item .env.example .env" -ForegroundColor Gray
  exit 1
}
$hasRuntime = Select-String -Path $envFile -Pattern "NERYVA_RUNTIME_BASE_URL=http" -ErrorAction SilentlyContinue
if (-not $hasRuntime) {
  Warn "NERYVA_RUNTIME_BASE_URL not set in .env - adding http://localhost:8080 for live runs"
  Warn "Without it Engine->Studio dispatch skips and runs stay ACCEPTED (runtime-control.client.ts:12-15)"
  Add-Content -Path $envFile -Value "`nNERYVA_RUNTIME_BASE_URL=http://localhost:8080"
  Ok "Appended NERYVA_RUNTIME_BASE_URL=http://localhost:8080 to .env (restart needed if Engine already running)"
}

# -- 1. Infra --------------------------------------------------------------
if (-not $SkipInfra) {
  Info "Step 1/4: infra (Postgres + Redis + S3)"
  & "$PSScriptRoot/start-infra.ps1"
  $infraCode = if (Test-Path variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
  if ($infraCode -ne 0) { Bad "start-infra.ps1 failed"; exit $infraCode }
} else {
  Info "Step 1/4: infra - skipped (-SkipInfra)"
}

# -- 2. Build + migrate ----------------------------------------------------
Info "Step 2/4: build + migrate"
# Use npx pnpm so PATH issues with pnpm don't block (npx --yes pnpm aliases to corepack)
try {
  Push-Location $Root
  Info "Building engine (tsc) ..."
  npx --yes pnpm run build 2>&1 | ForEach-Object { Write-Host $_ }
  $code = if (Test-Path variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
  if ($code -ne 0) { throw "pnpm run build failed" }
  Ok "Build done"
} finally { Pop-Location }

if (-not $SkipMigrate) {
  Info "Migrating DB (npx pnpm run migrate - once, idempotent) ..."
  try {
    Push-Location $Root
    npx --yes pnpm run migrate 2>&1 | ForEach-Object { Write-Host $_ }
    $code = if (Test-Path variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
    if ($code -ne 0) { Warn "migrate failed - if DB not reachable, run start-infra.ps1 and check DATABASE_URL"`n"      Error code $code" }
    else { Ok "Migrate done" }
  } finally { Pop-Location }
} else {
  Info "Migrate - skipped (-SkipMigrate)"
}

# Ensure MCP contract built (engine imports file:../products/neryva_mcp/...)
$mcpPkg = Join-Path (Split-Path $Root -Parent) "products/neryva_mcp/neryva-mcp-contract"
if ((Test-Path $mcpPkg) -and (-not (Test-Path (Join-Path $mcpPkg "dist")))) {
  Info "Building @neryva/mcp-contract (needed by engine) ..."
  try { Push-Location $mcpPkg; npx --yes pnpm run build 2>&1 | ForEach-Object { Write-Host $_ } } finally { Pop-Location }
}

# -- 3. Assemble concurrently commands -------------------------------------
Info "Step 3/4: starting services via concurrently (Ctrl+C kills all)"

# concurrently is cross-platform; Windows requires double quotes (npmjs.com/package/concurrently)
# We use npx concurrently so no global install needed.

$cmds = @()
$names = @()
$colors = @()

# Engine: tsc watch + node --watch dist/main.js is `pnpm run dev`; for concurrently we split build already done, use dev (which re-runs tsc + watch)
$cmds  += '"npx --yes pnpm run dev"'
$names += "engine"
$colors += "cyan"

if (-not $NoStudio) {
  if (-not (Test-Path $StudioRoot)) {
    Warn "Studio not found at $StudioRoot - skipping studio (use -NoStudio to silence)"
  } else {
    # Studio runtime-control inline mode (no Temporal needed). PORT 8080 to avoid Engine :3001 clash.
    # Config: products/agent-studio/apps/runtime-control/src/config.ts (PORT default 3001, overridden here)
    $studioCmd = '"npx --yes tsx --watch apps/runtime-control/src/main.ts"'
    $cmds  += $studioCmd
    $names += "studio"
    $colors += "magenta"
  }
}

if (-not $NoWeb) {
  if (-not (Test-Path $WebRoot)) {
    Warn "Website not found at $WebRoot - skipping web (use -NoWeb to silence)"
  } else {
    # Prefer pnpm filter, fall back to npx vite
    $webCmd = '"npx --yes pnpm --filter neryva-website exec vite --port 3000"'
    # Use direct vite invocation that works even if pnpm filter not available
    if (-not (Test-Path (Join-Path $WebRoot "node_modules"))) {
      Warn "Website node_modules missing - run in console/neryva-website: npx --yes pnpm install"
    }
    $cmds  += $webCmd
    $names += "web"
    $colors += "green"
  }
}

$namesStr  = $names -join ","
$colorsStr = $colors -join ","
$cmdsStr   = $cmds -join " "

Info "Running: npx concurrently --kill-others-on-fail --prefix [{name}] --names $namesStr --prefix-colors $colorsStr $cmdsStr"
Write-Host ""
Write-Host "Services:" -ForegroundColor White
Write-Host "  engine  http://localhost:3001  (health http://localhost:3001/health/live)" -ForegroundColor Gray
if (-not $NoStudio) { Write-Host "  studio  http://localhost:8080  (EXECUTION_MODE=inline, no Temporal)" -ForegroundColor Gray }
if (-not $NoWeb)    { Write-Host "  web     http://localhost:3000  (proxies /engine->:3001, /runtime->:8080)" -ForegroundColor Gray }
Write-Host "  minio   http://127.0.0.1:9000 (api)  http://127.0.0.1:9001 (console, minioadmin/minioadmin)" -ForegroundColor Gray
Write-Host ""
Write-Host "Logs are prefixed [engine]/[studio]/[web]. Ctrl+C kills all." -ForegroundColor Yellow
Write-Host ""

# Build env for studio: must have PORT=8080, EXECUTION_MODE=inline, NERYVA_MCP_ENDPOINT=http://localhost:3001
$studioEnv = ""
if (-not $NoStudio) {
  # concurrently can pass env per command via --env? Instead we set via cross-env style in command.
  # Simpler: wrap studio command with PowerShell env prefix handled by concurrently's shell.
  # Rebuild cmds with env prefix for studio when needed.
  # Use `cross-env` equivalent via `npx cross-env` if available, else PowerShell $env:.
  # For minimal deps, we inject env into the command string for cmd.exe / PowerShell.
  # On Windows, concurrently runs via cmd.exe by default, so `set VAR=... && command` works.
  # We'll rebuild the studio entry with env.
  $envPrefix = "set PORT=8080&& set EXECUTION_MODE=inline&& set NERYVA_MCP_ENDPOINT=http://localhost:3001&&"
  # Replace the studio cmd with env-prefixed variant
  for ($i=0; $i -lt $cmds.Count; $i++) {
    if ($names[$i] -eq "studio") {
      $cmds[$i] = '"' + $envPrefix + ' npx --yes tsx --watch apps/runtime-control/src/main.ts"'
    }
    if ($names[$i] -eq "web") {
      # Ensure web runs from its directory
      $cmds[$i] = '"npx --yes pnpm --filter neryva-website exec vite --port 3000 --host"'
    }
  }
}

# Execute concurrently with proper working dirs:
# Engine cwd = engine/, Studio cwd = products/agent-studio, Web cwd = console/neryva-website
# concurrently handles cwd per command via --cwd? No, global cwd only. So we use `npx --prefix` style.
# Workaround: each command cd's itself: `cd /d <dir> && <cmd>`
# Build final commands with explicit cd
$finalCmds = @()
for ($i=0; $i -lt $cmds.Count; $i++) {
  $n = $names[$i]
  $c = $cmds[$i].Trim('"')
  if ($n -eq "engine") {
    $finalCmds += "`"cd /d `"$Root`" && $c`""
  } elseif ($n -eq "studio") {
    $studioDir = $StudioRoot
    $finalCmds += "`"cd /d `"$studioDir`" && $c`""
  } elseif ($n -eq "web") {
    $webDir = $WebRoot
    $finalCmds += "`"cd /d `"$webDir`" && $c`""
  }
}

$args = @(
  "--kill-others-on-fail",
  "--prefix", "[{name}]",
  "--names", $namesStr,
  "--prefix-colors", $colorsStr
) + $finalCmds

# Run
& npx --yes concurrently @args
$code = if (Test-Path variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
Write-Host ""
if ($code -eq 0) { Ok "All services exited cleanly (code 0)" }
else { Warn "concurrently exited with code $code" }
exit $code
