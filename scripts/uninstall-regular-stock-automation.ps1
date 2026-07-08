$ErrorActionPreference = 'Stop'

Unregister-ScheduledTask -TaskName 'Regular Stock Workflow Daily Start' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Regular Stock Workflow Daily Stop' -Confirm:$false -ErrorAction SilentlyContinue

Write-Host 'Removed scheduled tasks for the regular stock workflow.'
