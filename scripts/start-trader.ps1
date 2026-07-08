$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Import-EnvFile {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) {
      return
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($value.StartsWith("'") -and $value.EndsWith("'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    Set-Item -Path "Env:$name" -Value $value
  }
}

Import-EnvFile (Join-Path $repoRoot '.env')
Import-EnvFile (Join-Path $repoRoot '.env.local')

$logDir = Join-Path $repoRoot 'data\logs'
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$logPath = Join-Path $logDir 'trader-startup.log'
Start-Transcript -Path $logPath -Append | Out-Null
try {
  Write-Host "Starting trader from $repoRoot"
  Write-Host "Writing startup transcript to $logPath"
  node src/trader-cli.js
} finally {
  Stop-Transcript | Out-Null
}
