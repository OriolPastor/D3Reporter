# D3Reporter – Unified Disguise Monitor

## Project Goal
- Frontend (Vue) connects **directly** to the Disguise Director via WebSocket (using `DIRECTOR_HOST` and `DIRECTOR_PORT` from `.env.local`). Displays timeline, layers, assets, playhead.
- Backend (Node.js) serves static frontend files (`frontend/dist`) and REST endpoints `/api/status` (returns `status.json`) and `/api/timeline` (returns timeline data). It also connects **directly** to the same Director WebSocket (separate connection) to collect health metrics and timeline data. Writes a **single `status.json`** containing:
  - Health of all servers (Director + Actors).
  - Timeline data: playhead, active layers (name + asset path), track details (start, end, duration, asset).
- **Pulse Plugin is the reference** for metrics and alerting – use the example in `disguise-examples/Pulse/`.
- OpenClaw reads `status.json` to send Telegram alerts based on Pulse reports.

## Core Rules (highest priority)
- **CRITICAL – NO WEBSOCKET PROXY**: The backend must never re‑forward WebSocket messages. Frontend connects directly to Director.
- Backend must have an HTTP server (Express) that serves `frontend/dist` and the REST endpoints. It must listen on `0.0.0.0` and port `3000` (or the configured port).
- Both frontend and backend read the same `.env.local` (variables `DIRECTOR_HOST`, `DIRECTOR_PORT`). Never hardcode IPs. Never use mDNS in WSL2.
- The single `status.json` must include **all servers** (health) **and** timeline fields (playhead, active layers, track details).

## Reference Sources (use in this order)
1. Local examples (read‑only):
   - Frontend UI → `disguise-examples/D3TrackReporter/`
   - Pulse Plugin (metrics & alerting) → `disguise-examples/Pulse/`
2. Vault documentation (when examples are insufficient). All paths start with `/mnt/f/Obsidian/Disguise/`:
   - LiveUpdate WebSocket → `Disguise API/api/Session/liveupdate.md`
   - Transport REST API → `Disguise API/api/Session/transport.md`
   - General API indices → `Disguise API/` (Designer, Python, SMC, Plugins)

## Strict Rules (MUST FOLLOW)
1. No absolute Windows paths – use relative or WSL2 paths (`/mnt/...`).
2. Never hardcode IPs – use `.env.local`.
3. Never attempt mDNS in WSL2 – rely on fixed IP from `.env.local`.
4. Never modify `disguise-examples/` – read‑only reference.
5. `alert.py` prints only to stdout – no Telegram API calls.
6. `status.json` must contain all servers (health) AND timeline fields.
7. Alerts are handled by Pulse reports – no need for manual alert rules in `notes/ALERTS.md`.
8. Security rules for secrets are globally enforced (`~/.claude/settings.json`).

## Workflow Preferences
- Surgical changes, ask before creating files, test‑driven.
- Always follow Karpathy coding style (skill `karpathy-guidelines`) – this is non‑negotiable.

## Internal Links (for Claude)
- Karpathy skill → `.claude/skills/karpathy-guidelines/SKILL.md`
- Frontend reference → `disguise-examples/D3TrackReporter/`
- Pulse reference → `disguise-examples/Pulse/`
- Vault base → `/mnt/f/Obsidian/Disguise/`