```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:bf9c7d5e116d805ef0db26670e3574f4d28ad3f422637f03a290c0de9d8f8335
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 7/7
scenarios: 10/10
test_command: node --test
test_exit_code: 0
test_output_hash: sha256:bf9c7d5e116d805ef0db26670e3574f4d28ad3f422637f03a290c0de9d8f8335
build_command: node --check src/index.js
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: fix-payment-confirmation
**Version**: N/A (spec-driven, spec v1)
**Mode**: Standard (hybrid persistence — Engram + openspec)

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 23 |
| Tasks complete | 23 |
| Tasks incomplete | 0 |
| Specs | 7 requirements / 10 scenarios (from `openspec/specs/payment-confirmation/spec.md`) |
| Design | present (`design.md`) — coherence checked |

### Build & Tests Execution
**Build**: ✅ Passed
```text
node --check src/index.js
(exit 0 — no output)
```

**Tests**: ✅ 19 passed / 0 failed / 0 skipped
```text
node --test
1..19
# tests 19
# pass 19
# fail 0
# skipped 0
```

**Coverage**: ➖ Not available (config.yaml `coverage.available: false`; threshold 0). Unit coverage asserted behaviorally via injected deps rather than measured.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| R1 Verify Payment Before Marking Paid | Amount and currency match | `test/stripe.test.js > completed con monto y moneda correctos -> pagada + confirmacion por WhatsApp` | ✅ COMPLIANT |
| R1 Verify Payment Before Marking Paid | Amount or currency mismatch | `test/stripe.test.js > completed con discrepancia de monto` + `completed con discrepancia de moneda` | ✅ COMPLIANT |
| R2 Mark Order Failed on Failed Payment | Payment failure | `test/stripe.test.js > payment_failed con ordenId en metadata -> orden marcada fallida` | ✅ COMPLIANT |
| R3 Mark Order Canceled on Expired Session | Expired checkout session | `test/stripe.test.js > checkout.session.expired con ordenId -> orden marcada cancelada` | ✅ COMPLIANT |
| R4 Send WhatsApp Payment Confirmation | Confirmation delivered | `test/stripe.test.js > completed con monto y moneda correctos...` (asserts `enviarMensaje` msg) | ✅ COMPLIANT |
| R4 Send WhatsApp Payment Confirmation | Confirmation send fails | `test/stripe.test.js > completed con fallo de WhatsApp -> se registra, la orden queda pagada, ack 200` | ✅ COMPLIANT |
| R5 Handle Events Idempotently | Duplicate completed event | `test/stripe.test.js > completed duplicado (orden ya pagada) -> sin reenvio de WhatsApp` | ✅ COMPLIANT |
| R6 Acknowledge Unrecoverable Events | Missing order metadata | `test/stripe.test.js > completed sin metadata.ordenId -> ack 200` | ✅ COMPLIANT |
| R6 Acknowledge Unrecoverable Events | Order not found | `test/stripe.test.js > completed con orden desconocida -> ack 200` | ✅ COMPLIANT |
| R7 Signal Retry for Transient Failures | Transient database failure | `test/stripe.test.js > completed con falla transitoria de DB en update -> 500` + `en lectura -> 500` | ✅ COMPLIANT |

**Compliance summary**: 10/10 scenarios compliant (all covering tests passed at runtime).

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| R1 Verify before paid | ✅ Implemented | `src/stripe.js` `procesarCheckoutCompletado` compares `session.amount_total`/`session.currency` to `orden.total`/`orden.moneda`; mismatch → log + ack. `src/insforge.js` `confirmarPagoOrden` sets `estado:'pagada'`, `stripe_session_id`, `pagado_en`. |
| R2 Mark fallida | ✅ Implemented | `procesarPagoFallido` → `marcarOrdenFallida` (insforge.js `.update({estado:'fallida'})`); `payment_intent_data.metadata` in `createPaymentLink` carries `ordenId`. |
| R3 Mark cancelada | ✅ Implemented | `procesarSesionExpirada` → `marcarOrdenCancelada`. |
| R4 WhatsApp confirmation | ✅ Implemented | `enviarMensaje(orden.cliente_id, '¡Gracias por tu compra! Tu pago fue confirmado.')` after `pagada`; failure logged, order stays paid. |
| R5 Idempotent | ✅ Implemented | WhatsApp sent only if prior `estado !== 'pagada'`; updates re-apply same values. |
| R6 Acknowledge unrecoverable | ✅ Implemented | Missing metadata / order not found / mismatch → log + ack 200. |
| R7 Retry transient failures | ✅ Implemented | Read & update DB errors → 500; route returns 500 (not ack). |
| `guardarOrden` array insert | ✅ Implemented | `src/insforge.js` `.insert([{...}])`; `moneda` persisted; `src/sora.js` passes `moneda:'mxn'`. |
| `confirmarPagoOrden` import cleanup | ✅ Implemented | `src/sora.js` no longer imports `confirmarPagoOrden` (task 5.1). |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| Currency verification via additive `moneda` column (Option A) | ✅ Yes | Migration `20260816080808_add-moneda-column-to-ordenes.sql`; `guardarOrden`/`sora.js` persist `moneda:'mxn'`. |
| `payment_intent_data.metadata` for `payment_failed` | ✅ Yes | `src/stripe.js` `createPaymentLink` line 182. |
| WhatsApp dedup on prior `estado !== 'pagada'` | ✅ Yes | `procesarCheckoutCompletado` lines 106-116. |
| Extract testable `procesarEvento(event, deps)` | ✅ Yes | `src/stripe.js`; thin route wrapper → 400 on bad sig. |
| `guardarOrden` array-form insert | ✅ Yes | `src/insforge.js` line 19. |
| **DEVIATION** Extra migration `add-fallida-to-ordenes-estado-check` | ⚠️ Deviation | `ordenes_estado_check` rejected `fallida` (only pendiente/pagada/cancelada); constraint recreated to include `fallida`. Not in design's migration plan, but REQUIRED by spec R2. Does NOT break a spec. |
| **DEVIATION** `obtenerOrden` read error → 500 | ⚠️ Deviation | Design only specified not-found → ack; read error distinguished as transient → 500 (Stripe retry). Aligns with R7. Does NOT break a spec. |
| **DEVIATION** `marcarOrden*` use `.maybeSingle()` | ⚠️ Deviation | Missing order returns null → log + ack 200 instead of throwing → 500 retry storm. Aligns with R6. Does NOT break a spec. |

### Issues Found
**CRITICAL**: None.
**WARNING**:
1. Design deviation: extra migration `20260816081026_add-fallida-to-ordenes-estado-check.sql` (estado constraint) — not in the design's migration plan; necessary for spec R2. No spec broken.
2. Design deviation: `obtenerOrden` read error → 500 (design only documented not-found → ack). Refinement; aligns with R7. No spec broken.
3. Design deviation: `marcarOrdenFallida`/`marcarOrdenCancelada` use `.maybeSingle()` returning null for missing orders (→ ack 200). Refinement; aligns with R6. No spec broken.
**SUGGESTION**: Coverage is behavioral-only (no coverage tooling configured); consider adding `node --experimental-test-coverage` for measured coverage. Integration path (`stripe trigger checkout.session.completed`) is manual only per design.

### Verdict
**PASS WITH WARNINGS** — all 7 requirements / 10 scenarios implemented and covered by 19 passing runtime tests; build clean; 0 critical findings. Three design deviations exist (extra migration + two transient/not-found refinements) but none break a spec — all strengthen spec compliance.
