(function() {
  'use strict';

  const stateEls = {
    notOreilly: document.getElementById('state-not-oreilly'),
    ready: document.getElementById('state-ready'),
    downloading: document.getElementById('state-downloading'),
    downloadingOther: document.getElementById('state-downloading-other'),
    error: document.getElementById('state-error'),
  };

  let activeTabId = null;

  function showState(name) {
    Object.values(stateEls).forEach(el => el.style.display = 'none');
    if (stateEls[name]) stateEls[name].style.display = 'block';
  }

  // Progress covers two phases: images (0-30%) and chapters (30-100%)
  function updateProgress(p) {
    const imgPct = p.totalImages > 0 ? (p.images || 0) / p.totalImages : 1;
    const chPct = p.totalChapters > 0 ? (p.chapter || 0) / p.totalChapters : 0;
    const pct = Math.round(imgPct * 30 + chPct * 70);

    document.getElementById('progress-fill').style.width = `${pct}%`;

    let label;
    if ((p.chapter || 0) === 0 && p.totalImages > 0) {
      label = `Images: ${p.images || 0}/${p.totalImages}`;
    } else {
      label = `Chapter ${p.chapter}/${p.totalChapters}`;
      if (p.totalImages > 0) label += ` · Images: ${p.images || 0}/${p.totalImages}`;
    }
    document.getElementById('progress-text').textContent = label;
  }

  function handleState(state) {
    if (!state || !state.bookInfo) {
      showState('notOreilly');
      return;
    }

    const isDownloadingThisTab = state.downloadingTabId === activeTabId;

    if (state.status === 'downloading' && isDownloadingThisTab && state.progress) {
      showState('downloading');
      updateProgress(state.progress);
    } else if (state.status === 'downloading' && !isDownloadingThisTab) {
      showState('downloadingOther');
      document.getElementById('book-title-other').textContent = state.bookInfo.title;
      document.getElementById('book-authors-other').textContent = state.bookInfo.authors.join(', ');
      document.getElementById('downloading-other-title').textContent =
        state.downloadingBookInfo ? state.downloadingBookInfo.title : 'Unknown';
    } else if (state.status === 'error' && isDownloadingThisTab) {
      showState('error');
      document.getElementById('error-text').textContent = state.error || 'Unknown error';
    } else {
      showState('ready');
      document.getElementById('book-title').textContent = state.bookInfo.title;
      document.getElementById('book-authors').textContent = state.bookInfo.authors.join(', ');
    }
  }

  // Query active tab, then fetch state for that tab
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) {
      showState('notOreilly');
      return;
    }
    activeTabId = tab.id;
    chrome.runtime.sendMessage({ action: 'getState', tabId: activeTabId }, handleState);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progressUpdate') {
      if (message.tabId === activeTabId) {
        showState('downloading');
        updateProgress(message);
      }
    } else if (message.action === 'downloadComplete' || message.action === 'downloadError') {
      // Re-query full state to correctly transition between states
      chrome.runtime.sendMessage({ action: 'getState', tabId: activeTabId }, handleState);
    }
  });

  const START_FAILURE_MESSAGES = {
    content_script_unreachable: 'Could not reach the page. Refresh the O\'Reilly tab and try again.',
    already_downloading: 'Another download is already in progress.',
    no_tab: 'No active tab found.',
  };

  function requestDownload(startLabel) {
    showState('downloading');
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').textContent = startLabel;
    chrome.runtime.sendMessage({ action: 'startDownload', tabId: activeTabId }, (response) => {
      if (response && response.ok === false) {
        showState('error');
        document.getElementById('error-text').textContent =
          START_FAILURE_MESSAGES[response.reason] || 'Could not start the download.';
      }
    });
  }

  document.getElementById('btn-download').addEventListener('click', () => requestDownload('Starting...'));

  document.getElementById('btn-cancel').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelDownload', tabId: activeTabId });
    showState('ready');
  });

  document.getElementById('btn-retry').addEventListener('click', () => requestDownload('Retrying...'));
})();
