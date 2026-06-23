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

Import-EnvFile (Join-Path $repoRoot '.env.local')
Import-EnvFile (Join-Path $repoRoot '.env')

$action = 'start'
for ($index = 0; $index -lt $args.Length; $index++) {
  if ($args[$index] -eq '-Action' -and ($index + 1) -lt $args.Length) {
    $action = $args[$index + 1]
    break
  }
  if ($args[$index] -match '^(start|stop)$') {
    $action = $args[$index]
    break
  }
}

node scripts/live-market-daily-start-stop.js $action
