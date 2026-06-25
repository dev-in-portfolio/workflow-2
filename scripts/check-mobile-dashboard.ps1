param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Resolve-TailscaleExePath {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }
  $fallback = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path $fallback) {
    return $fallback
  }
  return $null
}

function Get-DashboardRuntimeState {
  $statePath = Join-Path $repoRoot 'data\runtime\dashboard-runtime.json'
  if (-not (Test-Path $statePath)) {
    return $null
  }
  try {
    return Get-Content -Raw -Path $statePath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-JsonIntProperty {
  param(
    [object]$Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return 0
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return 0
  }

  $value = 0
  if ([int]::TryParse([string]$property.Value, [ref]$value) -and $value -gt 0) {
    return $value
  }
  return 0
}

function Resolve-ConfiguredDashboardPort {
  if ($Port -gt 0) { return $Port }
  $runtime = Get-DashboardRuntimeState
  foreach ($candidate in @(
    (Get-JsonIntProperty -Object $runtime -Name 'dashboard_port'),
    (Get-JsonIntProperty -Object $runtime -Name 'preferred_port')
  )) {
    if ($candidate -gt 0) { return $candidate }
  }
  foreach ($name in @('TRADER_DASHBOARD_PORT', 'DASHBOARD_PORT')) {
    $raw = [Environment]::GetEnvironmentVariable($name)
    if ($raw) {
      $value = 0
      if ([int]::TryParse($raw, [ref]$value) -and $value -gt 0) {
        return $value
      }
    }
  }
  return 1111
}

function Resolve-ResponsiveDashboardPort {
  param([int]$ConfiguredPort)

  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $candidates = New-Object 'System.Collections.Generic.List[int]'

  foreach ($seed in @($ConfiguredPort, 1111)) {
    if ($seed -gt 0 -and $seen.Add($seed)) {
      $candidates.Add($seed)
    }
    for ($offset = 1; $offset -lt 25; $offset++) {
      $candidate = $seed + $offset
      if ($candidate -gt 0 -and $seen.Add($candidate)) {
        $candidates.Add($candidate)
      }
    }
  }

  foreach ($candidate in $candidates) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/api/health" -Method Get -TimeoutSec 2
      if ($health.status) {
        return $candidate
      }
    } catch {
      continue
    }
  }

  return $ConfiguredPort
}

$configuredPort = Resolve-ConfiguredDashboardPort
$resolvedPort = Resolve-ResponsiveDashboardPort -ConfiguredPort $configuredPort
$healthUrl = "http://127.0.0.1:$resolvedPort/api/health"
$snapshotUrl = "http://127.0.0.1:$resolvedPort/api/snapshot"

Write-Host "Checking dashboard on port $resolvedPort"
try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
  Write-Host "Local dashboard: OK ($($health.status))"
} catch {
  Write-Host "Local dashboard: not reachable"
}

$tailscaleExe = Resolve-TailscaleExePath
if ($tailscaleExe) {
  Write-Host "Tailscale CLI: OK"
  try {
    $status = & $tailscaleExe status --json 2>$null
    if ($status) {
      Write-Host 'Tailscale status: available'
    } else {
      Write-Warning 'Tailscale status returned no data.'
    }
  } catch {
    Write-Warning "Tailscale status unavailable: $($_.Exception.Message)"
  }
  try {
    $serveStatus = & $tailscaleExe serve status 2>$null
    if ($serveStatus -and ($serveStatus -notmatch 'No serve config')) {
      Write-Host 'Serve status: available'
    } else {
      Write-Warning 'Serve status: no serve config yet. Run the serve helper and approve the enable link once if prompted.'
    }
  } catch {
    Write-Warning "Serve status unavailable: $($_.Exception.Message)"
  }
} else {
  Write-Warning 'Tailscale CLI not found on PATH.'
}

try {
  $snapshot = Invoke-RestMethod -Uri $snapshotUrl -Method Get -TimeoutSec 5
  Write-Host "Snapshot: OK at $($snapshot.timestamp)"
} catch {
  Write-Warning "Snapshot check failed: $($_.Exception.Message)"
}

Write-Host ''
Write-Host "Serve command:"
Write-Host "  tailscale serve --bg $resolvedPort"
Write-Host "Status command:"
Write-Host "  tailscale serve status"
Write-Host "Reset command:"
Write-Host "  tailscale serve reset"
