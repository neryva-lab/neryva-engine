#Requires -Version 5.1
<#
.SYNOPSIS
  Start Windows-native infra: Postgres service, Redis/Memurai probe, MinIO binary.

.DESCRIPTION
  No Docker. Postgres and Redis/Memurai run as Windows services (already
  installed; this script just ensures they're running). MinIO runs as a
  background job from dev_scripts/bin/minio.exe (downloaded by setup.ps1).

  Buckets (mirrors ops/docker-compose.yml minio-init):
    neryva-uploads (+ neryva-uploads/content/covers public-read)

.NOTES
  powershell -ExecutionPolicy Bypass -File dev_scripts/start-infra.ps1
  Stop with: dev_scripts/stop-infra.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path "$PSScriptRoot/..").Path
$BinDir = Join-Path $PSScriptRoot "bin"
$DataDir = Join-Path $BinDir "minio-data"
$MinioExe = Join-Path $BinDir "minio.exe"
$McExe    = Join-Path $BinDir "mc.exe"

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "[info] $m" -ForegroundColor Cyan }
function Bad($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "=== Neryva infra (Windows-native, no Docker) ===" -ForegroundColor White

# -- Postgres --------------------------------------------------------------
Info "Postgres :5432"
try {
  $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc) {
    if ($svc.Status -ne "Running") {
      Info "Starting service $($svc.Name) ..."
      Start-Service $svc.Name -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
      $svc = Get-Service $svc.Name
    }
    Ok "Postgres service $($svc.Name) - $($svc.Status)"
  } else {
    Warn "No postgresql* service - ensure EDB Postgres 17 installed and DATABASE_URL points to it, or use Docker: docker compose -f ops/docker-compose.yml up -d postgres"
  }
} catch { Warn "Postgres service check: $_" }

# Quick TCP probe
try {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($t.TcpTestSucceeded) { Ok "Postgres TCP 127.0.0.1:5432 open" } else { Warn "Postgres 127.0.0.1:5432 not reachable - check service / firewall / DATABASE_URL" }
} catch {}

# -- Redis / Memurai ------------------------------------------------------
Info "Redis / Memurai :6379"
try {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($t.TcpTestSucceeded) { Ok "Redis/Memurai TCP 127.0.0.1:6379 open" }
  else { Warn "Nothing on 127.0.0.1:6379 - install Memurai (https://www.memurai.com/redis-windows) or: wsl -- sudo service redis-server start" }
} catch { Warn "Redis probe failed: $_" }

# -- S3 (MinIO with moto fallback) -----------------------------------------
# MinIO Sept 2026 binaries are license-gated (dl.min.io 410 / AccessDenied
# No license installed). When MinIO is unavailable or fails its health
# check, fall back to moto_server (python -m moto.server, pip install moto[s3])
# on the same :9000 port -- Engine's S3_* (minioadmin) works against both.
Info "S3 :9000/:9001 (MinIO at dev_scripts/bin/minio.exe, moto fallback)"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# Kill prior S3 jobs/processes
$old = Get-Job -Name "neryva-minio" -ErrorAction SilentlyContinue
if ($old) { Info "Stopping prior MinIO job ..."; Stop-Job $old -ErrorAction SilentlyContinue; Remove-Job $old -Force -ErrorAction SilentlyContinue }
$oldMoto = Get-Job -Name "neryva-moto" -ErrorAction SilentlyContinue
if ($oldMoto) { Info "Stopping prior moto job ..."; Stop-Job $oldMoto -ErrorAction SilentlyContinue; Remove-Job $oldMoto -Force -ErrorAction SilentlyContinue }
try { Get-Process -Name "minio" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
# If :9000 already has a listener (moto/manual), keep it
try {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 9000 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($t.TcpTestSucceeded) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9000/moto-api" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
      if ($r.StatusCode -eq 200) { Ok "S3 already live via moto on :9000 (reusing)"; $ok = $true }
      else {
        $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:9000/minio/health/live" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($r2.StatusCode -eq 200) { Ok "S3 already live via MinIO on :9000 (reusing)"; $ok = $true }
      }
    } catch {}
  }
} catch {}

$ok = $false
$usingMoto = $false
if (-not $ok -and (Test-Path $MinioExe)) {
  $env:MINIO_ROOT_USER = "minioadmin"
  $env:MINIO_ROOT_PASSWORD = "minioadmin"
  Info "Starting MinIO: $MinioExe server $DataDir --console-address :9001"
  $job = Start-Job -Name "neryva-minio" -ScriptBlock {
    param($exe, $data)
    $env:MINIO_ROOT_USER = "minioadmin"
    $env:MINIO_ROOT_PASSWORD = "minioadmin"
    & $exe server $data --console-address :9001
  } -ArgumentList $MinioExe, $DataDir
  for ($i=0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9000/minio/health/live" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
    $st = (Get-Job -Name "neryva-minio" -ErrorAction SilentlyContinue).State
    if ($st -eq "Failed") {
      $out = Receive-Job -Name "neryva-minio" 2>&1 | Out-String
      Warn "MinIO job failed (likely license-gated):`n$out"
      break
    }
  }
  if ($ok) { Ok "MinIO live at http://127.0.0.1:9000 (console http://127.0.0.1:9001, minioadmin/minioadmin)" }
  else { Warn "MinIO not live -- trying moto fallback on :9000"; try { Stop-Job (Get-Job -Name "neryva-minio" -ErrorAction SilentlyContinue) -ErrorAction SilentlyContinue; Remove-Job (Get-Job -Name "neryva-minio" -ErrorAction SilentlyContinue) -Force -ErrorAction SilentlyContinue } catch {} }
}
if (-not $ok) {
  # Moto fallback -- in-memory S3, buckets are on-demand so no mc needed
  try {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
    if ($py) {
      $motoVer = & python -c "import moto; print(moto.__version__)" 2>$null
      if ($motoVer) {
        Info "Starting moto_server 5.2.3 on :9000 (pip install moto[s3] if missing)"
        $motoJob = Start-Job -Name "neryva-moto" -ScriptBlock { python -m moto.server -H 127.0.0.1 -p 9000 }
        for ($i=0; $i -lt 15; $i++) {
          Start-Sleep -Seconds 1
          try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:9000/moto-api" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { $ok = $true; $usingMoto = $true; break }
          } catch {}
        }
        if ($ok) { Ok "moto S3 live at http://127.0.0.1:9000 (in-memory, buckets on demand)" }
        else { Warn "moto not live after 15s -- check: Get-Job neryva-moto | Receive-Job" }
      } else { Warn "moto not installed -- pip install 'moto[s3]' for S3 fallback, or install licensed MinIO" }
    } else { Warn "python not found -- cannot start moto fallback" }
  } catch { Warn "moto fallback failed: $_" }
}
if (-not $ok) { Warn "S3 not live after MinIO+moto attempts -- Engine S3 calls will fail until :9000 is reachable. See dev_scripts/README.md" }

# -- Buckets (mirrors ops/docker-compose.yml minio-init) --------------------
# S3 requires explicit bucket creation on both MinIO and moto, so when mc.exe
# is unavailable (dl.min.io no longer serves OSS binaries) fall back to a
# python boto3 one-liner against :9000 with the dev minioadmin credentials.
if ((Test-Path $McExe) -and $ok) {
  Info "Creating buckets via mc ..."
  try {
    & $McExe alias set local http://127.0.0.1:9000 minioadmin minioadmin 2>&1 | Out-Null
    & $McExe mb --ignore-existing local/neryva-uploads 2>&1 | Out-Null
    & $McExe mb --ignore-existing local/neryva-uploads/content 2>&1 | Out-Null
    & $McExe anonymous set download local/neryva-uploads/content/covers 2>&1 | Out-Null
    Ok "Buckets ready: neryva-uploads (+ content/covers public-read)"
  } catch { Warn "mc bucket setup failed: $_ - create manually via http://127.0.0.1:9001" }
} elseif ($ok) {
  Info "Creating bucket neryva-uploads via S3 API (mc.exe not present) ..."
  try {
    $bucketOut = & python -c "import boto3; s=boto3.client('s3', endpoint_url='http://127.0.0.1:9000', aws_access_key_id='minioadmin', aws_secret_access_key='minioadmin', region_name='us-east-1'); names=[b['Name'] for b in s.list_buckets().get('Buckets',[])]; print('exists' if 'neryva-uploads' in names else 'missing')" 2>&1 | Out-String
    if ($bucketOut -match 'missing') {
      & python -c "import boto3; boto3.client('s3', endpoint_url='http://127.0.0.1:9000', aws_access_key_id='minioadmin', aws_secret_access_key='minioadmin', region_name='us-east-1').create_bucket(Bucket='neryva-uploads')" 2>&1 | Out-Null
      Ok "Bucket ready: neryva-uploads (created via S3 API)"
    } else {
      Ok "Bucket ready: neryva-uploads (already exists)"
    }
  } catch { Warn "S3 bucket setup failed: $_ - Engine uploads will 503 until neryva-uploads exists" }
}

Write-Host ""
Write-Host "Infra up (where available). Next:" -ForegroundColor White
Write-Host "  npx pnpm run migrate          # once, creates tables + pgvector extension" -ForegroundColor Gray
Write-Host "  dev_scripts/dev.ps1           # full stack (engine+studio+web)" -ForegroundColor Gray
Write-Host "  dev_scripts/check.ps1         # health probes" -ForegroundColor Gray
Write-Host "  dev_scripts/stop-infra.ps1    # stop MinIO job" -ForegroundColor Gray
Write-Host ""
