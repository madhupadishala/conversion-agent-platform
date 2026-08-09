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

Write-Host "=== Twilio inbound dental-agent validation ===" -ForegroundColor Cyan
Write-Host "You will call the Twilio trial number from your verified mobile." -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required but node was not found in PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required but npm was not found in PATH.' }

$accountSid = (Read-Host 'Twilio Account SID (AC...)').Trim()
$apiKeySid = (Read-Host 'Twilio API Key SID (SK...)').Trim()
$apiKeySecret = Read-PlainSecret 'Twilio API Key secret'
$fromNumber = ((Read-Host 'Twilio trial number (example +1737...)') -replace '\s','').Trim()
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

$tools = Join-Path $PSScriptRoot '..\.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$cloudflared = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
  Write-Host 'Downloading Cloudflare Tunnel client...' -ForegroundColor Yellow
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflared
}

$tunnelOut = Join-Path $env:TEMP 'conversion-agent-inbound-cloudflared.out.log'
$tunnelErr = Join-Path $env:TEMP 'conversion-agent-inbound-cloudflared.err.log'
Remove-Item $tunnelOut,$tunnelErr -ErrorAction SilentlyContinue
Write-Host 'Starting temporary public tunnel...' -ForegroundColor Yellow
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel','--url',"http://localhost:$port",'--no-autoupdate') -RedirectStandardError $tunnelErr -RedirectStandardOutput $tunnelOut -PassThru -WindowStyle Hidden

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
$env:PUBLIC_BASE_URL = $publicUrl
Write-Host "Public URL: $publicUrl" -ForegroundColor Green

$serverOut = Join-Path $env:TEMP 'conversion-agent-inbound-server.out.log'
$serverErr = Join-Path $env:TEMP 'conversion-agent-inbound-server.err.log'
Remove-Item $serverOut,$serverErr -ErrorAction SilentlyContinue
$server = Start-Process -FilePath 'node' -ArgumentList @('dist/src/inbound-validation-server.js') -WorkingDirectory (Join-Path $PSScriptRoot '..') -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

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

$authBytes = [Text.Encoding]::ASCII.GetBytes("${apiKeySid}:${apiKeySecret}")
$auth = [Convert]::ToBase64String($authBytes)
$headers = @{ Authorization = "Basic $auth" }
$listUri = "https://api.twilio.com/2010-04-01/Accounts/$accountSid/IncomingPhoneNumbers.json?PhoneNumber=$([uri]::EscapeDataString($fromNumber))"
Write-Host 'Locating Twilio trial number...' -ForegroundColor Yellow
$numbers = Invoke-RestMethod -Uri $listUri -Headers $headers -Method Get -TimeoutSec 30
$number = $numbers.incoming_phone_numbers | Where-Object { ($_.phone_number -replace '\s','') -eq $fromNumber } | Select-Object -First 1
if (-not $number) { throw "Could not find $fromNumber in this Twilio account." }

$voiceUrl = "$publicUrl/voice/inbound"
$updateUri = "https://api.twilio.com/2010-04-01/Accounts/$accountSid/IncomingPhoneNumbers/$($number.sid).json"
$updateBody = "VoiceUrl=$([uri]::EscapeDataString($voiceUrl))&VoiceMethod=POST"
Write-Host 'Routing Twilio trial number to the dental agent...' -ForegroundColor Yellow
Invoke-RestMethod -Uri $updateUri -Headers ($headers + @{ 'Content-Type'='application/x-www-form-urlencoded' }) -Method Post -Body $updateBody -TimeoutSec 30 | Out-Null

Write-Host "`nREADY FOR LIVE TEST" -ForegroundColor Green
Write-Host "From your verified mobile, call: $fromNumber" -ForegroundColor Cyan
Write-Host 'Twilio may play its trial-account announcement first. After that, the dental AI front desk should answer.' -ForegroundColor DarkGray
Write-Host 'Test normal dental questions, interruptions, accent, topic changes, and a clinical question that should trigger human handoff.' -ForegroundColor Cyan
Write-Host "`nPress ENTER only after you finish the call. This will stop the server and tunnel." -ForegroundColor Yellow
[void](Read-Host)

try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
try { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}
$env:SARVAM_API_KEY = $null
Write-Host 'Inbound validation runtime stopped.' -ForegroundColor Green
