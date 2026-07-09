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
