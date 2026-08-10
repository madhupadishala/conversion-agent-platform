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

Write-Host "=== Conversion Agent - Web Dental Demo ===" -ForegroundColor Cyan
Write-Host "No Twilio, Razorpay or Google Calendar credentials are required for this vertical slice." -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required but node was not found in PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required but npm was not found in PATH.' }

$sarvamKey = Read-PlainSecret 'Sarvam API subscription key'
$port = Get-FreeTcpPort
$env:SARVAM_API_KEY = $sarvamKey
$env:SARVAM_CHAT_MODEL = 'sarvam-105b'
$env:TEST_TENANT_ID = 'demo-dental-hospital'
$env:PORT = [string]$port
$env:TENANT_CONFIG_JSON = Get-Content (Join-Path $PSScriptRoot '..\config\dental-demo.json') -Raw

Write-Host 'Installing/building...' -ForegroundColor Yellow
npm install
npm run build

$serverOut = Join-Path $env:TEMP 'conversion-agent-web-demo.out.log'
$serverErr = Join-Path $env:TEMP 'conversion-agent-web-demo.err.log'
Remove-Item $serverOut,$serverErr -ErrorAction SilentlyContinue

$server = Start-Process -FilePath 'node' -ArgumentList @('dist/src/web-demo-server.js') -WorkingDirectory (Join-Path $PSScriptRoot '..') -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

$baseUrl = "http://127.0.0.1:$port"
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 3
    if ($health.ok) { $healthy = $true; break }
  } catch {}
  if ($server.HasExited) { throw "Web demo server exited early. Error: $(Get-Content $serverErr -Raw -ErrorAction SilentlyContinue)" }
}
if (-not $healthy) { throw "Web demo did not become healthy. Error: $(Get-Content $serverErr -Raw -ErrorAction SilentlyContinue)" }

Write-Host "`nWEB CONVERSION DEMO READY" -ForegroundColor Green
Write-Host $baseUrl -ForegroundColor Yellow
Write-Host "Opening it in your default browser..." -ForegroundColor Cyan
Start-Process $baseUrl
Write-Host "`nComplete this flow: enquiry -> qualification -> slots -> simulated INR 100 payment -> CONFIRMED." -ForegroundColor Cyan
Write-Host "Also test a clinical question; it must move to HUMAN_HANDOFF rather than provide advice." -ForegroundColor DarkGray
Write-Host "`nPress ENTER here only when you are finished testing. This will stop the demo server." -ForegroundColor Yellow
[void](Read-Host)

try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
$env:SARVAM_API_KEY = $null
Write-Host 'Web demo stopped.' -ForegroundColor Green
