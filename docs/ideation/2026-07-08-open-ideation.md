---
date: 2026-07-08
topic: open-ideation
focus: none (open-ended)
---

# Ideation: O'Reilly EPUB Extension Open Improvement Ideas (Round 2)

Follow-up to `2026-04-05-open-ideation.md`. That round's ideas were used as a dedup baseline: done/partial items (test harness, multi-tab isolation, pure-function extraction) and its 18 rejections were not re-proposed; undone items (structure preview, IndexedDB resume, e-ink CSS profiles, hierarchical TOC) were only revisited when a fresh angle existed.

## Codebase Context

- **Project**: Chrome MV3 extension, Vanilla JS, no build step. Three-layer arch: Popup ↔ Service Worker ↔ Content Script. Libs as globals (Fetcher, EpubBuilder, EinkOptimizer, PathUtils), load-order-sensitive.
- **Since last round**: 79 browser tests + `chrome-mock.js` landed (c9bad25); multi-tab state isolation fixed (801b074); epubcheck 0 errors achieved (c9bad25). CI automation still missing; no linter; repo junk untracked (`diff.txt`, `.playwright-mcp/`); `docs/solutions/` still absent.
- **Historical failure hotspots** (each a major fix commit): image pipeline (af2636a: CORS, entity encoding, `?query` 404s), O'Reilly HTML cleaning (2ba6898: wrapper divs duplicating content), EPUB compliance + download-state reset (c9bad25: abortController not reset on all exit paths), multi-tab state (801b074: `chrome.storage.session` shallow-merge trap).
- **Hard constraints**: keep epubcheck 0 errors; single download at a time (deliberate — rate limits); no build step/frameworks; metadata via search API not DOM scraping.
- **Convergence signal**: 4 ideation frames (user pain / step removal / assumption-breaking / leverage) independently converged on CI gating (3 frames), pre-package self-check + quality report (3 frames), download queue (3 frames), and cross-reference link rot (2 frames).

## Ranked Ideas

### 1. Download Quality Gate: Pre-Package Self-Check + Quality Report + Retry-Failed-Only
**Description:** Before `zip.generateAsync`, run a pure-JS invariant validator (OPF manifest ↔ ZIP entries ↔ spine three-way reconciliation; mimetype first entry STORE; chapters parse without `parsererror`). On completion, show a quality report (N chapters OK / M placeholder / K images failed across all fallback strategies) with a "retry failed items only" button, plus a `chrome.notifications` system notification on complete/fail (popup-closed downloads currently end with a ✓ badge that clears after 5s).
**Rationale:** Failed chapters are silently replaced with placeholder pages (`content.js:275-284`) and image failures only `console.warn` — users discover missing content on their e-ink device, the worst possible moment. Both historical EPUB compliance incidents were discovered post-hoc on reader devices; `content.js:387-389` comments already state the invariant ("anything in the ZIP but missing from the OPF manifest makes the EPUB invalid") that nothing enforces.
**Downsides:** Validator must stay in sync with epub-builder or it produces false alarms.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 2. CI Gate + Engineering Baseline Bundle
**Description:** GitHub Actions workflow: headless Chromium runs the existing 79 tests via `test-runner.html`, then epubcheck runs against a fixture EPUB built by EpubBuilder as a 0-errors gate. Bundle: ESLint flat config (`no-undef` catches global-object typos — high value in an IIFE/globals codebase), a static check that `manifest.json` content-script order satisfies declared `// @requires` dependencies, `.gitignore` for `diff.txt`/`.playwright-mcp/`, and a release script (bump version → test → zip).
**Rationale:** Completes last round's idea #1 (harness landed, automation didn't). All four historical incidents were regression-type bugs; the epubcheck-0-errors hard constraint currently has no machine enforcement.
**Downsides:** epubcheck needs a JVM in CI; one-time setup friction.
**Confidence:** 92%
**Complexity:** Low
**Status:** Unexplored

### 3. Rich OPF Metadata + API Cover + Unicode-Safe Filenames
**Description:** The search API response already contains `language`, `publishers`, `description`, `issued`, `subjects`, and `cover_url` — all currently discarded (`content.js:13-28` keeps only title/authors); `dc:language` is hardcoded `'en'` and the cover is guessed from filenames (`EpubBuilder.findCoverImage`). Write real metadata into the OPF; use `cover_url` (via the existing SW CORS proxy) as cover fallback. Also fix the filename sanitizer (`content.js:408`): `[^a-zA-Z0-9\s-]` strips CJK/accented titles to an empty string, producing files named `.epub` — fall back to ISBN when the sanitized result is empty and only strip filesystem-illegal characters.
**Rationale:** The CJK filename bug reproduces 100% for non-English books; wrong `dc:language` breaks hyphenation/dictionary on Boox/Kobo; the data is already in an API response we fetch — it's pure plumbing.
**Downsides:** Nearly none; `cover_url` field presence needs live verification.
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 4. SPA Route-Change Book Re-Detection
**Description:** `detectBook()` runs once at content-script injection (`content.js:421`), but O'Reilly is a React SPA — navigating from book A to book B in-page never re-runs it, so the popup shows stale book info. Re-detect on `chrome.webNavigation.onHistoryStateUpdated` (or content-side URL observation).
**Rationale:** This is the twin of the just-fixed multi-tab wrong-book incident (801b074) — the same state-staleness root cause, surviving via same-tab navigation instead of cross-tab confusion.
**Downsides:** SPA routing timing needs care (window where URL changed but book data isn't ready).
**Confidence:** 88%
**Complexity:** Low
**Status:** Unexplored

### 5. Intra-Book Cross-Reference and Footnote Link Rewriting
**Description:** Chapters are renamed to `chapter_NN.xhtml` (`content.js:271`), but `EinkOptimizer` only rewrites `img`/CSS paths (`eink-optimizer.js:13-50`) — footnotes and cross-references like `<a href="ch03.html#fn12">` point at files that don't exist in the ZIP. Build an originalPath→newFilename map (data already at hand where renaming happens) and rewrite all internal `a[href]`, preserving fragments. First step: verify actual link-rot extent with a footnote-heavy real book.
**Rationale:** Two ideation frames independently found this gap. Technical books lean heavily on footnotes and "see Chapter 3" references; dangling hrefs are also a latent epubcheck error source (RSC-007) — current 0-errors may just mean test samples had no internal links.
**Downsides:** External-link/anchor edge cases; needs live verification before sizing.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 6. Content-Level E-Ink Optimization Pipeline: Image Transcoding + Code/Table Handling
**Description:** Current "e-ink optimization" is one injected CSS file. Add content-level transforms: before images are written to the ZIP (`content.js:226,334,349` are the natural insertion points), pipe through OffscreenCanvas — downsample oversized screenshots to device width, grayscale color images, PNG→JPEG for photos; in chapters, soft-wrap long `<pre>` lines and add fallback wrapping for overwide tables. User-toggleable. Distinct from last round's "e-ink CSS customization/device profiles" idea: this transforms content, not user-adjustable styling.
**Rationale:** O'Reilly technical books are code blocks + tables + 2000px color PNGs; EPUBs routinely exceed 100MB, causing slow page turns on Boox, and truncated code lines make chapters unreadable — the largest gap in the product's stated core mission (e-ink optimization).
**Downsides:** Lossy transcoding risk (must be optional); highest complexity among survivors after #7.
**Confidence:** 75%
**Complexity:** Medium-High
**Status:** Unexplored

### 7. Serial Download Queue
**Description:** "Add to queue" on multiple book pages (later: paste ISBN/URL); the service worker holds a FIFO and auto-starts the next book when the current one completes. Concurrency stays 1 — the queue serializes, never parallelizes.
**Rationale:** Three ideation frames independently proposed this. Batch-stockpiling books is typical e-ink user behavior; today 5 books = babysitting 5 sequential 5-10 minute downloads. Technically the pipeline only needs an ISBN (all fetches are isbn-parameterized API paths), so queue items don't need a live page.
**Downsides:** Highest complexity of the survivors — touches all three layers and changes download-state semantics. Note: the multi-tab fix explicitly scoped queues out at the time (a bug-fix scoping decision about concurrent downloads, not a permanent veto; serial + cooldown avoids the rate-limit concern).
**Confidence:** 78% (raised from 72% after deep dive)
**Complexity:** High
**Status:** Unexplored

**Deep-dive analysis (2026-07-08):**
- **Single page dependency confirmed**: `content.js:86` `Fetcher.extractIsbn(window.location.href)` is the only page-coupled line in the whole download pipeline; everything downstream (`content.js:97,122`) is isbn-parameterized relative API paths with cookie auth.
- **Architecture options**: (A) queue of `{tabId, isbn}`, chain via `chrome.tabs.sendMessage` to each book's own tab — fragile, dies with closed/discarded tabs. **(B, recommended)** parameterize `startDownload(isbn)`; any learning.oreilly.com tab acts as execution proxy; queue items are `{isbn, title}` independent of tab lifetime; on `content_script_unreachable` (rollback precedent at `background.js:80-85`), find another reachable tab via `chrome.tabs.query`, else suspend queue. (C) move download into SW — rejected last round (MV3 SW termination), not re-litigated.
- **Hidden semantic crack**: popup's `downloadingBookInfo` is derived as `bookInfoByTab[downloadingTabId]` (`background.js:59-61`), assuming "the downloading book = the book that tab shows". Proxy downloads break this; option B must promote the downloading book's `{isbn, title}` to a global state field. Idea #4 fixes the other half of the same assumption — the two share the state-decoupling work.
- **Chaining insertion point**: `downloadComplete` (`background.js:129-143`) ends with a 5s `setTimeout` badge reset — a known MV3 hazard (SW may die first). Queue advancement must run immediately in the `downloadComplete` handler, never behind that timer.
- **Shallow-merge trap redux**: queue is nested state; per the 801b074 lesson, write dedicated `enqueue/dequeue` helpers (read-modify-write like `setTabBookInfo`), never `setState({queue})`. Deeper: `setState` is get-then-set, non-atomic — user enqueue racing chain-advance can drop writes; needs simple SW-side write serialization. Queue multiplies state-transition combinations — this is the natural trigger point for the (rejected-this-round) explicit state machine refactor; consider bundling.
- **Rate-limit accumulation**: serial adds no instantaneous concurrency, but 5 books = 30-60 min sustained traffic; add a configurable 30-60s inter-book cooldown.
- **Failure semantics**: `SESSION_EXPIRED` → pause queue + reuse existing `chrome.notifications` (`background.js:156-163`); other errors → skip, record, summarize at queue end (dovetails with idea #1's quality report).
- **Persistence choice (open)**: `chrome.storage.session` (consistent with current state, queue dies with browser — clean semantics) vs `chrome.storage.local` (survives restart but needs resume-confirmation UX). Leaning session; decide in brainstorm.
- **Phasing**: P1 = `startDownload(isbn)` + queue helpers + "add to queue" button + immediate chaining + global downloadingBookInfo; P2 = queue UI (item cancel/clear), cooldown, skip-and-summarize; P3 (optional) = paste ISBN/URL enqueue without opening pages.
- **Verification**: unit tests for queue helpers + chrome-mock message-flow tests (`already_downloading` → enqueued; complete → chain); manual scenarios: close proxy tab mid-queue, cancel mid-queue, session expiry mid-queue; full 79-test regression. Prerequisite recommendation: land #2 (CI) first — the queue sits exactly on the historically bug-densest state-management path.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Record-replay full-pipeline fixtures + adversarial HTML corpus + API contract snapshots | Real leverage but heavy; depends on CI (#2) landing first — recommend as next round's infrastructure |
| 2 | Persistent API response cache (second re-download in seconds) | Overlaps prior IndexedDB-resume infrastructure; dev-side pain solved cheaper by CI/fixtures |
| 3 | Session-expiry pause-and-resume (in-memory) | Subset of prior round's undone IndexedDB resumable-downloads idea |
| 4 | Rate-limit backoff surfaced in progress UI + adaptive pacing | Surfacing is narrow (can ride along with #1); adaptive speed-up risks triggering stricter limits |
| 5 | Explicit download lifecycle state machine | Root cause is real, but refactor belongs after the CI safety net; natural bundle with #7 if pursued |
| 6 | Structured download log + diagnostics export | Overlaps #1's quality report; better as its implementation detail |
| 7 | Shared messages.js protocol module | Message surface still small; abstraction cost exceeds value until queue-scale protocol growth |
| 8 | Backfill docs/solutions/ knowledge base | Just execute via existing /ce:compound workflow; doesn't need ideation ranking |
| 9 | Nightly real-book smoke canary | Maintenance cost and ToS sensitivity too high; contract-sentinel needs coverable manually |
| 10 | Markdown export target | Interesting but drifts from the e-ink EPUB core mission; better as a brainstorm variant |
| 11 | Online-reading enhancement mode (inject e-ink CSS into O'Reilly reader) | Product identity drift; overlaps O'Reilly's own reader settings |
| 12 | Playlist → anthology EPUB | Depends on unverified playlist API; cross-book resource collisions complex; brainstorm variant |
| 13 | Chapter-selection export (subset EPUB) | Incremental upgrade of prior round's undone structure-preview idea; mid value, below survivors |
| 14 | Early Release update detection + incremental re-export | Niche audience; depends on persistent-cache infrastructure not yet built |
| 15 | In-page one-click download button | Real but minor friction; value below survivors |
| 16 | System notifications (standalone) | Not rejected — merged into #1 |
| 17 | ISBN/URL paste enqueue (standalone) | Not rejected — merged into #7 Phase 3 |
| 18 | manifest.json load-order machine check (standalone) | Not rejected — merged into #2 bundle |

## Session Log
- 2026-07-08: Initial ideation (round 2) — 4 frames × ~10 ideas = 41 raw, ~25 after dedup, 7 survived adversarial filtering
- 2026-07-08: Deep-dive on idea #7 (serial download queue) — architecture options compared, proxy-tab design recommended, confidence 72% → 78%
