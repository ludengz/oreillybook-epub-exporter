// Integration-style tests for the content.js download lifecycle.
// content.js registers the FIRST runtime.onMessage listener (see load order
// in test-runner.html), background.js registers the second.
const CONTENT_LISTENER = 0;

function mockResponse({ ok = true, status = 200, jsonBody = null, textBody = '', buffer = null } = {}) {
  return {
    ok,
    status,
    headers: new Headers(),
    json: async () => jsonBody,
    text: async () => textBody,
    arrayBuffer: async () => buffer || new ArrayBuffer(8),
  };
}

const TEST_CHAPTER_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch 1</title></head><body><h1>Chapter One</h1><p>text</p></body></html>';

// Fetch mock simulating a healthy O'Reilly API with a one-chapter book
function successFetchMock() {
  return async (url) => {
    url = String(url);
    if (url.includes('/api/v2/search/')) {
      return mockResponse({ jsonBody: { results: [{ title: 'Test Book', authors: ['Author A'] }] } });
    }
    if (url.includes('/files/?limit=')) {
      return mockResponse({
        jsonBody: {
          results: [{ full_path: 'ch1.xhtml', kind: 'chapter', media_type: 'application/xhtml+xml' }],
          next: null,
        },
      });
    }
    if (url.includes('eink-override.css')) {
      return mockResponse({ textBody: 'body { color: #000; }' });
    }
    if (url.includes('/files/ch1.xhtml')) {
      return mockResponse({ textBody: TEST_CHAPTER_XHTML });
    }
    return mockResponse({ ok: false, status: 404 });
  };
}

// Run one download cycle in a patched environment; restores globals afterwards.
// The metadata cache in content.js persists for the whole test-runner page
// session, so tests needing fresh cache state must pass a distinct ISBN.
// The generated EPUB's blob URL is captured into lastBlobUrl for inspection.
let lastBlobUrl = null;
async function withPatchedEnv(fetchImpl, body, isbn = '9781111111111') {
  const origFetch = window.fetch;
  const origExtract = Fetcher.extractIsbn;
  const origClick = HTMLAnchorElement.prototype.click;
  try {
    Fetcher.extractIsbn = () => isbn;
    window.fetch = fetchImpl;
    // Suppress the real file download but keep the blob URL for assertions
    HTMLAnchorElement.prototype.click = function() { lastBlobUrl = this.href; };
    await body(origFetch);
  } finally {
    window.fetch = origFetch;
    Fetcher.extractIsbn = origExtract;
    HTMLAnchorElement.prototype.click = origClick;
  }
}

describe('content.js book detection and metadata cache', function() {
  it('sends the frozen bookDetected payload shape {isbn, title, authors}', async function() {
    await withPatchedEnv(successFetchMock(), async () => {
      ChromeMock.clearMessages();
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'redetectBook' });
      const msg = ChromeMock.sentMessages.find(m => m.action === 'bookDetected');
      assert(msg, 'bookDetected message expected');
      // Frozen contract: popup renders these fields directly
      assertEqual(Object.keys(msg.bookInfo).sort().join(','), 'authors,isbn,title');
      assertEqual(msg.bookInfo.isbn, '9783333333333');
      assertEqual(msg.bookInfo.title, 'Test Book');
      assert(Array.isArray(msg.bookInfo.authors), 'authors must be an array');
    }, '9783333333333');
  });

  it('does not cache fallback results: a later redetect retries the API', async function() {
    let failing = true;
    const inner = successFetchMock();
    const flippableFetch = async (url) => {
      if (failing) return mockResponse({ ok: false, status: 500 });
      return inner(url);
    };
    await withPatchedEnv(flippableFetch, async () => {
      ChromeMock.clearMessages();
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'redetectBook' });
      const first = ChromeMock.sentMessages.find(m => m.action === 'bookDetected');
      assert(first, 'fallback bookDetected expected');
      // The fallback title comes from document.title parsing, not the API
      assert(first.bookInfo.title !== 'Test Book', 'first detect should use the fallback title');

      failing = false;
      ChromeMock.clearMessages();
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'redetectBook' });
      const second = ChromeMock.sentMessages.find(m => m.action === 'bookDetected');
      assertEqual(second.bookInfo.title, 'Test Book',
        'a failed fetch must not be cached; the retry should reach the API');
    }, '9784444444444');
  });

  it('memoizes successful metadata fetches per ISBN', async function() {
    let searchCalls = 0;
    const inner = successFetchMock();
    const countingFetch = async (url) => {
      if (String(url).includes('/api/v2/search/')) searchCalls++;
      return inner(url);
    };
    await withPatchedEnv(countingFetch, async () => {
      ChromeMock.clearMessages();
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'redetectBook' });
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'redetectBook' });
      assertEqual(searchCalls, 1, 'second detect should be served from the cache');
    }, '9785555555555');
  });

  it('buildEpub retries a fallback-shaped metadata result once (backstop)', async function() {
    // Drives the retry branch inside buildEpub itself (not via redetectBook):
    // the first search call fails, the backstop's second call succeeds.
    const realFetch = window.fetch;
    const inner = successFetchMock();
    let searchCalls = 0;
    const flakyFetch = async (url) => {
      url = String(url);
      if (url.startsWith('blob:')) return realFetch(url);
      if (url.includes('/api/v2/search/')) {
        searchCalls++;
        if (searchCalls === 1) return mockResponse({ ok: false, status: 500 });
      }
      return inner(url);
    };
    await withPatchedEnv(flakyFetch, async () => {
      lastBlobUrl = null;
      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 8000, label: 'backstop downloadComplete' });
      assertEqual(searchCalls, 2, 'fallback-shaped first result must trigger exactly one retry');
      const buf = await (await window.fetch(lastBlobUrl)).arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const opf = await zip.file('OEBPS/content.opf').async('string');
      assertContains(opf, '<dc:title>Test Book</dc:title>',
        'the retried metadata must reach the OPF');
    }, '9781414141414');
  });

  it('distrusts rich fields when the search result is a different book', async function() {
    const realFetch = window.fetch;
    const inner = successFetchMock();
    const mismatchFetch = async (url) => {
      url = String(url);
      if (url.startsWith('blob:')) return realFetch(url);
      if (url.includes('/api/v2/search/')) {
        // archive_id differs from the requested ISBN → fuzzy-search miss
        return mockResponse({ jsonBody: { results: [{
          title: 'Wrong Book', authors: ['B'],
          archive_id: '9789999999999',
          language: 'ja',
        }] } });
      }
      return inner(url);
    };
    await withPatchedEnv(mismatchFetch, async () => {
      lastBlobUrl = null;
      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 8000, label: 'mismatch downloadComplete' });
      assert(lastBlobUrl, 'download should produce a blob URL');
      const buf = await (await window.fetch(lastBlobUrl)).arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const opf = await zip.file('OEBPS/content.opf').async('string');
      // Rich fields from the mismatched result must not reach the OPF:
      // dc:language falls back to en instead of the wrong book's "ja"
      assertContains(opf, '<dc:language>en</dc:language>',
        'mismatched search result must not contribute rich fields');
    }, '9786666666666');
  });
});

describe('content.js quality report bookkeeping', function() {
  const CHAPTER_WITH_IMG = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><h1>C</h1><img src="images/gone.png"/></body></html>';

  async function withNoRetries(body) {
    const origRetry = Fetcher._fetchWithRetry;
    Fetcher._fetchWithRetry = function(url, opts) {
      return origRetry.call(Fetcher, url, Object.assign({}, opts, { maxRetries: 0 }));
    };
    try { await body(); } finally { Fetcher._fetchWithRetry = origRetry; }
  }

  async function runDownload(attemptId, terminalAction = 'downloadComplete') {
    await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'cancelDownload' });
    ChromeMock.clearMessages();
    ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload', attemptId });
    await waitFor(() => ChromeMock.sentMessages.some(m => m.action === terminalAction),
      { timeout: 8000, label: `${terminalAction} report` });
    return ChromeMock.sentMessages.find(m => m.action === terminalAction);
  }

  it('attaches an all-clear report to downloadComplete on a clean download', async function() {
    await withPatchedEnv(successFetchMock(), async () => {
      const msg = await runDownload('rep-1');
      const r = msg.report;
      assert(r, 'downloadComplete must carry a report');
      assertEqual(r.attemptId, 'rep-1');
      assertEqual(r.outcome, 'complete');
      assertEqual(r.bookTitle, 'Test Book');
      assertEqual(r.counts.chaptersOk, 1);
      assertEqual(r.counts.chaptersPlaceholder, 0);
      assertEqual(r.counts.imagesOk, 0);
      assertEqual(r.counts.imagesFailed, 0);
      assertEqual(r.counts.cssFailed, 0);
      assertEqual(r.counts.coverPresent, false);
      assertEqual(r.counts.metadataFromApi, true);
      assertEqual(
        r.failures.chapters.length + r.failures.images.length + r.failures.css.length, 0,
        'an all-clear report must carry no failure detail');
    }, '9787000000002');
  });

  it('records placeholder chapters with their original path', async function() {
    const inner = successFetchMock();
    const failingChapter = async (url) => {
      if (String(url).includes('/files/ch1.xhtml')) return mockResponse({ ok: false, status: 500 });
      return inner(url);
    };
    await withNoRetries(async () => {
      await withPatchedEnv(failingChapter, async () => {
        const r = (await runDownload('rep-2')).report;
        assertEqual(r.counts.chaptersPlaceholder, 1);
        assertEqual(r.counts.chaptersOk, 0);
        assertEqual(r.failures.chapters.length, 1);
        assertEqual(r.failures.chapters[0].path, 'ch1.xhtml',
          'the placeholder must record the original chapter path');
      }, '9787000000003');
    });
  });

  it('dedupes the same failing image source across chapters', async function() {
    const fetchMock = async (url) => {
      url = String(url);
      if (url.includes('/api/v2/search/')) {
        return mockResponse({ jsonBody: { results: [{ title: 'Img Book', authors: ['A'] }] } });
      }
      if (url.includes('/files/?limit=')) {
        return mockResponse({ jsonBody: { results: [
          { full_path: 'ch1.xhtml', kind: 'chapter', media_type: 'application/xhtml+xml' },
          { full_path: 'ch2.xhtml', kind: 'chapter', media_type: 'application/xhtml+xml' },
        ], next: null } });
      }
      if (url.includes('eink-override.css')) return mockResponse({ textBody: 'body {}' });
      if (url.includes('/files/ch1.xhtml') || url.includes('/files/ch2.xhtml')) {
        return mockResponse({ textBody: CHAPTER_WITH_IMG });
      }
      return mockResponse({ ok: false, status: 404 });
    };
    await withNoRetries(async () => {
      await withPatchedEnv(fetchMock, async () => {
        const r = (await runDownload('rep-3')).report;
        assertEqual(r.counts.chaptersOk, 2);
        assertEqual(r.counts.imagesFailed, 1,
          'the same failing src in two chapters must count once');
        assertEqual(r.failures.images.length, 1);
        assertEqual(r.failures.images[0], 'images/gone.png');
      }, '9787000000004');
    });
  });

  it('attaches the partial report with outcome error to downloadError', async function() {
    const failingManifest = async (url) => {
      url = String(url);
      if (url.includes('/api/v2/search/')) {
        return mockResponse({ jsonBody: { results: [{ title: 'Err Book', authors: ['A'] }] } });
      }
      return mockResponse({ ok: false, status: 500 });
    };
    await withPatchedEnv(failingManifest, async () => {
      const msg = await runDownload('rep-4', 'downloadError');
      assert(msg.report, 'downloadError must carry the partial report');
      assertEqual(msg.report.outcome, 'error');
      assertEqual(msg.report.attemptId, 'rep-4');
      assertEqual(msg.report.counts.chaptersOk, 0);
      assertEqual(msg.errorKind, 'download');
    }, '9787000000005');
  });

  it('flags page-fallback metadata in the report', async function() {
    const inner = successFetchMock();
    const noApiMetadata = async (url) => {
      if (String(url).includes('/api/v2/search/')) return mockResponse({ ok: false, status: 500 });
      return inner(url);
    };
    await withPatchedEnv(noApiMetadata, async () => {
      const r = (await runDownload('rep-5')).report;
      assertEqual(r.outcome, 'complete');
      assertEqual(r.counts.metadataFromApi, false,
        'page-fallback metadata must be flagged in the report');
    }, '9787000000006');
  });
});

describe('content.js download lifecycle', function() {
  it('allows a second download after the first completes successfully', async function() {
    await withPatchedEnv(successFetchMock(), async () => {
      // Reset content-script internal state deterministically
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'cancelDownload' });
      ChromeMock.clearMessages();

      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 8000, label: 'first downloadComplete' });

      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 8000, label: 'second downloadComplete (download state must reset after success)' });
    });
  });

  it('carries the attemptId from startDownload on every lifecycle message', async function() {
    await withPatchedEnv(successFetchMock(), async () => {
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'cancelDownload' });
      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload', attemptId: 'attempt-123' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 8000, label: 'attemptId downloadComplete' });
      const lifecycle = ChromeMock.sentMessages.filter(m =>
        ['progress', 'downloadComplete', 'downloadError'].includes(m.action));
      assert(lifecycle.length > 0, 'expected lifecycle messages');
      for (const m of lifecycle) {
        assertEqual(m.attemptId, 'attempt-123', `${m.action} must carry the attemptId`);
      }
    }, '9787070707070');
  });

  it('allows retry after a failed download', async function() {
    const failingFetch = async () => mockResponse({ ok: false, status: 500 });
    await withPatchedEnv(failingFetch, async () => {
      await ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'cancelDownload' });
      ChromeMock.clearMessages();

      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadError'),
        { timeout: 8000, label: 'first downloadError' });

      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(CONTENT_LISTENER, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadError'),
        { timeout: 8000, label: 'second downloadError (download state must reset after failure)' });
    });
  });
});
