# Design: fix-payment-confirmation

## Technical Approach

Wire the existing-but-unused `confirmarPagoOrden` into the Stripe webhook (`src/stripe.js`). On `checkout.session.completed`: read `session.metadata?.ordenId`; fetch the order; verify `session.amount_total`/currency against the stored order before marking `pagada`. Unrecoverable cases (missing metadata, order not found, mismatch) log + ack 200; transient DB failure returns 500 so Stripe redelivers. Mark `fallida` on `payment_intent.payment_failed` and `cancelada` on `checkout.session.expired` (requires `payment_intent_data.metadata` in `createPaymentLink` so the PaymentIntent carries `ordenId`). After `pagada`, send the Spanish WhatsApp confirmation via `enviarMensaje`, deduplicated on prior state. Fix `guardarOrden` to array-form insert (AGENTS.md InsForge convention). Extract the event switch into a testable `procesarEvento(event, deps)` with injected InsForge functions; keep the route wrapper thin. Spanish comments in source stay (config.yaml apply guideline).

## Architecture Decisions

### Decision: Currency verification strategy (spec R1 requires amount AND currency)

| Option | Tradeoff | Decision |
|---|---|---|
| A. Add `moneda` column via SQL migration | One additive `ALTER TABLE`; fully satisfies spec currency scenario | **Chosen** |
| B. Compare `amount_total` only | Zero schema change; currency mismatch undetectable — spec scenario unexercisable | Rejected |
| C. Store expected amount in session metadata | Self-referential (session created from that amount); adds nothing | Rejected |

`guardarOrden` persists `moneda: 'mxn'`; verification compares both fields. Supersedes proposal's "schema migrations out of scope" — a one-column additive change (see Open Questions).

### Decision: Resolving the order for `payment_intent.payment_failed`

| Option | Tradeoff | Decision |
|---|---|---|
| A. `payment_intent_data.metadata` in `createPaymentLink` | PI deterministically carries `ordenId`; small change | **Chosen** |
| B. Lookup by `paymentIntent.id` | No mapping table exists; requires new table | Rejected |
| C. Skip `fallida` handling | Violates spec | Rejected |

### Decision: WhatsApp confirmation on duplicate events

| Option | Tradeoff | Decision |
|---|---|---|
| A. Send only if prior `estado !== 'pagada'` | No duplicate messages on Stripe redelivery; one extra field check | **Chosen** |
| B. Send on every completed event | Simpler; customers get repeated messages | Rejected |

### Decision: Webhook testability

| Option | Tradeoff | Decision |
|---|---|---|
| A. Extract `procesarEvento(event, deps)` | Unit-testable via `node:test` with crafted objects, no mocks | **Chosen** |
| B. Test via HTTP + real signatures | Needs network/keys; brittle | Rejected |

## Data Flow

```
Stripe ──POST /webhooks/stripe──▶ express.raw (Buffer)
  │
  ▼
constructEvent(req.body, sig) ──✗──▶ 400 (bad signature)
  │ ✓ (parsed event)
  ▼
procesarEvento(event, deps)
  │
  ├─ checkout.session.completed:
  │    session.metadata?.ordenId ──✗──▶ log + ack 200
  │    │ ✓
  │    obtenerOrden(ordenId) ──✗──▶ log + ack 200 (not found)
  │    │ ✓
  │    amount_total/moneda match? ──✗──▶ log + ack 200
  │    │ ✓
  │    confirmarPagoOrden(ordenId, session.id)
  │    │   DB error ──▶ log + 500 (Stripe retries)
  │    │ ✓ (orden.estado !== 'pagada')
  │    enviarMensaje(cliente_id, confirmación) ──✗──▶ log only, order stays pagada
  │    └──▶ ack 200
  ├─ payment_intent.payment_failed → marcarOrdenFallida(ordenId) → ack
  ├─ checkout.session.expired     → marcarOrdenCancelada(ordenId) → ack
  └─ default → log + ack
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/stripe.js` | Modify | Route wrapper calls `procesarEvento`; add verification, state transitions, WhatsApp confirmation; `payment_intent_data: { metadata }` in `createPaymentLink` |
| `src/insforge.js` | Modify | `guardarOrden`: `.insert([{...}])` + `moneda`; add `obtenerOrden`, `marcarOrdenFallida`, `marcarOrdenCancelada` |
| `src/sora.js` | Modify | Pass `moneda: 'mxn'` to `guardarOrden` |
| `test/stripe.test.js` | Create | `node:test` unit coverage for `procesarEvento` |

Migration via `insforge-cli` (not a code file): `ALTER TABLE ordenes ADD COLUMN moneda text NOT NULL DEFAULT 'mxn';`

## Interfaces / Contracts

```js
// Session + PaymentIntent metadata shape (set in sora.js / createPaymentLink)
{ ordenId: string, cliente: string }

// insforge.js additions
obtenerOrden(ordenId)          // → { id, cliente_id, total, moneda, estado }
marcarOrdenFallida(ordenId)    // update { estado: 'fallida' }
marcarOrdenCancelada(ordenId)  // update { estado: 'cancelada' }

// WhatsApp confirmation (Spanish, user-facing)
enviarMensaje(orden.cliente_id, '¡Gracias por tu compra! Tu pago fue confirmado.');
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `procesarEvento`: match → paid + WhatsApp sent; amount/currency mismatch; missing metadata; order not found; DB error → 500; duplicate → no re-send; `payment_failed` → fallida; `expired` → cancelada | `node:test`, injected deps, crafted event objects |
| Unit | Bad/missing signature → 400, event never processed | Route-level test |
| Integration | None (no infra) | Manual: `stripe trigger checkout.session.completed` |
| E2E | None | N/A |

## Threat Matrix

Stock rows (`requirements.txt`/Markdown, `git -C`, commit, push, PR commands) — **N/A**: no VCS, shell, subprocess, or executable-file boundary in this change. Webhook request-verification boundary:

| Boundary | Min adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Signature verification | Tampered/missing `stripe-signature` | Applicable | `constructEvent` throws → 400, payload never processed | Route test: bad sig → 400 |
| Untrusted event payload | Crafted events: no `ordenId`, unknown order, amount mismatch | Applicable | Log + ack 200, no state change, no retry storm | Unit: each unrecoverable case |
| Transient DB failure | Update throws | Applicable | Log + 500 → Stripe redelivers | Unit: DB error → 500 |

## Migration / Rollout

Run `ALTER TABLE ... ADD COLUMN moneda ...` via `insforge-cli` before deploy, then ship code. Rollback: revert `src/` changes; drop column only if needed. No feature flags. Verify `ordenes` UPDATE RLS policy for anon client (proposal dependency).

## Open Questions

- [x] Additive `moneda` column migration confirmed by user — applied via `insforge-cli` (`ALTER TABLE ordenes ADD COLUMN moneda text NOT NULL DEFAULT 'mxn';`) before code deploy.