// Minimal chrome extension API mock so content.js and background.js can be
// loaded and exercised inside the browser test runner.
//
// Listeners are captured in registration order. Tests route messages to one
// specific listener via ChromeMock.dispatchTo(index, ...), mimicking the
// isolation between extension contexts (content script vs service worker).
(function() {
  'use strict';

  const listeners = [];
  const sentMessages = [];
  const badgeEvents = [];
  const tabRemovedListeners = [];
  const notificationEvents = [];
  const notificationClickListeners = [];
  const notificationClosedListeners = [];
  const connectListeners = [];
  const focusEvents = [];
  let storageStore = {};
  let tabsSendMessageImpl = async () => undefined;
  let tabsGetImpl = async (tabId) => ({ id: tabId, windowId: 100 });
  let messageResponders = {};

  window.chrome = Object.assign(window.chrome || {}, {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) { listeners.push(fn); },
      },
      sendMessage(message, callback) {
        sentMessages.push(message);
        // Action-routed responders let tests serve real payloads (e.g. a
        // base64 image for fetchImage); default remains a bare { ok: true }
        const responder = messageResponders[message.action];
        if (callback) {
          if (responder) Promise.resolve(responder(message)).then(callback);
          else callback({ ok: true });
        }
        return Promise.resolve();
      },
      onConnect: {
        addListener(fn) { connectListeners.push(fn); },
      },
      getURL(path) { return path; },
    },
    storage: {
      session: {
        async get(key) { return { [key]: storageStore[key] }; },
        async set(obj) { Object.assign(storageStore, obj); },
      },
    },
    tabs: {
      onRemoved: { addListener(fn) { tabRemovedListeners.push(fn); } },
      sendMessage(tabId, message) { return tabsSendMessageImpl(tabId, message); },
      get(tabId) { return tabsGetImpl(tabId); },
      update(tabId, props) { focusEvents.push({ kind: 'tab', tabId, ...props }); return Promise.resolve(); },
    },
    windows: {
      update(windowId, props) { focusEvents.push({ kind: 'window', windowId, ...props }); return Promise.resolve(); },
    },
    action: {
      setBadgeText(details) { badgeEvents.push({ kind: 'text', ...details }); },
      setBadgeBackgroundColor(details) { badgeEvents.push({ kind: 'color', ...details }); },
    },
    notifications: {
      create(id, options) { notificationEvents.push({ id, ...options }); },
      clear() {},
      onClicked: { addListener(fn) { notificationClickListeners.push(fn); } },
      onClosed: { addListener(fn) { notificationClosedListeners.push(fn); } },
    },
  });

  window.ChromeMock = {
    listeners,
    sentMessages,
    // Dispatch a message to a single listener; resolves with the sendResponse
    // value (or undefined if the listener does not keep the channel open).
    dispatchTo(index, message, sender = {}) {
      return new Promise((resolve) => {
        const keepOpen = listeners[index](message, sender, resolve);
        if (keepOpen !== true) resolve(undefined);
      });
    },
    clearMessages() { sentMessages.length = 0; },
    setMessageResponder(action, fn) { messageResponders[action] = fn; },
    clearResponders() { messageResponders = {}; },
    resetStorage(initial = {}) { storageStore = initial; },
    getStorage() { return storageStore; },
    setTabsSendMessage(fn) { tabsSendMessageImpl = fn; },
    badgeEvents,
    clearBadgeEvents() { badgeEvents.length = 0; },
    // Fire chrome.tabs.onRemoved listeners; resolves after all handlers settle
    async fireTabRemoved(tabId) {
      await Promise.all(tabRemovedListeners.map(fn => Promise.resolve(fn(tabId))));
    },
    notificationEvents,
    clearNotificationEvents() { notificationEvents.length = 0; },
    async fireNotificationClicked(id) {
      await Promise.all(notificationClickListeners.map(fn => Promise.resolve(fn(id))));
    },
    async fireNotificationClosed(id) {
      await Promise.all(notificationClosedListeners.map(fn => Promise.resolve(fn(id))));
    },
    focusEvents,
    clearFocusEvents() { focusEvents.length = 0; },
    setTabsGet(fn) { tabsGetImpl = fn; },
    // Simulate the popup opening its presence port and reporting its tab.
    // Returns a handle whose disconnect() fires the port's onDisconnect.
    connectPopup(viewingTabId) {
      const messageListeners = [];
      const disconnectListeners = [];
      const port = {
        name: 'popup',
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
        postMessage(msg) { messageListeners.forEach(fn => fn(msg)); },
        disconnect() { disconnectListeners.forEach(fn => fn()); },
      };
      connectListeners.forEach(fn => fn(port));
      port.postMessage({ action: 'popupViewing', tabId: viewingTabId });
      return port;
    },
  };

  window.waitFor = async function waitFor(predicate, { timeout = 3000, interval = 20, label = 'condition' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = predicate();
      if (value) return value;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
})();
