# AGENTS.md

## Review guidelines

- Treat changes that expose authentication or session data, broaden extension host permissions, or transmit user data to new third parties as P1.
- Verify that supported proxy hosts remain synchronized between `oreilly-epub-extension/manifest.json` and `oreilly-epub-extension/lib/path-utils.js`, with regression coverage.
- Treat silent omission or corruption of EPUB chapters or assets, and changes that bypass EPUB integrity validation, as P1.
- Check Manifest V3 service-worker lifecycle assumptions, message passing, retry behavior, and download completion or cancellation paths.
- Keep EPUB generation client-side. Flag new backend dependencies or unexpected network transmission.
- Require focused browser tests for parsing, path normalization, host allowlisting, session-expiry handling, and EPUB structure changes.
