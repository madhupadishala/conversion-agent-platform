$ErrorActionPreference = 'Stop'

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  return $port
}

Write-Host "=== Twilio sandbox dental-agent validation ===" -ForegroundColor Cyan
Write-Host "This launcher starts the AI server and prints the Custom TwiML URL to paste into Twilio." -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required but node was not found in PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required but npm was not found in PATH.' }

$sarvamKey = Read-PlainSecret 'Sarvam API subscription key'
$port = Get-FreeTcpPort
Write-Host "Using free local port: $port" -ForegroundColor Green

$env:SARVAM_API_KEY = $sarvamKey
$env:SARVAM_CHAT_MODEL = 'sarvam-30b'
$env:TEST_TENANT_ID = 'demo-dental-hospital'
$env:PORT = [string]$port
$env:TENANT_CONFIG_JSON = Get-Content (Join-Path $PSScriptRoot '..\config\dental-demo.json') -Raw

Write-Host 'Installing/building...' -ForegroundColor Yellow
npm install
npm run build

$serverOut = Join-Path $env:TEMP 'conversion-agent-sandbox-server.out.log'
$serverErr = Join-Path $env:TEMP 'conversion-agent-sandbox-server.err.log'
Remove-Item $serverOut,$serverErr -ErrorAction SilentlyContinue

# PUBLIC_BASE_URL is needed by the app at startup. Start with localhost, then restart once the public URL exists.
$env:PUBLIC_BASE_URL = "http://127.0.0.1:$port"
Write-Host 'Starting local AI server...' -ForegroundColor Yellow
$server = Start-Process -FilePath 'node' -ArgumentList @('dist/src/inbound-validation-server.js') -WorkingDirectory (Join-Path $PSScriptRoot '..') -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

$localHealthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 3
    if ($health.ok) { $localHealthy = $true; break }
  } catch {}
  if ($server.HasExited) { throw "Server exited early. Error: $(Get-Content $serverErr -Raw)" }
}
if (-not $localHealthy) { throw "Local server did not become healthy. Error: $(Get-Content $serverErr -Raw -ErrorAction SilentlyContinue)" }
Write-Host 'Local server is healthy.' -ForegroundColor Green

$tools = Join-Path $PSScriptRoot '..\.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$cloudflared = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
  Write-Host 'Downloading Cloudflare Tunnel client...' -ForegroundColor Yellow
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflared
}

$tunnelOut = Join-Path $env:TEMP 'conversion-agent-sandbox-cloudflared.out.log'
$tunnelErr = Join-Path $env:TEMP 'conversion-agent-sandbox-cloudflared.err.log'
Remove-Item $tunnelOut,$tunnelErr -ErrorAction SilentlyContinue
Write-Host 'Starting temporary public tunnel...' -ForegroundColor Yellow
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel','--url',"http://127.0.0.1:$port",'--no-autoupdate') -RedirectStandardError $tunnelErr -RedirectStandardOutput $tunnelOut -PassThru -WindowStyle Hidden

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
if (-not $publicUrl) { throw 'Could not obtain Cloudflare tunnel URL.' }
Write-Host "Public URL: $publicUrl" -ForegroundColor Green

# Restart server so TwiML/WebSocket URLs use the public hostname.
try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
$env:PUBLIC_BASE_URL = $publicUrl
Remove-Item $serverOut,$serverErr -ErrorAction SilentlyContinue
$server = Start-Process -FilePath 'node' -ArgumentList @('dist/src/inbound-validation-server.js') -WorkingDirectory (Join-Path $PSScriptRoot '..') -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

$publicHealthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "$publicUrl/health" -Method Get -TimeoutSec 5
    if ($health.ok) { $publicHealthy = $true; break }
  } catch {}
  if ($server.HasExited) { throw "Server exited after public URL restart. Error: $(Get-Content $serverErr -Raw)" }
}
if (-not $publicHealthy) {
  $tunnelLog = ''
  if (Test-Path $tunnelErr) { $tunnelLog += (Get-Content $tunnelErr -Raw) }
  throw "Public endpoint did not become healthy. Server error: $(Get-Content $serverErr -Raw -ErrorAction SilentlyContinue) Tunnel log: $tunnelLog"
}

$twimlUrl = "$publicUrl/voice/inbound"
Write-Host "`nREADY FOR TWILIO SANDBOX TEST" -ForegroundColor Green
Write-Host "Paste this exact value into Twilio > Custom > TwiML URL:" -ForegroundColor Cyan
Write-Host $twimlUrl -ForegroundColor Yellow
Write-Host "`nThen click Start call in Twilio. Keep this PowerShell window open during the call." -ForegroundColor Cyan
Write-Host 'Expected greeting: Hi, welcome to the Demo Dental Hospital AI front desk. How can I help you today?' -ForegroundColor DarkGray
Write-Host 'Test normal dental questions, interruptions, accent/topic changes, and a clinical question that should trigger human handoff.' -ForegroundColor Cyan
Write-Host "`nPress ENTER only after you finish testing. This stops the local server and tunnel." -ForegroundColor Yellow
[void](Read-Host)

try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
try { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}
$env:SARVAM_API_KEY = $null
Write-Host 'Sandbox validation runtime stopped.' -ForegroundColor Green
