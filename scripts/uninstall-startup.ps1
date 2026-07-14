$ErrorActionPreference = 'Stop'

$startupFolder = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $startupFolder 'TradingWorkflow.cmd'
$legacyLauncherPath = Join-Path $startupFolder 'TradingTrader.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'TradingWorkflow'

if (Test-Path $launcherPath) {
  Remove-Item $launcherPath -Force
  Write-Host "Removed startup launcher: $launcherPath"
} else {
  Write-Host "No startup launcher found: $launcherPath"
}
if (Test-Path $legacyLauncherPath) {
  Remove-Item -LiteralPath $legacyLauncherPath -Force
  Write-Host "Removed legacy startup launcher: $legacyLauncherPath"
}
if (Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -LiteralPath $runKey -Name $runName -Force
  Write-Host "Removed per-user startup Run entry: $runName"
}
