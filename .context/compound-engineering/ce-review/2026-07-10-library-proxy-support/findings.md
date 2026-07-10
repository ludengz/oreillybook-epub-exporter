# ce:review run — feat/library-proxy-support (mode:autofix)

- Date: 2026-07-10
- Scope: `git diff 62a0f5b` (merge-base with feat/download-quality-gate, the stacked base), 11 files, +918/−60
- Plan: docs/plans/2026-07-09-002-feat-library-proxy-support-plan.md (plan_source: explicit)
- Reviewers (8, model opus per project policy): correctness, security, reliability, adversarial, testing, maintainability, project-standards, agent-native. learnings-researcher skipped — docs/solutions/ does not exist.
- Verdict: **Ready with fixes applied** — 0 P0/P1; six fixes applied in-branch (four safe_auto + F6/F7 by user decision); five residual items below (F1/F2/F3/F8 + one advisory).

## Cross-reviewer convergence (the headline signal)

Four independent reviewers (correctness, reliability, adversarial, testing) converged on **F1**: a legitimate same-origin 3xx from any O'Reilly endpoint, seen through the new `redirect: 'manual'`, becomes `response.type === 'opaqueredirect'` → SESSION_EXPIRED → whole-download abort with a misleading "session expired" message. Convergence boosted merged confidence to 0.72. **Trigger premise checked against live SPL probing (Unit 1, 2026-07-10): authenticated `redirect:'manual'` requests to chapter (xhtml), image (png), and files-JSON endpoints all returned `type:'basic'`, 200 — no O'Reilly resource endpoint was observed to redirect.** So the code path is real but the trigger is not observed at SPL. Recorded as residual, not blocking.

## Applied fixes (safe_auto, verified by 207-test green run)

| # | Finding | Reviewer(s) | Fix |
|---|---------|-------------|-----|
| F4 | fetchCoverFallback dropped its local allowlist gate → the SW `fetchImage` handler is the single enforcement point, but the real handler was tested only against `learning.oreilly.com` and only in the reject direction | testing (0.62) + security + adversarial | Two cases added to `background.js fetchImage proxy`: entry-check acceptance of the proxy host, and post-redirect acceptance of a URL staying on an allowlisted host (commit b3b62b0) |
| F5 | Plan mermaid diagram still labelled the expiry edge with the `text/html on /api/` predicate the same plan's P5 disproved and the code never shipped | project-standards (0.6) | Relabelled to "opaque redirect / HTTP 401" (b3b62b0) |
| F9 | "The real O'Reilly host" encoded as three unlinked literals in two spellings | maintainability (0.64) | New `PathUtils.DIRECT_HOST` constant; two logic sites collapsed onto it; pinned to the allowlist by a test (commit 7c3d2db). Zero behavior change |
| F10 | Two comments narrated deleted code ("used to die inside .json()") | maintainability (0.60) | Present-tensed (b3b62b0) |

## Residual actionable work (gated_auto / advisory — not auto-applied per autofix policy)

1. **[P2] F1 — opaqueredirect is fatal for every fetched resource, including per-asset image/CSS.** A single legitimate redirect anywhere aborts the whole book as "session expired." Trigger not observed at SPL (Unit 1). Reviewers' suggested direction: keep opaqueredirect→SESSION_EXPIRED fatal for the manifest and chapter fetches (the load-bearing "did the session die" signals — manifest is the first call, chapters are core content), but let image/CSS asset fetches fall through to their existing non-fatal `recordImageFailure`/`recordCssFailure` path so one redirecting asset degrades gracefully instead of killing the download. Caveat: a genuine mid-download expiry would then surface via the chapter fetches rather than the image phase, which is acceptable (the manifest fetch already gates the start). Decision deferred — changes abort semantics.
2. **[P2] F2 — retry backoff sleeps are not abort-aware.** `_fetchWithRetry`'s `setTimeout` sleeps (fetcher.js:33 rate-limit wait, :43 backoff) ignore the AbortSignal; a cancel mid-sleep is delayed up to ~9s (generic) or an uncapped `Retry-After`. Pre-existing for chapter/image loops, but the manifest fetch is newly routed through it and runs before the first progress message, so the stall is now user-visible. Fix: race the sleep against an `abort` listener; optionally cap `Retry-After`.
3. **[P2] F3 — manifest retry phase has no aggregate timeout and emits no progress.** Worst case per page ~163s (five uncapped 429 waits + backoff) × pages, with a static "downloading" popup and the SW rejecting new downloads. Fix: emit a "fetching manifest" heartbeat and/or bound the phase.
4. **[P2] F6 — RESOLVED (commit 35377bf).** Added `mode: 'direct'|'proxy'` to the report (rides both terminal messages + the reportByTab snapshot). Not added to the frozen `bookDetected` payload. Tests pin both branches.
5. **[P2] F7 — RESOLVED (commit 35377bf).** Subsumed by F6's `mode` field: a consumer composes `errorKind === 'session' && mode === 'proxy'` — no combinatorial errorKind enum.
6. **[P3] F8 — `pageOrigin()` is impure and SW-reachable, in a module documented as "pure helpers."** Guarded only by a comment; `rewriteToPageOrigin` already defuses SW misuse defensively (returns the URL unchanged when the page origin isn't https, which it is not in the SW). Reviewer's cleaner shape: inject the origin as a parameter, `rewriteToPageOrigin(url, pageOrigin)`, moving the impure read into content.js. Cost: reworking the tests that stub `PathUtils.pageOrigin`.
7. **[advisory] `rewriteToPageOrigin` preserves userinfo and strips a non-default port** (adversarial residual risk). Not reachable with real O'Reilly URLs (no userinfo, default 443), so latent, not active. Note for any future call site that might pass such URLs.

## Testing gaps recorded (not blocking)

- No test drives `_fetchWithRetry` with a legitimate (non-login) same-origin 3xx to pin whether it is followed or aborted — the crux of F1. Untestable against a third party's servers; only monitoring can guard it.
- No test for cancel latency during the manifest's new `_fetchWithRetry` backoff (F2).
- No integration test routes a proxied CDN host end-to-end (SPL's CDN is direct; another library proxying it is documented per-library variance with no coverage).

## Coverage

- Suppressed: reviewer-side (<0.60) suppression only; no synthesis-level drops.
- Untracked files excluded from scope (pre-existing repo junk): `.playwright-mcp/*`, `AGENTS.md`, `docs/brainstorms/*`, `docs/ideation/2026-04-05-*`, `docs/images/mockups.html`, `docs/plans/2026-04-05-*`, `oreilly-epub-extension/diff.txt`.
- learnings-researcher not run (docs/solutions/ absent).
- Both reviewer batches ran synchronously in-process after an earlier background dispatch was lost to a process-boundary restart (0-byte transcripts, no partial work recoverable).

## Requirements completeness (plan_source: explicit)

- R1 activate on the proxy host + full pipeline — met (Unit 2; manifest + origin normalization).
- R2 absolute-URL normalization + image resolution — met (rewriteToPageOrigin + cover gate removal; Unit 1 showed no CDN host to declare).
- R3 expiry detection + library-specific guidance, no login page packaged — met (Unit 3; opaqueredirect predicate). F1 is a robustness refinement of this mechanism, not a gap in it.
- R4 zero direct-mode regression, epubcheck-clean — met (207 tests green; epubcheck 0/0/0 on direct + proxy fixtures).
- R5 one-edit-per-library + OpenAthens no-op — met (README + bidirectional sync test).
- All 4 implementation units checked off.
