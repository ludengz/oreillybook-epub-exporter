const Fetcher = {
  extractIsbn(url) {
    const match = url.match(/\/library\/(?:view|cover)\/(?:[^/]+\/)?(\d{13})/);
    return match ? match[1] : null;
  },

  async _fetchWithRetry(url, { signal, maxRetries = 3 } = {}) {
    const delays = [1000, 3000, 9000];
    let attempt = 0;
    let rateLimitRetries = 0;
    const maxRateLimitRetries = 5;
    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, { signal, credentials: 'include' });
        if (response.status === 429 || response.status === 403) {
          rateLimitRetries++;
          if (rateLimitRetries > maxRateLimitRetries) throw new Error('Rate limit exceeded');
          const retryAfter = response.headers.get('Retry-After');
          const baseWait = response.status === 403 ? 3000 : 10000;
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseWait * rateLimitRetries;
          console.log(`Rate limited (${response.status}), waiting ${waitMs}ms before retry ${rateLimitRetries}/${maxRateLimitRetries}`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        if (response.status === 401) throw new Error('SESSION_EXPIRED');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (err) {
        if (err.name === 'AbortError' || err.message === 'SESSION_EXPIRED') throw err;
        if (err.message === 'Rate limit exceeded') throw err;
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, delays[attempt]));
        attempt++;
      }
    }
  },

  async throttledFetchAll(urls, { concurrency = 2, delayMs = 500, getContent, signal, onProgress } = {}) {
    const results = [];
    let completed = 0;
    for (let i = 0; i < urls.length; i += concurrency) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = urls.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (url) => {
          const response = await this._fetchWithRetry(url, { signal });
          const content = getContent ? await getContent(response) : response;
          completed++;
          if (onProgress) onProgress(completed, urls.length);
          return content;
        })
      );
      results.push(...batchResults);
      if (i + concurrency < urls.length) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return results;
  },

  // Parse XHTML to DOM, with fallback to text/html for malformed content
  parseXhtml(xhtml) {
    const parser = new DOMParser();
    let doc = parser.parseFromString(xhtml, 'application/xhtml+xml');
    // If XHTML parsing fails, DOMParser returns an error document
    if (doc.querySelector('parsererror')) {
      doc = parser.parseFromString(xhtml, 'text/html');
    }
    return doc;
  },

  // Extract all image-like URLs from parsed XHTML: <img>, <image>, <object>
  extractImageUrls(xhtml) {
    const doc = this.parseXhtml(xhtml);
    const urls = [];
    const seen = new Set();

    function add(src) {
      if (src && !seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
    }

    // <img src="...">
    doc.querySelectorAll('img[src]').forEach(el => add(el.getAttribute('src')));

    // <image href="..."> or <image xlink:href="..."> (SVG)
    doc.querySelectorAll('image').forEach(el => {
      add(el.getAttribute('href'));
      add(el.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
    });

    // <object data="..."> (embedded content)
    doc.querySelectorAll('object[data]').forEach(el => {
      const data = el.getAttribute('data');
      if (data && data.match(/\.(png|jpe?g|gif|svg|webp)(\?|#|$)/i)) {
        add(data);
      }
    });

    return urls;
  },

  // Extract url(...) references from CSS text
  extractCssImageUrls(cssText) {
    const urls = [];
    const seen = new Set();
    const regex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
    let match;
    while ((match = regex.exec(cssText)) !== null) {
      const url = match[1].trim();
      // Skip data URIs and fragment-only refs
      if (url.startsWith('data:') || url.startsWith('#')) continue;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  },

  // Strip query parameters and hash fragments from a path
  // (delegates to PathUtils — single implementation; path-utils.js loads first)
  stripQueryAndHash(path) {
    return PathUtils.stripQueryAndHash(path);
  },
};
