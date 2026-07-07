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
  let storageStore = {};
  let tabsSendMessageImpl = async () => undefined;

  window.chrome = Object.assign(window.chrome || {}, {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) { listeners.push(fn); },
      },
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (callback) callback({ ok: true });
        return Promise.resolve();
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
      onRemoved: { addListener() {} },
      sendMessage(tabId, message) { return tabsSendMessageImpl(tabId, message); },
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
    },
    notifications: { create() {} },
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
    resetStorage(initial = {}) { storageStore = initial; },
    getStorage() { return storageStore; },
    setTabsSendMessage(fn) { tabsSendMessageImpl = fn; },
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
