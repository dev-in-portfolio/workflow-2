param(
  [int]$Port = 0,
  [switch]$Reset,
  [switch]$Off,
  [switch]$Status
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

function Resolve-DashboardPort {
  param([int[]]$SeedPorts)

  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $candidates = New-Object 'System.Collections.Generic.List[int]'

  foreach ($seed in $SeedPorts) {
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
    $healthUrl = "http://127.0.0.1:$candidate/api/health"
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
      if ($health.status) {
        return $candidate
      }
    } catch {
      continue
    }
  }

  throw "Unable to find a responsive dashboard port. Checked: $($candidates -join ', ')"
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

$configuredPort = Resolve-ConfiguredDashboardPort
$resolvedPort = Resolve-DashboardPort -SeedPorts @($configuredPort, 1111)
$tailscaleExe = Resolve-TailscaleExePath
if (-not $tailscaleExe) {
  throw 'Tailscale CLI was not found on PATH.'
}

if ($Status) {
  & $tailscaleExe serve status
  exit $LASTEXITCODE
}

if ($Reset) {
  & $tailscaleExe serve reset
  exit $LASTEXITCODE
}

$healthUrl = "http://127.0.0.1:$resolvedPort/api/health"
try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
  Write-Host "Dashboard is responding locally on port $resolvedPort ($($health.status))."
} catch {
  Write-Warning "Dashboard did not respond on $healthUrl. Start it first with scripts\start-mobile-dashboard.ps1"
  throw
}

if ($Off) {
  Write-Host 'Running: tailscale serve off'
  & $tailscaleExe serve off
  exit $LASTEXITCODE
}

function Read-OutputFileText {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return ''
  }
  try {
    return Get-Content -Raw -Path $Path
  } catch {
    return ''
  }
}

$stdoutPath = Join-Path $env:TEMP 'tailscale-serve-stdout.txt'
$stderrPath = Join-Path $env:TEMP 'tailscale-serve-stderr.txt'
Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue

Write-Host "Starting: tailscale serve --bg --yes $resolvedPort"
$serveProcess = Start-Process -FilePath $tailscaleExe -ArgumentList @('serve', '--bg', '--yes', "$resolvedPort") -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$deadline = (Get-Date).AddSeconds(20)
$served = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  $stdoutText = Read-OutputFileText -Path $stdoutPath
  $stderrText = Read-OutputFileText -Path $stderrPath
  if ($stdoutText -match 'Serve is not enabled on your tailnet') {
    $enableUrl = $null
    if ($stdoutText -match '(https://login\.tailscale\.com/\S+)') {
      $enableUrl = $Matches[1].TrimEnd(')', '.', ',', '"')
    }
    if ($serveProcess -and -not $serveProcess.HasExited) {
      try { Stop-Process -Id $serveProcess.Id -Force } catch {}
    }
    Write-Warning 'Tailscale Serve is not enabled on this tailnet yet.'
    if ($enableUrl) {
      Write-Host "Open this one-time enable link in a browser on the laptop:"
      Write-Host "  $enableUrl"
    }
    if ($stderrText) {
      Write-Host $stderrText
    }
    exit 1
  }
  $statusText = & $tailscaleExe serve status 2>$null
  if ($statusText -and ($statusText -notmatch 'No serve config')) {
    $served = $true
    break
  }
  if ($serveProcess.HasExited) {
    break
  }
}

if (-not $served) {
  $stdoutText = Read-OutputFileText -Path $stdoutPath
  $stderrText = Read-OutputFileText -Path $stderrPath
  if ($stdoutText) { Write-Host $stdoutText.Trim() }
  if ($stderrText) { Write-Host $stderrText.Trim() }
}

$finalStatus = & $tailscaleExe serve status 2>$null
if (-not $finalStatus -or $finalStatus -match 'No serve config') {
  throw 'Tailscale Serve did not come online. If the tailnet enable link was shown, approve it once and rerun this script.'
}

Write-Host $finalStatus
