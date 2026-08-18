# Archive Report: wire-whatsapp-sora

**Change**: wire-whatsapp-sora
**Archived on**: 2026-08-17 (ISO)
**Archived to**: `openspec/changes/archive/2026-08-17-wire-whatsapp-sora/`
**Artifact store mode**: hybrid (Engram MCP + openspec filesystem)
**Archived by**: sdd-archive executor

## Gates

### Task Completion Gate — PASSED
- Persisted tasks artifact: `tasks.md` — **15/15 implementation tasks marked `[x]`, 0 unchecked** (verified on the archived copy).
- Apply-progress (Engram #17) confirms 15/15 complete; verify-report confirms 15/15. No stale unchecked tasks in the audit trail.

### Review Gate — NO NATIVE REVIEW RECEIPT
- No review artifacts exist: Engram search `sdd/wire-whatsapp-sora/review` returned no memories; no `review/` directory or transaction/ledger/receipt files on the filesystem.
- Review was **not run** in this cycle — the change went proposal→spec→design→tasks→apply→verify directly. Per orchestrator direction, the native review receipt gate applies only when such review artifacts exist; they do not here, so the gate does not block.
- Proceeding because `verify-report.md` verdict is **PASS WITH WARNINGS** with **0 CRITICAL** findings (blockers: 0, critical_findings: 0).

### Verification Status — PASS WITH WARNINGS (no CRITICAL)
- 7/7 requirements, 10/10 scenarios COMPLIANT; 40/40 tests pass (`node --test`, exit 0: 4 sora + 19 stripe regression + 17 whatsapp); build clean (`node --check` on src/index.js, whatsapp.js, sora.js, stripe.js, insforge.js — all exit 0).
- 4 warnings: design deviations, none spec-breaking — (1) `procesarMensaje(from, text, deps, messageId)` extra 4th param (required by the design's own `marcarLeidoYEscritura(from, messageId)` contract); (2) `soraResponder(from, texto, deps)` optional 3rd param (testability, task 2.1 mandate); (3) POST no longer logs each inbound message (task 5.1 stale log-only cleanup); (4) messages without `message.id` skipped (`!id` guard — dedupe requires identity). Non-blocking for archive.

## Spec Sync

| Domain | Action | Details |
|--------|--------|---------|
| whatsapp-bot-messaging | **Already source of truth — no copy/merge needed** | The full spec was written **directly** to `openspec/specs/whatsapp-bot-messaging/spec.md` during `sdd-spec` (confirmed by Engram spec observation #14: "NEW full spec at openspec/specs/whatsapp-bot-messaging/spec.md. 7 requirements / 10 scenarios"). Verified on filesystem before archive: no `specs/` delta folder existed inside `openspec/changes/wire-whatsapp-sora/`; main spec is complete — 7 requirements / 10 scenarios (Given/When/Then, RFC 2119 keywords). Matches verify-report's referenced spec (7/7 requirements, 10/10 scenarios). |

No delta merge was required (no delta sections — ADDED/MODIFIED/REMOVED/RENAMED — existed; the change introduced a brand-new full spec that was already placed at the source-of-truth path).
`rules.archive` ("Warn before merging destructive deltas"): **not triggered** — no destructive merge performed.

## Archive Contents

- proposal.md ✅
- specs/whatsapp-bot-messaging/spec.md ✅ (materialized copy from main spec — the change folder never contained a `specs/` delta dir because sdd-spec wrote the full spec straight to `openspec/specs/`; copied into the archive so the audit trail is self-contained. `diff` vs main spec: IDENTICAL.)
- design.md ✅
- tasks.md ✅ (15/15 tasks complete, 0 unchecked)
- verify-report.md ✅ (PASS WITH WARNINGS, 0 CRITICAL)

## Source of Truth Updated

The following spec now reflects the new behavior (unchanged by archive — it was already the source of truth):
- `openspec/specs/whatsapp-bot-messaging/spec.md` — 7 requirements / 10 scenarios (ack-fast 200 EVENT_RECEIVED; async processing with error containment; every message in a delivery processed; skip missing sender/empty text; dedupe by message.id within window; exactly one reply per message incl. payment branch; combined read + typing indicator with failure containment).

## Engram Traceability (observation IDs)

| Artifact | Engram Observation ID |
|----------|----------------------|
| proposal | #6 (`sdd/wire-whatsapp-sora/proposal`) |
| spec | #14 (`sdd/wire-whatsapp-sora/spec`) |
| design | #15 (`sdd/wire-whatsapp-sora/design`) |
| tasks | #16 (`sdd/wire-whatsapp-sora/tasks`) |
| apply-progress | #17 (`sdd/wire-whatsapp-sora/apply-progress`) |
| verify-report | #18 (`sdd/wire-whatsapp-sora/verify-report`) |
| review | none — review was not run (no native review receipt) |
| archive-report | this artifact (`sdd/wire-whatsapp-sora/archive-report`) |

## Notes / Reconciliation

- No archive-time exceptional repairs performed. All 15/15 tasks were already `[x]` in the persisted `tasks.md`; no stale-checkbox reconciliation needed. Archive is **standard**, not intentional-with-warnings (verify warnings are design deviations, all non-spec-breaking; 0 CRITICAL).
- No `state.yaml` existed in the change folder (consistent with the prior `2026-08-16-fix-payment-confirmation` archive, which also archived without one).

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. Ready for the next change.
