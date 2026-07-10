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

describe('background.js attempt guards and stable complete state', function() {
  // Start a download on the given tab; returns the attemptId the SW issued
  async function startAttempt(tabId, initialState) {
    ChromeMock.resetStorage(initialState ? { state: initialState } : {});
    ChromeMock.clearBadgeEvents();
    let sentAttemptId = null;
    ChromeMock.setTabsSendMessage(async (id, msg) => { sentAttemptId = msg.attemptId; });
    const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'startDownload', tabId });
    assert(response && response.ok === true, `start failed: ${JSON.stringify(response)}`);
    return sentAttemptId;
  }
  const sender = (tabId) => ({ tab: { id: tabId } });

  it('issues an attemptId, stores it, and passes it to the content script', async function() {
    const attemptId = await startAttempt(5);
    assert(attemptId, 'startDownload command must carry an attemptId');
    assertEqual(ChromeMock.getStorage().state.attemptId, attemptId,
      'the issued attemptId must be stored in session state');
  });

  it('accepts progress from the current attempt and scopes the badge to the tab', async function() {
    const attemptId = await startAttempt(5);
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER,
      { action: 'progress', attemptId, chapter: 1, totalChapters: 3, images: 0, totalImages: 0 },
      sender(5));
    const state = ChromeMock.getStorage().state;
    assertEqual(state.progress && state.progress.chapter, 1);
    const badge = ChromeMock.badgeEvents.find(e => e.kind === 'text' && e.text === '1/3');
    assert(badge, 'progress badge expected');
    assertEqual(badge.tabId, 5, 'badge must be scoped to the downloading tab');
  });

  it('drops progress with a stale attemptId after cancel (no status resurrection)', async function() {
    const attemptId = await startAttempt(5);
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'cancelDownload' });
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER,
      { action: 'progress', attemptId, chapter: 2, totalChapters: 3, images: 0, totalImages: 0 },
      sender(5));
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'idle', 'a late progress message must not resurrect downloading');
    assertEqual(state.progress, null, 'stale progress payload must be dropped');
  });

  it('drops downloadComplete with a stale attemptId (cancel wins the race)', async function() {
    const attemptId = await startAttempt(5);
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'cancelDownload' });
    ChromeMock.clearBadgeEvents();
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER,
      { action: 'downloadComplete', attemptId }, sender(5));
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'idle', 'a late downloadComplete must not mint a complete state');
    assert(!ChromeMock.badgeEvents.some(e => e.text === '✓'),
      'no success badge after a cancelled attempt');
  });

  it('drops lifecycle messages whose sender is not the downloading tab', async function() {
    const attemptId = await startAttempt(5);
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER,
      { action: 'progress', attemptId, chapter: 1, totalChapters: 3, images: 0, totalImages: 0 },
      sender(9));
    assertEqual(ChromeMock.getStorage().state.progress, null,
      'messages from the wrong tab must be dropped');
  });

  it('downloadComplete yields a stable complete state with a tab-scoped badge', async function() {
    const attemptId = await startAttempt(5);
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER,
      { action: 'downloadComplete', attemptId }, sender(5));
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'complete');
    assertEqual(state.downloadingTabId, null);
    assertEqual(state.attemptId, null, 'no active attempt after completion');
    const badge = ChromeMock.badgeEvents.find(e => e.kind === 'text' && e.text === '✓');
    assert(badge, 'success badge expected');
    assertEqual(badge.tabId, 5, 'success badge must be scoped to the completed tab');
    // Stable: a fresh state read a beat later still reports complete
    await new Promise(r => setTimeout(r, 50));
    assertEqual(ChromeMock.getStorage().state.status, 'complete',
      'complete must persist with no timer resetting it');
  });

  it('clears the starting tab\'s badge and old report when a new download begins', async function() {
    await startAttempt(5, {
      status: 'complete', progress: null, error: null, downloadingTabId: null,
      attemptId: null, bookInfoByTab: {}, reportByTab: { 5: { attemptId: 'old' } },
    });
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'downloading');
    assert(!state.reportByTab[5], 'the starting tab\'s previous report must be replaced');
    assert(ChromeMock.badgeEvents.some(e => e.kind === 'text' && e.text === '' && e.tabId === 5),
      'the starting tab\'s stale badge must be cleared');
  });

  it('reportAck clears the badge for the given tab without touching state', async function() {
    ChromeMock.resetStorage({ state: {
      status: 'complete', progress: null, error: null, downloadingTabId: null,
      attemptId: null, bookInfoByTab: {}, reportByTab: { 7: { attemptId: 'a' } },
    } });
    ChromeMock.clearBadgeEvents();
    await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'reportAck', tabId: 7 });
    assert(ChromeMock.badgeEvents.some(e => e.kind === 'text' && e.text === '' && e.tabId === 7),
      'ack must clear the tab badge');
    const state = ChromeMock.getStorage().state;
    assertEqual(state.status, 'complete', 'ack must not change status');
    assert(state.reportByTab[7], 'ack must not delete the report');
  });

  it('closing the report tab removes its report and residual complete status', async function() {
    ChromeMock.resetStorage({ state: {
      status: 'complete', progress: null, error: null, downloadingTabId: null,
      attemptId: null, bookInfoByTab: { 7: { title: 'X' } }, reportByTab: { 7: { attemptId: 'a' } },
    } });
    await ChromeMock.fireTabRemoved(7);
    const state = ChromeMock.getStorage().state;
    assert(!state.reportByTab[7], 'report must be removed with its tab');
    assert(!state.bookInfoByTab[7], 'book info must be removed with its tab');
    assertEqual(state.status, 'idle', 'residual complete must reset when its tab closes');
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
        undefined,
      ]) {
        const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, { action: 'fetchImage', url });
        assert(response && response.ok === false, `expected rejection for ${url}`);
      }
      assertEqual(fetched, false, 'handler must not fetch disallowed URLs');
    });
  });

  it('rejects responses that redirected outside the allowlist', async function() {
    const bytes = new Uint8Array([1, 2, 3]);
    await withPatchedFetch(async () => ({
      ok: true,
      url: 'https://evil.example/final.jpg',
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => bytes.buffer,
    }), async () => {
      const response = await ChromeMock.dispatchTo(BACKGROUND_LISTENER, {
        action: 'fetchImage', url: 'https://learning.oreilly.com/library/cover/123/',
      });
      assert(response && response.ok === false,
        'a credentialed fetch that 302s off-allowlist must be rejected');
    });
  });
});
