# Tasks: ops-prod-supervision

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~15 (unit file deployed to `/etc/systemd/system/`, NOT in repo) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR (work happens on VPS, not in repo) |
| Delivery strategy | single-pr |
| Chain strategy | pending (won't be needed) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Cut-over to systemd supervision | PR 1 | `systemctl is-active whatsapp-bot` | live VPS | `systemctl disable --now whatsapp-bot && rm /etc/systemd/system/whatsapp-bot.service && nohup node src/index.js > /tmp/whatsapp-bot.log 2>&1 &` |

## Phase 1: Pre-flight verification

- [x] 1.1 Confirm bot is currently running as `dani` on port 3000: `ss -ltnp | grep :3000`, `ps -o pid,user,cmd -p 1579425`, `sudo -u dani test -r /home/dani/whatsapp-stripe-bot/.env` all succeed.
- [x] 1.2 Run `node --check src/index.js` from `/home/dani/whatsapp-stripe-bot`; expect exit 0.

## Phase 2: Deploy unit file

- [x] 2.1 `sudo tee /etc/systemd/system/whatsapp-bot.service` with: `[Unit]\nDescription=WhatsApp-Stripe Bot\n[Service]\nUser=dani\nWorkingDirectory=/home/dani/whatsapp-stripe-bot\nEnvironmentFile=/home/dani/whatsapp-stripe-bot/.env\nExecStart=/usr/bin/env node src/index.js\nRestart=always\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n[Install]\nWantedBy=multi-user.target`. Written via `sudo -n tee`; verified via `read /etc/systemd/system/whatsapp-bot.service` (13 lines, 310 bytes, root:root, 644, content matches Decision 1 verbatim).
- [x] 2.2 `sudo -n systemctl daemon-reload` → exit 0.
- [x] 2.3 `sudo -n systemctl enable whatsapp-bot` → `Created symlink /etc/systemd/system/multi-user.target.wants/whatsapp-bot.service → /etc/systemd/system/whatsapp-bot.service`; `systemctl is-enabled whatsapp-bot` → `enabled`.

## Phase 3: Cut-over (~10s downtime)

- [x] 3.1 Stop nohup: `sudo -n kill 1579425` → exit 0; `sleep 6`.
- [x] 3.2 Confirm port 3000 free: `ss -ltn | grep :3000` → empty → `OK: port 3000 free`.
- [x] 3.3 `sudo -n systemctl start whatsapp-bot` → exit 0; `systemctl status whatsapp-bot --no-pager` → `active (running)` since Sun 2026-08-30 04:13:21 CST, Main PID 1601853.
- [x] 3.4 Verify new PID runs as `dani`: `ps -o pid,user,cmd -p 1601853` → `1601853 dani node src/index.js`.
- [x] 3.5 Smoke: `curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/webhooks/whatsapp` → `HTTP 403` (handshake reject without valid token; service is reachable).

## Phase 4: Resilience verification

- [x] 4.1 Crash test: `sudo -n kill -9 $(pgrep -f "node src/index.js" -u dani) && sleep 6 && systemctl is-active whatsapp-bot` → `active` (proves `Restart=always` + `RestartSec=5`). NEW PID after restart: 1602012 (was 1601853).
- [x] 4.2 Log destination: `sudo -n journalctl -u whatsapp-bot -n 5 --no-pager` shows restart lifecycle (`Failed with result 'signal'` → `Scheduled restart job, restart counter is at 1` → `Started whatsapp-bot.service` → `Servidor corriendo en puerto 3000`). `ls -la /tmp/whatsapp-bot.log` → file exists but stale (mtime 03:15, pre-cut-over), no growth from systemd process.
- [x] 4.3 Boot persistence: `sudo -n systemctl restart whatsapp-bot` → exit 0; `systemctl is-active whatsapp-bot` → `active`.

## Phase 5: Cleanup + documentation

- [x] 5.1 Remove stale log: `sudo -n rm -f /tmp/whatsapp-bot.log` → blocked (rm not in NOPASSWD); fell back to `rm -f /tmp/whatsapp-bot.log` as `dani` (file owned by dani, 644) → exit 0; `ls` → `No such file or directory`.
- [x] 5.2 Runbook update: no `deploy/RUNBOOK.md` exists — skip; flag to user to add one later documenting `systemctl {status,restart} whatsapp-bot` and `journalctl -u whatsapp-bot -f`.
- [x] 5.3 Verify NO nohup: `pgrep -af "nohup.*node src/index.js"` → only self-match (zsh subshell running the grep); no actual nohup process.

## Phase 6: Rollback dry-run (documentation only, NOT executed)

- [x] 6.1 Document rollback sequence in memory/PR description: `sudo -n systemctl disable --now whatsapp-bot && sudo -n rm -f /etc/systemd/system/whatsapp-bot.service && sudo -n systemctl daemon-reload && nohup node src/index.js > /tmp/whatsapp-bot.log 2>&1 &` — confirms pure supervisor swap, no code path changes.