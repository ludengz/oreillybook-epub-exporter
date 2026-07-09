# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that converts O'Reilly Learning books to EPUB 3.0 format, optimized for e-ink readers. Runs entirely in the browser using the user's existing O'Reilly session — no backend server.

## Running Tests

Tests run in a browser (no Node.js test runner):
```bash
# Start a local server and open the test runner
python -m http.server 8765
# Then open: http://localhost:8765/oreilly-epub-extension/tests/test-runner.html
```

The test framework is a minimal custom implementation (`describe`/`it`/`assert`) in `test-runner.html`. Test files: `tests/*.test.js`.

## Loading the Extension

1. Open `chrome://extensions/` with Developer mode enabled
2. Click "Load unpacked" → select `oreilly-epub-extension/`
3. Navigate to any book page on `learning.oreilly.com`

## Architecture

### Three-Layer Communication Model

```
Popup (UI) ←→ Service Worker (relay/state) ←→ Content Script (all work)
```

- **Content script** (`content.js`) — the workhorse. Runs on `learning.oreilly.com`, does all fetching, parsing, and EPUB assembly. Same-origin context means session cookies are included automatically.
- **Service worker** (`background.js`) — relay + CORS proxy. Forwards messages, updates badge, persists state via `chrome.storage.session` (survives MV3 service worker termination). Also acts as a CORS proxy for CDN images (`fetchImage` handler fetches in SW context, returns base64).
- **Popup** (`popup.html/js/css`) — pure UI. Queries service worker for state, displays it, sends commands.

### Library Modules (loaded as content scripts, not ES modules)

All expose global objects (`Fetcher`, `EpubBuilder`, `EinkOptimizer`) — no import/export. **Load order matters**: `fetcher.js` must load before `eink-optimizer.js` (dependency on `Fetcher.parseXhtml()`).

- `lib/fetcher.js` — HTTP fetching with retry + progressive backoff. Handles both 403 and 429 as rate limits. ISBN extraction from URLs via regex. Also provides: `parseXhtml()` (XHTML parser with text/html fallback), `extractImageUrls()` (extracts `<img>`, `<image>`, `<object>` sources with deduplication), `extractCssImageUrls()` (CSS `url()` extraction), `stripQueryAndHash()`.
- `lib/epub-builder.js` — Generates EPUB structural files (content.opf, toc.xhtml, toc.ncx, container.xml, cover.xhtml). Pure string generation, no side effects.
- `lib/eink-optimizer.js` — Rewrites chapter XHTML via DOM manipulation (DOMParser + XMLSerializer): injects e-ink CSS override, remaps image paths to `../Images/`, rewrites CSS links to `../Styles/`. Uses `Fetcher.parseXhtml()` for robust parsing. Serializes back via `XMLSerializer` to avoid HTML entity mismatches.
- `lib/jszip.min.js` — Third-party EPUB packaging.

### Key Implementation Details

- **Book metadata** comes from the search API (`/api/v2/search/?query={ISBN}&limit=1`), not DOM selectors. O'Reilly is a React SPA — DOM elements render asynchronously and are unreliable from content scripts. Rich fields (`language`, `publishers`, `topics_payload` as subjects, `issued`, `description`, `cover_url`) are kept only when `archive_id` matches the URL ISBN (the search is fuzzy; the `isbn` field is the print edition's). Fetches are memoized per ISBN (success only, 15s timeout) and normalized by `EpubBuilder.normalizeMetadata` before reaching the OPF: Intl-canonicalized BCP 47 language (2-3-alpha primary subtag, `en` fallback), string-level ISO date prefix with calendar checks, DOMParser-flattened description, XML-illegal code point and lone-surrogate stripping.
- **Title fallback**: parses `document.title` (format: `"ChapterTitle | BookTitle"`) taking the last segment.
- **Download filename** preserves Unicode/case/spaces via `PathUtils.sanitizeFilename` (strips only filesystem-illegal, control, and zero-width characters; guards Windows reserved names; ~200-UTF-8-byte cap) and falls back to `book-{isbn}.epub` when nothing usable remains.
- **File manifest** is paginated — fetched in a loop following `filesData.next`.
- **Two-phase download with progress**: Phase 1 pre-downloads all manifest images (0-30% progress bar), Phase 2 processes chapters (30-100%). This keeps the progress bar moving during the entire download.
- **Four-strategy image fallback** (in `content.js`): (1) Match resolved path against pre-downloaded manifest images, (2) Match by filename only, (3) Fetch via O'Reilly API (relative URLs), (4) Fetch via background SW CORS proxy (absolute URLs only; the handler enforces an https + O'Reilly-host allowlist — `PathUtils.isAllowedImageUrl`, kept in sync with `manifest.json` host_permissions by a test — and re-validates the post-redirect URL, so off-domain images are rejected).
- **API cover fallback**: when `findCoverImage`'s filename heuristic misses, the search API's `cover_url` is fetched through the SW proxy behind a fail-closed chain (URL normalized against learning.oreilly.com, https + host allowlist, filename extension derived from the response Content-Type — the live cover endpoint is extensionless — with URL-extension fallback only for absent/octet-stream types, 15s single attempt). Any miss yields a coverless but valid EPUB; both EPUB3 `properties="cover-image"` and the EPUB2 `<meta name="cover">` are emitted either way.
- **CSS background images** are also extracted and downloaded from stylesheets via `Fetcher.extractCssImageUrls()`.
- **MV3 state persistence**: `chrome.storage.session` ensures popup state survives service worker termination (MV3 terminates idle SWs after ~30s).
- **Chapters fetched in batches of 2** with 1s delay between batches to avoid 403 rate limiting.
- **`mimetype` must be the first ZIP entry** with `{compression: 'STORE'}` per EPUB spec.
- **EPUB includes both EPUB 3 nav (`toc.xhtml`) and EPUB 2 NCX (`toc.ncx`)** for Boox reader compatibility.
- **Query/hash stripping**: Image URLs with `?v=123` or `#fragment` are cleaned before API requests to avoid 404s.

## O'Reilly API Endpoints Used

- `GET /api/v2/search/?query={ISBN}&limit=1` — book metadata (title, authors)
- `GET /api/v2/epubs/urn:orm:book:{ISBN}/files/?limit=200` — file manifest (paginated)
- `GET /api/v2/epubs/urn:orm:book:{ISBN}/files/{path}` — individual file content

## Code Style

- Vanilla JavaScript, no build step, no frameworks
- All extension code wrapped in IIFEs (`(function() { 'use strict'; ... })()`)
- Library modules use global object pattern (e.g., `const Fetcher = { ... }`)
- Comments and code in English
