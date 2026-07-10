# ce:review run — feat/download-quality-gate (mode:autofix)

- Date: 2026-07-09
- Scope: `git diff d5eeedb` (master merge-base), 17 files, +1936/−42, branch feat/download-quality-gate
- Plan: docs/plans/2026-07-09-001-feat-download-quality-gate-plan.md (plan_source: explicit)
- Reviewers (9, model opus per project policy): correctness, testing, maintainability, project-standards, reliability, adversarial, julik-frontend-races, security, agent-native. learnings-researcher skipped — docs/solutions/ does not exist.
- Verdict: **Ready with fixes applied** — 0 P0/P1; all safe_auto findings fixed in-branch; residuals below.

## Applied fixes (safe_auto queue, verified by 181-test green run)

| # | Finding | Reviewer(s) | Fix |
|---|---------|-------------|-----|
| F1 | `&`/`"` in source filenames makes the OPF malformed → the new gate hard-blocks the book as an "extension bug" (escalated latent builder bug) | adversarial (0.62) | XML-escape hrefs in `generateOpf` (Styles/Text/Images) and the cover `src` in `generateCoverXhtml`; regression test `fig&1.png` (well-formed OPF + clean validator reconciliation) |
| F2 | Popup headline renders "0 issues found" under a ⚠ banner for coverless/fallback-metadata clean downloads; popup and notification disagree | correctness (0.8) + adversarial (0.82) → 0.92 | `!clean && problemCount===0` → headline "Downloaded with notes"; new `notes` fixture in popup-preview.html, visually verified |
| F3 | Error-outcome reports rendered via renderReport show misleading "metadata fallback"/"integrity skipped" notices (error path hardcodes flags false) | correctness (0.62) | Notices now gated on `!isError` (matching the cover notice) |
| F4 | `content_script_unreachable` rollback destroys the tab's previously completed report | adversarial (0.75) | Rollback restores `reportByTab` from the pre-start snapshot; regression test added |
| F5 | `errorKind` enum computed but unused ('session'/'download'); session-ness re-derived by substring match — two sources of truth | maintainability (0.66) + agent-native | `errorKind` now persisted on the report and used by the SW notification title (substring kept only as a dev-reload fallback) |
| F6 | CLAUDE.md drift: "Bodies carry the report summary" overstates the failure path | project-standards (0.62) | Doc wording corrected (completion=summary, failure=error text) |
| F7 | CSS failure tier (stylesheet + background-image) had zero test coverage | testing (0.85) | New content-lifecycle test drives both failure kinds |
| F8 | SESSION_EXPIRED rethrow guards in image/CSS catches untested | testing (0.72) | New test: 401 on a phase-1 image → downloadError errorKind 'session' |
| F9 | FAILURE_DETAIL_CAP truncation untested | testing (0.8) | New test: 52 failing images → detail 50, total 52 |
| F10 | validateBlob compressed-mimetype fatal branch untested | testing (0.82) | New test: DEFLATE-compressed mimetype blob → fatal |

Post-fix verification: 181 browser tests / 0 failed (port-isolated run); epubcheck 5.1.0 on generated output 0/0/0 (pre-fix run; the href-escaping change is byte-identical for fixture filenames and covered by the new well-formedness test).

## Residual actionable work (downstream-resolver; not auto-applied)

1. **[P2] Serialize SW state mutations** (reliability 0.62 + julik 0.60, largely pre-existing pattern widened by this diff): `getState→merge→set` read-modify-write in every handler can interleave (e.g. an in-flight `progress` resurrecting a just-cancelled/completed state, stale badge writes). Concrete fix: a small promise-chain mutex around state mutations in background.js (~15 lines), or re-check `isCurrentAttempt` inside a single critical section. Practical window is small (single download at a time + attemptId guards); recommend as a follow-up hardening change with an interleaving test.
2. **[P2, pre-existing] Stranded `status:'downloading'` on tab reload/SPA-navigation/renderer crash** (reliability 0.66): no terminal message and no `tabs.onRemoved` → `already_downloading` blocks future downloads until manual Cancel. Fix direction: `tabs.onUpdated`/webNavigation listener resetting state when `downloadingTabId` reloads, or self-healing in the startDownload gate.
3. **[P3, pre-existing] Content-side `startDownload` early-returns (`abortController` set / `!isbn`) leave the SW in 'downloading'** (reliability 0.60): send a terminal/abort message on early return.

## Advisory (report-only)

- Extract the shared "problem count" formula (popup renderReport vs SW reportSummaryText) into one helper to prevent surface drift (maintainability 0.72; partially mitigated — headline logic fixed, formulas still duplicated).
- Popup pure decision logic (clean/problemCount/isValidation) has no assertion-bearing harness; consider extracting into a testable helper (testing 0.9, advisory).
- Test-side `withNoRetries` duplicated across suites (maintainability 0.68); validator fail-open try/catch duplicated for the two phases (0.61); `rethrowIfFatal` guard repeated at 4 catch sites (0.62).
- Notification suppression handshake gap: a terminal event between port-connect and `popupViewing` fires a redundant (never lost) notification (julik 0.62 — consistent with the stated fail-notify design).
- Cancel-button jank (pre-existing): an in-flight `progressUpdate` can briefly revert the popup's optimistic 'ready' (julik 0.68).
- `notificationTabs` map can accumulate entries within a session if `onClosed` never fires (bounded by session lifetime).
- Fail-open coupling: a structural-validator self-error also skips the physical blob check (intentional fail-open; the two phases are not independent).
- popup-preview.html markup mirrors popup.html by hand (documented; drift risk accepted for a dev harness).
- Security review: no findings ≥0.60. textContent-only rendering confirmed; no externally_connectable; attemptId (crypto.randomUUID) never exposed to page main world; fetchImage allowlist unchanged.
- Agent-native parity holds: everything the popup renders is reachable via getState (reportByTab), all new chrome surfaces are mock-observable.

## Requirements completeness (plan_source: explicit)

- R1 failure bookkeeping — met (Unit 2 + F7/F9 coverage)
- R2 severity-tiered validator — met (Unit 3, test-first)
- R3 report panel + re-download + persistence — met (Unit 4; popup rendering verified via fixture harness screenshots)
- R4 tab-scoped notifications + click-to-focus + cancel-silent — met (Unit 5)
- R5 attemptId guards + timer removal + stable complete — met (Unit 1)
- All 5 implementation units checked off in the plan.

## Coverage

- Suppressed: reviewer-side (<0.60) suppression only; no synthesis-level drops.
- Untracked files excluded from scope: `.playwright-mcp/*`, `AGENTS.md`, `docs/brainstorms/*`, `docs/ideation/2026-04-05-*`, `docs/images/mockups.html`, `docs/plans/2026-04-05-*`, `oreilly-epub-extension/diff.txt` (pre-existing repo junk; `.gitignore` is ideation idea #2's scope).
- learnings-researcher not run (docs/solutions/ absent).
- Pre-existing findings (reliability #2/#3, julik cancel-jank, background.js non-IIFE style) do not count toward the verdict.
