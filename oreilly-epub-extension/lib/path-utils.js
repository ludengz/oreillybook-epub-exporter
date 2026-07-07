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
