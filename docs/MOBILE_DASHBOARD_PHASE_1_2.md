# Mobile Dashboard Phase 1 and 2

This repo already runs a local dashboard on the laptop. The goal here is to make that same dashboard reachable privately from your phone/tablet through Tailscale, then make the UI installable as a PWA.

Do not use Tailscale Funnel for this phase.

## What runs locally

- Dashboard default port: `1111`
- Optional override: `TRADER_DASHBOARD_PORT`
- Dashboard launcher: `npm run dashboard`
- Local check helper: `powershell -ExecutionPolicy Bypass -File scripts/check-mobile-dashboard.ps1`

## Phase 1. Private Tailscale access

### 1. Install and sign in to Tailscale on the laptop

1. Install Tailscale on the laptop if it is not already installed.
2. Sign in on the laptop with the same Tailscale account that your phone and tablet use.
3. Confirm the laptop shows as connected in the Tailscale client.

### 2. Confirm the phone/tablet is on the same tailnet

1. Open Tailscale on the phone/tablet.
2. Confirm it is signed into the same tailnet/account as the laptop.
3. Keep Tailscale connected while you use the dashboard.

### 3. Start the trading bot on the laptop

```powershell
npm start
```

If you already use a different start command for the live workflow, keep using that exact command.

### 4. Start the dashboard locally

```powershell
npm run dashboard
```

If you want a specific dashboard port:

```powershell
$env:TRADER_DASHBOARD_PORT = "1111"
npm run dashboard
```

Or use the helper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-dashboard.ps1
```

### 5. Confirm the dashboard works locally

Open the local URL shown by the launcher, usually:

```text
http://127.0.0.1:1111
```

Optional local check:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-dashboard.ps1
```

### 6. Serve the dashboard privately through Tailscale

Use Tailscale Serve against the local dashboard port:

```powershell
tailscale serve --bg 1111
```

If the dashboard is on a different port, replace `1111` with that port.
The launcher also writes the resolved port to `data/runtime/dashboard-runtime.json`, and the helper scripts read that file first so they stay aligned with the actual running dashboard.
If Tailscale prints a one-time enable link, open it in the laptop browser and approve Serve for this tailnet once.

You can also use the helper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/serve-dashboard-tailscale.ps1
```

### 7. Copy the Tailscale URL

When Serve starts, Tailscale prints a private `https://*.ts.net` URL.

- Copy that URL from the terminal output.
- Open that URL on the phone/tablet while it is connected to Tailscale.

### 8. Stop or reset Serve

Stop the active Serve mapping:

```powershell
tailscale serve off
```

Reset all Serve config on the device:

```powershell
tailscale serve reset
```

The helper also supports `-Off` and `-Reset`.

## Phase 2. Mobile PWA

### What the dashboard now does

- Uses a mobile-first layout that keeps the top trading state readable on phone widths.
- Shows heartbeat and freshness state so stale data does not look live.
- Includes a web manifest and install hint.
- Registers a service worker that only caches the app shell, not live trading data.

### Install on Android

1. Open the private Tailscale dashboard URL in Chrome on the phone/tablet.
2. Wait for the browser install prompt if it appears.
3. If it does not appear, use the browser menu and choose:
   - `Add to Home screen`
   - or `Install app`

### What is cached

Only static shell assets are cached:

- HTML shell
- CSS
- dashboard JS files
- icons
- manifest

The service worker does not cache:

- `/api` responses
- broker/account data
- positions
- orders
- scanner results
- logs

## Troubleshooting

- Wrong Tailscale account: sign out and back in on the device that is wrong.
- Laptop asleep: wake the laptop and reconnect Tailscale if needed.
- Dashboard not running: start the dashboard locally before running `tailscale serve`.
- Wrong port: confirm `TRADER_DASHBOARD_PORT` or `DASHBOARD_PORT`, then use that port in the Serve command.
- Firewall issue: keep the dashboard bound to `127.0.0.1`; do not open router forwarding for this setup.
- Tailscale disconnected: reconnect the laptop or phone/tablet in the Tailscale client.
- Stale dashboard heartbeat: refresh the page and confirm the local dashboard process is still alive.
- Phone/tablet not on same tailnet: log both devices into the same Tailscale account.

## Strong warning

Do not use Tailscale Funnel for this phase. Funnel exposes services publicly; this phase is private tailnet access only.
