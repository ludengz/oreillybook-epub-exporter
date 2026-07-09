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
