# Design: ops-prod-supervision

## Technical Approach
Replace `nohup`-managed PID 1579425 (user `dani`) with a systemd unit at `/etc/systemd/system/whatsapp-bot.service` for auto-restart on crash and auto-start on reboot. Logs go to journald (built-in rotation). Pure ops/infra — no `src/*.js` changes.

## Architecture Decisions

### Decision: Supervisor = systemd unit, NOT pm2
**Choice**: Unit with `User=dani`, `Restart=always`, `RestartSec=5`, `EnvironmentFile=/home/dani/whatsapp-stripe-bot/.env`, `WorkingDirectory=/home/dani/whatsapp-stripe-bot`, `ExecStart=/usr/bin/env node src/index.js`, `WantedBy=multi-user.target`.

| Option | Tradeoff | Decision |
|---|---|---|
| pm2 (`ecosystem.config.js`) | Node-native; but `pm2-root.service` runs as `root` (exposes `.env`), `pm2` not on `$PATH` (nvm global), adds abstraction over systemd we already own, requires `pm2 save`/`resurrect`. `devDependencies` placement = dev-only intent. | Reject |
| `nohup` + cron `@reboot` | No crash-loop protection, no rotation — doesn't solve the problem. | Reject |
| Docker + compose | Container for one Node process on a single VPS = overkill. | Reject |
| **systemd unit** | Zero new deps; matches nginx/certbot pattern on this host; runs as `dani`; journald rotation; `engram.service` proves the template. | **Accept** |

**Rationale**: (1) Least privilege — bot runs as `dani` under nohup; pm2 daemon runs as `root` and would re-escalate. systemd pins `User=dani` cleanly. (2) Consistency — VPS already runs nginx + certbot under systemd. (3) Observability — `journalctl -u whatsapp-bot -f` is one command. (4) Reversibility covered by proposal.

### Decision: Logs via journald, no separate file
**Choice**: `StandardOutput=journal`, `StandardError=journal`.
**Rationale**: journald rotates by size+time, indexes by unit, already running. A separate file duplicates storage and rotation.

### Decision: `package.json` scripts untouched
**Choice**: Keep `start: node src/index.js` as-is.
**Rationale**: Operators use `systemctl`/`journalctl`, not `npm`. Supervisor-shaped scripts muddy deploy surface.

## Data Flow

**Boot**: kernel → systemd → `multi-user.target` → `whatsapp-bot.service` (WantedBy) → `ExecStart=/usr/bin/env node src/index.js` with `WorkingDirectory=/home/dani/whatsapp-stripe-bot`, `EnvironmentFile=...env`, `User=dani` → bind `:PORT` (default 3000).

**Crash recovery**: node dies → systemd detects empty cgroup → wait `RestartSec=5` → re-run SAME `ExecStart` → fresh node reads `.env`, binds :3000 → journald records restart. Worst case: 5s.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `/etc/systemd/system/whatsapp-bot.service` | Create (deployed, `sudo tee`) | Unit per Decision 1. Root-only path. |
| `openspec/changes/ops-prod-supervision/design.md` | Create | This file. |
| `/tmp/whatsapp-bot.log` | Becomes stale | nohup stops writing; manual `rm` after cut-over. |
| `package.json`, `src/index.js` | NOT modified | Out of scope. |
| `~/.pm2` | Untouched | `pm2-root.service` stays; we just don't register our app. |

No repo files modified except the design doc → minimal PR surface.

## Interfaces / Contracts

- Service: `whatsapp-bot.service`; User: `dani` (uid 1001, must own repo + `r` on `.env`); Port: 3000 or `PORT` from `.env`; Restart: `always` / 5s; Boot: `systemctl enable whatsapp-bot`.
- Ops: `systemctl {status,restart} whatsapp-bot`; `sudo journalctl -u whatsapp-bot [-f | --since "1 hour ago"]`.

## Testing Strategy

`strict_tdd: false` in `openspec/config.yaml` — no test runner. Verification by direct command.

| Check | Command | Pass |
|---|---|---|
| Syntax | `node --check src/index.js` | exit 0 |
| Perms | `sudo -u dani test -r .env` | exit 0 |
| Crash recovery | `sudo kill -9 $(pgrep -f "node src/index.js" -u dani) && sleep 6 && systemctl is-active whatsapp-bot` | `active` |
| Reboot recovery | `sudo reboot` → `curl -fsS http://127.0.0.1:3000/health` | 200 |
| Log dest | `sudo journalctl -u whatsapp-bot -n 5` | lines; no `/tmp/whatsapp-bot.log` growth |
| nohup gone | `pgrep -af "nohup\|node src/index.js"` (as `dani`) | empty after cut-over |
| Rollback dry-run | `disable --now` + `rm` unit + `daemon-reload` + `nohup` | bot back under nohup |

## Threat Matrix

Process-integration — applicable for subprocess/restart boundary. Generic rows are N/A.

| Boundary | Applicability | Design response |
|---|---|---|
| Documentation-like paths (`*.sh`, exec docs) | N/A — change creates none. | — |
| Git selection / commit / push / PR | N/A — no VCS automation. | — |
| **Subprocess execution** | Applicable | `ExecStart=/usr/bin/env node src/index.js` (absolute interpreter); `WorkingDirectory` + `EnvironmentFile` pinned; `User=dani` non-root. `Restart=always` re-runs SAME `ExecStart` only — no arbitrary commands. |
| **Restart semantics** | Applicable | `RestartSec=5` bounds crash-loop CPU. systemd default `StartLimitBurst=5/StartLimitIntervalSec=10s` prevents infinite storms. No alerting yet (deferred `ops-observability-and-alerting`). |

## Migration / Rollout

Single-shot cut-over, low-traffic window (operator's call):

1. Pre-flight: `node --check src/index.js`; `sudo -u dani test -r .env`; `ss -ltnp | grep :3000` confirms PID 1579425.
2. `sudo tee /etc/systemd/system/whatsapp-bot.service` (per Decision 1); `daemon-reload`.
3. `sudo systemctl enable whatsapp-bot`.
4. Stop nohup: `sudo kill 1579425 && sleep 6`.
5. `sudo systemctl start whatsapp-bot` → verify `active (running)`, new pid.
6. Smoke: `curl -fsS http://127.0.0.1:3000/health` → 200; `journalctl -u whatsapp-bot -n 20` → banner.
7. Crash test: `kill -9 $(pgrep -f "node src/index.js" -u dani)`; `sleep 6`; `is-active` → `active`.
8. `rm /tmp/whatsapp-bot.log`; update runbook (replace nohup with `systemctl`/`journalctl` commands).

Total downtime: ~10s.

## Open Questions
None.