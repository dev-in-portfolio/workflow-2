$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$taskPrefix = 'Live Market Workflow'
$scriptPath = Join-Path $repoRoot 'scripts\live-market-daily-start-stop.ps1'

$startAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Action start"
$stopAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Action stop"

$weekdayTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 8:30AM
$weekdayTriggerStop = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:15PM

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "$taskPrefix Daily Start" -Action $startAction -Trigger $weekdayTrigger -Principal $principal -Settings $settings -Description 'Starts the live-market workflow at 8:30 AM ET on market weekdays.'
Register-ScheduledTask -TaskName "$taskPrefix Daily Stop" -Action $stopAction -Trigger $weekdayTriggerStop -Principal $principal -Settings $settings -Description 'Stops the live-market workflow at 4:15 PM ET on market weekdays.'

Write-Host "Registered scheduled tasks for the live-market workflow."
