#Requires -Version 5.1
<#
.SYNOPSIS
  Probe all Neryva dev dependencies and services (no side effects).

.DESCRIPTION
  Checks Postgres :5432, Redis :6379, MinIO :9000, Engine :3001, Studio
  runtime-control :8080, Website :3000. Uses HTTP + TCP probes only.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red }
function Info($m) { Write-Host "[info] $m" -ForegroundColor Cyan }

Write-Host ""
Write-Host "=== Neryva health check (Windows-native) ===" -ForegroundColor White
Write-Host ""

# Postgres
Info "Postgres 127.0.0.1:5432"
$t = Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -WarningAction SilentlyContinue
if ($t.TcpTestSucceeded) { Ok "TCP open" } else { Bad "TCP closed - is Postgres service running? (services.msc or docker compose -f ops/docker-compose.yml up -d postgres)" }

# Redis
Info "Redis / Memurai 127.0.0.1:6379"
$t = Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -WarningAction SilentlyContinue
if ($t.TcpTestSucceeded) {
  Ok "TCP open"
  try {
    $c = New-Object System.Net.Sockets.TcpClient("127.0.0.1", 6379)
    $s = $c.GetStream(); $w = New-Object System.IO.StreamWriter($s); $w.AutoFlush = $true; $r = New-Object System.IO.StreamReader($s)
    $w.WriteLine("*1`r`n`$4`r`nPING`r`n"); $s.ReadTimeout = 1500; $resp = $r.ReadLine()
    if ($resp -like "*PONG*") { Ok "PING -> PONG" } else { Warn "Unexpected reply: $resp" }
    $c.Close()
  } catch { Warn "PING failed: $_" }
} else { Bad "TCP closed - install Memurai or start WSL redis-server / Docker redis" }

# S3 (:9000 is MinIO when licensed, else moto_server fallback from start-infra.ps1)
Info "S3 http://127.0.0.1:9000 (MinIO health, else moto fallback)"
$s3Ok = $false
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:9000/minio/health/live" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { Ok "S3 live via MinIO API"; $s3Ok = $true } else { Warn "MinIO status $($r.StatusCode)" } } catch {}
if (-not $s3Ok) {
  try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:9000/moto-api" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { Ok "S3 live via moto fallback (buckets in-memory, recreated by start-infra.ps1)"; $s3Ok = $true } } catch {}
}
if (-not $s3Ok) { Bad "S3 not reachable on :9000 - run dev_scripts/start-infra.ps1" }
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:9001" -UseBasicParsing -TimeoutSec 3; Ok "MinIO console reachable (http://127.0.0.1:9001)" } catch { Warn "No console on :9001 (expected with moto fallback; API above is what Engine uses)" }

# Engine
Info "Engine http://localhost:3001/health/*"
try { $r = Invoke-WebRequest -Uri "http://localhost:3001/health/live" -UseBasicParsing -TimeoutSec 3; Ok "GET /health/live -> $($r.StatusCode)" } catch { Bad "Engine /health/live not reachable - is dev running? (dev_scripts/dev.ps1 or npx pnpm run dev)" }
try { $r = Invoke-WebRequest -Uri "http://localhost:3001/health/ready" -UseBasicParsing -TimeoutSec 3; Ok "GET /health/ready -> $($r.StatusCode)" } catch { Warn "Engine /health/ready not reachable (DB/Redis may be down)" }
try { $r = Invoke-WebRequest -Uri "http://localhost:3001/metrics" -UseBasicParsing -TimeoutSec 3; Ok "GET /metrics -> $($r.StatusCode)" } catch { Warn "Engine /metrics not reachable" }

# Runtime-control
Info "Studio runtime-control http://localhost:8080 (inline)"
$t = Test-NetConnection -ComputerName 127.0.0.1 -Port 8080 -WarningAction SilentlyContinue
if ($t.TcpTestSucceeded) {
  Ok "TCP 8080 open"
  try { $r = Invoke-WebRequest -Uri "http://localhost:8080/healthz" -UseBasicParsing -TimeoutSec 3; Ok "GET /healthz -> $($r.StatusCode)" } catch { Warn "Runtime-control on :8080 but /healthz not 200: $_" }
} else { Warn "Nothing on 127.0.0.1:8080 - start runtime-control: PORT=8080 EXECUTION_MODE=inline npx tsx --watch apps/runtime-control/src/main.ts (in products/agent-studio)" }

# Website
Info "Website http://localhost:3000"
$t = Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue
if ($t.TcpTestSucceeded) {
  Ok "TCP 3000 open"
  try { $r = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 3; Ok "GET / -> $($r.StatusCode)" } catch { Warn "Website on :3000 but GET / failed: $_" }
} else { Warn "Nothing on 127.0.0.1:3000 - run: npx pnpm --filter neryva-website dev (in console/neryva-website) or dev_scripts/dev.ps1" }

Write-Host ""
