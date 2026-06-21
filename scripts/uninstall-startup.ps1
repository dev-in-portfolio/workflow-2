$ErrorActionPreference = 'Stop'

$startupFolder = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $startupFolder 'TradingTrader.cmd'

if (Test-Path $launcherPath) {
  Remove-Item $launcherPath -Force
  Write-Host "Removed startup launcher: $launcherPath"
} else {
  Write-Host "No startup launcher found: $launcherPath"
}
