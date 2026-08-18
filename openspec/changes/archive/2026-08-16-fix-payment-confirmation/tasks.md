# Tasks: fix-payment-confirmation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 250–350 (incl. tests) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (fallback: PR 1 infra+core → PR 2 tests) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes (resolved: user approved single PR)
Chained PRs recommended: No
Chain strategy: N/A (single PR approved)
400-line budget risk: Medium (within budget)

### Suggested Work Units (fallback only if diff exceeds 400)

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Migration + insforge.js/sora.js + stripe.js logic | PR 1 | `node --test` (RED tests ship in-repo) | Manual `stripe trigger checkout.session.completed` (needs keys/network) | Revert `src/` changes; `moneda` column stays (additive) |
| 2 | Full `test/stripe.test.js` suite + cleanup | PR 2 | `node --test` | N/A — pure unit via injected deps | Delete `test/` |

## Phase 1: Migration / Infra

- [x] 1.1 Via `insforge` CLI (project oss-project, host https://insforge.grupopsi.com; run `insforge login` first — CLI not authenticated): apply `ALTER TABLE ordenes ADD COLUMN moneda text NOT NULL DEFAULT 'mxn';` — applied via migrations/20260816080808_add-moneda-column-to-ordenes.sql; CLI worked without login (project appkey grants DB access)
- [x] 1.2 Verify anon client UPDATE RLS policy on `ordenes` via `insforge` CLI; add policy if denied (follow AGENTS.md `auth.uid()` pattern) — `anon_all` policy (Command ALL, roles {anon}, qual true, with check true) already covers UPDATE; live no-op anon UPDATE verified; no policy added
- [x] 1.3 Create `test/stripe.test.js` scaffold (`node:test`, `procesarEvento` deps stub) so RED tests are runnable

## Phase 2: Core (stripe.js)

- [x] 2.1 RED: route test — bad/missing `stripe-signature` → 400, event never processed (threat row: signature verification)
- [x] 2.2 Extract `procesarEvento(event, deps)` in `src/stripe.js`; thin route wrapper: `constructEvent` throw → 400
- [x] 2.3 RED: `checkout.session.completed` missing `metadata.ordenId` → ack 200, no DB call (threat row: untrusted payload)
- [x] 2.4 RED: unknown `ordenId` → ack 200, no state change (threat row: untrusted payload)
- [x] 2.5 RED: `amount_total`/`moneda` mismatch → ack 200, order stays `pendiente` (threat row: untrusted payload)
- [x] 2.6 GREEN: verification flow — `obtenerOrden`, compare amount+moneda, `confirmarPagoOrden`, send Spanish `enviarMensaje` only if prior `estado !== 'pagada'`, log-only on WhatsApp failure
- [x] 2.7 RED: transient DB error on update → 500 (threat row: transient DB failure)
- [x] 2.8 GREEN: try/catch → log + 500 (Stripe retries); unrecoverable cases ack 200

## Phase 3: Integration / Wiring

- [x] 3.1 `src/insforge.js`: `guardarOrden` → `.insert([{ ... }])` array form + persist `moneda`
- [x] 3.2 `src/insforge.js`: add `obtenerOrden(ordenId)`, `marcarOrdenFallida(ordenId)`, `marcarOrdenCancelada(ordenId)`
- [x] 3.3 `src/sora.js`: pass `moneda: 'mxn'` to `guardarOrden`
- [x] 3.4 `src/stripe.js` `createPaymentLink`: add `payment_intent_data: { metadata }` so PaymentIntent carries `ordenId`
- [x] 3.5 Wire `payment_intent.payment_failed` → `marcarOrdenFallida`; `checkout.session.expired` → `marcarOrdenCancelada`

## Phase 4: Testing

- [x] 4.1 Unit: match → order `pagada` + WhatsApp confirmation sent
- [x] 4.2 Unit: duplicate completed event (prior `estado === 'pagada'`) → no WhatsApp re-send
- [x] 4.3 Unit: `payment_failed` → `fallida`; `expired` → `cancelada`
- [x] 4.4 Unit: WhatsApp send fails → logged, order stays `pagada`, ack 200
- [x] 4.5 Run `node --test` green + `node --check src/index.js`

## Phase 5: Cleanup

- [x] 5.1 Remove unused `confirmarPagoOrden` import from `src/sora.js`
- [x] 5.2 Confirm Spanish comments convention kept; no debug logs remaining

## Apply Notes (from sdd-apply)

- Extra migration `migrations/20260816081026_add-fallida-to-ordenes-estado-check.sql`: discovered during implementation that `ordenes_estado_check` rejected `fallida` (allowed only pendiente/pagada/cancelada); spec requires `fallida` on `payment_intent.payment_failed`. Constraint recreated to include `fallida`. Verified live.
- Deviation/refinement: `obtenerOrden` throwing (transient read error) → 500, distinct from "not found" (null) → ack 200. Design only specified not-found → ack; read failure is transient and should trigger Stripe retry.
- `marcarOrdenFallida`/`marcarOrdenCancelada` use `.maybeSingle()` so a missing order returns null (→ log + ack 200) instead of throwing (→ 500 retry storm).