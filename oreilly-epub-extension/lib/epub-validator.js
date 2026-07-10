// EPUB integrity validator: reconciles OPF manifest <-> ZIP entries <-> spine
// before packaging, and sniffs the generated blob's first local file header.
//
// Pure functions with no side effects and no chrome.* APIs so the module
// unit-tests without mocks. Findings are severity-tiered:
//   fatal    — genuinely breaks readers (malformed OPF, manifest-declared
//              file missing from the ZIP, unresolvable spine idref,
//              mimetype-first/STORE violation). Callers block delivery.
//   warnings — degraded but usable output (ZIP orphans not in the manifest,
//              chapters failing a strict XHTML re-parse). Callers deliver
//              and surface them in the quality report.
//
// The validator derives expectations from the OPF output itself (DOMParser)
// rather than re-deriving them from generateOpf's inputs, so builder changes
// that keep the EPUB valid stay green and OPF well-formedness comes free.
const EpubValidator = {
  // Structural phase, run before zip.generateAsync. `zip` is the JSZip
  // instance about to be packaged; `opfXml` the OPF string written into it.
  async validateStructure(zip, opfXml, opfPath = 'OEBPS/content.opf') {
    const fatal = [];
    const warnings = [];

    const doc = new DOMParser().parseFromString(opfXml, 'application/xml');
    if (doc.querySelector('parsererror')) {
      return { fatal: ['OPF XML is malformed'], warnings };
    }

    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifestIds = new Set();
    const manifestPaths = new Set();
    const xhtmlPaths = [];

    for (const item of doc.querySelectorAll('manifest > item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id) manifestIds.add(id);
      if (!href) continue;
      // Manifest hrefs are OPF-relative; ZIP keys are archive-root paths
      const resolved = PathUtils.normalizePath(baseDir ? `${baseDir}/${href}` : href);
      manifestPaths.add(resolved);
      const entry = zip.files[resolved];
      if (!entry || entry.dir) {
        fatal.push(`Manifest file missing from ZIP: ${resolved}`);
      } else if ((item.getAttribute('media-type') || '') === 'application/xhtml+xml') {
        xhtmlPaths.push(resolved);
      }
    }

    for (const ref of doc.querySelectorAll('spine > itemref')) {
      const idref = ref.getAttribute('idref');
      if (!idref || !manifestIds.has(idref)) {
        fatal.push(`Spine idref has no manifest item: ${idref}`);
      }
    }

    // ZIP -> manifest direction. JSZip's createFolders default inserts
    // directory entries — those are ZIP bookkeeping, not resources.
    const allowed = new Set(['mimetype', 'META-INF/container.xml', opfPath]);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      if (allowed.has(name) || manifestPaths.has(name)) continue;
      warnings.push(`ZIP entry not declared in the OPF manifest: ${name}`);
    }

    // mimetype must be the first inserted entry, stored uncompressed
    const firstEntry = Object.keys(zip.files)[0];
    if (firstEntry !== 'mimetype') {
      fatal.push(`mimetype must be the first ZIP entry (found: ${firstEntry})`);
    } else if (((zip.files['mimetype'].options || {}).compression) !== 'STORE') {
      fatal.push('mimetype must be stored uncompressed (STORE)');
    }

    // Strict XHTML re-parse of every manifest-declared XHTML document. No
    // text/html fallback here — the fallback is exactly what would hide a
    // serialization bug (Fetcher.parseXhtml falls back by design; we cannot).
    for (const path of xhtmlPaths) {
      const text = await zip.files[path].async('string');
      const chapterDoc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
      if (chapterDoc.querySelector('parsererror')) {
        warnings.push(`Chapter does not parse as XHTML: ${path}`);
      }
    }

    return { fatal, warnings };
  },

  // Physical phase, run on the generated blob: the first local file header
  // must name an uncompressed "mimetype" (EPUB OCF media-type sniffing).
  async validateBlob(blob) {
    const fatal = [];
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const isZip = head.length >= 30
      && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    if (!isZip) {
      return { fatal: ['Generated file does not start with a ZIP local file header'], warnings: [] };
    }
    const method = head[8] | (head[9] << 8);
    const nameLength = head[26] | (head[27] << 8);
    const name = String.fromCharCode(...head.slice(30, 30 + Math.min(nameLength, 32)));
    if (name !== 'mimetype') {
      fatal.push(`First ZIP entry is "${name}", expected "mimetype"`);
    } else if (method !== 0) {
      fatal.push('mimetype entry is compressed in the ZIP; must be stored');
    }
    return { fatal, warnings: [] };
  },
};
