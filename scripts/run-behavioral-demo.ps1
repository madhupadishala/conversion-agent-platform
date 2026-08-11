$ErrorActionPreference='Stop'
$port=3210
while(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){$port++}
$env:PORT="$port"
Write-Host "Starting behavioral appointment inventory demo on port $port..."
$proc=Start-Process node -ArgumentList ".\scripts\behavioral-demo-server.mjs" -PassThru -NoNewWindow
Start-Sleep -Seconds 1
$url="http://127.0.0.1:$port"
Start-Process $url
Write-Host "Demo opened: $url"
Write-Host "Press ENTER to stop."
Read-Host | Out-Null
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue