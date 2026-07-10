---
title: "feat: Library proxy (EZproxy) support"
type: feat
status: completed
date: 2026-07-09
deepened: 2026-07-09
completed: 2026-07-10
---

# feat: Library proxy (EZproxy) support

## Overview

The exporter today only activates on `learning.oreilly.com` — personal subscriptions. Library users reach the same content through hostname-rewriting proxies, e.g. `https://learning-oreilly-com.ezproxy.spl.org/library/view/python-crash-course/9781098156664/f01.xhtml` (Seattle Public Library). The paths, page structure, and `/api/v2/...` endpoints are identical; only the origin differs.

This plan adds the library proxy host as a **static manifest declaration**, then fixes the three things that actually break on a different origin: absolute `learning.oreilly.com` URLs baked into the pipeline, the SW image-proxy allowlist, and EZproxy's session-expiry mode (a 302 to a login host that is invisible under `fetch`'s default `redirect: 'follow'` — see Calibration Findings P5 for what live probing showed, which is not what this paragraph originally claimed).

Adding a *different* library is then a one-line manifest edit, documented in the README. A runtime "Enable on this site" flow that would make arbitrary libraries work without editing the manifest was designed and costed during planning, then deliberately deferred — see Alternative Approaches Considered, which preserves its hazards so they don't have to be rediscovered.

## Problem Frame

Direct request from the user (no brainstorm doc; bootstrap): expand support from personal subscriptions to library access — "essentially the content are similar". The concrete target is SPL; the extension is installed via Load-unpacked for personal use, so a manifest edit is an acceptable per-library setup step.

What breaks on a proxy origin:

1. **Static host declarations.** `manifest.json` scopes `content_scripts`, `host_permissions`, and `web_accessible_resources` to `learning.oreilly.com`, so the extension is inert on the proxy host.
2. **Session locality.** The library session cookie lives on the proxy domain (`*.ezproxy.spl.org`); requests to the real `learning.oreilly.com` from the same browser are unauthenticated. Every absolute `learning.oreilly.com` URL in the pipeline (the cover-fallback base, API-returned `cover_url`, chapter-embedded absolute URLs) is a broken path in library mode.
3. **Proxy failure modes differ.** EZproxy session expiry is not a 401 — it is a 302 to `login.ezproxy.<lib>.org`. *(Revised after Unit 1: from a content script that cross-origin redirect is CORS-blocked into a bare `TypeError`, which `_fetchWithRetry` mistakes for a transient network fault and retries with backoff, per file. Where a library's login host is same-origin, `fetch` follows it to a 200 HTML page that crashes manifest JSON parsing or is written into the EPUB as a chapter. Both are covered by the same fix.)*

What already works unchanged (verified by code scan): all API fetches are relative paths against the page origin; pagination `next` is converted to path+query before fetching; `Fetcher.extractIsbn` is path-anchored with no host dependency; all download state is keyed by tabId, not host.

## Requirements Trace

- R1. On the declared library proxy host, the extension activates and the full pipeline works: book detection, chapter/CSS/image fetching, cover fallback, quality report, notifications.
- R2. Absolute `learning.oreilly.com` URLs are normalized to the page origin, and images resolve whether the library's proxy rewrites the CDN or leaves it direct.
- R3. Proxy session expiry is detected and surfaced with library-specific guidance; a login page is never packaged into an EPUB and never misreported as a JSON/parse error.
- R4. Zero regression for direct `learning.oreilly.com` use: the existing 181-test suite stays green and generated output stays epubcheck-clean.
- R5. Supporting another library is a single documented manifest edit; OpenAthens/SSO libraries (which land users on the real `learning.oreilly.com` with an institutional session) already work with no changes.

## Scope Boundaries

- **No runtime permission UX.** No `optional_host_permissions`, no `chrome.scripting.registerContentScripts`, no "Enable on this site" popup flow. Users at other libraries edit one manifest line and reload the unpacked extension (README-documented). Rationale and the deferred design live in Alternative Approaches Considered.
- **One library declared out of the box** (SPL, the user's). Others are a manifest edit, not a code change.
- **https hostname-rewriting proxies only.** Proxy-by-port (`https://ezproxy.x.org:2443`) and http-only proxies are out of scope. WAM/MUSE-style rewriters may work if their hostname is declared, but their absolute-URL variants are untested and best-effort.
- **ToS posture unchanged:** the personal-use-only disclaimer applies equally to library access; the README gains a note. This plan does not assess individual libraries' terms.

## Context & Research

### Relevant Code and Patterns

- `oreilly-epub-extension/manifest.json` — three static host surfaces to extend: `content_scripts.matches`, `host_permissions`, `web_accessible_resources.matches`.
- `oreilly-epub-extension/content.js` — `fetchCoverFallback` normalizes `cover_url` against a hardcoded `https://learning.oreilly.com` base (the only absolute base in content code); the four-strategy image fallback's Strategy 4 hands absolute URLs to the SW proxy; `imageMap`/`chapterImageMap` keys are the original `src` strings consumed by `EinkOptimizer` for XHTML rewriting (host-swapping must never touch the keys); the eink CSS is fetched via `chrome.runtime.getURL().then(fetch)` at a single call site.
- `oreilly-epub-extension/lib/path-utils.js` — `isAllowedImageUrl`: exact-match `learning.oreilly.com`, dot-suffix `oreillystatic.com` / `safaribooksonline.com`. **Correction found during review:** this is enforced in the SW `fetchImage` handler (entry check + post-redirect re-validation); on the content side it is consulted **only** by `fetchCoverFallback` — Strategy 4 calls the SW with no local gate. The plan's allowlist changes follow from this, not from a symmetric two-sided gate.
- `oreilly-epub-extension/lib/fetcher.js` — `_fetchWithRetry` treats only HTTP 401 as `SESSION_EXPIRED`; `extractIsbn` is path-anchored (`/\/library\/(?:view|cover)\/.../`) and proxy-safe as-is.
- `oreilly-epub-extension/background.js` — message switch, guarded lifecycle handlers, `fetchImage` with two allowlist checkpoints.
- Test harness: `oreilly-epub-extension/tests/chrome-mock.js` (message routing, storage, badges, notifications, ports); `tests/epub-compliance.test.js` (full-pipeline fixtures); `tests/popup-preview.html` (popup visuals).

### Institutional Learnings

- `docs/solutions/` does not exist. Project memory applies: bust the browser-test cache with a fresh port; JSON `\u` escapes decode to raw characters in tool args (write such content via Python); every SW message handler must `sendResponse` or an awaited `dispatchTo` hangs.

### External References

- **EZproxy mechanics** (OCLC docs + live probe of `ezproxy.spl.org`): hostname rewriting confirmed — `learning.oreilly.com` → `learning-oreilly-com.<proxyhost>`, dots→hyphens so the wildcard cert `*.ezproxy.spl.org` matches; **path preserved verbatim**. EZproxy ≥6.0.8 rewrites URLs inside JSON responses by default, so `cover_url` / pagination `next` may arrive already-proxied — normalization must be idempotent. The session cookie lives on the proxy domain; O'Reilly's own cookies are held server-side by EZproxy. The O'Reilly stanza is customized per library and not public, so whether `*.oreillystatic.com` is proxied (as `cdn-oreillystatic-com.<proxyhost>`) or left direct is per-library and only knowable by observation. Docs: help.oclc.org (Option HttpsHyphens, About URL rewriting, MimeFilter, Option Cookie, LoginCookieDomain).
- **Prior art:** no existing O'Reilly export tool handles EZproxy. Zotero Connector's proxy support (infer the scheme from a visited URL rather than enumerating) is the reference design for the deferred runtime approach.

## Key Technical Decisions

- **Static manifest declaration, not runtime permissions** (user decision): the extension is load-unpacked and personal; one known library is in scope. Declaring `https://learning-oreilly-com.ezproxy.spl.org/*` alongside the existing host costs one line and zero new machinery, where the runtime-permission design cost two implementation units, a new SW lifecycle (`reconcile()`), an injection sentinel, and a permission-scoped rewrite of the image proxy. Consequence that shapes everything below: **content scripts only ever run on hosts we chose**, so there is no untrusted-granted-origin threat model.
- **Allowlist gains the declared proxy hosts, keeping target-URL authorization**: `isAllowedImageUrl` accepts the proxy book host and (if Unit 1 shows it is used) the proxied CDN host, as exact matches. Sender-scoped authorization — required by the runtime design, because there any granted origin could have driven the SW to fetch the user's personal `learning.oreilly.com` session — is **not** needed here: every origin the content script runs on is one we declared. The post-redirect re-validation stays as-is.
- **Origin normalization is a pure helper, idempotent and narrow**: swap the host to `location.origin` only when the URL's hostname is exactly `learning.oreilly.com` and the page origin differs. URLs EZproxy already rewrote don't match the condition and pass through untouched; CDN/S3 hosts are never touched. The swap affects only the fetch URL — `imageMap` keys stay the original `src`, so XHTML rewriting is unaffected. A swapped absolute URL becomes same-origin and takes the relative/API path (Strategy 3), never the SW proxy.
- **`fetchCoverFallback` defers absolute URLs to the SW.** Its local allowlist check must go: an *already-proxied* `cover_url` (`cdn-oreillystatic-com.<suffix>`) is neither same-origin nor on the pre-change static list, so a local gate would reject a cover the SW would have allowed. The SW remains the single enforcement point; fail-closed semantics are unchanged (SW refuses → `null` → coverless EPUB).
- **Proxy session-expiry detection in `_fetchWithRetry`** *(revised by Unit 1)*: treat as `SESSION_EXPIRED` when (a) HTTP 401 (existing), or (b) the request, issued with `redirect: 'manual'`, comes back as `response.type === 'opaqueredirect'`. The originally-planned predicates — inspecting `response.redirected`/`response.url`, and flagging `text/html` on `/api/` paths — are respectively unobservable from a content script and outright wrong (chapters *are* `text/html`); see Calibration Findings P5. Error copy branches on the page origin: direct → "log in to O'Reilly"; proxy → "your library session expired — sign in through your library's portal again". The value is fast, accurate diagnosis and coverage of same-origin-login EZproxy configs; at SPL, CORS already prevents a login page from reaching the ZIP.
- **eink CSS: broaden `web_accessible_resources.matches` to the declared hosts** (user decision). A content script cannot fetch a WAR resource from an origin outside `matches`. Since the origins are known statically, adding them to `matches` is a one-line fix — no new SW message action, no path-guard, no migration of the seven `eink-override.css` fetch stubs across the test suites. `chrome.scripting.insertCSS` is not an alternative: this resource is embedded as *text* into the EPUB ZIP, not applied to the page.
- **Live calibration before code** (user decision — SPL credentials available): Unit 1 settles what research could not — whether the CDN is proxied (decides one manifest line and one allowlist entry), whether JSON URLs arrive rewritten, and the exact shape of an expired session.

## Open Questions

### Resolved During Planning

- Generality: static declaration now; runtime permission flow deferred with its design recorded (user decision).
- Sender-scoped SW authorization: unnecessary under static declaration — no untrusted origins run our code. (It would be mandatory if the runtime flow is ever built; recorded in Alternatives.)
- Parent-wildcard grant / two-step confirmation UX: moot — no grants exist.
- CSS delivery: broaden WAR matches rather than remove WAR (user decision).
- Live verification: yes, Unit 1, before the code units (user decision).

### Resolved by Unit 1 (see Calibration Findings)

- Proxied CDN host: **not declared.** `cdn.oreillystatic.com` is absent from SPL's stanza and unreferenced by the book (P4).
- Expiry predicate: **`redirect: 'manual'` + `response.type === 'opaqueredirect'`.** The plan's redirect-inspection and `text/html` predicates are respectively undetectable and wrong (P5).
- `document.title`: **unchanged shape**, no code impact (P6).

### Newly Opened by Unit 1

- **Chrome's lookalike interstitial gates the whole feature** (P1). No code remedy exists — extensions are inert on interstitials. Handled as documentation (README) plus a step in Unit 4's live run. Left open: whether Chrome's dismissal survives profile sync / a fresh profile, which would decide how prominent the README warning must be.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

The pipeline is already origin-relative; only the marked edges need work.

```mermaid
flowchart TD
    M["manifest.json<br/>+ proxy host in content_scripts,<br/>host_permissions, WAR matches"] -->|activates| C["content.js on<br/>learning-oreilly-com.ezproxy.spl.org"]
    C -->|relative paths — already correct| API["/api/v2/... on the proxy origin<br/>(library session cookie)"]
    C -->|"NEW: host-swap when hostname is<br/>exactly learning.oreilly.com"| ABS["absolute URLs:<br/>cover_url, chapter images"]
    ABS -->|swapped → same-origin| API
    ABS -->|proxied CDN, if any| SW["SW fetchImage<br/>allowlist + declared proxy hosts"]
    API -->|"NEW: 302→login seen as an<br/>opaque redirect, or HTTP 401"| EXP["SESSION_EXPIRED<br/>(library-specific copy)"]
    EXP -.->|abort before packaging| ZIP["EPUB"]
    API -->|chapters, CSS, images| ZIP
```

Everything else — attemptId guards, `reportByTab`, notifications, the quality gate — is keyed by tabId and host-agnostic, so it inherits proxy support for free.

## Implementation Units

- [x] **Unit 1: Live proxy calibration (SPL session)** — done 2026-07-10; see Calibration Findings.

**Goal:** Replace the three research blind spots with observed facts before code is written against assumptions.

**Requirements:** R2, R3 (calibration input)

**Dependencies:** The user's Chrome with an active SPL session (coordinate as with the prior live O'Reilly API verification).

**Files:**
- Modify: `docs/plans/2026-07-09-002-feat-library-proxy-support-plan.md` (record observations in a Calibration Findings appendix)

**Approach:**
- On a logged-in proxied book page, observe via DevTools and scripted fetches: (a) `/api/v2/search/` and `/api/v2/epubs/.../files/` return complete JSON under the institutional session; (b) the actual form of `filesData.next` and `cover_url` — real host or already-proxied (JSON-rewrite actuality); (c) how chapter HTML references images (relative / absolute-real / absolute-proxied) and whether `cdn.oreillystatic.com` assets arrive direct or as `cdn-oreillystatic-com.ezproxy.spl.org` — **this decides whether the CDN host is declared at all**; (d) session-expiry behavior after logout or timeout on an API path: full redirect chain, final host, status codes, response `Content-Type`; (e) `document.title` shape on a proxied chapter page.
- Record each observation as confirmed / contradicted against the research summary, and update Unit 2's manifest line count and Unit 3's expiry conditions accordingly.

**Test scenarios:**
- Test expectation: none — observation-only unit; its deliverable is the calibration appendix.

**Verification:**
- The appendix answers all five probes with observed values, each marked confirmed or contradicted, and names the concrete downstream change (declare the CDN host or not; the exact expiry predicate).

- [x] **Unit 2: Declare the proxy host; normalize origins; extend the allowlist**

**Goal:** The extension activates on the SPL proxy origin and every absolute-URL path in the pipeline resolves against it.

**Requirements:** R1, R2

**Dependencies:** Unit 1 — **satisfied**: exactly one host is declared (`learning-oreilly-com.ezproxy.spl.org`); no proxied CDN host exists at SPL (P4).

**Files:**
- Modify: `oreilly-epub-extension/manifest.json` (add the proxy book host to `content_scripts.matches`, `host_permissions`, and `web_accessible_resources.matches`)
- Modify: `oreilly-epub-extension/lib/path-utils.js` (pure host-swap helper; `isAllowedImageUrl` gains the declared proxy hosts)
- Modify: `oreilly-epub-extension/content.js` (cover base + drop the local cover gate; pre-Strategy-4 swap)
- Test: `oreilly-epub-extension/tests/path-utils.test.js`
- Test: `oreilly-epub-extension/tests/content-lifecycle.test.js`
- Test: `oreilly-epub-extension/tests/epub-compliance.test.js` (proxy-origin fixture)

**Approach:**
- `fetchCoverFallback` (`content.js:249-253`) is the one place the pipeline actually breaks at SPL: resolve `cover_url` against `location.origin` instead of the hardcoded `https://learning.oreilly.com` base, and **remove its local `isAllowedImageUrl` check** so the already-proxied cover reaches the SW (the single enforcement point). Fail-closed behavior is unchanged. Per P3 this — not the host-swap — is what restores the cover.
- Host-swap helper: swap only when the URL's hostname is exactly `learning.oreilly.com` and the page origin differs; idempotent on already-proxied URLs; never touches other hosts. **Defensive only** — at SPL, EZproxy pre-rewrites every JSON URL (P3), so the helper is a no-op. It earns its keep on EZproxy < 6.0.8 or `MimeFilter`-restricted deployments that hand back real-host URLs. Comment it as such so a later reader does not mistake it for load-bearing code.
- Chapter images: swap absolute `learning.oreilly.com` URLs to the page origin *before* the Strategy-4 branch, so they become same-origin and take Strategy 3. `imageMap` / `chapterImageMap` keys stay the original `src` — `EinkOptimizer` rewrites XHTML from them.
- `isAllowedImageUrl`: add the declared proxy hosts as exact matches, alongside the existing entries. The existing manifest-sync test must be extended to cover the new hosts.
- The `path-utils.test.js` manifest-sync test is the guard that keeps `host_permissions` and the allowlist from drifting when a future user adds their own library.

**Patterns to follow:**
- `PathUtils` pure-helper style with `_`-prefixed privates and dedicated unit tests; the existing `isAllowedImageUrl` exact-vs-dot-suffix distinction (never substring matching); `tests/epub-compliance.test.js`'s `buildEpubWith` harness for a full-pipeline fixture on a mocked proxy origin.

**Test scenarios:**
- Happy path: host-swap of `https://learning.oreilly.com/api/x` with a proxy page origin → proxied URL; an already-proxied URL → unchanged (idempotent); `https://cdn.oreillystatic.com/x` → unchanged; direct mode (origin is the real host) → unchanged.
- Edge case: relative and protocol-relative `cover_url` on a proxied page → resolve against the proxy origin, not the real host.
- Happy path (allowlist): the declared proxy book host and (if declared) the proxied CDN host are accepted; `learning-oreilly-com.ezproxy.spl.org.evil.example` is rejected (exact match, no suffix confusion); `http://` of a declared host is rejected.
- Edge case (allowlist): the manifest-sync test fails if a host is added to `host_permissions` but not to `isAllowedImageUrl` (and vice versa).
- Integration: full mocked download on a proxy origin → cover_url arriving in real-host form is fetched same-origin and packaged; the same run with an already-proxied `cover_url` produces the same EPUB (regression against the removed local gate).
- Integration: an absolute real-host chapter image on a proxied page → downloaded via Strategy 3 with no SW call, XHTML rewritten via the original `src` key, no orphan resource (compliance harness).
- Integration (regression): the direct-mode compliance fixture produces a byte-comparable EPUB and makes the same `fetchImage` decisions as before.

**Verification:**
- New unit and integration tests green; the full suite green; a proxied-origin mocked run yields an epubcheck-clean EPUB with images and cover resolved.

- [x] **Unit 3: Proxy session-expiry detection**

**Goal:** An expired library session aborts the download with library-specific guidance instead of packaging a login page.

**Requirements:** R3

**Dependencies:** Unit 1 (observed expiry shape)

**Files:**
- Modify: `oreilly-epub-extension/lib/fetcher.js`
- Modify: `oreilly-epub-extension/content.js` (error copy branches on origin)
- Test: `oreilly-epub-extension/tests/fetcher.test.js`
- Test: `oreilly-epub-extension/tests/content-lifecycle.test.js`

**Approach (rewritten after Unit 1 — the original predicates were disproven):**
- `_fetchWithRetry` issues its request with `redirect: 'manual'` and throws `SESSION_EXPIRED` when `response.type === 'opaqueredirect'`. This check must sit **before** the existing `!response.ok` branch (an opaque redirect reports `status: 0`, which would otherwise become a retried `HTTP 0`). The `401` branch is untouched.
- Rejected predicates, for the record: inspecting `response.redirected` / `response.url` is impossible (the cross-origin login redirect is CORS-blocked into a `TypeError` before any response exists), and `Content-Type: text/html` on an `/api/` path is a *normal* chapter response — that guard would have failed every download in both modes.
- Content's session-expired message branches on whether `location.origin` is the real host — the proxy variant tells the user to sign back in through the library portal.
- Chapter fetches already treat `SESSION_EXPIRED` as fatal (the rethrow guards added by the quality-gate work), so once the throw happens at fetch level no login-page bytes can reach the ZIP. At SPL this path was already unreachable (CORS threw first); the guard's real beneficiaries are same-origin-login EZproxy configurations, plus every SPL user who today waits through 4 retries × 13 s of backoff per file before getting a placeholder.

**Execution note:** Test-first — the failure modes are crisp and mock-expressible (`response.url`, `response.redirected`, headers).

**Test scenarios:**
- Happy path: HTTP 401 still throws `SESSION_EXPIRED` (direct-mode regression).
- Happy path: `response.type === 'opaqueredirect'` (status 0) → `SESSION_EXPIRED`, thrown without consuming a retry.
- Happy path: an authenticated `type: 'basic'` 200 answering `Content-Type: text/html` (a real chapter) → **succeeds**. This is the regression test for the predicate Unit 1 killed; it must exist even though the bad code never shipped.
- Edge case: `_fetchWithRetry` is invoked with `redirect: 'manual'` — assert the option reaches `fetch`, so a later refactor cannot silently restore `follow` and reintroduce the un-observable failure.
- Error path: a genuine `TypeError` (offline) still retries and then throws a non-session error — expiry detection must not swallow network faults.
- Integration: expiry mid-download (a chapter fetch yields an opaque redirect) → `downloadError` with `errorKind: 'session'`, the partial quality report intact, no EPUB delivered, and the popup shows the library-variant copy on a proxied-origin fixture.
- Integration: no login-page bytes appear anywhere in a ZIP produced during an expiry run.

**Verification:**
- Fetcher suite green with the new cases; the integration fixture proves no login HTML reaches the ZIP; direct-mode 401 handling unchanged.

- [x] **Unit 4: Regression, docs, and live end-to-end**

**Goal:** Direct-mode zero-regression proven; library support documented; one real proxied book exported and validated.

**Requirements:** R4, R5

**Dependencies:** Units 2–3

**Files:**
- Modify: `README.md` (Library access section: which host is declared, how to add your own library, unsupported proxy types, OpenAthens note, ToS reminder)
- Modify: `CLAUDE.md` (architecture notes: declared proxy hosts, origin normalization, expiry detection, and the allowlist/manifest sync invariant)
- Test: full suite + epubcheck gate

**Approach:**
- Full browser suite on a fresh port; epubcheck 5.1.0 against both a direct-mode fixture EPUB and a proxied-origin fixture EPUB; live end-to-end on the SPL proxy (load unpacked → open the Python Crash Course chapter → download → epubcheck the artifact → spot-check cover and images).
- README documents the one-line manifest edit for other libraries, and that OpenAthens/SSO libraries need no change because they land on the real host.

**Test scenarios:**
- Test expectation: none beyond the suites above — this unit is verification and documentation.

**Verification:**
- **Done 2026-07-10:** 204 browser tests / 0 failed (181 before this feature). epubcheck 5.1.0 on pipeline-generated output: direct-origin build **0/0/0**, proxy-origin build **0/0/0**, and no host string (`ezproxy` or `learning.oreilly.com`) appears in any of the 9 text entries of the proxy-built EPUB. README + CLAUDE.md updated. Live SPL export pending a manual Load-unpacked run by the repo owner (see PR).

## System-Wide Impact

- **Interaction graph:** no new message actions, listeners, or state fields. The change surface is three manifest arrays, one pure helper, two call sites in `content.js`, and one predicate in `fetcher.js`.
- **Error propagation:** `SESSION_EXPIRED` semantics widen (redirect and content-type detection) but flow through the existing `errorKind: 'session'` path — quality report, notification, and popup copy all inherit it; only the copy branches by origin.
- **Security boundary:** unchanged in kind. Content scripts run only on statically declared hosts, so the SW's target-URL authorization remains sound; the allowlist grows by exactly the hosts the manifest declares, and the manifest-sync test keeps the two in step. Adding a host to `host_permissions` without adding it to `isAllowedImageUrl` (or vice versa) fails a test rather than silently opening or breaking the credentialed proxy.
- **State lifecycle risks:** none new. `bookInfoByTab`, `reportByTab`, and the attemptId guards are keyed by tabId and host-agnostic.
- **API surface parity:** `fetchCoverFallback` stops consulting the allowlist locally, leaving the SW as the single enforcement point — a simplification, not a new asymmetry.
- **Integration coverage:** a proxied-origin compliance fixture proves the pipeline end-to-end without a live session; the live SPL run covers what mocks cannot (stanza behavior, real expiry chain).
- **Unchanged invariants:** relative-path API fetching; the frozen `bookDetected` payload; attemptId guards and report lifecycle; direct-mode `fetchImage` decisions; epubcheck-clean output; single-download-at-a-time; `EinkOptimizer`'s dependence on original `src` keys.

## Alternative Approaches Considered

**Runtime host permissions + dynamic content-script registration** (designed in full, then deferred). It would let *any* library work with an in-popup "Enable on this site" click, no manifest edit: `optional_host_permissions: ["https://*/*"]`, a narrow `permissions.request` inside the click gesture, and `chrome.scripting.registerContentScripts` for durability. Rejected for now because the extension is load-unpacked and personal, one library is in scope, and the design carries real hazards that a manifest line does not. Recording them here so a future implementer inherits the analysis rather than repeating it:

- **The SW image proxy becomes a confused deputy.** Once content scripts can run on an arbitrary granted origin, the existing target-URL allowlist lets a script on *any* granted origin drive a `credentials: 'include'` fetch to `learning.oreilly.com` and receive the user's **personal** session bytes. Authorization would have to be scoped by `sender.origin` (fail-closed when absent) plus an O'Reilly host-shape check on the target, and credentialed fetches would have to refuse cross-first-party redirects. Non-negotiable prerequisite.
- **Hostname heuristics are not a security control.** `learning-oreilly-com.evil.com` matches both the "contains oreilly" enable heuristic *and* the EZproxy derivation shape, so a naive flow would offer the primary button and derive a `https://*.evil.com/*` grant. The parent wildcard (needed only to cover a proxied CDN, which is a *different origin* from the book page) must never be one autopilot click from a look-alike host.
- **`content.js` re-executes silently on double injection.** It is an IIFE with no top-level declarations, so a second execution does not throw the way the lib files' `const`s do — it registers a second `onMessage` listener with its own `abortController`, and one `startDownload` runs two concurrent downloads under one attemptId. A sentinel belongs **inside `content.js` only**; a chain-wide guard would break the first injection and the single-load test harness.
- **Registrations must be derived, not written.** Dynamic registrations survive browser restarts but not extension reloads, while grants persist; a grant made from `chrome://extensions` may never reach the popup. The only self-healing shape is a `reconcile()` that diffs `permissions.getAll()` against `getRegisteredContentScripts()` at every SW start, with ids and matches as pure functions of the *granted pattern* (a hostname-derived id cannot be reproduced at reconcile time).
- **Revocation cleanup must not use `tabs.query`.** Once the permission is gone the extension can no longer see those tabs' URLs, so cleanup keyed on a live query silently no-ops exactly when it is needed. The tab's origin has to be stamped into `bookInfoByTab` at detection time.

**Removing `web_accessible_resources` in favor of an SW-served resource message.** Rejected: the eink CSS is non-sensitive static text, `matches` accepts the declared hosts directly, and the message route would add a new action, a path-guard, a failure mode, and a migration of seven `eink-override.css` fetch stubs across two test suites.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SPL's private stanza doesn't proxy a path the pipeline needs (e.g. `/api/v2/`) → downloads impossible at that library | Unit 1 verifies end-to-end before any code is written; the failure mode is a clean `SESSION_EXPIRED`-style error, not corruption; documented as per-library variance |
| **Chrome's lookalike interstitial blocks the proxy host** (P1) — the extension cannot run at all until dismissed, and no code can dismiss it | Documentation only. README's Library-access section leads with the one-time "Details → Continue" step; Unit 4's live run exercises it. Verified real: SPL's own portal link to `/home/` triggers it too |
| **Login page packaged as chapter content** — *reassessed by Unit 1*: unreachable at SPL (the cross-origin login redirect is CORS-blocked into a `TypeError` first), but live for EZproxy configs whose login stays same-origin | Unit 3's `opaqueredirect` predicate is origin-agnostic and catches both shapes; an integration test asserts no login HTML reaches the ZIP. What SPL users actually suffer today — 4 retries × 13 s backoff per file, then placeholder chapters — is closed by the same change |
| Expiry heuristics false-positive on legitimate redirects (locale bounces, Akamai edge) | `redirect: 'manual'` verified non-disruptive: authed search / files-JSON / chapter / image all return `type: 'basic'` at SPL, and unauthenticated direct-mode API endpoints return `200` with no `3xx` anywhere. A false positive surfaces as a loud `SESSION_EXPIRED`, never as silent corruption |
| A future user adds their library to `host_permissions` but not to `isAllowedImageUrl`, silently breaking image fetches (or vice versa, silently widening the credentialed proxy) | The existing manifest-sync test is extended to cover every declared host in both directions; README's "add your library" instructions name both places |
| Proxied CDN discovered later at another library, though absent at SPL | The allowlist and manifest take exact hosts, so it is the same one-line addition; nothing in the design assumes the CDN is direct |
| Host-swap corrupts `imageMap` keys and breaks XHTML rewriting | The swap is applied to the fetch URL only, never to map keys; an integration test asserts the rewritten XHTML still points at the packaged filename |

## Documentation / Operational Notes

- README gains a "Library access" section, **led by the Chrome interstitial step** (P1): the declared host, the one-time "Safety warning → Details → Continue" click, the one-line edit for another library (naming both `manifest.json` and `lib/path-utils.js`), unsupported proxy types, and the OpenAthens note.
- CLAUDE.md records the origin-normalization rule, the expiry predicate, and the manifest↔allowlist sync invariant.
- The Unit 1 calibration appendix doubles as the institutional record of SPL-observed proxy behavior — the only place this repo will have observed EZproxy facts.

## Calibration Findings (Unit 1 — observed 2026-07-10, live SPL session)

Probed against `https://learning-oreilly-com.ezproxy.spl.org/library/view/python-crash-course/9781098156664/f01.xhtml` with the user's authenticated EZproxy session. Page-context `fetch` was used deliberately: it is subject to the same CORS rules a content script is, so its observations transfer.

| # | Probe | Result | vs. research |
|---|-------|--------|--------------|
| P1 | Extension can activate on the proxy host | **Blocked before any code runs** — Chrome shows its lookalike/target-embedding interstitial (`<title>Safety warning`, "Did you mean learning.oreilly.com?") on `learning-oreilly-com.ezproxy.spl.org`, including on SPL's own portal link to `/home/`. Extensions cannot run, screenshot, or attach to an interstitial. Dismissible by the user (Details → Continue); Chrome then remembers the site. | **NEW — unanticipated** |
| P2 | API under the institutional session | `/api/v2/search/`, `/api/v2/epubs/.../files/`, chapter `.xhtml`, and `.png` assets all return `200`, `redirected: false`, same-origin, relative paths intact. `archive_id` matches the URL ISBN. | confirmed |
| P3 | JSON URL rewriting | **Total.** `cover_url`, `web_url`, `next`, and every `files[].url` arrive as `learning-oreilly-com.ezproxy.spl.org`. The real host never appears in a JSON body. | confirmed, stronger than assumed |
| P4 | CDN routing | `cdn.oreillystatic.com` is **not in SPL's stanza**: `cdn-oreillystatic-com.ezproxy.spl.org` returns the same bare `Location: https://login.ezproxy.spl.org/favicon.ico` bounce as a nonexistent host, whereas an in-stanza host (`www-safaribooksonline-com.…`) returns `login?qurl=https://www.safaribooksonline.com/…`. Independently, all 61 images in the book's manifest and every `<img>` on the live reader page are served from the proxied `learning` host; no chapter references the CDN. | **contradicted** — no proxied CDN host exists |
| P5 | Session-expiry shape | At the HTTP layer: `302` → `login.ezproxy.spl.org` → `200 text/html` (as predicted). **But a page/content-script `fetch` never sees that**: the redirect leaves the origin, CORS blocks the response, and `fetch` throws `TypeError: Failed to fetch`. `response.redirected` and `response.url` are unobservable. With `redirect: 'manual'` the same request yields `type: 'opaqueredirect'`, `status: 0` — on both the JSON and chapter endpoints — while every authenticated request stays `type: 'basic'`, `200`. | **contradicted** — both plan predicates unusable |
| P6 | `document.title` shape | `"Praise for Python Crash Course \| Python Crash Course, 3rd Edition"` — the `"Chapter \| Book"` split the title fallback depends on is preserved. | confirmed |

### Consequences

- **P1 → docs + Unit 4.** No code fix exists; an extension cannot touch an interstitial. README must tell library users to click through once. Unit 4's live end-to-end must account for it.
- **P3 → Unit 2's real fix is the *removal*, not the swap.** Since EZproxy hands us an already-proxied `cover_url`, the host-swap helper is a no-op at SPL. What actually loses the cover today is `fetchCoverFallback`'s local `PathUtils.isAllowedImageUrl` gate (`content.js:250`) rejecting the proxied host. The swap helper stays as insurance for libraries whose EZproxy predates JSON rewriting (< 6.0.8) or disables it via `MimeFilter`; it is defensive, and the plan should not claim otherwise.
- **P4 → one manifest host, not two.** Nothing proxied-CDN gets declared. If some other book references `cdn.oreillystatic.com` absolutely, EZproxy leaves it alone (not in stanza), so it arrives as the real CDN host and the existing `*.oreillystatic.com` allowlist entry already covers it through the SW proxy.
- **P5 → Unit 3's predicate is replaced wholesale.**
  - Predicate (b) *("redirected off-origin / `login.`-prefixed host")* is **undetectable** from a content script — the throw happens first.
  - Predicate (c) *("`/api/` request answering `text/html` ⇒ expired")* is **actively wrong**: authenticated chapter fetches legitimately return `Content-Type: text/html` (`/api/v2/epubs/.../files/f01.xhtml` → `text/html`). Shipping it would fail every chapter of every book, in both modes.
  - Replacement: issue API fetches with `redirect: 'manual'` and treat `response.type === 'opaqueredirect'` as `SESSION_EXPIRED`. Verified safe: authenticated search / files-JSON / chapter / image requests all return `type: 'basic'` under `manual`, and unauthenticated `learning.oreilly.com` API endpoints return `200` with no `3xx` anywhere, so direct mode is undisturbed. The `401` branch stays for direct mode.
  - This predicate is **origin-agnostic**, which matters: it also catches EZproxy configurations whose login redirect stays *same-origin* — and those, not SPL, are where the "login page packaged as a chapter" hazard actually lives.
- **P5 → the corruption risk was mis-stated, but a real harm remains.** At SPL an expired session cannot silently produce a login-page chapter; CORS throws first. What it *does* produce today is a `TypeError` that `_fetchWithRetry` treats as a transient network fault: 4 attempts with 1 s + 3 s + 9 s backoff, per file, across 102 files, ending in placeholder chapters and a generic error. Unit 3's value is fast, accurate diagnosis (and covering the same-origin-login configs), not preventing corruption at SPL.

## Sources & References

- Related code: `oreilly-epub-extension/manifest.json`, `oreilly-epub-extension/content.js` (`fetchCoverFallback`, image strategies), `oreilly-epub-extension/lib/path-utils.js` (`isAllowedImageUrl`), `oreilly-epub-extension/lib/fetcher.js` (`_fetchWithRetry`, `extractIsbn`), `oreilly-epub-extension/background.js` (`fetchImage`)
- Related plans: `docs/plans/2026-07-09-001-feat-download-quality-gate-plan.md` (the report, `errorKind`, and rethrow-guard surfaces this plan reuses)
- External docs: help.oclc.org — EZproxy Option HttpsHyphens / About URL rewriting / MimeFilter / Option Cookie / LoginCookieDomain; developer.chrome.com — content-scripts, web-accessible-resources, network-requests (content scripts fetch as the page origin)
- Example target: `https://learning-oreilly-com.ezproxy.spl.org/library/view/python-crash-course/9781098156664/f01.xhtml`
