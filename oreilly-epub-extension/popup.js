(function() {
  'use strict';

  const stateEls = {
    notOreilly: document.getElementById('state-not-oreilly'),
    ready: document.getElementById('state-ready'),
    downloading: document.getElementById('state-downloading'),
    downloadingOther: document.getElementById('state-downloading-other'),
    report: document.getElementById('state-report'),
    error: document.getElementById('state-error'),
  };

  let activeTabId = null;
  let lastErrorDetails = '';

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

  // --- Quality report rendering ---------------------------------------------
  // All report data is rendered via textContent (never innerHTML): titles,
  // paths, and URLs in the report are page-derived strings.

  function line(parent, text, className) {
    const div = document.createElement('div');
    if (className) div.className = className;
    div.textContent = text;
    parent.appendChild(div);
    return div;
  }

  // Collapsed <details> block: count in the summary, capped entries in the
  // body, an explicit "+N more" row when detail was truncated below the total
  function detailsSection(parent, label, entries, total, titles) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = label;
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'report-list';
    entries.forEach((entry, i) => {
      const el = line(list, entry);
      if (titles && titles[i]) el.title = titles[i];
    });
    if (total > entries.length) line(list, `+${total - entries.length} more`, 'report-more');
    details.appendChild(list);
    parent.appendChild(details);
    return details;
  }

  function renderReport(report) {
    showState('report');
    const counts = report.counts || {};
    const failures = report.failures || {};
    const warnings = report.validationWarnings || [];
    const problemCount = (counts.chaptersPlaceholder || 0) + (counts.imagesFailed || 0)
      + (counts.cssFailed || 0) + warnings.length;
    const isError = report.outcome === 'error';
    const clean = !isError && problemCount === 0 && report.validated !== false
      && counts.coverPresent !== false && counts.metadataFromApi !== false;

    document.getElementById('report-header').className =
      'report-header ' + (clean ? 'report-ok' : 'report-warn');
    document.getElementById('report-icon').textContent = clean ? '✓' : '⚠';
    document.getElementById('report-headline').textContent = isError
      ? 'Download failed — partial report'
      : clean ? 'Everything downloaded'
      : `${problemCount} issue${problemCount === 1 ? '' : 's'} found`;
    document.getElementById('report-book-title').textContent =
      `Download report for "${report.bookTitle || 'Unknown'}"`;

    const body = document.getElementById('report-body');
    body.textContent = '';
    line(body, `${counts.chaptersOk || 0} chapters OK · ${counts.imagesOk || 0} images OK`, 'report-summary');
    if (report.validated === false) line(body, 'Integrity check was skipped for this file.', 'report-notice');
    if (counts.metadataFromApi === false) line(body, 'Book metadata came from a page fallback.', 'report-notice');
    if (counts.coverPresent === false && !isError) line(body, 'No cover image could be found.', 'report-notice');

    const expand = !clean;
    if (counts.chaptersPlaceholder > 0) {
      const entries = (failures.chapters || []).map(c => `Chapter ${c.chapter}: ${c.path}`);
      detailsSection(body, `${counts.chaptersPlaceholder} chapter(s) missing (placeholder pages)`,
        entries, counts.chaptersPlaceholder).open = expand;
    }
    if (counts.imagesFailed > 0) {
      const sources = failures.images || [];
      const entries = sources.map(src => src.split('/').pop() || src);
      detailsSection(body, `${counts.imagesFailed} image(s) failed`,
        entries, counts.imagesFailed, sources).open = expand;
    }
    if (counts.cssFailed > 0) {
      detailsSection(body, `${counts.cssFailed} stylesheet(s) failed`,
        failures.css || [], counts.cssFailed).open = expand;
    }
    if (warnings.length > 0) {
      detailsSection(body, `${warnings.length} integrity warning(s)`,
        warnings, warnings.length).open = expand;
    }

    // Ack clears the badge only; the report itself persists until replaced
    chrome.runtime.sendMessage({ action: 'reportAck', tabId: activeTabId });
    updateRedownloadButton(report);
  }

  // Re-download goes through the normal startDownload gate; disabled with a
  // note when the tab no longer shows the report's book (live ISBN check)
  function updateRedownloadButton(report) {
    const btn = document.getElementById('btn-redownload');
    const note = document.getElementById('redownload-note');
    btn.disabled = true;
    note.style.display = 'none';
    chrome.tabs.sendMessage(activeTabId, { action: 'getBookInfo' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.isbn) {
        note.textContent = 'Refresh the O\'Reilly tab to re-download.';
        note.style.display = 'block';
        return;
      }
      if (response.isbn !== report.isbn) {
        note.textContent = 'This tab now shows a different book.';
        note.style.display = 'block';
        return;
      }
      btn.disabled = false;
    });
  }

  function renderError(state) {
    showState('error');
    document.getElementById('error-text').textContent = state.error || 'Unknown error';
    const report = state.report;
    const violations = (report && report.validationViolations) || [];
    const isValidation = violations.length > 0;
    const detailsEl = document.getElementById('error-details');
    const copyBtn = document.getElementById('btn-copy-error');
    const retryBtn = document.getElementById('btn-retry');
    const retryNote = document.getElementById('retry-note');
    const countsEl = document.getElementById('error-report-counts');

    if (report && report.counts) {
      countsEl.textContent =
        `Before failing: ${report.counts.chaptersOk || 0} chapters, ${report.counts.imagesOk || 0} images downloaded.`;
      countsEl.style.display = 'block';
    } else {
      countsEl.style.display = 'none';
    }

    if (isValidation) {
      // A fatal integrity violation is an extension bug: retrying will most
      // likely reproduce it, so "copy details" becomes the primary action
      lastErrorDetails = [
        `Book: ${report.bookTitle || ''} (${report.isbn || ''})`,
        `Attempt: ${report.attemptId || ''}`,
        `Error: ${state.error || ''}`,
        'Violations:',
        ...violations.map(v => `- ${v}`),
      ].join('\n');
      document.getElementById('error-details-text').textContent = violations.join('\n');
      detailsEl.style.display = 'block';
      copyBtn.style.display = 'block';
      retryBtn.className = 'btn-secondary';
      retryNote.textContent = 'This looks like an extension bug — a retry will likely reproduce it. Please report it.';
      retryNote.style.display = 'block';
    } else {
      detailsEl.style.display = 'none';
      copyBtn.style.display = 'none';
      retryBtn.className = 'btn-primary';
      retryNote.style.display = 'none';
    }
  }

  function handleState(state) {
    if (!state) {
      showState('notOreilly');
      return;
    }

    const isDownloadingThisTab = state.downloadingTabId === activeTabId;

    if (state.status === 'downloading' && isDownloadingThisTab && state.progress) {
      showState('downloading');
      updateProgress(state.progress);
    } else if (state.status === 'downloading' && !isDownloadingThisTab && state.bookInfo) {
      // Another tab's download takes priority over this tab's report panel
      showState('downloadingOther');
      document.getElementById('book-title-other').textContent = state.bookInfo.title;
      document.getElementById('book-authors-other').textContent = state.bookInfo.authors.join(', ');
      document.getElementById('downloading-other-title').textContent =
        state.downloadingBookInfo ? state.downloadingBookInfo.title : 'Unknown';
    } else if (state.status === 'error' && isDownloadingThisTab) {
      renderError(state);
    } else if (state.report) {
      // Report presence drives the panel (not a transient status), so it
      // survives popup close/reopen and labels itself with its own book title
      renderReport(state.report);
    } else if (!state.bookInfo) {
      showState('notOreilly');
    } else {
      showState('ready');
      document.getElementById('book-title').textContent = state.bookInfo.title;
      document.getElementById('book-authors').textContent = state.bookInfo.authors.join(', ');
    }
  }

  // Presence port: lets the SW suppress a terminal notification only when
  // this popup is actually showing the affected tab; the port's disconnect
  // is the popup-closed signal (reliable in MV3, unlike unload events)
  const presencePort = chrome.runtime.connect({ name: 'popup' });

  // Query active tab, then fetch state for that tab
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) {
      showState('notOreilly');
      return;
    }
    activeTabId = tab.id;
    presencePort.postMessage({ action: 'popupViewing', tabId: activeTabId });
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

  document.getElementById('btn-redownload').addEventListener('click', () => requestDownload('Starting...'));

  document.getElementById('btn-copy-error').addEventListener('click', () => {
    navigator.clipboard.writeText(lastErrorDetails).then(() => {
      const btn = document.getElementById('btn-copy-error');
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy error details'; }, 1500);
    }).catch(() => {});
  });
})();
