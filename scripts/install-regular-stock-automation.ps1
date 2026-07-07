$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$taskPrefix = 'Regular Stock Workflow'
$scriptPath = Join-Path $repoRoot 'scripts\regular-stock-daily-start-stop.ps1'

$startAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Action start"
$stopAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Action stop"

$weekdayTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 5:00AM
$weekdayTriggerStop = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 5:00PM

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "$taskPrefix Daily Start" -Action $startAction -Trigger $weekdayTrigger -Principal $principal -Settings $settings -Description 'Starts the regular stock workflow at 5:00 AM ET on market weekdays.'
Register-ScheduledTask -TaskName "$taskPrefix Daily Stop" -Action $stopAction -Trigger $weekdayTriggerStop -Principal $principal -Settings $settings -Description 'Stops the regular stock workflow at 5:00 PM ET on market weekdays.'

$startTask = Get-ScheduledTask -TaskName "$taskPrefix Daily Start"
$stopTask = Get-ScheduledTask -TaskName "$taskPrefix Daily Stop"
Write-Host "Registered scheduled tasks for the regular stock workflow."
Write-Host "Start task: $($startTask.TaskName) -> $scriptPath @ 5:00 AM weekdays"
Write-Host "Stop task: $($stopTask.TaskName) -> $scriptPath @ 5:00 PM weekdays"
