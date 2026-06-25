param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ($Port -gt 0) {
  $env:TRADER_DASHBOARD_PORT = "$Port"
}

Write-Host "Starting local dashboard from $repoRoot"
if ($Port -gt 0) {
  Write-Host "Using TRADER_DASHBOARD_PORT=$Port"
}

& npm.cmd run dashboard
