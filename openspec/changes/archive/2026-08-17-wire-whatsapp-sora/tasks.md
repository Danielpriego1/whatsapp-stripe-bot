# Tasks: Wire WhatsApp to Sora

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 250–350 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Webhook → Sora reply: ack-fast, dedupe, structured `soraResponder`, tests | PR 1 | `node --test` | `node src/index.js` + curl POST /webhooks/whatsapp (live reply needs real Meta creds — else N/A) | Revert `src/whatsapp.js` + `src/sora.js` to log-only; no migration |

## Phase 1: Foundation — Threat-matrix RED tests + dedupe

- [x] 1.1 Create `test/whatsapp.test.js` scaffold: env dummies before `import('../src/whatsapp.js')`, `crearDeps`/`rastrear` stubs (stripe.test.js pattern)
- [x] 1.2 RED: duplicate-delivery tests — same `message.id` in window → processed once, no side effects; id past TTL → processed again
- [x] 1.3 GREEN: `src/whatsapp.js` module-level dedupe `Map<id, timestamp>` (TTL 10 min, cap 5000, evict oldest on overflow); export `yaProcesado(id)`/`marcarProcesado(id)`; Spanish comments

## Phase 2: Core

- [x] 2.1 RED: `test/sora.test.js` — payment branch → `{ reply: null, alreadySent: true }` + link sent exactly once (stub `guardarOrden`/`createPaymentLink`/`enviarMensaje`); pricing → `{ reply: <string>, alreadySent: false }`
- [x] 2.2 GREEN: `src/sora.js` — return `{ reply, alreadySent }`; payment branch returns `reply: null` after sending link; delete "Te acabo de enviar..." string
- [x] 2.3 RED: `test/whatsapp.test.js` — `enviarMensaje` rejects → logged, no crash, next message still processed; indicator failure logged but reply still delivered
- [x] 2.4 GREEN: `src/whatsapp.js` `procesarMensaje(from, text, deps)` with injectable deps (stripe.js pattern); per-step try/catch + `console.error`
- [x] 2.5 GREEN: `src/whatsapp.js` `postGraphMessage(payload)` helper + `marcarLeidoYEscritura(from, messageId)` sending `{ messaging_product, status: 'read', message_id, typing_indicator: { type: 'text' } }`; own try/catch, never blocks reply

## Phase 3: Integration / Wiring

- [x] 3.1 RED: integration tests — POST returns `200 EVENT_RECEIVED` before processing; multi-message delivery → each processed; no-from/empty-text skipped; non-`whatsapp_business_account` → 404; never throws
- [x] 3.2 GREEN: rewire POST in `src/whatsapp.js` — iterate ALL `entry[].changes[].value.messages[]`; per message skip if `!from`/`!text`/`yaProcesado`; `marcarProcesado` before `res.send`; ack 200 first; sequential `for...of` fire-and-forget after ack

## Phase 4: Testing

- [x] 4.1 Unit: dedupe TTL expiry + cap-5000 eviction via `node:test` mock timers
- [x] 4.2 Unit: skip missing `from`/empty `text`; multi-message all processed at `procesarMensaje` level
- [x] 4.3 Run `node --test` (all green) + `node --check src/index.js`

## Phase 5: Cleanup

- [x] 5.1 Remove stale log-only block/comments from old POST handler in `src/whatsapp.js`
- [x] 5.2 Review: Spanish comments on all new code; confirm `enviarMensaje` export/signature unchanged (used by `src/stripe.js`)