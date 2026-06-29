Write-Host "╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   ELITE SNIPER - Auto Restart Mode    ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

while ($true) {
    $t = Get-Date -Format 'HH:mm:ss'
    Write-Host "[$t] Starting server..." -ForegroundColor Green
    node index.js
    $t2 = Get-Date -Format 'HH:mm:ss'
    Write-Host ""
    Write-Host "[$t2] Server stopped. Restarting in 3 seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}
