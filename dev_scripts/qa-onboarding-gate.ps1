#Requires -Version 5.1
<#
.SYNOPSIS
  Live QA for the first-run onboarding gate (eng-0061 / first-run ledger F1-7).
.DESCRIPTION
  Reuses the M0 OAuth round-trip (email-code, PKCE S256) to mint a REAL L1 token
  for a brand-new account, then proves the onboarding contract end to end:

    1. GET /auth/me carries account.onboarding with needed = true, a terms
       version, and no completion stamp — for an account whose first login is
       happening right now (the case the old 30-minute window was meant to
       catch, and the case it silently missed when that first login failed).
    2. The gate is stable across reads: no wall clock can close it.
    3. POST /auth/me/onboarding/welcome WITHOUT consent → 400 (consent cannot be
       skipped or implied).
    4. POST with a stale terms_version → 409 (agreement to unread text is never
       recorded).
    5. POST with consent (+ skipped personalization) → 200 and needed = false.
    6. GET /auth/me agrees — completion is durable server state.
    7. A replay (new Idempotency-Key, same body) keeps the FIRST completion
       stamp, so "onboarded at" can never drift.

  Uses curl.exe with a cookie jar: the OP sets path-scoped interaction cookies
  (_interaction, _interaction_resume) that PowerShell's WebSession does not
  persist across calls. Browsers handle them normally.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File dev_scripts/qa-onboarding-gate.ps1
#>
param([string]$Email = ("qa.onboarding." + (Get-Date -Format 'yyyyMMddHHmm') + "@neryva.local"))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Engine = 'http://localhost:3001'
$Outbox = Join-Path $PSScriptRoot '../var/outbox'
$Tmp = 'C:\Users\Hellx\AppData\Local\Temp\opencode'
$Jar = Join-Path $Tmp 'qa-onboarding-jar.txt'
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
  $bodyFile = Join-Path $Tmp 'qa-onboarding-login.json'
  Set-Content -LiteralPath $bodyFile -Value $json -NoNewline -Encoding Ascii
  $out = curl.exe -s --max-time 25 -b $Jar -c $Jar -X POST $url -H 'Content-Type: application/json' -d "@$bodyFile" -w "`n%{http_code} %{redirect_url}"
  return ($out -join "`n")
}
# Bearer-authenticated JSON call that never throws on 4xx/5xx, so each step can
# assert the exact status. NOTE: never name a local variable $args — that is a
# PowerShell automatic variable, and splatting it silently drops every argument.
function Api($method, $url, $token, $json = $null) {
  $idem = [guid]::NewGuid().ToString()
  $curlArgs = @('-s','--max-time','25','-X',$method,$url,'-H',"authorization: Bearer $token",'-H',"Idempotency-Key: $idem",'-w',"`n%{http_code}")
  if ($json) {
    $bodyFile = Join-Path $Tmp 'qa-onboarding-api.json'
    Set-Content -LiteralPath $bodyFile -Value $json -NoNewline -Encoding Ascii
    $curlArgs += @('-H','Content-Type: application/json','-d',"@$bodyFile")
  }
  $out = & curl.exe @curlArgs
  $lines = ($out -join "`n") -split "`n"
  $code = $lines[-1].Trim()
  $body = if ($lines.Count -gt 1) { ($lines[0..($lines.Count - 2)] -join "`n") } else { '' }
  return @{ code = $code; body = $body; idempotencyKey = $idem }
}

# ── 1. Mint a real token for a brand-new account (the M0 round-trip) ─────────

$verifier = New-RandomB64 32
$challenge = Get-S256 $verifier
$state = New-RandomB64 16
$redirect = 'http://localhost:3000/platform/auth/callback'
$scope = 'openid email profile offline_access'
$authUrl = "$Engine/auth/auth?client_id=neryva-console&response_type=code&scope=$([uri]::EscapeDataString($scope))&redirect_uri=$([uri]::EscapeDataString($redirect))&state=$state&code_challenge=$challenge&code_challenge_method=S256"

Remove-Item -LiteralPath $Jar -Force -ErrorAction SilentlyContinue

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
  $verifyBody = Join-Path $Tmp 'qa-onboarding-verify.json'
  Set-Content -LiteralPath $verifyBody -Value (@{ email = $Email; code = $script:code } | ConvertTo-Json -Compress) -NoNewline -Encoding Ascii
  $out = curl.exe -s -b "$Jar" -c "$Jar" -X POST "$script:loginUrl/verify" -H 'Content-Type: application/json' -d "@$verifyBody" -w "`n%{http_code} %{redirect_url}"
  $lines = (($out -join "`n") -split "`n")
  $status = $lines[-1]
  if ($status -notmatch '^303 .*?(/auth/auth/\S+|http\S+)') { throw "no resume redirect: $status" }
  $script:resumeUrl = $Matches[1]
  if ($script:resumeUrl -notmatch '^https?://') { $script:resumeUrl = "$Engine$script:resumeUrl" }
  '-> resume'
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
  "access $($script:tokens.access_token.Length) chars"
}

# ── 2. The onboarding gate contract (eng-0061 / F1-7) ────────────────────────

$terms = $null
Step 'GET /auth/me carries the onboarding block (gate OPEN for a first login)' {
  $me = Invoke-RestMethod "$Engine/auth/me" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  $on = $me.account.onboarding
  if ($null -eq $on) { throw "no onboarding block: $($me | ConvertTo-Json -Depth 4)" }
  if ($on.needed -ne $true) { throw "expected needed=true on a brand-new account: $($on | ConvertTo-Json -Compress)" }
  if ($on.welcome_completed_at -ne $null) { throw "unexpected completion stamp: $($on.welcome_completed_at)" }
  if ([string]::IsNullOrWhiteSpace($on.terms_version)) { throw 'no terms_version to consent to' }
  $script:terms = $on.terms_version
  "needed=true terms=$script:terms"
}
Step 'the open gate is stable across reads (no wall clock involved)' {
  $me = Invoke-RestMethod "$Engine/auth/me" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  if ($me.account.onboarding.needed -ne $true) { throw 'the gate closed itself without a completion' }
  'still open'
}
Step 'completion WITHOUT consent is refused (400)' {
  $r = Api 'POST' "$Engine/auth/me/onboarding/welcome" $script:tokens.access_token (@{ skipped = $false; terms_version = $script:terms } | ConvertTo-Json -Compress)
  if ($r.code -ne '400') { throw "expected 400, got $($r.code): $($r.body)" }
  'refused'
}
Step 'consenting against a stale terms version is refused (409)' {
  $r = Api 'POST' "$Engine/auth/me/onboarding/welcome" $script:tokens.access_token (@{ consented = $true; skipped = $false; terms_version = '1999-01-01' } | ConvertTo-Json -Compress)
  if ($r.code -ne '409') { throw "expected 409, got $($r.code): $($r.body)" }
  'refused'
}
Step 'consent + skip closes the gate (201, needed=false)' {
  # 201 = the account.controller POST convention (NestJS default, same as
  # password-reset / revoke-all / MFA routes — no @HttpCode override).
  $r = Api 'POST' "$Engine/auth/me/onboarding/welcome" $script:tokens.access_token (@{ consented = $true; skipped = $true; terms_version = $script:terms } | ConvertTo-Json -Compress)
  if ($r.code -notmatch '^20[01]$') { throw "expected 200/201, got $($r.code): $($r.body)" }
  $parsed = $r.body | ConvertFrom-Json
  if ($parsed.onboarding.needed -ne $false) { throw "gate still open: $($r.body)" }
  if ($parsed.onboarding.welcome_skipped -ne $true) { throw "skip flag not recorded: $($r.body)" }
  if ($parsed.onboarding.consent_version -ne $script:terms) { throw "consent version mismatch: $($parsed.onboarding.consent_version)" }
  $script:firstStamp = $parsed.onboarding.welcome_completed_at
  "closed at $script:firstStamp"
}
Step 'the completion is durable: GET /auth/me agrees' {
  $me = Invoke-RestMethod "$Engine/auth/me" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  $on = $me.account.onboarding
  if ($on.needed -ne $false) { throw "still needed: $($on | ConvertTo-Json -Compress)" }
  if ($on.welcome_completed_at -ne $script:firstStamp) { throw "stamp mismatch: $($on.welcome_completed_at)" }
  "consent=$($on.consent_version) completed=$($on.welcome_completed_at)"
}
Step 'a replay keeps the FIRST completion stamp (idempotent)' {
  $r = Api 'POST' "$Engine/auth/me/onboarding/welcome" $script:tokens.access_token (@{ consented = $true; skipped = $true; terms_version = $script:terms } | ConvertTo-Json -Compress)
  if ($r.code -notmatch '^20[01]$') { throw "expected 200/201, got $($r.code): $($r.body)" }
  $parsed = $r.body | ConvertFrom-Json
  if ($parsed.onboarding.welcome_completed_at -ne $script:firstStamp) { throw "stamp moved: $($parsed.onboarding.welcome_completed_at) vs $script:firstStamp" }
  'stable'
}
Step 'org contexts (the workspace the consent disclosed)' {
  $c = Invoke-RestMethod "$Engine/console/org/contexts" -Headers @{ authorization = "Bearer $($script:tokens.access_token)" }
  "$($c.contexts.Count) context(s)"
}

Write-Host ''
if ($fail -eq 0) { Write-Host "Onboarding gate round-trip: ALL PASS (account $Email)" -ForegroundColor Green }
else { Write-Host "Onboarding gate round-trip: $fail FAILURES" -ForegroundColor Red; exit 1 }
