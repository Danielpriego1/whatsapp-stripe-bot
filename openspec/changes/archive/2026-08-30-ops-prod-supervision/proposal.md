# Proposal: ops-prod-supervision

## Intent

Bot runs under `nohup` on Contabo VPS (PID 1579425): no auto-restart on crash, no auto-start on reboot. nginx + certbot already run under systemd — that's the gap. Replace `nohup` with a real supervisor (pm2 OR systemd unit — TBD by sdd-design) that restarts on crash and on reboot, with logs not silently filling `/tmp`.

## Scope

### In Scope
- Supervisor config (pm2 `ecosystem.config.js` OR systemd unit) with auto-restart; boot persistence (`pm2 startup` / `systemctl enable`); logs to non-`/tmp` path with rotation/size cap.
- Verification: bot survives `kill -9 <pid>` and `sudo reboot`.
- Migration: stop `nohup`, bring bot up under supervisor, update runbook.

### Out of Scope
- `/health` endpoint (deferred to `ops-observability-and-alerting`).
- Alerting, metrics, dashboards.
- Any code change to `src/*.js` (env `PORT` already works).
- Uncommitted `src/whatsapp.js` `hub.mode`/`hub_mode` handling (separate change).

## Capabilities

### New Capabilities
None

### Modified Capabilities
None

Pure ops/infra change — no spec-level behavior changes.

## Approach

Supervisor TBD by sdd-design. Both paths give: restart on `kill`/crash in seconds, alive after `sudo reboot`, logs at non-`/tmp` path with rotation. sdd-design compares pm2 (in `devDependencies` ^7.0.3 from e13fd19) vs systemd (zero deps, matches nginx/certbot, needs `User=`/`WorkingDirectory=`). sdd-tasks: write config, cut over from `nohup`, verify kill + reboot, update runbook. Verification: `node --check src/index.js`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `ecosystem.config.js` OR `/etc/systemd/system/whatsapp-bot.service` | New | Supervisor config |
| `package.json` | Modified | Optional `start`/`stop` scripts |
| `pm2 startup` OR `systemctl enable whatsapp-bot` | External config | Boot persistence |
| Log path (`/var/log/whatsapp-bot/` OR pm2-managed) | External config | Replaces `/tmp/whatsapp-bot.log` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Wrong supervisor picked (lock-in regret) | Low | Both reversible; rollback restores `nohup` |
| Systemd unit runs as root, exposes `.env` | Med | `User=` + `WorkingDirectory=`; restrict perms |
| Crash loop unnoticed (no `/health`) | Med | Supervisor logs crash count; alerting deferred |
| Reboot affects other VPS services | Med | Low-traffic window; nginx/certbot recovery |

## Rollback Plan

Stop supervisor, restore `nohup` from runbook. pm2: `pm2 delete whatsapp-bot && pm2 unstartup systemd`. systemd: `systemctl disable --now whatsapp-bot && rm /etc/systemd/system/whatsapp-bot.service`. Urgent: re-spawn PID 1579425 via prior `nohup` line. Pure supervisor swap.

## Dependencies

- Node.js v22 on `$PATH`; `pm2 ^7.0.3` (e13fd19) OR systemd; `.env.local` readable by supervisor user.

## Success Criteria

- [ ] `kill -9 <pid>` → supervisor restarts within 5 seconds.
- [ ] `sudo reboot` → bot alive on port 3000.
- [ ] Logs at non-`/tmp` with rotation/size cap.
- [ ] `node --check src/index.js` passes; env vars unchanged.
- [ ] `nohup` removed; runbook updated; rollback dry-run OK.