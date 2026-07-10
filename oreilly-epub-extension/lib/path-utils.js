// Pure path helpers shared by content.js and the library modules.
// Loaded as a content script before fetcher.js (see manifest.json).
const PathUtils = {
  // Strip query parameters and hash fragments from a path
  stripQueryAndHash(path) {
    return path.split('?')[0].split('#')[0];
  },

  // Normalize a path for matching: resolve relative segments and strip leading slashes
  normalizePath(path) {
    const parts = path.replace(/^\/+/, '').split('/');
    const resolved = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.' && part !== '') resolved.push(part);
    }
    return resolved.join('/');
  },

  // Resolve an image src from chapter HTML against the chapter's original path in the EPUB
  resolveImagePath(imgSrc, chapterOriginalPath) {
    const cleanSrc = this.stripQueryAndHash(imgSrc);
    // Absolute URL — return as-is
    if (cleanSrc.startsWith('http://') || cleanSrc.startsWith('https://')) {
      return { resolved: cleanSrc, isAbsolute: true };
    }
    // Resolve relative to the chapter's directory in the EPUB structure
    const chapterDir = chapterOriginalPath.substring(0, chapterOriginalPath.lastIndexOf('/'));
    const combined = chapterDir + '/' + cleanSrc;
    return { resolved: this.normalizePath(combined), isAbsolute: false };
  },

  // The canonical direct O'Reilly host. Single source of truth for the three
  // places that must agree: the allowlist below, rewriteToPageOrigin's
  // "is this a real-host URL" check, and sessionExpiredMessage's direct/proxy
  // branch. Kept as a hostname (no scheme); prefix 'https://' where an origin
  // is needed.
  DIRECT_HOST: 'learning.oreilly.com',

  // Exact hostnames for credentialed image fetches. Library proxy hosts belong
  // here and never in the suffix list: a dot-suffix rule would also accept
  // "learning-oreilly-com.ezproxy.spl.org.evil.example".
  ALLOWED_IMAGE_HOSTS: [
    'learning.oreilly.com',
    'learning-oreilly-com.ezproxy.spl.org',
  ],

  // Dot-suffix domains, matching manifest.json's "https://*.domain/*" patterns
  // (which also match the bare domain).
  ALLOWED_IMAGE_DOMAIN_SUFFIXES: ['oreillystatic.com', 'safaribooksonline.com'],

  // Allowlist for credentialed image fetches, mirroring manifest.json
  // host_permissions. Exact-or-dot-suffix matching only — substring checks
  // would let "oreillystatic.com.evil.example" through. Shared by content.js
  // and background.js (the SW loads this file via guarded importScripts).
  // A test asserts the two lists above stay in sync with host_permissions in
  // both directions; adding a library to one place only fails loudly.
  isAllowedImageUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (this.ALLOWED_IMAGE_HOSTS.includes(host)) return true;
    for (const domain of this.ALLOWED_IMAGE_DOMAIN_SUFFIXES) {
      if (host === domain || host.endsWith('.' + domain)) return true;
    }
    return false;
  },

  // The origin of the page the content script runs in. A seam, not a helper:
  // tests stub it to simulate a library-proxy origin. Meaningless in the
  // service worker, where `location` is the extension's own origin — which is
  // why rewriteToPageOrigin is only ever called from content.js.
  pageOrigin() {
    return location.origin;
  },

  // Rewrite an absolute learning.oreilly.com URL onto the page's own origin.
  //
  // DEFENSIVE ONLY. EZproxy >= 6.0.8 rewrites URLs inside JSON response bodies,
  // so on the declared SPL proxy every cover_url and files[].url already arrives
  // proxied and this is a no-op (observed 2026-07-10). It earns its keep on
  // deployments that leave real-host URLs in API responses: there, fetching
  // learning.oreilly.com from a proxied page reaches an unauthenticated origin,
  // because the library session cookie lives on the proxy domain.
  //
  // Idempotent on already-proxied URLs, and never touches CDN hosts. Only the
  // fetch URL is rewritten — callers must keep the original src as the imageMap
  // key, since EinkOptimizer rewrites chapter XHTML from those keys.
  rewriteToPageOrigin(url) {
    let u, base;
    try { u = new URL(url); } catch (e) { return url; } // relative: caller resolves
    try { base = new URL(this.pageOrigin()); } catch (e) { return url; }
    if (base.protocol !== 'https:') return url; // never downgrade or leave https
    if (u.hostname.toLowerCase() !== this.DIRECT_HOST) return url;
    if (u.origin === base.origin) return url; // direct mode
    u.protocol = base.protocol;
    u.host = base.host;
    return u.href;
  },

  // Sanitize a book title into a download filename stem. Preserves Unicode,
  // case, and spaces; strips only what filesystems cannot take. Returns
  // `fallback` when nothing usable remains (a pure-CJK title used to be
  // stripped to '' by an ASCII-only filter, producing a file named ".epub").
  sanitizeFilename(name, fallback) {
    if (typeof name !== 'string') return fallback;
    let stem = name
      // Filesystem-illegal on Windows (superset of ext4's illegal set)
      .replace(/[\\/:*?"<>|]/g, ' ')
      // C0/C1 controls, zero-width/format characters, bidi overrides
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // Windows rejects trailing dots/spaces; leading dots hide the file
      .replace(/^[. ]+|[. ]+$/g, '');
    // Keep the full filename well under ext4's 255-byte limit. Byte-aware:
    // a code-point cap would let 200 CJK characters reach ~600 UTF-8 bytes.
    stem = this._truncateUtf8(stem, 200).replace(/[. ]+$/g, '');
    if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return fallback;
    return stem;
  },

  // Truncate to at most maxBytes of UTF-8 without splitting a code point
  _truncateUtf8(str, maxBytes) {
    let bytes = 0;
    let out = '';
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      const b = cp <= 0x7F ? 1 : cp <= 0x7FF ? 2 : cp <= 0xFFFF ? 3 : 4;
      if (bytes + b > maxBytes) break;
      bytes += b;
      out += ch;
    }
    return out;
  },

  // Stateful filename deduper: collisions get _1, _2, ... before the extension
  createUniqueNamer() {
    const used = new Set();
    return function uniqueFilename(basename) {
      let name = basename;
      let counter = 1;
      while (used.has(name)) {
        const dot = basename.lastIndexOf('.');
        const stem = dot > 0 ? basename.substring(0, dot) : basename;
        const ext = dot > 0 ? basename.substring(dot) : '';
        name = `${stem}_${counter}${ext}`;
        counter++;
      }
      used.add(name);
      return name;
    };
  },
};
