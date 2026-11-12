# AGENTS.md

## Communication

- Always reply in Chinese (中文).
- When generating code and code comments, use English.

## Project Overview

Chrome extension (Manifest V3) that converts O'Reilly Learning books to EPUB 3.0 format, optimized for e-ink readers. Runs entirely in the browser using the user's existing O'Reilly session — no backend server.

## Tech Stack

- Language: Vanilla JavaScript (no TypeScript, no build step)
- Framework: None — plain Chrome Extension APIs (Manifest V3)
- Testing: Custom browser-based test runner (`tests/test-runner.html`)
- Packaging: JSZip for EPUB assembly

## Code Conventions

- All extension code wrapped in IIFEs
- Library modules use global object pattern (e.g., `const Fetcher = { ... }`)
- No ES module imports — load order matters in `manifest.json`
- Comments and code in English

## Testing Requirements

- Tests run in browser via `test-runner.html`, not Node.js
- Test files in `tests/*.test.js`

## Build & Deploy

- No build step — load unpacked in `chrome://extensions/`
- Start test server: `python -m http.server 8765`
- Headless tests (CI): `node .github/scripts/run-browser-tests.mjs` after `npm install --no-save playwright@1.64.1`
- Release: bump `manifest.json` version, merge to `master`, push tag `vX.Y.Z`; `.github/workflows/release.yml` tests, packages, and publishes the GitHub Release

## Review guidelines

- Treat changes that expose authentication or session data, broaden extension host permissions, or transmit user data to new third parties as P1.
- Verify that supported proxy hosts remain synchronized between `oreilly-epub-extension/manifest.json` and `oreilly-epub-extension/lib/path-utils.js`, with regression coverage.
- Treat silent omission or corruption of EPUB chapters or assets, and changes that bypass EPUB integrity validation, as P1.
- Check Manifest V3 service-worker lifecycle assumptions, message passing, retry behavior, and download completion or cancellation paths.
- Keep EPUB generation client-side. Flag new backend dependencies or unexpected network transmission.
- Require focused browser tests for parsing, path normalization, host allowlisting, session-expiry handling, and EPUB structure changes.
