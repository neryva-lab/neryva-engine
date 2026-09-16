#Requires -Version 5.1
<#
.SYNOPSIS
  M0 live QA: full OAuth round-trip against the dev engine (email-code path).
.DESCRIPTION
  authorize (PKCE S256) -> OP login page -> email code (file outbox) ->
  verify -> resume -> code -> token exchange -> GET /auth/me ->
  org contexts -> refresh rotation. Prints PASS/FAIL per step.

  Uses curl.exe with a cookie jar: the OP sets path-scoped interaction
  cookies (_interaction, _interaction_resume) that PowerShell's WebSession
  does not persist across calls. Browsers handle them normally.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File dev_scripts/qa-m0-auth.ps1
  powershell -ExecutionPolicy Bypass -File dev_scripts/qa-m0-auth.ps1 -Email qa.m0@neryva.local
#>
param([string]$Email = ("qa.m0." + (Get-Date -Format 'yyyyMMddHHmm') + "@neryva.local"))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Engine = 'http://localhost:3001'
# Browser-facing origin (what the console + real browsers use): website :3000
# with the Vite /engine + /login proxies. The OP absolutizes its redirects
# from the issuer, so the whole browser flow must stay on this origin —
# hitting :3001 directly splits cookies and breaks resume/silent paths.
$Web = 'http://localhost:3000'
$EngineProxied = "$Web/engine"
$LoginBase = "$Web/login"
$Outbox = Join-Path $PSScriptRoot '../var/outbox'
$Tmp = 'C:\Users\Hellx\AppData\Local\Temp\opencode'
$Jar = Join-Path $Tmp 'qa-m0-jar.txt'
$fail = 0
function Step($name, [scriptblock]$b) {
  try { $r = & $b; Write-Host "[ok] $name $r" -ForegroundColor Green }
  catch { Write-Host "[FAIL] $name : $_" -ForegroundColor Red; $script:fail++ }
}
function New-RandomB64($bytes) {
  $b = New-Object byte[] $bytes; (New-Object Random).NextBytes($b)
  [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_').TrimEnd('=')
}
function Get-S256($s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $h = $sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($s))
  [Convert]::ToBase64String($h).Replace('+','-').Replace('/','_').TrimEnd('=')
}
function Curl-Redirect($url) {
  $out = curl.exe -s --max-time 25 -b $Jar -c $Jar $url -o NUL -w '%{http_code} %{redirect_url}'
  $parts = $out.Split(' ', 2)
  return @{ code = $parts[0]; redirect = if ($parts.Count -gt 1) { $parts[1] } else { '' } }
}
function Curl-PostJson($url, $json) {
  $bodyFile = Join-Path $Tmp 'qa-m0-body.json'
  Set-Content -LiteralPath $bodyFile -Value $json -NoNewline -Encoding Ascii
  $out = curl.exe -s --max-time 25 -b $Jar -c $Jar -X POST $url -H 'Content-Type: application/json' -d "@$bodyFile" -w "`n%{http_code} %{redirect_url}"
  return ($out -join "`n")
}

$verifier = New-RandomB64 32
$challenge = Get-S256 $verifier
$state = New-RandomB64 16
$redirect = 'http://localhost:3000/platform/auth/callback'
$scope = 'openid email profile offline_access'
$authUrl = "$Engine/auth/auth?client_id=neryva-console&response_type=code&scope=$([uri]::EscapeDataString($scope))&redirect_uri=$([uri]::EscapeDataString($redirect))&state=$state&code_challenge=$challenge&code_challenge_method=S256"

Remove-Item -LiteralPath $Jar -Force -ErrorAction SilentlyContinue

Step 'providers list' {
  $p = Invoke-RestMethod "$Engine/login/providers"
  "@($($p.providers.Count)) providers [$(($p.providers | ForEach-Object { $_.key }) -join ',')]"
}
$loginUrl = $null
Step 'authorize -> OP login page' {
  $r = Curl-Redirect $authUrl
  if ($r.code -notmatch '30[12378]' -or $r.redirect -notmatch '/login/') { throw "unexpected: $($r.code) $($r.redirect)" }
  $script:loginUrl = $r.redirect
  "-> $script:loginUrl"
}
Step 'submit email (429-aware, up to ~3.5 min backoff)' {
  $deadline = (Get-Date).AddMinutes(3.5)
  while ($true) {
    $out = Curl-PostJson "$script:loginUrl/email" (@{ email = $Email } | ConvertTo-Json -Compress)
    if ($out -match 'Check your inbox') { break }
    if ($out -match 'Too many codes' -and (Get-Date) -lt $deadline) {
      Write-Host '  (login-email rate limited — backing off 25s…)' -ForegroundColor DarkGray
      Start-Sleep -Seconds 25
      continue
    }
    throw "no inbox page: $(($out | Out-String).Substring(0, [Math]::Min(200, ($out | Out-String).Length)))"
  }
  'code sent'
}
$code = $null
Step 'read code from file outbox' {
  Start-Sleep -Seconds 1
  $latest = Get-ChildItem -LiteralPath $Outbox -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "outbox empty at $Outbox" }
  if ((New-TimeSpan -Start $latest.LastWriteTime -End (Get-Date)).TotalMinutes -gt 3) { throw "latest outbox file is stale: $($latest.Name)" }
  $text = Get-Content -LiteralPath $latest.FullName -Raw
  $m = [regex]::Match($text, '\b(\d{8})\b')
  if (-not $m.Success) { throw "no 8-digit code in $($latest.Name)" }
  $script:code = $m.Groups[1].Value
  "code in $($latest.Name)"
}
$resumeUrl = $null
Step 'verify code -> resume URL' {
  $verifyBody = Join-Path $Tmp 'qa-m0-verify.json'
  Set-Content -LiteralPath $verifyBody -Value (@{ email = $Email; code = $script:code } | ConvertTo-Json -Compress) -NoNewline -Encoding Ascii
  $verifyUrl = "$script:loginUrl/verify"
  $out = curl.exe -s -b "$Jar" -c "$Jar" -X POST "$verifyUrl" -H 'Content-Type: application/json' -d "@$verifyBody" -w "`n%{http_code} %{redirect_url}"
  $out = ($out -join "`n")
  $m = [regex]::Match($out, 'https?://\S+')
  # curl -w appends "code redirect" after the body; the resume URL is the last URL on the status line
  $lines = $out -split "`n"
  $status = $lines[-1]
  if ($status -notmatch '^303 .*?(/auth/auth/\S+|http\S+)') { throw "no resume redirect: $status" }
  $script:resumeUrl = $Matches[1]
  if ($script:resumeUrl -notmatch '^https?://') { $script:resumeUrl = "$Engine$script:resumeUrl" }
  "-> resume"
}
$callbackQuery = $null
Step 'resume -> callback with ?code' {
  $r = Curl-Redirect $script:resumeUrl
  if ($r.redirect -notmatch 'code=') { throw "no code: $($r.code) $($r.redirect)" }
  $script:callbackQuery = ($r.redirect -split '\?', 2)[1]
  'code received'
}
$tokens = $null
Step 'code -> token exchange' {
  $form = "grant_type=authorization_code&client_id=neryva-console&code=$([uri]::EscapeDataString(($script:callbackQuery -replace '.*code=([^&]+).*','$1')))&code_verifier=$verifier&redirect_uri=$([uri]::EscapeDataString($redirect))"
  $script:tokens = Invoke-RestMethod "$Engine/auth/token" -Method POST -ContentType 'application/x-www-form-urlencoded' -Body $form
  "access $($script:tokens.access_token.Length) chars, refresh $(if ($script:tokens.refresh_token) { 'yes' } else { 'NO' })"
}
Step 'GET /auth/me shape' {
  $me = Invoke-RestMethod "$Engine/auth/me" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  if (-not $me.account.id) { throw "no account.id: $($me | ConvertTo-Json -Depth 3)" }
  "id=$($me.account.id) email=$($me.account.email) name=$($me.account.display_name)"
}
Step 'org contexts' {
  $c = Invoke-RestMethod "$Engine/console/org/contexts" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  "$($c.contexts.Count) context(s)"
}
Step 'refresh rotation' {
  $form = "grant_type=refresh_token&client_id=neryva-console&refresh_token=$($script:tokens.refresh_token)"
  $t2 = Invoke-RestMethod "$Engine/auth/token" -Method POST -ContentType 'application/x-www-form-urlencoded' -Body $form
  if (-not $t2.access_token -or -not $t2.refresh_token) { throw 'rotation did not return a pair' }
  'new pair issued'
}

Write-Host ""
if ($fail -eq 0) { Write-Host 'M0 OAuth round-trip: ALL PASS' -ForegroundColor Green }
else { Write-Host "M0 OAuth round-trip: $fail FAILURES" -ForegroundColor Red; exit 1 }
