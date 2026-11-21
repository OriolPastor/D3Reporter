# D3Reporter — Unified Disguise Monitor

Web-based monitoring dashboard for [Disguise](https://disguise.one) (d3) render networks. It displays the live timeline, transport state, and health metrics of the Director and all Actors, and exposes a single `status.json` for external alerting (OpenClaw → Telegram).

## Features

- **Live timeline** — playhead position, active layers (name + asset path), per-track details (start, end, duration, asset)
- **Transport controls** — play / stop / seek, section and track navigation, loop
- **Health metrics** — Director + Actors: FPS, GPU load (compositor / GUI / render), CPU time, process & GPU memory, disk I/O
- **Metrics dashboard** — real-time charts (ECharts) with configurable warning/critical thresholds
- **Alerting** — threshold-based alerts with webhook delivery and per-metric cooldown; the [Pulse plugin](https://github.com/disguise-one) is the reference for metrics and alerting (`disguise-examples/Pulse/`)
- **`status.json`** — single file with all server health + timeline data, consumed by OpenClaw for Telegram alerts

## Architecture

```
┌─────────────┐  LiveUpdate WS (direct)   ┌──────────────────┐
│   Browser   │ ────────────────────────► │   Disguise       │
│   (Vue 3)   │                           │   Director       │
└──────┬──────┘                           └────────┬─────────┘
       │ HTTP :3000                                │ WS (separate connection)
┌──────▼─────────────────────────────┐             │
│  Node.js / Express backend         │ ◄───────────┘
│  • serves frontend/dist            │
│  • REST API (/api/*)               │
│  • writes status.json              │
└──────┬─────────────────────────────┘
       │ reads status.json
┌──────▼──────┐
│   OpenClaw  │ ──► Telegram alerts
└─────────────┘
```

**No WebSocket proxy** — the browser connects directly to the Director's LiveUpdate WebSocket. The backend keeps its own, separate connection only to collect health metrics and timeline data.

## Requirements

- Node.js (backend + frontend build)
- Python 3 (optional, helper scripts only)
- Network access to a Disguise Director (host + port)

## Setup

```bash
# 1. Install backend dependencies
npm install

# 2. Install frontend dependencies
cd frontend && npm install && cd ..

# 3. Configure the Director connection (file is gitignored)
echo "DIRECTOR_HOST=<director-ip>" > .env.local
echo "DIRECTOR_PORT=80" >> .env.local

# 4. Build the frontend (also generates frontend/.env from .env.local)
npm run build

# 5. Start the server
npm start            # or: npm run dev  (nodemon, auto-reload)
```

Open `http://<server-ip>:3000` in a browser.

### Configuration

Both frontend and backend read the same `.env.local` — never hardcode IPs.

| Variable        | Description                              | Default     |
| --------------- | ---------------------------------------- | ----------- |
| `DIRECTOR_HOST` | IP/hostname of the Disguise Director     | `localhost` |
| `DIRECTOR_PORT` | Director LiveUpdate port                 | `80`        |

> **WSL2 note:** mDNS discovery does not work reliably in WSL2 — use a fixed IP in `.env.local`. `scripts/discover_director.py` is provided to find the Director IP from a normal network host.

## Project structure

```
├── scripts/
│   ├── websocket_service.js   # Backend: Express server + Director WS collector
│   ├── alert.py               # Alert helper (stdout only)
│   ├── discover_director.py   # mDNS/DNS-SD discovery helper
│   ├── api_reference.md       # API reference notes
│   └── build-frontend.sh      # Generates frontend/.env from .env.local
├── frontend/
│   ├── src/
│   │   ├── views/MetricsView.vue      # Metrics dashboard (charts)
│   │   ├── components/                # TrackDetail, Timeline, transport, charts
│   │   ├── composables/usePlayhead.js
│   │   └── stores/liveUpdateStore.js  # Direct LiveUpdate WS connection
│   └── dist/                          # Built frontend (served by backend)
├── disguise-examples/             # Read-only reference plugins (Pulse, D3TrackReporter)
├── alert-config.example.json      # Alert threshold template (copy to alert-config.json)
├── status.json                    # Generated: health + timeline (gitignored)
└── .env.local                     # Director connection (gitignored)
```

## REST API

All endpoints are served by the backend on port `3000`.

| Endpoint                     | Method | Description                                  |
| ---------------------------- | ------ | -------------------------------------------- |
| `/api/status`                | GET    | Full `status.json` (health + timeline)       |
| `/api/health`                | GET    | Director + Actor health                      |
| `/api/timeline`              | GET    | Playhead, active layers, track layers        |
| `/api/timeline/active`       | GET    | Currently active layers                      |
| `/api/timeline/sections`     | GET    | Timeline sections                            |
| `/api/play` · `/api/stop` · `/api/seek` | POST | Basic transport control               |
| `/api/play-section` · `/api/loop-section` · `/api/return-start` | POST | Section transport |
| `/api/next-section` · `/api/prev-section` | POST | Section navigation                 |
| `/api/next-track` · `/api/prev-track`   | POST | Track navigation                        |
| `/api/transport/status`      | GET    | Transport status                             |
| `/api/transport/activetransport` | GET | Active transport                        |
| `/api/transport/gototime`    | POST   | Seek to a timecode                           |
| `/api/alerts`                | GET/POST | Get / update alert config                   |
| `/api/alerts/config`         | GET    | Alert configuration                          |
| `/api/alerts/modify`         | POST   | Modify alert thresholds                      |
| `/api/alerts/send`           | POST   | Send webhook alert (cooldown + state guards) |
| `/api/alerts/webhook`        | POST   | Configure webhook URL/chat                   |
| `/api/alerts/webhook/toggle` | POST   | Enable/disable webhook                       |
| `/api/alerts/reset`          | POST   | Reset alert state                            |

## `status.json`

Single generated file (gitignored) containing everything external consumers need:

| Section    | Fields                                                        |
| ---------- | ------------------------------------------------------------- |
| `metrics`  | `director`, `actors` — per-server FPS, GPU, CPU, memory, disk |
| `health`   | `director`, `msi` — server health status                      |
| `transport`| `playing`, `isLooping`                                        |
| `timeline` | `playhead`, `playing`, `activeLayers`, `trackLayers`          |

## Alerting

- Thresholds (warning/critical per metric) live in `alert-config.json` — start from `alert-config.example.json`.
- Webhook delivery is the only send path, guarded by a state-transition check and a per-metric cooldown (no duplicate alerts).
- The **Pulse plugin** (`disguise-examples/Pulse/`) is the reference implementation for metrics and alerting.
- OpenClaw reads `status.json` and sends Telegram alerts based on Pulse reports.

## Helper scripts

```bash
# Discover Director/Actor IPs on the network (run from a host with mDNS access)
pip install -r requirements.txt
python scripts/discover_director.py
```
