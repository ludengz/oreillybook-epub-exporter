// Service Worker: message relay, badge, state, progress broadcast
// Uses chrome.storage.session to survive SW termination (MV3 lifecycle)

const DEFAULT_STATE = {
  status: 'idle', // idle | downloading | complete | error
  progress: null,
  error: null,
  downloadingTabId: null,
  bookInfoByTab: {},
};

async function getState() {
  const result = await chrome.storage.session.get('state');
  return result.state || { ...DEFAULT_STATE };
}

async function setState(updates) {
  const current = await getState();
  const next = { ...current, ...updates };
  await chrome.storage.session.set({ state: next });
  return next;
}

async function setTabBookInfo(tabId, bookInfo) {
  if (tabId == null) return;
  const state = await getState();
  const bookInfoByTab = { ...state.bookInfoByTab, [tabId]: bookInfo };
  await chrome.storage.session.set({ state: { ...state, bookInfoByTab } });
}

async function removeTabBookInfo(tabId) {
  const state = await getState();
  const bookInfoByTab = { ...state.bookInfoByTab };
  delete bookInfoByTab[tabId];
  const updates = { bookInfoByTab };
  if (state.downloadingTabId === tabId) {
    updates.status = 'idle';
    updates.progress = null;
    updates.error = null;
    updates.downloadingTabId = null;
    chrome.action.setBadgeText({ text: '' });
  }
  await chrome.storage.session.set({ state: { ...state, ...updates } });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap async handler so sendResponse works
  (async () => {
    switch (message.action) {
      case 'getState': {
        const st = await getState();
        const tabId = message.tabId;
        sendResponse({
          status: st.status,
          progress: st.progress,
          error: st.error,
          downloadingTabId: st.downloadingTabId,
          bookInfo: tabId ? (st.bookInfoByTab[tabId] || null) : null,
          downloadingBookInfo: st.downloadingTabId
            ? (st.bookInfoByTab[st.downloadingTabId] || null)
            : null,
        });
        return;
      }

      case 'startDownload': {
        const st = await getState();
        if (st.status === 'downloading') {
          sendResponse({ ok: false, reason: 'already_downloading' });
          return;
        }
        const targetTabId = message.tabId;
        if (!targetTabId) {
          sendResponse({ ok: false, reason: 'no_tab' });
          return;
        }
        await setState({ downloadingTabId: targetTabId, status: 'downloading' });
        try {
          await chrome.tabs.sendMessage(targetTabId, { action: 'startDownload' });
        } catch (err) {
          // Content script unreachable (e.g. extension reloaded, page not refreshed):
          // roll back so the UI is not stuck in a downloading state forever
          await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null });
          sendResponse({ ok: false, reason: 'content_script_unreachable' });
          return;
        }
        sendResponse({ ok: true });
        return;
      }

      case 'cancelDownload': {
        const st = await getState();
        if (st.downloadingTabId) {
          chrome.tabs.sendMessage(st.downloadingTabId, { action: 'cancelDownload' });
        }
        await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null });
        chrome.action.setBadgeText({ text: '' });
        return;
      }

      case 'bookDetected':
        if (sender.tab?.id != null) {
          await setTabBookInfo(sender.tab.id, message.bookInfo);
        }
        sendResponse({ ok: true });
        return;

      case 'progress': {
        const st = await getState();
        const progress = {
          chapter: message.chapter,
          totalChapters: message.totalChapters,
          images: message.images,
          totalImages: message.totalImages,
        };
        await setState({ status: 'downloading', progress });
        chrome.action.setBadgeText({
          text: `${message.chapter}/${message.totalChapters}`,
        });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
        chrome.runtime.sendMessage({
          action: 'progressUpdate',
          tabId: st.downloadingTabId,
          ...progress,
        }).catch(() => {});
        return;
      }

      case 'downloadComplete': {
        const st = await getState();
        const completedTabId = st.downloadingTabId;
        await setState({ status: 'complete', downloadingTabId: null });
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
        chrome.runtime.sendMessage({
          action: 'downloadComplete',
          tabId: completedTabId,
        }).catch(() => {});
        setTimeout(async () => {
          chrome.action.setBadgeText({ text: '' });
          await setState({ status: 'idle' });
        }, 5000);
        return;
      }

      case 'downloadError': {
        const st = await getState();
        await setState({ status: 'error', error: message.error });
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
        chrome.runtime.sendMessage({
          action: 'downloadError',
          tabId: st.downloadingTabId,
          error: message.error,
        }).catch(() => {});
        if (message.error && message.error.includes('Session expired')) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'O\'Reilly EPUB Exporter',
            message: 'Session expired. Please log in to O\'Reilly and try again.',
          });
        }
        return;
      }

      case 'fetchImage': {
        // CORS proxy: fetch image from SW context (bypasses content script CORS)
        try {
          const response = await fetch(message.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          // Convert to base64 for message passing (ArrayBuffer can't be sent)
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          sendResponse({ ok: true, data: btoa(binary) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
    }
  })();
  return true; // Keep message channel open for async response
});

// Clean up per-tab state when a tab is closed (R5, R6)
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabBookInfo(tabId);
});
