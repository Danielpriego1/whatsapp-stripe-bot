```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:7c44b2e57bb4acae8cdaf6264d5c7953d927b4499770254efe6450985b349164
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 7/7
scenarios: 10/10
test_command: node --test
test_exit_code: 0
test_output_hash: sha256:7c44b2e57bb4acae8cdaf6264d5c7953d927b4499770254efe6450985b349164
build_command: node --check src/index.js
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: wire-whatsapp-sora
**Version**: N/A (spec-driven, spec v1)
**Mode**: Standard (hybrid persistence — Engram + openspec)

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 15 |
| Tasks complete | 15 |
| Tasks incomplete | 0 |
| Specs | 7 requirements / 10 scenarios (from `openspec/specs/whatsapp-bot-messaging/spec.md`) |
| Design | present (`design.md`) — coherence checked |

### Build & Tests Execution
**Build**: ✅ Passed
```text
node --check src/index.js            (exit 0)
node --check src/whatsapp.js         (exit 0)
node --check src/sora.js             (exit 0)
node --check src/stripe.js           (exit 0)
node --check src/insforge.js         (exit 0)
(no output; combined build_output_hash sha256:e3b0c442... = SHA-256 of empty output)
```

**Tests**: ✅ 40 passed / 0 failed / 0 skipped
```text
node --test
1..40
# tests 40
# pass 40
# fail 0
# skipped 0
# duration_ms 1464.075943
```
Distribution: 4 sora.test.js + 19 stripe.test.js (regression) + 17 whatsapp.test.js = 40 (matches apply-progress claim 40/40).

**Coverage**: ➖ Not available (config.yaml `coverage.available: false`; threshold 0). Unit coverage asserted behaviorally via injected deps rather than measured.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| R1 Acknowledge Inbound Deliveries Immediately | Delivery acknowledged before processing | `test/whatsapp.test.js > ruta: acks 200 EVENT_RECEIVED antes de que termine el procesamiento` (stub axios post kept pending; 200 arrives anyway) | ✅ COMPLIANT |
| R2 Process Asynchronously with Error Containment | One message fails, others still processed | `test/whatsapp.test.js > procesarMensaje: enviarMensaje rechaza -> se registra, el siguiente mensaje sigue` + `procesarMensaje: soraResponder falla -> se registra y no lanza` | ✅ COMPLIANT |
| R3 Process Every Message in a Delivery | Multiple messages in one delivery | `test/whatsapp.test.js > ruta: payload multi-mensaje -> cada mensaje con indicador y respuesta` (asserts 2 indicators + 2 replies, per-message order) | ✅ COMPLIANT |
| R4 Skip Messages Without a Sender or Text | Message with no text | `test/whatsapp.test.js > ruta: mensaje sin from o sin texto -> se salta, sin respuestas, ack 200` + `procesarMensaje: sin from o sin texto -> no hace nada` | ✅ COMPLIANT |
| R5 Ignore Duplicate Message Deliveries | Meta redelivers the same message | `test/whatsapp.test.js > ruta: redelivery del mismo message.id -> procesado una sola vez, sin efectos` | ✅ COMPLIANT |
| R5 Ignore Duplicate Message Deliveries | Identifier outside the deduplication window | `test/whatsapp.test.js > dedupe: id pasado el TTL (10 min) -> yaProcesado vuelve a false` (mock timers, 10min+1ms) | ✅ COMPLIANT |
| R6 Send Exactly One Reply per Message | Payment request sends link exactly once | `test/sora.test.js > pagar -> { reply: null, alreadySent: true }...` + `comprar -> mismo contrato...` + `test/whatsapp.test.js > procesarMensaje: resultado sin reply (pago ya enviado) -> no envia segundo mensaje` | ✅ COMPLIANT |
| R6 Send Exactly One Reply per Message | Regular question gets one reply | `test/sora.test.js > precio/cotizar -> { reply: string, alreadySent: false }` + route multi-message test asserts one reply per message | ✅ COMPLIANT |
| R7 Indicate Typing and Mark Messages Read | Read receipt and typing indicator precede the reply | `test/whatsapp.test.js > marcarLeidoYEscritura: payload combinado read + typing_indicator` + `procesarMensaje: indicador y respuesta se envian en orden (indicador primero)` + route multi-message payload-order asserts | ✅ COMPLIANT |
| R7 Indicate Typing and Mark Messages Read | Indicator fails to send | `test/whatsapp.test.js > procesarMensaje: falla el indicador de lectura/escritura -> la respuesta se envia igual` + `ruta: falla el indicador de Graph -> la respuesta se envia igual (y 200)` | ✅ COMPLIANT |

**Compliance summary**: 10/10 scenarios compliant (all covering tests passed at runtime).

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| R1 Ack-fast | ✅ Implemented | `src/whatsapp.js` POST handler: dedupe/parse loop first, then `res.status(200).send('EVENT_RECEIVED')` with NO awaits before it (lines 139-167); processing runs in a fire-and-forget IIFE after the ack (lines 171-179). |
| R2 Async + error containment | ✅ Implemented | `procesarMensaje` per-step try/catch + `console.error` (lines 97-119); route wraps each message in its own try/catch (lines 173-177); a failure never throws into the ack path and never stops the next message. |
| R3 Every message processed | ✅ Implemented | Nested loops over `entry[].changes[].value.messages[]` collect ALL valid messages into `pendientes` (lines 151-164); sequential `for...of` processes each (line 172). |
| R4 Skip missing from/text | ✅ Implemented | Guard `if (!from || !text) return;` in `procesarMensaje` (line 93); route-level `if (!id || !from || !text || yaProcesado(id)) continue;` (line 159). |
| R5 Dedupe by message.id | ✅ Implemented | Module-level `Map<id, timestamp>` with TTL 10 min + cap 5000 + evict-oldest-on-overflow (lines 16-36); check+insert happens BEFORE `res.send` so in-flight redeliveries are caught (lines 159-160); past-TTL ids are processed again (`yaProcesado` returns false after sweep). |
| R6 Exactly one reply | ✅ Implemented | `src/sora.js` payment branch sends the link itself then returns `{ reply: null, alreadySent: true }` (lines 44-51); caller gates `if (resultado?.reply)` (whatsapp.js line 113); non-payment branches return a reply string with `alreadySent: false`. |
| R7 Typing + read indicator | ✅ Implemented | `marcarLeidoYEscritura` sends the documented combined payload `{ messaging_product, status: 'read', message_id, typing_indicator: { type: 'text' } }` (lines 70-77); called FIRST in `procesarMensaje` (line 98); failure wrapped in own try/catch — logged, reply still delivered (lines 97-101); indicator auto-dismisses on reply (no typing_off, per Meta docs). |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| Dedupe: in-memory `Map<id, timestamp>`, TTL 10 min, cap 5000, evict oldest | ✅ Yes | `src/whatsapp.js` lines 16-36; `DEDUPE_TTL_MS`, `DEDUPE_CAP`, lazy sweep in `yaProcesado`, eviction in `marcarProcesado`. |
| Check+insert during parse, before `res.send` | ✅ Yes | Route loop marks id before ack (lines 159-160), ack at line 167. |
| `soraResponder` structured `{ reply, alreadySent }`; payment returns `reply: null` after sending link | ✅ Yes | `src/sora.js` lines 18-52; "Te acabo de enviar..." string removed. |
| Caller sends only `if (resultado.reply)` | ✅ Yes | `src/whatsapp.js` line 113. |
| Dedicated indicator helper + shared `postGraphMessage(payload)`; combined read+typing payload, no typing_off | ✅ Yes | `postGraphMessage` (lines 42-52) + `marcarLeidoYEscritura` (lines 70-77); exact payload shape verified in test. |
| Indicator failure logged, never blocks reply | ✅ Yes | Lines 97-101; covered by two tests. |
| Sequential per-message processing, fire-and-forget after ack | ✅ Yes | `for...of await` in fire-and-forget IIFE (lines 171-179). |
| Injectable deps for `procesarMensaje` (stripe.js pattern) | ✅ Yes | `depsPorDefecto` (lines 83-87); same pattern in `src/sora.js` (`depsPorDefecto` lines 7-11). |
| New test files `test/whatsapp.test.js`, `test/sora.test.js` | ✅ Yes | Both present; 17 + 4 tests. |
| **DEVIATION** `procesarMensaje(from, text, deps, messageId)` 4th param | ⚠️ Deviation | Added `messageId` (default null) — required by the design's OWN `marcarLeidoYEscritura(from, messageId)` contract; POST passes the real id. 3-arg form unchanged. Does NOT break a spec. |
| **DEVIATION** `soraResponder(from, texto, deps)` optional 3rd param | ⚠️ Deviation | Injectable deps for testability (task 2.1 mandate); 2-arg call unchanged. Does NOT break a spec. |
| **DEVIATION** POST no longer logs each inbound message | ⚠️ Deviation | Old log-only block removed (task 5.1 cleanup); only errors logged. Does NOT break a spec. |
| **DEVIATION** Messages without `message.id` skipped | ⚠️ Deviation | `!id` added to the `!from`/`!text` skip — cannot dedupe without identity. Extends, does NOT break a spec. |

### Issues Found
**CRITICAL**: None.
**WARNING**:
1. Design deviation: `procesarMensaje(from, text, deps, messageId)` — 4th param added to satisfy the design's own `marcarLeidoYEscritura(from, messageId)` contract. Non-spec-breaking; 3-arg form unchanged.
2. Design deviation: `soraResponder(from, texto, deps = depsPorDefecto)` — optional 3rd param for injectable deps (required by task 2.1). Non-spec-breaking; 2-arg call unchanged.
3. Design deviation: POST handler no longer logs each inbound message (stale log-only block removed per task 5.1). Non-spec-breaking; errors are still logged.
4. Design deviation: messages without `message.id` are skipped (`!id` guard). Non-spec-breaking; dedupe requires identity.
**SUGGESTION**:
1. Coverage is behavioral-only (no coverage tooling configured); consider `node --experimental-test-coverage` for measured coverage.
2. Live end-to-end path (real Meta creds → actual Graph reply) is manual-only per config; integration tests use mocked axios.
3. Change size (~700 added lines, mostly tests) exceeded the 250-350 Low forecast — already explicitly resolved by orchestrator as single PR (recorded in apply-progress); flag for future forecasts.

### Verdict
**PASS WITH WARNINGS** — all 7 requirements / 10 scenarios implemented and covered by 40 passing runtime tests (0 failed); build clean on all 5 files; 0 critical findings. Four design deviations exist (extra `messageId`/`deps` params, dropped per-message logging, `!id` skip) but none break a spec — all are refinements consistent with spec intent.
