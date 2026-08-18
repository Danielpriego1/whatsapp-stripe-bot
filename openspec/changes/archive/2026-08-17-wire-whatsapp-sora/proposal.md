# Proposal: wire-whatsapp-sora

## Intent

The WhatsApp POST webhook (`src/whatsapp.js:23-45`) logs messages but never calls `soraResponder` — the bot is completely non-responsive. Wire inbound messages to Sora and reply via `enviarMensaje`, keeping the Meta webhook ack fast and failures observable.

## Scope

### In Scope
- Call `soraResponder(from, text)` per inbound message; send returned reply via `enviarMensaje`.
- Ack-fast: `200 EVENT_RECEIVED` immediately; async processing with try/catch + logs.
- **Structured Sora response**: `soraResponder` returns `{ reply, alreadySent }` so the payment branch (which already sent the link) doesn't produce a second message — fixes the double-message bug.
- **Dedupe by `message.id`**: bounded in-memory TTL set; skip already-processed ids (Meta retries can't duplicate orders).
- **Typing indicator**: send `typing_on` before processing and `typing_off` after reply; `mark_as_read` on inbound (low-cost UX).
- Edge cases: missing `from`/empty `text` (skip), errors (log, no crash), multiple messages per payload (iterate all).

### Out of Scope
- Payment confirmation (`fix-payment-confirmation` owns it).
- Verify-token hardening (`mi_token_secreto` — flagged risk).
- AI/LLM, auth, schema changes.

## Capabilities

### New Capabilities
- `whatsapp-bot-messaging`: inbound text → Sora reply → outbound message; fast ack, async processing, error containment.

### Modified Capabilities
- None (`openspec/specs/` empty).

## Approach

In `src/whatsapp.js` POST handler: loop `entry[].changes[].value.messages[]`; per `from`+`text`, skip if `message.id` in the TTL dedupe set (insert first, then process); send `typing_on` + `mark_as_read`; fire-and-forget a `processMessage` wrapper: `soraResponder` → `enviarMensaje(reply)` only when the structured result returns a reply string (payment branch sets `alreadySent: true`); send `typing_off`; all in try/catch. Respond `200` first. Replies go outbound via Graph API, so fast ack doesn't delay UX; awaiting risks Meta timeout retries re-processing the same event (duplicate orders — dedupe set is the second defense). `soraResponder` becomes `{ reply, alreadySent }`. Spanish comments kept; design adds webhook sequence diagram (config.yaml).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/whatsapp.js` | Modified | POST invokes Sora, iterates all messages, async processing |
| `openspec/specs/whatsapp-bot-messaging/spec.md` | New | From sdd-spec phase |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Background failures invisible to Meta | Med | Logs; optional user notification (deferred) |
| Duplicate messages on Meta retry | Low | Fast ack + `message.id` TTL dedupe set |
| `pagar/comprar` double message | Med | Structured `{ reply, alreadySent }` — reply suppressed when link already sent |
| Hardcoded `mi_token_secreto` | Med | Flagged; hardening deferred |
| Meta outbound 429s / typing indicator spam | Low | Sequential processing; bounded typing window; log 429s |

## Rollback Plan

Revert `src/whatsapp.js` POST handler to log-only (single-file git revert). `soraResponder`/`enviarMensaje` untouched; no data migration.

## Dependencies

- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (existing).
- InsForge `ordenes` insert RLS (existing).

## Success Criteria

- [ ] "precio"/"cotizar" gets a Sora reply within seconds.
- [ ] Webhook always acks `200` fast; failures logged, no crashes.
- [ ] Multiple messages per payload all processed.
- [ ] `pagar/comprar` sends the payment link exactly once — no double message.
- [ ] Duplicate webhook delivery of the same `message.id` is ignored (dedupe set).
- [ ] Typing indicator on/off brackets the reply; message marked as read.
- [ ] `node --check src/index.js` passes; payment branch creates order + link.

## Proposal question round

Confirmed by user:
1. ✅ Ack-fast + fire-and-forget.
2. ✅ Structured `{ reply, alreadySent }` — no double message on `pagar/comprar`.
3. ✅ Log-only on failure (user notification deferred).
4. ✅ `message.id` TTL dedupe set + fast ack.
5. ✅ Typing indicators + `mark_as_read` (added as improvement).