// Service Worker: message relay, badge, state, progress broadcast
// Uses chrome.storage.session to survive SW termination (MV3 lifecycle)

// Shared pure helpers (PathUtils.isAllowedImageUrl). In the real MV3 service
// worker importScripts loads them; in the test-runner page background.js is
// loaded via a script tag where importScripts does not exist but PathUtils
// is already a global. Do not derive the allowlist from
// chrome.runtime.getManifest() — the test chrome mock does not stub it.
if (typeof importScripts === 'function') {
  try {
    importScripts('lib/path-utils.js');
  } catch (e) {
    // Fail closed but keep the SW alive: fetchImage's allowlist check will
    // throw on the missing PathUtils and reject requests, while the message
    // relay and state handlers keep working.
    console.error('Failed to load lib/path-utils.js in the service worker:', e);
  }
}

const DEFAULT_STATE = {
  status: 'idle', // idle | downloading | complete | error
  progress: null,
  error: null,
  downloadingTabId: null,
  attemptId: null, // generation id of the active download; guards late messages
  bookInfoByTab: {},
  reportByTab: {}, // per-tab quality report snapshots (last attempt per tab)
};

// Lifecycle messages (progress/downloadComplete/downloadError) are only
// trusted while their attempt is the active one. A message that lost a race
// against cancelDownload or a newer download carries a stale attemptId (or
// arrives from the wrong tab) and must be dropped, or it would resurrect a
// cancelled download's status, mint ghost reports, or fire false
// notifications.
function isCurrentAttempt(st, message, sender) {
  return st.status === 'downloading'
    && st.attemptId != null
    && message.attemptId === st.attemptId
    && sender.tab?.id === st.downloadingTabId;
}

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

// --- Popup presence & system notifications ---------------------------------
// The popup opens a "popup" port on load and reports which tab it shows.
// Port disconnect is the reliable popup-closed signal in MV3. A terminal
// notification is suppressed only when a connected popup is showing the
// affected tab — a popup open on another tab must not swallow the signal.
// (Module state resets with the SW; worst case is one redundant
// notification, never a lost one.)
let popupPresence = null; // { viewingTabId }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.action === 'popupViewing') {
      popupPresence = { viewingTabId: msg.tabId };
    }
  });
  port.onDisconnect.addListener(() => { popupPresence = null; });
});

// notificationId -> tabId survives SW restarts between create and click
async function rememberNotificationTab(notificationId, tabId) {
  const stored = await chrome.storage.session.get('notificationTabs');
  const map = stored.notificationTabs || {};
  map[notificationId] = tabId;
  await chrome.storage.session.set({ notificationTabs: map });
}

function reportSummaryText(report) {
  if (!report || !report.counts) return 'Download complete.';
  const c = report.counts;
  const problems = (c.chaptersPlaceholder || 0) + (c.imagesFailed || 0)
    + (c.cssFailed || 0) + (report.validationWarnings || []).length;
  const base = `${c.chaptersOk || 0} chapters, ${c.imagesOk || 0} images downloaded.`;
  return problems ? `${base} ${problems} issue(s) — see the popup report.` : base;
}

async function notifyTerminal(tabId, title, messageText) {
  if (popupPresence && popupPresence.viewingTabId === tabId) return;
  const notificationId = `oreilly-epub-${Date.now()}-${tabId}`;
  await rememberNotificationTab(notificationId, tabId);
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: messageText,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const stored = await chrome.storage.session.get('notificationTabs');
  const tabId = (stored.notificationTabs || {})[notificationId];
  if (tabId == null) return;
  try {
    // Resolve the tab's CURRENT window at click time — it may have moved
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    // Tab is gone — graceful no-op
  }
  chrome.notifications.clear(notificationId);
});

// Clean map entries only when their notification goes away, so still-visible
// older notifications keep working across later downloads
chrome.notifications.onClosed.addListener(async (notificationId) => {
  const stored = await chrome.storage.session.get('notificationTabs');
  const map = stored.notificationTabs || {};
  if (map[notificationId] != null) {
    delete map[notificationId];
    await chrome.storage.session.set({ notificationTabs: map });
  }
});

async function removeTabBookInfo(tabId) {
  const state = await getState();
  const bookInfoByTab = { ...state.bookInfoByTab };
  delete bookInfoByTab[tabId];
  const updates = { bookInfoByTab };
  if (state.reportByTab && state.reportByTab[tabId]) {
    const reportByTab = { ...state.reportByTab };
    delete reportByTab[tabId];
    updates.reportByTab = reportByTab;
    // A stable complete state belongs to its report; when that report's tab
    // goes away and nothing is downloading, return to baseline
    if (state.status === 'complete' && state.downloadingTabId == null) {
      updates.status = 'idle';
    }
  }
  if (state.downloadingTabId === tabId) {
    updates.status = 'idle';
    updates.progress = null;
    updates.error = null;
    updates.downloadingTabId = null;
    updates.attemptId = null;
  }
  // Per-tab badges die with their tab; no badge call needed here
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
          report: tabId ? ((st.reportByTab || {})[tabId] || null) : null,
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
        // New attempt: a fresh generation id gates every lifecycle message
        // of this download; the starting tab's old badge and report go away
        const attemptId = crypto.randomUUID();
        const reportByTab = { ...st.reportByTab };
        delete reportByTab[targetTabId];
        await setState({
          downloadingTabId: targetTabId,
          status: 'downloading',
          attemptId,
          progress: null,
          error: null,
          reportByTab,
        });
        chrome.action.setBadgeText({ text: '', tabId: targetTabId });
        try {
          await chrome.tabs.sendMessage(targetTabId, { action: 'startDownload', attemptId });
        } catch (err) {
          // Content script unreachable (e.g. extension reloaded, page not refreshed):
          // roll back so the UI is not stuck in a downloading state forever
          await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null, attemptId: null });
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
          chrome.action.setBadgeText({ text: '', tabId: st.downloadingTabId });
        }
        // Nulling attemptId makes any in-flight message of this attempt stale
        await setState({ status: 'idle', progress: null, error: null, downloadingTabId: null, attemptId: null });
        sendResponse({ ok: true });
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
        if (!isCurrentAttempt(st, message, sender)) {
          sendResponse({ ok: false, reason: 'stale_attempt' });
          return;
        }
        const progress = {
          chapter: message.chapter,
          totalChapters: message.totalChapters,
          images: message.images,
          totalImages: message.totalImages,
        };
        await setState({ progress });
        chrome.action.setBadgeText({
          text: `${message.chapter}/${message.totalChapters}`,
          tabId: st.downloadingTabId,
        });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId: st.downloadingTabId });
        chrome.runtime.sendMessage({
          action: 'progressUpdate',
          tabId: st.downloadingTabId,
          ...progress,
        }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }

      case 'downloadComplete': {
        const st = await getState();
        if (!isCurrentAttempt(st, message, sender)) {
          sendResponse({ ok: false, reason: 'stale_attempt' });
          return;
        }
        const completedTabId = st.downloadingTabId;
        // Snapshot the quality report before downloadingTabId is cleared; a
        // single setState write keeps status and report consistent
        const updates = { status: 'complete', downloadingTabId: null, attemptId: null, progress: null };
        if (message.report) {
          updates.reportByTab = { ...st.reportByTab, [completedTabId]: message.report };
        }
        // Stable state: no timer resets this — it clears when a new download
        // starts, the popup acks the report, or the tab closes (MV3 SW
        // termination makes delayed cleanup unreliable and racy)
        await setState(updates);
        chrome.action.setBadgeText({ text: '✓', tabId: completedTabId });
        chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId: completedTabId });
        chrome.runtime.sendMessage({
          action: 'downloadComplete',
          tabId: completedTabId,
        }).catch(() => {});
        const bookTitle = message.report && message.report.bookTitle
          ? message.report.bookTitle : 'Book';
        await notifyTerminal(completedTabId,
          `Download complete: ${bookTitle}`, reportSummaryText(message.report));
        sendResponse({ ok: true });
        return;
      }

      case 'downloadError': {
        const st = await getState();
        if (!isCurrentAttempt(st, message, sender)) {
          sendResponse({ ok: false, reason: 'stale_attempt' });
          return;
        }
        // downloadingTabId stays set: the popup's error view is scoped to it.
        // The partial report is snapshotted too — an error-terminated attempt
        // keeps the bookkeeping it accumulated
        const errUpdates = { status: 'error', error: message.error, attemptId: null };
        if (message.report) {
          errUpdates.reportByTab = { ...st.reportByTab, [st.downloadingTabId]: message.report };
        }
        await setState(errUpdates);
        chrome.action.setBadgeText({ text: '!', tabId: st.downloadingTabId });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId: st.downloadingTabId });
        chrome.runtime.sendMessage({
          action: 'downloadError',
          tabId: st.downloadingTabId,
          error: message.error,
        }).catch(() => {});
        // Generic failure notification (the old session-expiry special case
        // is merged here). Cancel sends no downloadError, so never notifies.
        const errorTitle = message.errorKind === 'validation'
          ? 'Download blocked: EPUB integrity error'
          : message.error && message.error.includes('Session expired')
            ? 'Session expired'
            : 'Download failed';
        await notifyTerminal(st.downloadingTabId, errorTitle, message.error || 'Unknown error');
        sendResponse({ ok: true });
        return;
      }

      case 'reportAck': {
        // Popup rendered the report panel: the badge has served its purpose.
        // Badge only — the report itself persists until replaced/tab close.
        if (message.tabId != null) {
          chrome.action.setBadgeText({ text: '', tabId: message.tabId });
        }
        sendResponse({ ok: true });
        return;
      }

      case 'fetchImage': {
        // CORS proxy: fetch image from SW context (bypasses content script CORS)
        try {
          // Defense-in-depth: the privileged, credentialed fetch validates
          // the URL itself instead of trusting the caller-side gate alone.
          // Off-O'Reilly chapter images are deliberately rejected too.
          if (!PathUtils.isAllowedImageUrl(message.url)) {
            sendResponse({ ok: false, error: 'URL not allowed' });
            return;
          }
          const response = await fetch(message.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // Redirects can land outside the allowlist; re-validate the final
          // URL so an allowed host cannot 302 the credentialed fetch away
          if (response.url && !PathUtils.isAllowedImageUrl(response.url)) {
            sendResponse({ ok: false, error: 'Redirected outside allowlist' });
            return;
          }
          const contentType = response.headers.get('content-type') || null;
          const buffer = await response.arrayBuffer();
          // Convert to base64 for message passing (ArrayBuffer can't be sent)
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          sendResponse({ ok: true, data: btoa(binary), contentType });
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
