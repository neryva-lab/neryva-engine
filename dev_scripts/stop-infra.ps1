#Requires -Version 5.1
<#
.SYNOPSIS
  Stop Windows-native infra started by start-infra.ps1 (S3 job/process).

.DESCRIPTION
  Postgres and Redis/Memurai are Windows services - left running (stop via
  services.msc if needed). This script stops the S3 background jobs (MinIO
  and/or moto fallback) and any stray minio.exe / moto.server processes
  on :9000/:9001.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== Neryva infra stop (Windows-native) ===" -ForegroundColor White

$job = Get-Job -Name "neryva-minio" -ErrorAction SilentlyContinue
if ($job) {
  Write-Host "[info] Stopping MinIO job (neryva-minio) ..." -ForegroundColor Cyan
  Stop-Job $job | Out-Null
  Remove-Job $job -Force | Out-Null
  Write-Host "[ok] MinIO job stopped" -ForegroundColor Green
} else {
  Write-Host "[info] No MinIO job neryva-minio found" -ForegroundColor DarkGray
}

$procs = Get-Process -Name "minio" -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "[info] Stopping stray minio.exe processes ..." -ForegroundColor Cyan
  $procs | Stop-Process -Force
  Write-Host "[ok] minio.exe stopped" -ForegroundColor Green
} else {
  Write-Host "[info] No minio.exe process found" -ForegroundColor DarkGray
}

$motoJob = Get-Job -Name "neryva-moto" -ErrorAction SilentlyContinue
if ($motoJob) {
  Write-Host "[info] Stopping moto job (neryva-moto) ..." -ForegroundColor Cyan
  Stop-Job $motoJob | Out-Null
  Remove-Job $motoJob -Force | Out-Null
  Write-Host "[ok] moto job stopped" -ForegroundColor Green
} else {
  Write-Host "[info] No moto job neryva-moto found" -ForegroundColor DarkGray
}

try {
  $motoProcs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*moto.server*" }
  if ($motoProcs) {
    Write-Host "[info] Stopping moto.server python processes ..." -ForegroundColor Cyan
    $motoProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "[ok] moto.server stopped" -ForegroundColor Green
  } else {
    Write-Host "[info] No moto.server process found" -ForegroundColor DarkGray
  }
} catch { Write-Host "[warn] moto process probe failed: $_" -ForegroundColor Yellow }

Write-Host ""
Write-Host "Postgres/Redis services left running (services.msc to stop)." -ForegroundColor DarkGray
Write-Host "MinIO data kept at dev_scripts/bin/minio-data (delete to wipe buckets)." -ForegroundColor DarkGray
Write-Host ""
