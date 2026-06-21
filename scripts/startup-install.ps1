$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$startupFolder = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $startupFolder 'TradingTrader.cmd'
$scriptPath = Join-Path $repoRoot 'scripts\start-trader.ps1'

$launcherContent = "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"$scriptPath`"`r`n"

Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII
Write-Host "Created startup launcher: $launcherPath"
