describe('Fetcher.extractIsbn', function() {
  it('extracts ISBN from standard book URL', function() {
    const isbn = Fetcher.extractIsbn('https://learning.oreilly.com/library/view/llm-engineers-handbook/9781836200079/Text/Chapter_04.xhtml');
    assertEqual(isbn, '9781836200079');
  });
  it('extracts ISBN from cover URL', function() {
    const isbn = Fetcher.extractIsbn('https://learning.oreilly.com/library/cover/9781836200079/');
    assertEqual(isbn, '9781836200079');
  });
  it('returns null for non-matching URL', function() {
    assertEqual(Fetcher.extractIsbn('https://learning.oreilly.com/playlists/something'), null);
  });
});

describe('Fetcher.throttledFetchAll', function() {
  it('fetches all URLs and returns results in order', async function() {
    const originalFetch = window.fetch;
    window.fetch = async (url) => ({ ok: true, text: async () => `content-${url}`, status: 200, headers: new Headers() });

    const results = await Fetcher.throttledFetchAll(['/a', '/b', '/c'], {
      concurrency: 2,
      delayMs: 10,
      getContent: async (res) => res.text(),
    });

    assertEqual(results.length, 3);
    assertEqual(results[0], 'content-/a');
    assertEqual(results[2], 'content-/c');
    window.fetch = originalFetch;
  });
});

describe('Fetcher.extractImageUrls', function() {
  it('extracts img src from XHTML', function() {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="../Images/fig1.png"/><img src="../Images/fig2.jpg"/></body></html>';
    const urls = Fetcher.extractImageUrls(xhtml);
    assertEqual(urls.length, 2);
    assertEqual(urls[0], '../Images/fig1.png');
  });
  it('returns empty array when no images', function() {
    assertEqual(Fetcher.extractImageUrls('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>text</p></body></html>').length, 0);
  });
  it('extracts SVG image href', function() {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg"><image href="diagram.svg"/></svg></body></html>';
    const urls = Fetcher.extractImageUrls(xhtml);
    assertEqual(urls.length, 1);
    assertEqual(urls[0], 'diagram.svg');
  });
  it('extracts object data for image types', function() {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><object data="chart.svg" type="image/svg+xml"></object></body></html>';
    const urls = Fetcher.extractImageUrls(xhtml);
    assertEqual(urls.length, 1);
    assertEqual(urls[0], 'chart.svg');
  });
  it('deduplicates URLs', function() {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="a.png"/><img src="a.png"/></body></html>';
    assertEqual(Fetcher.extractImageUrls(xhtml).length, 1);
  });
});

describe('Fetcher.extractCssImageUrls', function() {
  it('extracts url() references from CSS', function() {
    const css = 'body { background: url("../images/bg.png"); } .icon { background-image: url(icon.svg); }';
    const urls = Fetcher.extractCssImageUrls(css);
    assertEqual(urls.length, 2);
    assertEqual(urls[0], '../images/bg.png');
    assertEqual(urls[1], 'icon.svg');
  });
  it('skips data URIs', function() {
    const css = '.x { background: url(data:image/png;base64,abc); }';
    assertEqual(Fetcher.extractCssImageUrls(css).length, 0);
  });
  it('deduplicates CSS image URLs', function() {
    const css = '.a { background: url(bg.png); } .b { background: url(bg.png); }';
    assertEqual(Fetcher.extractCssImageUrls(css).length, 1);
  });
});

describe('Fetcher.stripQueryAndHash', function() {
  it('strips query parameters', function() {
    assertEqual(Fetcher.stripQueryAndHash('image.png?v=123'), 'image.png');
  });
  it('strips hash fragments', function() {
    assertEqual(Fetcher.stripQueryAndHash('image.svg#layer1'), 'image.svg');
  });
  it('strips both query and hash', function() {
    assertEqual(Fetcher.stripQueryAndHash('img.png?w=100#x'), 'img.png');
  });
  it('returns unchanged path when no query or hash', function() {
    assertEqual(Fetcher.stripQueryAndHash('path/to/image.jpg'), 'path/to/image.jpg');
  });
});

describe('Fetcher.parseXhtml', function() {
  it('parses valid XHTML', function() {
    const doc = Fetcher.parseXhtml('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>test</p></body></html>');
    assertEqual(doc.querySelector('p').textContent, 'test');
  });
  it('falls back to text/html for malformed XHTML', function() {
    const doc = Fetcher.parseXhtml('<html><body><p>unclosed<br>tag</p></body></html>');
    assert(doc.querySelector('p') !== null, 'should parse with text/html fallback');
  });
});

// --- Session expiry detection -------------------------------------------
// A library proxy (EZproxy) answers an unauthenticated request with a 302 to
// its login host. From a content script that redirect is cross-origin, so
// `redirect: 'follow'` never yields a readable response -- CORS turns it into
// an indistinguishable TypeError. Issuing the request with `redirect: 'manual'`
// surfaces it as an opaque redirect instead, which is the only observable
// signal, and works whether the login host is same-origin or not.

describe('Fetcher._fetchWithRetry session expiry', function() {
  async function withFetch(impl, body) {
    const orig = window.fetch;
    const calls = [];
    window.fetch = async (url, init) => { calls.push({ url: String(url), init }); return impl(calls.length); };
    try { return await body(calls); } finally { window.fetch = orig; }
  }
  async function expectThrows(fn) {
    try { await fn(); } catch (e) { return e; }
    throw new Error('expected a throw, got none');
  }
  const okResponse = (over = {}) => Object.assign({
    ok: true, status: 200, type: 'basic', headers: new Headers(),
    text: async () => 'body', json: async () => ({}),
  }, over);

  it('still throws SESSION_EXPIRED on HTTP 401 (direct mode)', async function() {
    await withFetch(() => okResponse({ ok: false, status: 401 }), async () => {
      const err = await expectThrows(() => Fetcher._fetchWithRetry('/api/v2/x', { maxRetries: 0 }));
      assertEqual(err.message, 'SESSION_EXPIRED');
    });
  });

  it('throws SESSION_EXPIRED on an opaque redirect', async function() {
    // EZproxy's 302 to login.ezproxy.<lib>.org, seen through redirect:'manual'
    await withFetch(() => okResponse({ ok: false, status: 0, type: 'opaqueredirect' }), async () => {
      const err = await expectThrows(() => Fetcher._fetchWithRetry('/api/v2/x', { maxRetries: 3 }));
      assertEqual(err.message, 'SESSION_EXPIRED');
    });
  });

  it('does not spend retries on an opaque redirect', async function() {
    await withFetch(() => okResponse({ ok: false, status: 0, type: 'opaqueredirect' }), async (calls) => {
      await expectThrows(() => Fetcher._fetchWithRetry('/api/v2/x', { maxRetries: 3 }));
      assertEqual(calls.length, 1, 'an expired session must fail fast, not retry 4x with backoff');
    });
  });

  it('issues requests with redirect: manual', async function() {
    // Guards the whole mechanism: a refactor back to the default 'follow'
    // would make expiry unobservable again, silently.
    await withFetch(() => okResponse(), async (calls) => {
      await Fetcher._fetchWithRetry('/api/v2/x', { maxRetries: 0 });
      assertEqual(calls[0].init.redirect, 'manual');
      assertEqual(calls[0].init.credentials, 'include');
    });
  });

  it('accepts an authenticated 200 that answers text/html', async function() {
    // Chapter endpoints legitimately serve text/html under /api/. Treating that
    // as expiry -- as an earlier draft of this feature proposed -- would fail
    // every chapter of every book, in both direct and proxy mode.
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    await withFetch(() => okResponse({ headers }), async () => {
      const res = await Fetcher._fetchWithRetry('/api/v2/epubs/urn:orm:book:1/files/ch1.xhtml', { maxRetries: 0 });
      assertEqual(res.status, 200);
      assertEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
    });
  });

  it('retries a genuine network TypeError and rethrows it as a non-session error', async function() {
    await withFetch(() => { throw new TypeError('Failed to fetch'); }, async (calls) => {
      const err = await expectThrows(() => Fetcher._fetchWithRetry('/api/v2/x', { maxRetries: 1 }));
      assertEqual(err.constructor.name, 'TypeError');
      assert(err.message !== 'SESSION_EXPIRED', 'offline must not masquerade as an expired session');
      assertEqual(calls.length, 2, 'a transient fault is still retried');
    });
  });
});
