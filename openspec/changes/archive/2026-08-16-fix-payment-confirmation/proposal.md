# Proposal: fix-payment-confirmation

## Intent

`confirmarPagoOrden` exists in `src/insforge.js` but is never called: the Stripe webhook only logs `checkout.session.completed`, so orders stay `pendiente` forever. Wire the webhook to mark orders paid (session carries `metadata.ordenId`) and fix the non-array `insert` violating the InsForge SDK convention.

## Scope

### In Scope
- Call `confirmarPagoOrden(session.metadata.ordenId, session.id)` on `checkout.session.completed`, with error handling that preserves Stripe retry semantics.
- Verify `session.amount_total` and currency against the order before marking it paid; mismatch → log + leave `pendiente` (ack).
- Mark order `fallida` on `payment_intent.payment_failed` and `cancelada` on `checkout.session.expired`.
- Unrecoverable cases (missing `metadata.ordenId`, order not found, amount mismatch): log + ack — no retry storm.
- WhatsApp payment confirmation message to the customer after the order flips to `pagada`.
- Fix `guardarOrden` to `.insert([{ ... }])`.
- Optional `node:test` unit tests for the webhook (config.yaml `test_command: node --test`).

### Out of Scope
- Frontend, auth, schema migrations, `@insforge/sdk` payments migration.

## Capabilities

### New Capabilities
- `payment-confirmation`: marks orders `pagada` on Stripe `checkout.session.completed` (after amount/currency verification), `fallida` on `payment_intent.payment_failed`, `cancelada` on `checkout.session.expired`; sends WhatsApp confirmation to the customer; idempotent updates, non-retriable failure handling.

### Modified Capabilities
- None (`openspec/specs/` empty).

## Approach

In `src/stripe.js` `checkout.session.completed`: read `session.metadata?.ordenId`; if missing, log + ack. Else fetch the order, verify `session.amount_total`/currency matches; on success `confirmarPagoOrden` in try/catch — DB error: log + `500` (Stripe retries); order not found / amount mismatch: log + ack (retry pointless). On `pagada`, send WhatsApp confirmation via `enviarMensaje`. `payment_intent.payment_failed` → `fallida`; `checkout.session.expired` → `cancelada`. Update is naturally idempotent (same values re-applied). Fix `guardarOrden` insert to array form. Design phase adds a webhook sequence diagram (config.yaml); Spanish comments stay.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/stripe.js` | Modified | Marks order paid/failed/canceled on Stripe events; WhatsApp confirmation |
| `src/insforge.js` | Modified | `guardarOrden` insert array fix; fetch order for amount verification |
| `test/stripe.test.js` | New (optional) | `node:test` webhook coverage |
| `openspec/specs/payment-confirmation/spec.md` | New | From sdd-spec phase |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Duplicate events double-update | Med | Idempotent update |
| Missing `ordenId` / unknown order | Low | Log + ack, no retry loop |
| Amount mismatch (order vs session) | Low | Leave `pendiente`, log + ack |
| WhatsApp send fails after paid | Low | Log; order already paid, retry manually |
| RLS denies UPDATE on `ordenes` (anon) | Med | Verify policy via `insforge-cli` |

## Rollback Plan

Revert both one-file changes (log-only webhook, object-form insert). No migration; `confirmarPagoOrden` stays additive and unused if reverted.

## Dependencies

- `STRIPE_WEBHOOK_SECRET` + `checkout.session.completed` registration (existing).
- `ordenes` UPDATE RLS policy for anon client (verify via `insforge-cli`).

## Success Criteria

- [ ] Completed checkout flips order to `pagada` with `stripe_session_id` and `pagado_en` (after amount/currency verification).
- [ ] `payment_failed` → `fallida`; `session.expired` → `cancelada`.
- [ ] Customer receives WhatsApp confirmation after `pagada`.
- [ ] Duplicates error-free; missing metadata/order/amount mismatch ack without retry storms.
- [ ] `node --check src/index.js` passes; `node --test` green (if tests added).
- [ ] Order creation works with array insert.

## Proposal question round

Confirmed:
1. ✅ Mark orders `cancelada`/`fallida` on `payment_intent.payment_failed` / `checkout.session.expired`.
2. ✅ Verify `session.amount_total`/currency against the order before marking paid.
3. ✅ Unrecoverable cases: ack-and-log (no retry storms).
4. ✅ WhatsApp payment confirmation message to the customer.