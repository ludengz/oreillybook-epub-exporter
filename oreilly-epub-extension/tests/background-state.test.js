// Tests for background.js state management around startDownload.
// background.js registers the SECOND runtime.onMessage listener (see load
// order in test-runner.html).
const BACKGROUND_LISTENER = 1;

describe('background.js startDownload state management', function() {
  it('rolls back to idle and reports failure when the content script is unreachable', async function() {
    ChromeMock.resetStorage();
    ChromeMock.setTabsSendMessage(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });

    const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'startDownload', tabId: 42 });

    assert(response && response.ok === false,
      `expected ok:false response, got ${JSON.stringify(response)}`);
    const state = ChromeMock.getStorage().state;
    assertEqual(state ? state.status : '(no state)', 'idle', 'state should roll back to idle');
    assertEqual(state ? state.downloadingTabId : '(no state)', null, 'downloadingTabId should be cleared');
  });

  it('enters downloading state when the content script is reachable', async function() {
    ChromeMock.resetStorage();
    ChromeMock.setTabsSendMessage(async () => undefined);

    const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'startDownload', tabId: 7 });

    assert(response && response.ok === true, `expected ok:true, got ${JSON.stringify(response)}`);
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'downloading');
    assertEqual(state.downloadingTabId, 7);
  });

  it('rejects startDownload without a tab id', async function() {
    ChromeMock.resetStorage();
    const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'startDownload' });
    assert(response && response.ok === false,
      `expected ok:false for missing tabId, got ${JSON.stringify(response)}`);
    const state = ChromeMock.getStorage().state;
    assert(!state || state.status !== 'downloading', 'must not enter downloading state without a tab');
  });
});

describe('background.js fetchImage proxy', function() {
  async function withPatchedFetch(impl, body) {
    const orig = window.fetch;
    try {
      window.fetch = impl;
      await body();
    } finally {
      window.fetch = orig;
    }
  }

  it('returns base64 data and contentType for an allowed host', async function() {
    const bytes = new Uint8Array([1, 2, 3]);
    await withPatchedFetch(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => bytes.buffer,
    }), async () => {
      const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, {
        action: 'fetchImage', url: 'https://learning.oreilly.com/library/cover/123/',
      });
      assert(response && response.ok === true, `expected ok:true, got ${JSON.stringify(response)}`);
      assertEqual(response.data, btoa(String.fromCharCode(1, 2, 3)));
      assertEqual(response.contentType, 'image/jpeg');
    });
  });

  it('reports fetch failures as ok:false', async function() {
    await withPatchedFetch(async () => ({ ok: false, status: 404, headers: new Headers() }), async () => {
      const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, {
        action: 'fetchImage', url: 'https://learning.oreilly.com/x.png',
      });
      assert(response && response.ok === false, 'HTTP failure must surface as ok:false');
    });
  });

  it('rejects disallowed, spoofed, and non-https URLs without fetching', async function() {
    let fetched = false;
    await withPatchedFetch(async () => { fetched = true; throw new Error('should not fetch'); }, async () => {
      for (const url of [
        'https://evil.example/x.jpg',
        'https://oreillystatic.com.evil.example/x.jpg',
        'http://learning.oreilly.com/x.jpg',
      ]) {
        const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'fetchImage', url });
        assert(response && response.ok === false, `expected rejection for ${url}`);
      }
      assertEqual(fetched, false, 'handler must not fetch disallowed URLs');
    });
  });
});
