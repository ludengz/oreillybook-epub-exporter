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

// Run one download cycle in a patched environment; restores globals afterwards
async function withPatchedEnv(fetchImpl, body) {
  const origFetch = window.fetch;
  const origExtract = Fetcher.extractIsbn;
  const origClick = HTMLAnchorElement.prototype.click;
  try {
    Fetcher.extractIsbn = () => '9781111111111';
    window.fetch = fetchImpl;
    HTMLAnchorElement.prototype.click = function() {}; // suppress real file download
    await body();
  } finally {
    window.fetch = origFetch;
    Fetcher.extractIsbn = origExtract;
    HTMLAnchorElement.prototype.click = origClick;
  }
}

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
