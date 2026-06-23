$ErrorActionPreference = 'Stop'

Unregister-ScheduledTask -TaskName 'Live Market Workflow Daily Start' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Live Market Workflow Daily Stop' -Confirm:$false -ErrorAction SilentlyContinue

Write-Host 'Removed scheduled tasks for the live-market workflow.'
