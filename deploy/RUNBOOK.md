# Runbook — whatsapp-stripe-bot

Operational reference for the WhatsApp + Stripe bot running on the Contabo VPS
(`grupopsi.contaboserver.net`, Ubuntu 24.04, systemd-based).

Last updated: 2026-08-30 (after `ops-prod-supervision` change).

---

## Service

The bot runs as a systemd unit, **not** under `nohup`.

| Property | Value |
|----------|-------|
| Unit file | `/etc/systemd/system/whatsapp-bot.service` |
| Working dir | `/home/dani/whatsapp-stripe-bot` |
| ExecStart | `/usr/bin/env node src/index.js` |
| User | `dani` (non-root) |
| Env file | `/home/dani/whatsapp-stripe-bot/.env` (mode `0600`, owner `dani`) |
| Port | `3000` (or `PORT` from `.env`) |
| Restart policy | `Restart=always`, `RestartSec=5` |
| Logs | journald (unit `whatsapp-bot.service`) |
| Boot persistence | `enabled` in `multi-user.target.wants/` |

---

## Day-to-day commands

### Check if the bot is running

```bash
systemctl is-active whatsapp-bot
# expect: active

systemctl status whatsapp-bot --no-pager
# shows: Main PID, uptime, last log lines, memory/CPU
```

### Tail the logs (live)

```bash
sudo journalctl -u whatsapp-bot -f
```

### Tail the last 100 lines and exit

```bash
sudo journalctl -u whatsapp-bot -n 100 --no-pager
```

### Logs from the last hour

```bash
sudo journalctl -u whatsapp-bot --since "1 hour ago" --no-pager
```

### Restart the bot (after editing `.env` or pulling new code)

```bash
sudo systemctl restart whatsapp-bot
sudo journalctl -u whatsapp-bot -n 20 --no-pager   # confirm boot banner
```

The restart takes ~5 seconds (the bot dies, systemd waits `RestartSec=5`, restarts).

### Stop the bot temporarily

```bash
sudo systemctl stop whatsapp-bot
```

To bring it back up:

```bash
sudo systemctl start whatsapp-bot
```

### Reload code without downtime

Not supported. The bot is a single Node process; any code change requires a
restart. For zero-downtime deploys you would need a cluster (PM2 cluster mode,
systemd socket activation, or a load balancer) — out of scope today.

---

## Smoke tests

After any restart, verify the bot is reachable:

```bash
# Port is listening
ss -ltnp | grep :3000
# expect: LISTEN ... users:(("node",pid=...,fd=21))

# Handshake rejects without a valid token (this is correct)
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  http://127.0.0.1:3000/webhooks/whatsapp
# expect: HTTP 403 (NOT 000 / connection refused)

# Handshake accepts with the right verify token
TOKEN=$(grep '^WHATSAPP_VERIFY_TOKEN=' /home/dani/whatsapp-stripe-bot/.env | cut -d= -f2)
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=test123"
# expect: HTTP 200, body = "test123"
```

---

## Incident response

### Bot is unresponsive (no log output, webhook 000)

1. Check status: `systemctl status whatsapp-bot --no-pager`.
2. If `inactive (dead)`: systemd stopped it for some reason.
   - Look at recent journal: `sudo journalctl -u whatsapp-bot -n 50 --no-pager`.
   - Start it: `sudo systemctl start whatsapp-bot`.
3. If `active (running)` but no response: probably stuck. Restart:
   ```bash
   sudo systemctl restart whatsapp-bot
   ```
4. If restart does not help, escalate by checking the application logs and
   recent code changes.

### Crash loop (service keeps dying)

`Restart=always` + `RestartSec=5` means systemd will keep restarting a crashing
process, but `StartLimitBurst=5` / `StartLimitIntervalSec=10s` (defaults) caps
the retry rate. After 5 crashes in 10 seconds, systemd gives up and marks the
service `failed`.

To diagnose:

```bash
sudo journalctl -u whatsapp-bot -n 200 --no-pager
```

Look for repeated exception traces. Common causes:

- Missing or invalid `.env` (check `EnvironmentFile` path and perms).
- Port already in use by another process (rare; check `ss -ltnp | grep :3000`).
- Unhandled exception in a webhook handler (Stripe or WhatsApp). Look at the
  last stack trace before each restart.

To manually reset the failed state and try again:

```bash
sudo systemctl reset-failed whatsapp-bot
sudo systemctl start whatsapp-bot
```

### Service will not start after editing `.env`

Most common cause: file permissions. `.env` must be readable by `dani`:

```bash
ls -la /home/dani/whatsapp-stripe-bot/.env
# expect: -rw------- 1 dani dani ...

sudo -u dani test -r /home/dani/whatsapp-stripe-bot/.env && echo OK
# expect: OK
```

If perms are wrong:

```bash
sudo chown dani:dani /home/dani/whatsapp-stripe-bot/.env
sudo chmod 0600 /home/dani/whatsapp-stripe-bot/.env
sudo systemctl restart whatsapp-bot
```

---

## Maintenance

### Apply a code change

```bash
cd /home/dani/whatsapp-stripe-bot
git pull                                           # get latest code
node --check src/index.js                          # sanity-check syntax
sudo systemctl restart whatsapp-bot                # ~5s downtime
sudo journalctl -u whatsapp-bot -n 20 --no-pager   # confirm boot
```

### Roll back to a previous commit

```bash
cd /home/dani/whatsapp-stripe-bot
git log --oneline -10                # find the SHA you want
git checkout <sha>                   # detaches HEAD on that SHA
node --check src/index.js
sudo systemctl restart whatsapp-bot
```

### Rotate the WhatsApp / Stripe / InsForge secrets

1. Generate the new secret in the provider's dashboard (Meta, Stripe, InsForge).
2. Update `.env`:
   ```bash
   nano /home/dani/whatsapp-stripe-bot/.env
   ```
3. Restart so the new env is picked up:
   ```bash
   sudo systemctl restart whatsapp-bot
   ```
4. Smoke test as in the Smoke tests section above.

### Free up disk if `/var/log/journal` grows too large

```bash
sudo journalctl --vacuum-size=200M
sudo journalctl --vacuum-time=14d
```

journald's defaults already cap storage, but check with:

```bash
sudo journalctl --disk-usage
```

---

## Rollback: revert from systemd to nohup

Use this only if the systemd unit is causing trouble and you need the bot back
online fast. Pure supervisor swap; no code path changes.

```bash
sudo systemctl disable --now whatsapp-bot
sudo rm /etc/systemd/system/whatsapp-bot.service
sudo systemctl daemon-reload

cd /home/dani/whatsapp-stripe-bot
nohup node src/index.js > /tmp/whatsapp-bot.log 2>&1 &
```

Verify:

```bash
ss -ltnp | grep :3000
tail -f /tmp/whatsapp-bot.log
```

The bot is now back under `nohup`. It will not auto-restart on crash or
reboot — schedule a proper fix.

---

## Reference

- Unit file content: see `/etc/systemd/system/whatsapp-bot.service`.
- Change history: `openspec/changes/ops-prod-supervision/` (proposal, design,
  tasks, apply-progress, verify-report).
- Nginx config (separate, but related): `deploy/whats.grupopsi.com.conf` and
  `/etc/nginx/sites-available/whats.grupopsi.com.conf`.
- SSL cert renewal: handled automatically by `certbot.timer` (systemd, runs
  twice a day). No operator action needed.