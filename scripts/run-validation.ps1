$ErrorActionPreference = 'Stop'

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host "=== Conversion Agent live voice validation ===" -ForegroundColor Cyan
Write-Host "This uses Twilio trial + Sarvam. Secrets stay in this PowerShell process only." -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required but node was not found in PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required but npm was not found in PATH.' }

$accountSid = Read-Host 'Twilio Account SID (AC...)'
$apiKeySid = Read-Host 'Twilio API Key SID (SK...)'
$apiKeySecret = Read-PlainSecret 'Twilio API Key secret'
$fromNumber = Read-Host 'Twilio trial number in E.164 format (example +1737...)'
$sarvamKey = Read-PlainSecret 'Sarvam API subscription key'
$testPhone = Read-Host 'Verified recipient phone in E.164 format (example +91...)'

$env:TWILIO_ACCOUNT_SID = $accountSid
$env:TWILIO_API_KEY_SID = $apiKeySid
$env:TWILIO_API_KEY_SECRET = $apiKeySecret
$env:TWILIO_FROM_NUMBER = $fromNumber
$env:TWILIO_VALIDATE_SIGNATURE = 'false'
$env:SARVAM_API_KEY = $sarvamKey
$env:SARVAM_CHAT_MODEL = 'sarvam-30b'
$env:TEST_TENANT_ID = 'demo-dental-hospital'
$env:ADMIN_API_KEY = 'local_validation_only'
$env:PORT = '3000'
$env:RAZORPAY_KEY_ID = 'rzp_test_placeholder'
$env:RAZORPAY_KEY_SECRET = 'placeholder'
$env:GOOGLE_CALENDAR_ACCESS_TOKEN = 'placeholder'
$env:GOOGLE_CALENDAR_ID = 'primary'
$env:APPOINTMENT_MINUTES = '30'
$env:BUSINESS_DAY_START_HOUR = '9'
$env:BUSINESS_DAY_END_HOUR = '18'
$env:CALENDAR_HORIZON_DAYS = '7'
$env:TENANT_CONFIG_JSON = Get-Content (Join-Path $PSScriptRoot '..\config\dental-demo.json') -Raw

Write-Host 'Installing/building...' -ForegroundColor Yellow
npm install
npm run build

$tools = Join-Path $PSScriptRoot '..\.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$cloudflared = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
  Write-Host 'Downloading Cloudflare Tunnel client...' -ForegroundColor Yellow
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflared
}

$tunnelOut = Join-Path $env:TEMP 'conversion-agent-cloudflared.out.log'
$tunnelErr = Join-Path $env:TEMP 'conversion-agent-cloudflared.err.log'
Remove-Item $tunnelOut,$tunnelErr -ErrorAction SilentlyContinue
Write-Host 'Starting temporary public tunnel...' -ForegroundColor Yellow
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel','--url','http://localhost:3000','--no-autoupdate') -RedirectStandardError $tunnelErr -RedirectStandardOutput $tunnelOut -PassThru -WindowStyle Hidden

$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $text = ''
  if (Test-Path $tunnelErr) { $text += (Get-Content $tunnelErr -Raw) }
  if (Test-Path $tunnelOut) { $text += "`n" + (Get-Content $tunnelOut -Raw) }
  $match = [regex]::Match($text, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $publicUrl = $match.Value; break }
  if ($tunnel.HasExited) { throw "cloudflared exited early. Log: $text" }
}
if (-not $publicUrl) { throw "Could not obtain Cloudflare tunnel URL. Error log: $(Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue)" }

$env:PUBLIC_BASE_URL = $publicUrl
Write-Host "Public URL: $publicUrl" -ForegroundColor Green

$serverOut = Join-Path $env:TEMP 'conversion-agent-server.out.log'
$serverErr = Join-Path $env:TEMP 'conversion-agent-server.err.log'
Remove-Item $serverOut,$serverErr -ErrorAction SilentlyContinue
$server = Start-Process -FilePath 'node' -ArgumentList @('dist/src/server.js') -WorkingDirectory (Join-Path $PSScriptRoot '..') -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "$publicUrl/health" -Method Get -TimeoutSec 5
    if ($health.ok) { $healthy = $true; break }
  } catch {}
  if ($server.HasExited) { throw "Server exited early. Error: $(Get-Content $serverErr -Raw)" }
}
if (-not $healthy) { throw "Server did not become healthy. Error: $(Get-Content $serverErr -Raw)" }

Write-Host 'Server is live. Triggering the first call...' -ForegroundColor Green
$body = @{
  tenantId = 'demo-dental-hospital'
  name = 'Validation Caller'
  phone = $testPhone
  source = 'manual-validation'
  serviceInterest = 'dental consultation'
} | ConvertTo-Json

try {
  $result = Invoke-RestMethod -Uri "$publicUrl/api/leads" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
  Write-Host "Call requested. Lead: $($result.leadId) | Call SID: $($result.callSid)" -ForegroundColor Green
  Write-Host 'Answer the phone and test the dental Q&A. For this first call, stop before slot/payment because live Google/Razorpay credentials are not loaded yet.' -ForegroundColor Cyan
} catch {
  Write-Host 'Call trigger failed.' -ForegroundColor Red
  if (Test-Path $serverErr) { Get-Content $serverErr }
  throw
}

Write-Host "`nPress ENTER when you are finished testing to stop the server and tunnel." -ForegroundColor Yellow
[void](Read-Host)
try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
try { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}

$env:TWILIO_API_KEY_SECRET = $null
$env:SARVAM_API_KEY = $null
Write-Host 'Validation runtime stopped.' -ForegroundColor Green
