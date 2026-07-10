describe('PathUtils.normalizePath', function() {
  it('resolves .. segments', function() {
    assertEqual(PathUtils.normalizePath('OEBPS/Text/../Images/fig.png'), 'OEBPS/Images/fig.png');
  });
  it('strips leading slashes', function() {
    assertEqual(PathUtils.normalizePath('/OEBPS/ch1.xhtml'), 'OEBPS/ch1.xhtml');
  });
  it('removes . segments and empty parts', function() {
    assertEqual(PathUtils.normalizePath('a/./b//c'), 'a/b/c');
  });
  it('does not go above the root', function() {
    assertEqual(PathUtils.normalizePath('../../img.png'), 'img.png');
  });
});

describe('PathUtils.resolveImagePath', function() {
  it('resolves relative src against the chapter directory', function() {
    const r = PathUtils.resolveImagePath('../images/fig.png', 'OEBPS/Text/ch1.xhtml');
    assertEqual(r.resolved, 'OEBPS/images/fig.png');
    assertEqual(r.isAbsolute, false);
  });
  it('passes through absolute URLs with query stripped', function() {
    const r = PathUtils.resolveImagePath('https://cdn.example.com/a.png?v=1', 'Text/ch1.xhtml');
    assertEqual(r.resolved, 'https://cdn.example.com/a.png');
    assertEqual(r.isAbsolute, true);
  });
  it('strips query and hash before resolving relative paths', function() {
    const r = PathUtils.resolveImagePath('fig.png?v=2#top', 'ch1.xhtml');
    assertEqual(r.resolved, 'fig.png');
  });
  it('handles chapters at the EPUB root', function() {
    const r = PathUtils.resolveImagePath('images/fig.png', 'ch1.xhtml');
    assertEqual(r.resolved, 'images/fig.png');
  });
});

describe('PathUtils.createUniqueNamer', function() {
  it('returns names unchanged when unique', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('a.png'), 'a.png');
    assertEqual(namer('b.png'), 'b.png');
  });
  it('suffixes duplicate basenames before the extension', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('fig.png'), 'fig.png');
    assertEqual(namer('fig.png'), 'fig_1.png');
    assertEqual(namer('fig.png'), 'fig_2.png');
  });
  it('handles names without an extension', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('README'), 'README');
    assertEqual(namer('README'), 'README_1');
  });
  it('keeps separate namers independent', function() {
    const a = PathUtils.createUniqueNamer();
    const b = PathUtils.createUniqueNamer();
    assertEqual(a('x.png'), 'x.png');
    assertEqual(b('x.png'), 'x.png');
  });
});

describe('PathUtils.isAllowedImageUrl', function() {
  it('accepts the O\'Reilly hosts over https', function() {
    assertEqual(PathUtils.isAllowedImageUrl('https://learning.oreilly.com/library/cover/x/'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://cdn.oreillystatic.com/a.png'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://oreillystatic.com/a.png'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://www.safaribooksonline.com/a.jpg'), true);
  });
  it('rejects suffix-spoofing and lookalike hosts', function() {
    assertEqual(PathUtils.isAllowedImageUrl('https://oreillystatic.com.evil.example/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('https://xlearning.oreilly.com/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('https://notoreillystatic.com/a.png'), false);
  });
  it('rejects non-https schemes and junk', function() {
    assertEqual(PathUtils.isAllowedImageUrl('http://learning.oreilly.com/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('not a url'), false);
    assertEqual(PathUtils.isAllowedImageUrl(undefined), false);
    assertEqual(PathUtils.isAllowedImageUrl(null), false);
  });
  it('keeps DIRECT_HOST as the first allowlisted host (single source of truth)', function() {
    // DIRECT_HOST feeds rewriteToPageOrigin and sessionExpiredMessage; it must
    // stay in the credentialed-fetch allowlist or those two would diverge from
    // what the SW proxy accepts.
    assertEqual(PathUtils.DIRECT_HOST, 'learning.oreilly.com');
    assert(PathUtils.ALLOWED_IMAGE_HOSTS.includes(PathUtils.DIRECT_HOST),
      'DIRECT_HOST must be in ALLOWED_IMAGE_HOSTS');
  });
  it('accepts the declared library proxy host', function() {
    assertEqual(PathUtils.isAllowedImageUrl('https://learning-oreilly-com.ezproxy.spl.org/a.png'), true);
    assertEqual(
      PathUtils.isAllowedImageUrl('https://learning-oreilly-com.ezproxy.spl.org/api/v2/epubs/x/files/cover.jpg'),
      true
    );
  });
  it('rejects hosts that merely embed or extend the proxy host', function() {
    // The proxy host is an EXACT match, never a dot-suffix: Chrome's own
    // lookalike heuristic flags this hostname shape, and a suffix rule would
    // hand the SW's credentialed fetcher to anyone who can register a subdomain.
    assertEqual(
      PathUtils.isAllowedImageUrl('https://learning-oreilly-com.ezproxy.spl.org.evil.example/a.png'),
      false
    );
    assertEqual(PathUtils.isAllowedImageUrl('https://evil.learning-oreilly-com.ezproxy.spl.org/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('https://learning-oreilly-com.ezproxy.evil.org/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('http://learning-oreilly-com.ezproxy.spl.org/a.png'), false);
  });
  it('stays in sync with manifest.json host_permissions, in both directions', async function() {
    // The allowlist deliberately duplicates host_permissions (the SW cannot
    // read getManifest in tests) — this test fails if the two drift apart.
    // Both directions matter: a host declared but not allowlisted silently
    // breaks image fetches, and one allowlisted but not declared silently
    // widens the credentialed SW proxy beyond what Chrome granted.
    const manifest = await (await fetch('../manifest.json')).json();
    const patterns = manifest.host_permissions || [];
    assert(patterns.length >= 3, 'expected host_permissions in manifest.json');

    const manifestExact = new Set();
    const manifestSuffix = new Set();
    for (const pattern of patterns) {
      const host = pattern.replace(/^https:\/\//, '').replace(/\/.*$/, '').toLowerCase();
      if (host.startsWith('*.')) manifestSuffix.add(host.slice(2));
      else manifestExact.add(host);

      const sample = 'https://' + host.replace(/^\*\./, 'sub.') + '/x.png';
      assertEqual(PathUtils.isAllowedImageUrl(sample), true,
        `host_permissions entry ${pattern} must be accepted by isAllowedImageUrl`);
      if (host.startsWith('*.')) {
        const bare = 'https://' + host.slice(2) + '/x.png';
        assertEqual(PathUtils.isAllowedImageUrl(bare), true,
          `bare domain of ${pattern} must be accepted (Chrome *. patterns match the host itself)`);
      }
    }

    const sorted = (s) => [...s].sort().join(',');
    assertEqual(sorted(new Set(PathUtils.ALLOWED_IMAGE_HOSTS)), sorted(manifestExact),
      'ALLOWED_IMAGE_HOSTS must equal the exact hosts in host_permissions');
    assertEqual(sorted(new Set(PathUtils.ALLOWED_IMAGE_DOMAIN_SUFFIXES)), sorted(manifestSuffix),
      'ALLOWED_IMAGE_DOMAIN_SUFFIXES must equal the "*." domains in host_permissions');
  });
  it('covers every content_scripts and web_accessible_resources host', async function() {
    // A library proxy needs all three manifest arrays. Declaring the host for
    // content_scripts but not host_permissions leaves the content script running
    // with no image proxy; the reverse leaves the extension inert.
    const manifest = await (await fetch('../manifest.json')).json();
    const hostOf = (p) => p.replace(/^https:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    const declared = new Set((manifest.host_permissions || []).map(hostOf));

    const csHosts = new Set(manifest.content_scripts.flatMap(cs => cs.matches.map(hostOf)));
    for (const h of csHosts) {
      assert(declared.has(h), `content_scripts host ${h} is missing from host_permissions`);
    }
    const warHosts = new Set(manifest.web_accessible_resources.flatMap(w => w.matches.map(hostOf)));
    for (const h of csHosts) {
      assert(warHosts.has(h),
        `content_scripts host ${h} must appear in web_accessible_resources.matches, ` +
        'or the e-ink stylesheet cannot be fetched from that origin');
    }
  });
});

describe('PathUtils.rewriteToPageOrigin', function() {
  const origPageOrigin = PathUtils.pageOrigin;
  const PROXY = 'https://learning-oreilly-com.ezproxy.spl.org';
  const withOrigin = (origin, fn) => {
    PathUtils.pageOrigin = () => origin;
    try { return fn(); } finally { PathUtils.pageOrigin = origPageOrigin; }
  };

  it('maps a real-host URL onto a proxy page origin, preserving path and query', function() {
    withOrigin(PROXY, () => {
      assertEqual(
        PathUtils.rewriteToPageOrigin('https://learning.oreilly.com/api/v2/x/y.png?v=3'),
        PROXY + '/api/v2/x/y.png?v=3'
      );
    });
  });
  it('is idempotent on an already-proxied URL', function() {
    withOrigin(PROXY, () => {
      const already = PROXY + '/api/v2/x/y.png';
      assertEqual(PathUtils.rewriteToPageOrigin(already), already);
      assertEqual(PathUtils.rewriteToPageOrigin(PathUtils.rewriteToPageOrigin(already)), already);
    });
  });
  it('never touches CDN or unrelated hosts', function() {
    withOrigin(PROXY, () => {
      assertEqual(
        PathUtils.rewriteToPageOrigin('https://cdn.oreillystatic.com/a.png'),
        'https://cdn.oreillystatic.com/a.png'
      );
      assertEqual(
        PathUtils.rewriteToPageOrigin('https://www.safaribooksonline.com/a.jpg'),
        'https://www.safaribooksonline.com/a.jpg'
      );
      // Suffix lookalikes of the real host must not be rewritten either
      assertEqual(
        PathUtils.rewriteToPageOrigin('https://xlearning.oreilly.com/a.png'),
        'https://xlearning.oreilly.com/a.png'
      );
    });
  });
  it('is a no-op in direct mode', function() {
    withOrigin('https://learning.oreilly.com', () => {
      const u = 'https://learning.oreilly.com/api/v2/x/y.png';
      assertEqual(PathUtils.rewriteToPageOrigin(u), u);
    });
  });
  it('passes relative values through for the caller to resolve', function() {
    withOrigin(PROXY, () => {
      assertEqual(PathUtils.rewriteToPageOrigin('/api/v2/x.png'), '/api/v2/x.png');
      assertEqual(PathUtils.rewriteToPageOrigin('images/x.png'), 'images/x.png');
    });
  });
  it('refuses to rewrite onto a non-https page origin', function() {
    // The test harness itself runs on http://localhost — a downgrade here would
    // silently strip credentials protection.
    withOrigin('http://localhost:8765', () => {
      const u = 'https://learning.oreilly.com/a.png';
      assertEqual(PathUtils.rewriteToPageOrigin(u), u);
    });
  });
});

describe('PathUtils.sanitizeFilename', function() {
  const FB = 'book-9781234567890';
  it('preserves CJK titles unchanged', function() {
    assertEqual(PathUtils.sanitizeFilename('深入理解计算机系统', FB), '深入理解计算机系统');
  });
  it('preserves accented characters and case', function() {
    assertEqual(PathUtils.sanitizeFilename('Café Sécurité', FB), 'Café Sécurité');
  });
  it('keeps ASCII titles readable instead of kebab-lowercase', function() {
    assertEqual(
      PathUtils.sanitizeFilename('Designing Data-Intensive Applications', FB),
      'Designing Data-Intensive Applications'
    );
  });
  it('replaces filesystem-illegal characters with spaces and collapses', function() {
    assertEqual(PathUtils.sanitizeFilename('C++: Design/Use?', FB), 'C++ Design Use');
  });
  it('falls back for punctuation-only titles', function() {
    assertEqual(PathUtils.sanitizeFilename('???', FB), FB);
  });
  it('falls back for empty and whitespace-only titles', function() {
    assertEqual(PathUtils.sanitizeFilename('', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('   ', FB), FB);
    assertEqual(PathUtils.sanitizeFilename(null, FB), FB);
  });
  it('falls back for Windows reserved device names', function() {
    assertEqual(PathUtils.sanitizeFilename('con', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('COM7', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('LPT1', FB), FB);
  });
  it('trims leading and trailing dots and spaces', function() {
    assertEqual(PathUtils.sanitizeFilename('Title...', FB), 'Title');
    assertEqual(PathUtils.sanitizeFilename('.hidden', FB), 'hidden');
  });
  it('strips zero-width, bidi-override, and control characters', function() {
    assertEqual(PathUtils.sanitizeFilename('A\u200BB\u202EC\u0007D', FB), 'A B C D');
  });
  it('truncates byte-aware without splitting a code point', function() {
    // 100 CJK chars = 300 UTF-8 bytes; cap is 200 bytes = 66 chars (198 bytes)
    const long = '书'.repeat(100);
    const out = PathUtils.sanitizeFilename(long, FB);
    assertEqual(out, '书'.repeat(66));
  });
  it('re-trims trailing dots or spaces exposed by truncation', function() {
    // 66 CJK chars (198 bytes) + '. ' — the cap cuts inside the padding
    const tricky = '书'.repeat(66) + '.  X';
    const out = PathUtils.sanitizeFilename(tricky, FB);
    assertEqual(out, '书'.repeat(66));
  });
});

describe('PathUtils.stripQueryAndHash', function() {
  it('strips query and hash', function() {
    assertEqual(PathUtils.stripQueryAndHash('img.png?w=100#x'), 'img.png');
  });
  it('returns unchanged path when clean', function() {
    assertEqual(PathUtils.stripQueryAndHash('path/to/image.jpg'), 'path/to/image.jpg');
  });
});
