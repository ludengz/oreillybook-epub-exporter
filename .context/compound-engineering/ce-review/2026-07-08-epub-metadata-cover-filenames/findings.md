# ce:review run — feat/epub-metadata-cover-filenames (2026-07-08)

Mode: autofix (invoked from ce:work). Scope: 8f5d547..working-tree (12 files, +1102/-24).
Plan: docs/plans/2026-07-08-001-feat-epub-metadata-cover-filenames-plan.md (explicit).
Reviewers: correctness, testing, maintainability, project-standards, agent-native,
learnings-researcher, security, reliability, adversarial (all sonnet). 0 malformed outputs;
severity labels "high/medium/low" from reliability/adversarial normalized to P1/P2/P3.

## Findings (post-merge, post-gate)

| ID | Sev | File | Title | Reviewer(s) | Conf | Final route |
|----|-----|------|-------|-------------|------|-------------|
| F1 | P1 | content.js:22 | Shared metadata cache can hang download forever (no timeout/signal) | reliability | 0.78 | gated_auto → fixed this round (15s race timeout, degrade to fallback shape) |
| F2 | P1 | lib/epub-builder.js:13 | Lone surrogates survive _stripIllegalXmlChars → invalid UTF-8 OPF via JSZip CESU-8 (reproduced) | adversarial | 0.80 | gated_auto → fixed this round (pairing-aware codepoint filter + U+FFFE/FFFF) |
| F3 | P1 | content.js:518 | Cover-fetch abort window has zero test coverage | testing | 0.82 | safe_auto → test added |
| F4 | P2 | content.js:160 | CT-present-but-unusable skips URL-ext fallback (plan divergence) | correctness | 0.68 | gated_auto → fixed (octet-stream/absent → URL ext; definite non-image/non-whitelist type → skip) |
| F5 | P2 | lib/epub-builder.js:57 | dc:date accepts 0000 and calendar-impossible dates | adversarial | 0.62 | gated_auto → fixed (year!=0000, days-in-month + leap) |
| F6 | P2 | content.js:472 | buildEpub retry backstop branch untested | testing | 0.80 | safe_auto → test added |
| F7 | P2 | tests/epub-compliance.test.js | Plan-mandated collision scenario (failed manifest cover.jpg + fallback) untested | testing + learnings (corroborated, 0.75→0.85) | 0.85 | safe_auto → test added |
| F8 | P2 | background.js:9 | Unguarded importScripts can kill entire SW | reliability | 0.62 | safe_auto → try/catch |
| F9 | P2 | lib/path-utils.js:43 | Host allowlist duplicates manifest.json host_permissions | maintainability | 0.65 | safe_auto (sync test added); duplication itself advisory |
| F10 | P2 | content.js:134 | Cover-type mapping duplicated vs _mimeType | maintainability | 0.68 | advisory (residual) |
| F11 | P2 | background.js fetchImage / content.js cover chain | Redirect endpoint not re-validated against allowlist (security+adversarial residuals, promoted) | security + adversarial | 0.65 | gated_auto → fixed (validate response.url post-fetch) |
| F12 | P3 | content.js:146 | Race timer never cleared | reliability | 0.65 | safe_auto → clearTimeout via finally |
| F13 | P3 | content.js:86 | redetectBook missing .catch (channel can hang) | reliability | 0.60 | safe_auto → .catch added |
| F14 | P3 | content.js:83 | redetectBook not relayed by background.js; runtime.sendMessage silently no-ops | maintainability + agent-native | 0.60 | safe_auto → contract comment added |
| F15 | P3 | content.js:308 | `rich` variable name obscures contents | maintainability | 0.62 | safe_auto → renamed normalizedMeta |
| F16 | P3 | content.js:319 | Failed manifest cover.jpg → fallback named cover_1.jpg (cosmetic, correct) | adversarial | 0.72 | advisory |
| F17 | P3 | testing gaps: relative cover_url normalization, CT parameter stripping | testing | 0.60-0.65 | safe_auto → tests added |

Pre-existing (not counted toward verdict): background.js not IIFE-wrapped (project-standards, 0.62).

## Residual / advisory (no code action this round)
- archive_id equality assumption: live-verified once (Fluent Python); systematic drift would silently disable rich fields; all tests mock the shape. (correctness, standards)
- archive_id-mismatch results memoized permanently with fromApi:true — "fetched-but-distrusted" inherits trusted-cache lifetime. Candidate docs/solutions/ lesson. (learnings)
- Strategy-4 off-domain images now rejected; degradation silent (console.warn only). Accepted in plan; monitor. (adversarial)
- Subdomain-takeover trust on *.oreillystatic.com/*.safaribooksonline.com mirrors host_permissions. (security)
- fetchImage sender trust is implicit (no externally_connectable today). (security)
- Deep-nested description HTML can overflow walk() recursion (~10-15k depth) → whole download fails; likelihood negligible. (adversarial)
- dc:title/dc:creator predate this diff and lack surrogate stripping (pre-existing class of F2).

## Requirements completeness (plan_source: explicit)
R1-R5: met. Units 1-3: implemented. Pending non-code items: CLAUDE.md Key Implementation
Details update; manual epubcheck 5.1.0 gate; plan checkboxes → handled in ship phase.

## Verdict
Ready with fixes — no blocking defects; P1/P2 fixes applied in the same ce:work session
(deviation note: fixes applied by the ce:work orchestrator directly instead of a spawned
fixer subagent — full context already in-session; re-verified by full browser suite after).

## Learnings worth capturing (docs/solutions/ candidates)
1. Claim-then-fetch namers: name reservation is independent of fetch success; reordering
   silently reintroduces the c9bad25 collision class. Test the failed-claim collision path.
2. Success-boolean memoization conflates "fetched" with "trusted" — re-examine cache
   lifetime whenever a fetched-but-distrusted branch is added.
3. Browser test runners need an explicit <meta charset="utf-8">; latent until the first
   non-ASCII fixture (windows-1252 decode corrupted CJK strings).
4. Playwright MCP persistent profiles cache localhost responses across sessions; stale
   cached JS silently reviews old code — bust with a fresh port (new origin).
