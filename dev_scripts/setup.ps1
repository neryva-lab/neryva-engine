#Requires -Version 5.1
<#
.SYNOPSIS
  One-time Windows-native dev setup (no Docker). Idempotent - safe to re-run.
.DESCRIPTION
  Checks Node/pnpm, Postgres + pgvector, Redis/Memurai on :6379, downloads
  MinIO binaries to dev_scripts/bin/. Production stays Docker (ops/docker-compose.yml).
.NOTES
  Run as: powershell -ExecutionPolicy Bypass -File dev_scripts/setup.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path "$PSScriptRoot/..").Path
$BinDir = Join-Path $PSScriptRoot 'bin'
$DataDir = Join-Path $BinDir 'minio-data'
$MinioUrls = @(
  'https://dl.min.io/aistor/minio/release/windows-amd64/minio.exe',
  'https://dl.min.io/server/minio/release/windows-amd64/minio.exe',
  'https://github.com/minio/minio/releases/latest/download/minio.exe'
)
$McUrls = @(
  'https://dl.min.io/aistor/mclient/release/windows-amd64/mc.exe',
  'https://dl.min.io/client/mc/release/windows-amd64/mc.exe',
  'https://github.com/minio/mc/releases/latest/download/mc.exe'
)

function Write-Ok($m)  { Write-Host "[ok] $m" -ForegroundColor Green }
function Write-Warn($m){ Write-Host "[warn] $m" -ForegroundColor Yellow }
function Write-Info($m){ Write-Host "[info] $m" -ForegroundColor Cyan }
function Write-Bad($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "=== Neryva Windows-native setup (no Docker) ===" -ForegroundColor White
Write-Host "Root: $Root" -ForegroundColor DarkGray
Write-Host ""

Write-Info "1/5 Node + pnpm"
try { $nodeV = (node --version 2>&1) } catch { $nodeV = $null }
if (-not $nodeV) { Write-Bad "node not found - install Node 22 LTS from https://nodejs.org"; exit 1 }
Write-Ok "node $nodeV (need >=22 per engine/package.json)"
$pnpmV = $null
try { $pnpmV = (npx --yes pnpm --version 2>&1 | Select-Object -Last 1) } catch {}
if ($pnpmV -and $pnpmV -match '^\d+\.') { Write-Ok "pnpm $pnpmV via npx (need >=9)" }
else { Write-Warn "npx pnpm not working - run in elevated shell: corepack enable; corepack prepare pnpm@9.12.0 --activate" }

Write-Info "2/5 Postgres + pgvector (need PG 16/17 + CREATE EXTENSION vector)"
$psql = $null
$pgCandidates = @(
  "C:\Program Files\PostgreSQL\17\bin\psql.exe",
  "C:\Program Files\PostgreSQL\16\bin\psql.exe",
  "C:\Program Files\PostgreSQL\15\bin\psql.exe"
)
foreach ($c in $pgCandidates) { if (Test-Path $c) { $psql = $c; break } }
if (-not $psql) {
  $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter "psql.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { $psql = $found }
}
if ($psql) {
  Write-Ok "psql at $psql"
  try { $v = & $psql --version 2>&1; Write-Ok "$v" } catch { Write-Warn "psql --version failed" }
  $dbUrl = $null
  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern "^DATABASE_URL=" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { $dbUrl = ($line.Line -replace '^DATABASE_URL=','').Trim('"').Trim("'") }
  }
  if (-not $dbUrl) { $dbUrl = "postgresql://neryva:neryva@127.0.0.1:5432/neryva" }
  try {
    $q = "SELECT installed_version FROM pg_available_extensions WHERE name='vector';"
    $out = & $psql $dbUrl -t -A -c $q 2>&1 | Out-String
    if ($out -match '\d') { Write-Ok "pgvector available (installed_version: $($out.Trim()))" }
    else { Write-Warn "pgvector not found - build it: x64 Native Tools Prompt (Admin) > set PGROOT=C:\Program Files\PostgreSQL\17 & git clone --branch v0.8.6 https://github.com/pgvector/pgvector.git %TEMP%\pgvector ; cd %TEMP%\pgvector ; nmake /F Makefile.win ; nmake /F Makefile.win install ; psql -c 'CREATE EXTENSION vector;' neryva" }
  } catch { Write-Warn "Could not probe pgvector (DB may be down) - start Postgres service and retry; then psql -c 'CREATE EXTENSION vector;'" }
} else {
  Write-Bad "psql not found - install PostgreSQL 17 EDB from https://www.postgresql.org/download/windows/ (check 'add to PATH'). Data dir is usually C:\Program Files\PostgreSQL\17\data."
  Write-Host "      EDB installer: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads" -ForegroundColor DarkGray
}
$pgData = "C:\Program Files\PostgreSQL\17\data"
if ((Test-Path $pgData) -and (-not (Test-Path "C:\Program Files\PostgreSQL\17\bin"))) {
  Write-Warn "PG data at $pgData but bin/ missing - reinstall Postgres 17 over existing data dir to restore binaries."
}
try {
  $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc) { Write-Ok "Postgres service: $($svc.Name) - $($svc.Status)" }
  else { Write-Warn "No postgresql* Windows service found - if installed, start via services.msc; Docker PG (ops/docker-compose.yml) is the alternative." }
} catch { Write-Warn "Could not query postgres service (non-admin?)" }

Write-Info "3/5 Redis / Memurai on :6379"
$redisOk = $false
try {
  $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($tcp.TcpTestSucceeded) { $redisOk = $true; Write-Ok "Something is listening on 127.0.0.1:6379" }
  else { Write-Warn "Nothing on 127.0.0.1:6379 - install Memurai Developer Edition (https://www.memurai.com/redis-windows) or start Redis via WSL: wsl -- sudo service redis-server start. Also: docker compose -f ops/docker-compose.yml up -d redis is the Docker fallback." }
} catch { Write-Warn "Could not probe :6379: $_" }
if ($redisOk) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient("127.0.0.1", 6379)
    $s = $c.GetStream()
    $w = New-Object System.IO.StreamWriter($s); $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($s)
    $w.WriteLine("*1`r`n`$4`r`nPING`r`n")
    $s.ReadTimeout = 1500
    $resp = $r.ReadLine()
    if ($resp -like "*PONG*") { Write-Ok "Redis/Memurai PING -> PONG" } else { Write-Warn "Port 6379 replied but not PONG (got: $resp) - check what's bound there." }
    $c.Close()
  } catch { Write-Warn "Port 6379 open but PING failed: $_ - may still be usable via ioredis." }
}
try {
  $rsvc = Get-Service -Name "*memurai*","*redis*" -ErrorAction SilentlyContinue
  if ($rsvc) { $rsvc | ForEach-Object { Write-Ok "Service $($_.Name) - $($_.Status)" } }
} catch {}

Write-Info "4/5 MinIO binaries -> dev_scripts/bin/"
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$minioExe = Join-Path $BinDir "minio.exe"
$mcExe    = Join-Path $BinDir "mc.exe"
foreach ($pair in @(@{ urls=$MinioUrls; dst=$minioExe; name="minio.exe" }, @{ urls=$McUrls; dst=$mcExe; name="mc.exe" })) {
  if (Test-Path $pair.dst) { Write-Ok "$($pair.name) already at $($pair.dst)" }
  else {
    $done = $false
    foreach ($u in $pair.urls) {
      Write-Info "Trying $($pair.name) from $u ..."
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $u -OutFile $pair.dst -UseBasicParsing -TimeoutSec 60
        if ((Get-Item $pair.dst).Length -gt 10000) { Write-Ok "Downloaded $($pair.name) -> $($pair.dst) (from $u)"; $done = $true; break }
        else { Remove-Item $pair.dst -Force -ErrorAction SilentlyContinue; throw "too small" }
      } catch { Write-Warn "Failed from $u : $_" }
    }
    if (-not $done) { Write-Warn "All mirrors failed for $($pair.name) - dl.min.io no longer serves OSS binaries (archived upstream). S3 dev still works: start-infra.ps1 falls back to moto_server on :9000 (pip install 'moto[s3]') and creates buckets via the S3 API, no mc needed. Docker remains the fallback: docker compose -f ops/docker-compose.yml up -d minio"; Write-Host "      Tried: $($pair.urls -join ', ')" -ForegroundColor DarkGray }
  }
}

Write-Info "5/5 Env + contracts"
$envExample = Join-Path $Root ".env.example"
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
  Write-Warn ".env missing - copying .env.example -> .env (edit it!)"
  Copy-Item $envExample $envFile -ErrorAction SilentlyContinue
}
if (Test-Path $envFile) {
  $hasRuntime = Select-String -Path $envFile -Pattern "NERYVA_RUNTIME_BASE_URL=http" -ErrorAction SilentlyContinue
  if (-not $hasRuntime) { Write-Warn "Set in .env: NERYVA_RUNTIME_BASE_URL=http://localhost:8080  (without it Engine->Studio dispatch skips and runs stay ACCEPTED - see src/transport/mcp/runtime-control.client.ts:12-15)" }
  else { Write-Ok "NERYVA_RUNTIME_BASE_URL present in .env" }
}

Write-Host ""
Write-Host "Setup done. Next:" -ForegroundColor White
Write-Host "  1. Edit .env (DATABASE_URL, REDIS_URL, S3_* for MinIO, NERYVA_RUNTIME_BASE_URL=http://localhost:8080)" -ForegroundColor Gray
Write-Host "  2. powershell -ExecutionPolicy Bypass -File dev_scripts/start-infra.ps1  # PG+Redis+MinIO" -ForegroundColor Gray
Write-Host "  3. npx pnpm run migrate   # once" -ForegroundColor Gray
Write-Host "  4. powershell -ExecutionPolicy Bypass -File dev_scripts/dev.ps1          # full stack" -ForegroundColor Gray
Write-Host ""
