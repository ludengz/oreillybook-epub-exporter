const EpubBuilder = {
  _escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // XML 1.0 forbids these code points entirely — escaping cannot save them.
  // Strip from any API-sourced text before it reaches the OPF templates.
  _stripIllegalXmlChars(str) {
    return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  },

  // Converge one untrusted value into a trimmed, XML-safe string, or null
  _cleanString(value) {
    if (typeof value !== 'string') return null;
    const s = this._stripIllegalXmlChars(value).trim();
    return s || null;
  },

  // Converge a list-valued API field (bare string, or an array of strings /
  // {name} objects) into a deduped array of clean strings
  _cleanStringList(value) {
    const items = Array.isArray(value) ? value : (value != null ? [value] : []);
    const out = [];
    for (const item of items) {
      let raw = null;
      if (typeof item === 'string') raw = item;
      else if (item && typeof item === 'object' && typeof item.name === 'string') raw = item.name;
      const s = raw !== null ? this._cleanString(raw) : null;
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  },

  // Validate and canonicalize a BCP 47 tag. Intl alone admits well-formed
  // 5-8-alpha names like "english", so additionally require a 2-3-alpha
  // primary subtag (ISO 639-1/2). Returns the canonicalized tag or null.
  _normalizeLanguage(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let canonical;
    try {
      canonical = Intl.getCanonicalLocales(raw.trim())[0];
    } catch (e) {
      return null;
    }
    if (!canonical || !/^[a-zA-Z]{2,3}(-|$)/.test(canonical)) return null;
    return canonical;
  },

  // Extract an ISO date prefix (YYYY[-MM[-DD]]) as a string — never through
  // Date, which drifts across timezones and parses junk like "May 2023".
  // Range-checks month/day so "2023-13" is omitted rather than emitted.
  _normalizeDate(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?=$|[T ])/);
    if (!m) return null;
    const [, y, mo, d] = m;
    if (mo !== undefined && (mo < '01' || mo > '12')) return null;
    if (d !== undefined && (d < '01' || d > '31')) return null;
    return y + (mo ? `-${mo}` : '') + (d ? `-${d}` : '');
  },

  // Flatten an HTML description into plain text via DOM (never regex tag
  // surgery). Block boundaries become spaces — bare textContent would glue
  // "<p>A</p><p>B</p>" into "AB".
  _htmlToPlainText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const BLOCK = /^(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|section|article)$/i;
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const isBlock = BLOCK.test(child.tagName);
          if (isBlock) out += ' ';
          walk(child);
          if (isBlock) out += ' ';
        }
      }
    };
    walk(doc.body);
    return out.replace(/\s+/g, ' ').trim();
  },

  // Converge an untrusted metadata object (the content script's rich fetch
  // result) into clean optional OPF fields. Every value is type-guarded;
  // absent or invalid fields come back as null / empty arrays.
  normalizeMetadata(raw) {
    const book = (raw && typeof raw === 'object') ? raw : {};
    const description = typeof book.description === 'string'
      ? this._cleanString(this._htmlToPlainText(book.description))
      : null;
    return {
      language: this._normalizeLanguage(book.language) || 'en',
      publishers: this._cleanStringList(book.publishers),
      subjects: this._cleanStringList(book.subjects),
      date: this._normalizeDate(book.issued),
      description,
      coverUrl: this._cleanString(book.coverUrl),
    };
  },

  _mimeType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const types = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
      css: 'text/css', xhtml: 'application/xhtml+xml',
      ncx: 'application/x-dtbncx+xml',
    };
    return types[ext] || 'application/octet-stream';
  },

  _sanitizeId(filename) {
    return filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  },

  generateContainer() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  },

  // Pick the cover image from a list of image filenames. Word-boundary
  // matching avoids false positives like "recovery-diagram.png".
  findCoverImage(filenames) {
    const basename = (f) => f.split('/').pop();
    const exact = filenames.find(f => /^cover\.[a-z0-9]+$/i.test(basename(f)));
    if (exact) return exact;
    return filenames.find(f => /(^|[_\-.])cover($|[_\-.])/i.test(basename(f))) || null;
  },

  generateOpf(metadata, chapters, images, cssFiles, coverImageFilename) {
    const manifestItems = [];
    const spineItems = [];

    // Manifest IDs must be unique within the OPF; sanitized filenames can
    // collide (e.g. cover.png / cover.jpg both sanitize to "cover")
    const usedIds = new Set(['nav', 'ncx', 'bookid']);
    const uniqueId = (base) => {
      let id = base;
      let n = 2;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id);
      return id;
    };

    manifestItems.push('    <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    manifestItems.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

    cssFiles.forEach(f => {
      const id = uniqueId(`css-${this._sanitizeId(f)}`);
      manifestItems.push(`    <item id="${id}" href="Styles/${f}" media-type="text/css"/>`);
    });

    chapters.forEach(ch => {
      const id = uniqueId(this._sanitizeId(ch.filename));
      manifestItems.push(`    <item id="${id}" href="Text/${ch.filename}" media-type="application/xhtml+xml"/>`);
      spineItems.push(`    <itemref idref="${id}"/>`);
    });

    let coverId = null;
    images.forEach(img => {
      const id = uniqueId(`img-${this._sanitizeId(img)}`);
      const isCover = (img === coverImageFilename);
      if (isCover) coverId = id;
      const props = isCover ? ' properties="cover-image"' : '';
      manifestItems.push(`    <item id="${id}" href="Images/${img}" media-type="${this._mimeType(img)}"${props}/>`);
    });

    // EPUB2-style cover meta for readers that ignore properties="cover-image"
    const coverMeta = coverId ? `\n    <meta name="cover" content="${coverId}"/>` : '';

    const authors = metadata.authors.map(a => `    <dc:creator>${this._escapeXml(a)}</dc:creator>`).join('\n');

    // Optional dc elements: emitted only when the (already normalized)
    // metadata carries them — never as empty elements
    const optional = [];
    (metadata.publishers || []).forEach(p =>
      optional.push(`    <dc:publisher>${this._escapeXml(p)}</dc:publisher>`));
    (metadata.subjects || []).forEach(s =>
      optional.push(`    <dc:subject>${this._escapeXml(s)}</dc:subject>`));
    if (metadata.description) optional.push(`    <dc:description>${this._escapeXml(metadata.description)}</dc:description>`);
    if (metadata.date) optional.push(`    <dc:date>${metadata.date}</dc:date>`);
    const optionalMeta = optional.length ? '\n' + optional.join('\n') : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:identifier id="bookid">urn:isbn:${metadata.isbn}</dc:identifier>
    <dc:title>${this._escapeXml(metadata.title)}</dc:title>
    <dc:language>${this._escapeXml(metadata.language)}</dc:language>
${authors}${optionalMeta}
    <meta property="dcterms:modified">${metadata.modified}</meta>${coverMeta}
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems.join('\n')}
  </spine>
</package>`;
  },

  generateTocXhtml(title, chapters) {
    const items = chapters.map(ch =>
      `        <li><a href="Text/${ch.filename}">${this._escapeXml(ch.title)}</a></li>`
    ).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${this._escapeXml(title)}</title></head>
<body>
  <nav epub:type="toc">
    <h1>${this._escapeXml(title)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
  },

  generateTocNcx(isbn, title, chapters) {
    const navPoints = chapters.map((ch, i) =>
      `    <navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${this._escapeXml(ch.title)}</text></navLabel>
      <content src="Text/${ch.filename}"/>
    </navPoint>`
    ).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:isbn:${isbn}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${this._escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
  },

  generateCoverXhtml(title, coverImageFilename) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${this._escapeXml(title)}</title></head>
<body style="margin:0;padding:0;text-align:center;">
  <img src="../Images/${coverImageFilename}" alt="${this._escapeXml(title)}" style="max-width:100%;max-height:100%;"/>
</body>
</html>`;
  },
};
