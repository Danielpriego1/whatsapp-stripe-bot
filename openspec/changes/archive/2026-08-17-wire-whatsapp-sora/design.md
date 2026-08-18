# Design: wire-whatsapp-sora

## Technical Approach

Make the WhatsApp POST webhook (`src/whatsapp.js:23-45`) responsive: ack `200 EVENT_RECEIVED` first, then asynchronously iterate every message in the delivery, dedupe by `message.id` (bounded TTL map), and per message run typing indicators + mark-as-read + `soraResponder` → `enviarMensaje` (only when a reply string is returned). `soraResponder` becomes structured `{ reply, alreadySent }` so the payment branch's self-sent link never produces a second message. All per-message failures are logged, never thrown into the ack path. Follows the injectable-deps testability pattern from `src/stripe.js:14-21` and keeps Spanish comments.

## Architecture Decisions

### Decision: Dedupe location and bound

| Option | Tradeoff | Decision |
|---|---|---|
| Unbounded `Set` | Memory leak under high volume | ✗ |
| In-memory `Map<id, timestamp>` + TTL sweep | Simple; lost on restart/multi-instance (acceptable: single-instance bot) | ✓ TTL 10 min, evict on access |
| TTL + hard cap N (5000) | Bounded both ways; evict oldest on overflow | ✓ cap 5000 |

Module-level `Map` in `whatsapp.js`; helpers `yaProcesado(id)` / `marcarProcesado(id)` exported for tests. Check+insert happens during parse (before `res.send`), so a redelivery racing in-flight processing is still caught; processing itself runs after the ack.

### Decision: `soraResponder` structured return

| Option | Tradeoff | Decision |
|---|---|---|
| Payment branch returns confirmation string | Second message — the bug being fixed | ✗ |
| `{ reply: null, alreadySent: true }` | Caller gates on `reply` truthiness; `alreadySent` is observability only | ✓ |

`sora.js` payment branch sends the link itself, then returns `{ reply: null, alreadySent: true }` (the old "Te acabo de enviar..." string is removed). Non-payment branches return `{ reply: <string>, alreadySent: false }`. Caller sends only `if (resultado.reply)`.

### Decision: Typing/read indicators — placement and payloads

| Option | Tradeoff | Decision |
|---|---|---|
| Reuse `enviarMensaje` for indicators | Wrong payload shape; couples concerns | ✗ |
| Separate `type: "typing"` + `typing.state` calls | Not the real Meta Cloud API shape | ✗ |
| Dedicated helper + shared `postGraphMessage(payload)` | One endpoint; matches Meta's documented combined payload | ✓ |

Verified against Meta Cloud API docs (typing-indicators page): the documented request marks the message as read AND shows the typing indicator in ONE call to `/messages` with `status: 'read'` + `message_id` + `typing_indicator: { type: 'text' }` — there is no `type: 'typing'`/`typing.state` form and no separate `typing_off`: the indicator auto-dismisses on reply or after 25s. Sequence inside per-message processing: combined read+typing call → `soraResponder` → reply (dismisses indicator). The indicator call is wrapped in its own try/catch + `console.error`; failure never blocks the reply (spec: "Indicator fails to send").

### Decision: Sequential per-message processing

| Option | Tradeoff | Decision |
|---|---|---|
| `Promise.all` over messages | Faster; 429 risk on Graph API | ✗ |
| `for...of` await, fire-and-forget after `res.send` | Slower; bounded rate; no queue infra needed | ✓ (proposal risk table) |

## Data Flow

```
Meta ──POST /webhooks/whatsapp──▶ whatsapp.js router.post
  │ parse entry[].changes[].value.messages[] (iterate ALL)
  │ per message: skip if !from / !text / yaProcesado(id); marcarProcesado(id)
  │ res 200 'EVENT_RECEIVED' ──▶ Meta        (fast ack, nothing awaits it)
  │ for each message (sequential, each step try/catch + log):
  │   marcarLeidoYEscritura(from, id) ─▶ Graph  (combined read + typing indicator)
  │   resultado = soraResponder(from, text) ──▶ sora.js
  │     ├─ 'pagar'/'comprar' → guardarOrden → createPaymentLink
  │     │    → enviarMensaje(link) → return { reply: null, alreadySent: true }
  │     └─ else → { reply: <texto>, alreadySent: false }
  │   if (resultado.reply) enviarMensaje(from, resultado.reply) ─▶ Graph (dismisses indicator)
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/whatsapp.js` | Modify | Dedupe map, ack-fast POST, iterate all messages, `procesarMensaje` (injectable deps), `postGraphMessage` + `marcarLeidoYEscritura` |
| `src/sora.js` | Modify | Return `{ reply, alreadySent }`; payment branch returns `reply: null` |
| `test/whatsapp.test.js` | Create | RED tests: threat-matrix rows + flow unit tests (node:test, stub deps) |
| `test/sora.test.js` | Create | Structured-return contract tests |

## Interfaces / Contracts

```js
// sora.js — nuevo contrato
export async function soraResponder(from, texto)
// → Promise<{ reply: string|null, alreadySent: boolean }>

// whatsapp.js — helpers nuevos
export async function marcarLeidoYEscritura(from, messageId) // combined read + typing indicator
export function yaProcesado(id) / marcarProcesado(id)
```

Graph payloads (endpoint `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, existing v17.0):

```json
// leido + indicador de escritura (combined, per Meta typing-indicators docs):
// { "messaging_product": "whatsapp", "status": "read", "message_id": "<id>",
//   "typing_indicator": { "type": "text" } }
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit (RED first) | Dedupe TTL/cap, skip missing from/empty text | node:test; export `yaProcesado`/`marcarProcesado`; fake timers for TTL |
| Unit (RED first) | Error containment: one message rejects → others still processed | `procesarMensaje` with stub `soraResponder`/`enviarMensaje` (deps injection, stripe.js pattern) |
| Unit | `soraResponder` shape: payment → `reply: null, alreadySent: true`; no second `enviarMensaje` | Stub `guardarOrden`/`createPaymentLink`/`enviarMensaje` |
| Integration | POST handler: 200 before processing, multi-message delivery all processed, indicator failures logged not blocking | Mock req/res + stubbed Graph calls |

## Threat Matrix

HTTP webhook routing + outbound third-party calls are the touched boundaries. Stock VCS rows (documentation-like paths, git selection, commit/push state, PR commands): **N/A** — no shell, subprocess, or VCS/PR automation involved.

| Boundary | Adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Webhook untrusted payload | Missing `from`, empty/missing `text`, non-text (media), malformed body, non-`whatsapp_business_account` object | Applicable — untrusted HTTP input | Skip silently per spec; guard array access; keep 404 for wrong object; never throw on malformed per-message data | Test: no-from → no reply, 200; empty text → skipped; multi-message → each processed |
| Outbound Graph API failures | 5xx, 429, network errors, missing token | Applicable — axios to Meta | try/catch per call + `console.error`; sequential processing caps 429s; errors never reach ack path | Test: `enviarMensaje` rejects → logged, no crash, next message still processed |
| Retry / duplicate delivery | Same `message.id` redelivered in window; outside window | Applicable — dedupe semantics | TTL map insert-before-process; duplicates ignored with no side effects; window expiry allows reprocessing | Test: same id twice → processed once; id past TTL → processed again |

## Migration / Rollout

No migration. Rollback: revert `src/whatsapp.js` + `src/sora.js` (proposal: single-file git revert); no schema or env changes. Deploy note: dedupe assumes single instance.

## Open Questions

- [x] Combined read+typing payload adopted directly (documented Meta shape, verified) — no separate typing_off; indicator auto-dismisses on reply/25s.
- [ ] Confirm TTL (10 min) and cap (5000) defaults for this bot's volume.
- [ ] Revisit typing indicator if noisy (Meta notes it's for slow responses only).