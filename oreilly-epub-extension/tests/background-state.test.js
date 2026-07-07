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
