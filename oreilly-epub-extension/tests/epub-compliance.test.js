// EPUB compliance tests: every resource written into the ZIP must be declared
// in the OPF manifest, manifest IDs must be unique, and cover detection must
// not false-positive on names like "recovery".

describe('EpubBuilder.generateOpf manifest ID uniqueness', function() {
  const metadata = {
    title: 'Test Book', authors: ['A'], isbn: '9781234567890',
    language: 'en', modified: '2024-01-01T00:00:00Z',
  };
  const chapters = [{ filename: 'chapter_01.xhtml', title: 'C1' }];

  function collectIds(opf) {
    return [...opf.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  }

  it('generates unique ids for images differing only by extension', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, ['cover.png', 'cover.jpg'], []);
    const ids = collectIds(opf);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assertEqual(dupes.length, 0, `duplicate manifest ids: ${dupes.join(', ')}`);
  });

  it('generates unique ids when sanitized names collide', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, ['a b.png', 'a_b.png'], []);
    const ids = collectIds(opf);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assertEqual(dupes.length, 0, `duplicate manifest ids: ${dupes.join(', ')}`);
  });
});

describe('EpubBuilder.findCoverImage', function() {
  it('finds exact cover basename', function() {
    assertEqual(EpubBuilder.findCoverImage(['fig1.png', 'cover.jpg']), 'cover.jpg');
  });
  it('finds hyphenated cover name', function() {
    assertEqual(EpubBuilder.findCoverImage(['book-cover.png']), 'book-cover.png');
  });
  it('does not match cover as substring of another word', function() {
    assertEqual(EpubBuilder.findCoverImage(['recovery-diagram.png', 'discovery.png']), null);
  });
  it('prefers exact cover.* over partial matches', function() {
    assertEqual(EpubBuilder.findCoverImage(['back-cover.png', 'cover.png']), 'cover.png');
  });
  it('returns null for empty list', function() {
    assertEqual(EpubBuilder.findCoverImage([]), null);
  });
});

// --- Integration: unpack a generated EPUB and audit ZIP vs OPF bookkeeping ---

const COMPLIANCE_CHAPTER = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch 1</title></head><body><h1>Chapter One</h1><img src="images/fig1.png"/></body></html>';

// Real minimal images so epubcheck can validate media types on the output
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_JPG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
const TINY_PNG = b64ToBuf(TINY_PNG_B64);
const TINY_JPG = b64ToBuf(TINY_JPG_B64);

function complianceFetchMock(origFetch) {
  return async (url) => {
    url = String(url);
    if (url.startsWith('blob:')) return origFetch(url);
    if (url.includes('/api/v2/search/')) {
      // Rich metadata mirroring the live API shape (archive_id matches the
      // requested ISBN so rich fields are trusted; topics_payload is the
      // real-world subjects source)
      return mockResponse({ jsonBody: { results: [{
        title: 'Compliance Book', authors: ['Author A'],
        archive_id: '9782222222222',
        language: 'en-US',
        publishers: ["O'Reilly Media, Inc."],
        issued: '2022-04-01T00:00:00Z',
        description: '<p>First &amp; second.</p><p>Third.</p>',
        topics_payload: [{ uuid: 'u1', slug: 'python', name: 'Python' }],
      }] } });
    }
    if (url.includes('/files/?limit=')) {
      return mockResponse({
        jsonBody: {
          results: [
            { full_path: 'ch1.xhtml', kind: 'chapter', media_type: 'application/xhtml+xml' },
            { full_path: 'images/fig1.png', kind: 'image', media_type: 'image/png' },
            { full_path: 'images/unreferenced.png', kind: 'image', media_type: 'image/png' },
            { full_path: 'images/cover.jpg', kind: 'image', media_type: 'image/jpeg' },
            { full_path: 'styles/a/main.css', kind: 'stylesheet', media_type: 'text/css' },
            { full_path: 'styles/b/main.css', kind: 'stylesheet', media_type: 'text/css' },
          ],
          next: null,
        },
      });
    }
    if (url.includes('eink-override.css')) return mockResponse({ textBody: 'body { color: #000; }' });
    if (url.includes('/files/ch1.xhtml')) return mockResponse({ textBody: COMPLIANCE_CHAPTER });
    if (url.includes('/files/styles/a/main.css')) {
      return mockResponse({ textBody: 'body { background: url(../bg.png); }' });
    }
    if (url.includes('/files/styles/b/main.css')) return mockResponse({ textBody: 'p { color: red; }' });
    if (/\.png$/.test(url)) return mockResponse({ buffer: TINY_PNG });
    if (/\.jpe?g$/.test(url)) return mockResponse({ buffer: TINY_JPG });
    return mockResponse({ ok: false, status: 404 });
  };
}

let compliancePromise = null;
function getComplianceEpub() {
  if (compliancePromise) return compliancePromise;
  compliancePromise = (async () => {
    const origFetch = window.fetch;
    const origExtract = Fetcher.extractIsbn;
    const origClick = HTMLAnchorElement.prototype.click;
    let blobUrl = null;
    try {
      Fetcher.extractIsbn = () => '9782222222222';
      window.fetch = complianceFetchMock(origFetch);
      HTMLAnchorElement.prototype.click = function() { blobUrl = this.href; };

      await ChromeMock.dispatchTo(0, { action: 'cancelDownload' });
      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(0, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        { timeout: 15000, label: 'compliance downloadComplete' });

      const buf = await (await origFetch(blobUrl)).arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const opf = await zip.file('OEBPS/content.opf').async('string');
      const zipPaths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
      return { zip, opf, zipPaths };
    } finally {
      window.fetch = origFetch;
      Fetcher.extractIsbn = origExtract;
      HTMLAnchorElement.prototype.click = origClick;
    }
  })();
  return compliancePromise;
}

describe('content.js EPUB compliance (integration)', function() {
  it('declares every ZIP image in the OPF manifest (no orphan resources)', async function() {
    const { opf, zipPaths } = await getComplianceEpub();
    const images = zipPaths.filter(p => p.startsWith('OEBPS/Images/'));
    assert(images.length >= 4, `expected at least 4 images in ZIP, got: ${images.join(', ')}`);
    for (const p of images) {
      const href = p.replace('OEBPS/', '');
      assertContains(opf, `href="${href}"`, `ZIP file ${p} is not declared in the OPF manifest`);
    }
  });

  it('declares every ZIP stylesheet in the OPF manifest without collisions', async function() {
    const { opf, zipPaths } = await getComplianceEpub();
    const styles = zipPaths.filter(p => p.startsWith('OEBPS/Styles/'));
    // two distinct source main.css files + eink-override.css
    assertEqual(styles.length, 3, `expected 3 stylesheets in ZIP, got: ${styles.join(', ')}`);
    for (const p of styles) {
      const href = p.replace('OEBPS/', '');
      assertContains(opf, `href="${href}"`, `ZIP file ${p} is not declared in the OPF manifest`);
    }
  });

  it('produces an OPF with unique manifest ids', async function() {
    const { opf } = await getComplianceEpub();
    const ids = [...opf.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assertEqual(dupes.length, 0, `duplicate manifest ids: ${dupes.join(', ')}`);
  });

  it('detects the cover image even when no chapter references it', async function() {
    const { opf, zipPaths } = await getComplianceEpub();
    assert(zipPaths.includes('OEBPS/Text/cover.xhtml'), 'cover.xhtml should be generated');
    assertContains(opf, 'properties="cover-image"', 'cover image should be marked in the OPF');
  });

  it('carries rich API metadata end-to-end into the OPF', async function() {
    const { opf } = await getComplianceEpub();
    assertContains(opf, '<dc:language>en-US</dc:language>');
    assertContains(opf, "<dc:publisher>O'Reilly Media, Inc.</dc:publisher>");
    assertContains(opf, '<dc:subject>Python</dc:subject>');
    assertContains(opf, '<dc:date>2022-04-01</dc:date>');
    assertContains(opf, '<dc:description>First &amp; second. Third.</dc:description>');
  });
});

// --- API cover fallback scenarios ---
// Each scenario runs a full mocked download with its own ISBN (the metadata
// cache in content.js persists for the whole test-runner page session).

function coverScenarioFetchMock(origFetch, { isbn, coverUrl, includeCoverImage, failCoverImage }) {
  return async (url) => {
    url = String(url);
    if (url.startsWith('blob:')) return origFetch(url);
    if (url.includes('/api/v2/search/')) {
      return mockResponse({ jsonBody: { results: [{
        title: 'Cover Scenario Book', authors: ['A'],
        archive_id: isbn,
        cover_url: coverUrl,
      }] } });
    }
    if (url.includes('/files/?limit=')) {
      const files = [
        { full_path: 'ch1.xhtml', kind: 'chapter', media_type: 'application/xhtml+xml' },
        { full_path: 'images/fig1.png', kind: 'image', media_type: 'image/png' },
      ];
      if (includeCoverImage || failCoverImage) {
        files.push({ full_path: 'images/cover.jpg', kind: 'image', media_type: 'image/jpeg' });
      }
      return mockResponse({ jsonBody: { results: files, next: null } });
    }
    if (url.includes('eink-override.css')) return mockResponse({ textBody: 'body { color: #000; }' });
    if (url.includes('/files/ch1.xhtml')) return mockResponse({ textBody: COMPLIANCE_CHAPTER });
    if (failCoverImage && url.includes('images/cover.jpg')) {
      return mockResponse({ ok: false, status: 404 });
    }
    if (/\.png$/.test(url)) return mockResponse({ buffer: TINY_PNG });
    if (/\.jpe?g$/.test(url)) return mockResponse({ buffer: TINY_JPG });
    return mockResponse({ ok: false, status: 404 });
  };
}

// Run one full download with the given mocks and unpack the produced EPUB
async function buildEpubWith({ isbn, fetchMock, fetchImageResponder }) {
  const origFetch = window.fetch;
  const origExtract = Fetcher.extractIsbn;
  const origClick = HTMLAnchorElement.prototype.click;
  let blobUrl = null;
  try {
    Fetcher.extractIsbn = () => isbn;
    window.fetch = fetchMock(origFetch);
    HTMLAnchorElement.prototype.click = function() { blobUrl = this.href; };
    if (fetchImageResponder) ChromeMock.setMessageResponder('fetchImage', fetchImageResponder);

    await ChromeMock.dispatchTo(0, { action: 'cancelDownload' });
    ChromeMock.clearMessages();
    ChromeMock.dispatchTo(0, { action: 'startDownload' });
    await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
      { timeout: 15000, label: `downloadComplete for ${isbn}` });

    const fetchImageCalls = ChromeMock.sentMessages.filter(m => m.action === 'fetchImage').length;
    const completeMsg = ChromeMock.sentMessages.find(m => m.action === 'downloadComplete');
    const buf = await (await origFetch(blobUrl)).arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const opf = await zip.file('OEBPS/content.opf').async('string');
    const zipPaths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
    return { zip, opf, zipPaths, fetchImageCalls, report: completeMsg ? completeMsg.report : null };
  } finally {
    ChromeMock.clearResponders();
    window.fetch = origFetch;
    Fetcher.extractIsbn = origExtract;
    HTMLAnchorElement.prototype.click = origClick;
  }
}

function assertNoImageOrphans(opf, zipPaths) {
  for (const p of zipPaths.filter(x => x.startsWith('OEBPS/Images/'))) {
    assertContains(opf, `href="${p.replace('OEBPS/', '')}"`, `${p} missing from OPF manifest`);
  }
}

describe('content.js API cover fallback (integration)', function() {
  it('falls back to the API cover when the heuristic finds nothing', async function() {
    const isbn = '9787777777777';
    const { opf, zipPaths, fetchImageCalls } = await buildEpubWith({
      isbn,
      // Extensionless cover_url mirrors the live API — the Content-Type is
      // the only usable media-type signal
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg' }),
    });
    assertEqual(fetchImageCalls, 1, 'exactly one cover proxy fetch expected');
    assert(zipPaths.includes('OEBPS/Images/cover.jpg'),
      'fallback cover stored as cover.jpg (extension from Content-Type)');
    assert(zipPaths.includes('OEBPS/Text/cover.xhtml'), 'cover.xhtml expected');
    assertContains(opf, 'href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"');
    assertContains(opf, '<meta name="cover"', 'EPUB2 cover meta expected');
    const spineFirst = opf.match(/<itemref idref="([^"]+)"/)[1];
    assertEqual(spineFirst, 'cover', 'cover.xhtml must be first in the spine');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('builds a valid coverless EPUB when the cover fetch fails', async function() {
    const isbn = '9788888888888';
    const { opf, zipPaths } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: false, error: 'boom' }),
    });
    assert(!zipPaths.includes('OEBPS/Text/cover.xhtml'), 'no cover.xhtml expected');
    assert(!opf.includes('properties="cover-image"'), 'no cover-image property expected');
    assert(!opf.includes('<meta name="cover"'), 'no EPUB2 cover meta expected');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('never consults the fallback when the heuristic finds a cover', async function() {
    const isbn = '9781212121212';
    const { opf, zipPaths, fetchImageCalls } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, includeCoverImage: true,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg' }),
    });
    assertEqual(fetchImageCalls, 0, 'heuristic hit must not trigger the proxy');
    assertContains(opf, 'properties="cover-image"');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('skips the cover when the URL is extensionless and contentType is missing', async function() {
    // Dev-time version skew: a stale SW that does not send contentType
    const isbn = '9781313131313';
    const { opf, zipPaths, fetchImageCalls } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64 }),
    });
    assertEqual(fetchImageCalls, 1, 'the proxy fetch itself still happens');
    assert(!opf.includes('properties="cover-image"'),
      'an unidentifiable media type must never reach the manifest');
    assert(!zipPaths.some(p => /OEBPS\/Images\/cover\./.test(p)), 'no cover file expected in the ZIP');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('dedupes the fallback filename against a failed manifest cover.jpg', async function() {
    // The namer reserves names at claim time, before the fetch runs — a
    // manifest cover.jpg whose download fails still occupies "cover.jpg",
    // so the API fallback must land on cover_1.jpg consistently everywhere.
    const isbn = '9781515151515';
    const origRetry = Fetcher._fetchWithRetry;
    // 404s retry for ~13s by default; not what this test is about
    Fetcher._fetchWithRetry = function(url, opts) {
      return origRetry.call(Fetcher, url, Object.assign({}, opts, { maxRetries: 0 }));
    };
    try {
      const { opf, zip, zipPaths, fetchImageCalls } = await buildEpubWith({
        isbn,
        fetchMock: (orig) => coverScenarioFetchMock(orig, {
          isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, failCoverImage: true,
        }),
        fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg' }),
      });
      assertEqual(fetchImageCalls, 1, 'heuristic misses (cover.jpg never downloaded) → fallback runs');
      assert(zipPaths.includes('OEBPS/Images/cover_1.jpg'),
        `fallback must dedupe to cover_1.jpg; ZIP has: ${zipPaths.join(', ')}`);
      assert(!zipPaths.includes('OEBPS/Images/cover.jpg'), 'the failed manifest name must stay unwritten');
      assertContains(opf, 'href="Images/cover_1.jpg" media-type="image/jpeg" properties="cover-image"');
      const coverXhtml = await zip.file('OEBPS/Text/cover.xhtml').async('string');
      assertContains(coverXhtml, '../Images/cover_1.jpg', 'cover.xhtml must reference the deduped name');
      assertNoImageOrphans(opf, zipPaths);
    } finally {
      Fetcher._fetchWithRetry = origRetry;
    }
  });

  it('reports injected image failures while the EPUB stays orphan-free', async function() {
    // The manifest cover.jpg 404s (one terminal image failure) while the API
    // fallback cover succeeds — the report must count exactly that failure
    // and the produced EPUB must still reconcile OPF vs ZIP
    const isbn = '9787000000007';
    const origRetry = Fetcher._fetchWithRetry;
    Fetcher._fetchWithRetry = function(url, opts) {
      return origRetry.call(Fetcher, url, Object.assign({}, opts, { maxRetries: 0 }));
    };
    try {
      const { opf, zipPaths, report } = await buildEpubWith({
        isbn,
        fetchMock: (orig) => coverScenarioFetchMock(orig, {
          isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, failCoverImage: true,
        }),
        fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg' }),
      });
      assert(report, 'downloadComplete must carry the report');
      assertEqual(report.counts.imagesFailed, 1, 'exactly the failed manifest cover');
      assertEqual(report.failures.images[0], 'images/cover.jpg');
      assertEqual(report.counts.imagesOk, 2, 'fig1.png plus the fallback cover');
      assertEqual(report.counts.chaptersOk, 1);
      assertEqual(report.counts.coverPresent, true, 'the fallback cover still made it');
      assertEqual(report.counts.metadataFromApi, true);
      assertNoImageOrphans(opf, zipPaths);
    } finally {
      Fetcher._fetchWithRetry = origRetry;
    }
  });

  it('normalizes a relative cover_url and strips Content-Type parameters', async function() {
    const isbn = '9781616161616';
    const { opf, zipPaths } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `/library/cover/${isbn}/`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg; charset=binary' }),
    });
    assert(zipPaths.includes('OEBPS/Images/cover.jpg'),
      'relative cover_url must resolve against learning.oreilly.com; CT parameters must strip');
    assertContains(opf, 'properties="cover-image"');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('falls back to the URL extension for a non-committal Content-Type', async function() {
    const isbn = '9781717171717';
    const { opf, zipPaths } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/covers/${isbn}.jpg`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'application/octet-stream' }),
    });
    assert(zipPaths.includes('OEBPS/Images/cover.jpg'),
      'octet-stream is non-committal — the valid .jpg URL extension must win');
    assertContains(opf, 'href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('skips the cover for a definite non-image Content-Type despite a .jpg URL', async function() {
    const isbn = '9781818181818';
    const { opf, zipPaths } = await buildEpubWith({
      isbn,
      fetchMock: (orig) => coverScenarioFetchMock(orig, {
        isbn, coverUrl: `https://learning.oreilly.com/covers/${isbn}.jpg`, includeCoverImage: false,
      }),
      fetchImageResponder: () => ({ ok: true, data: TINY_JPG_B64, contentType: 'text/html' }),
    });
    assert(!opf.includes('properties="cover-image"'),
      'HTML bytes must never be packaged under an image extension');
    assert(!zipPaths.some(p => /OEBPS\/Images\/cover\./.test(p)), 'no cover file expected');
    assertNoImageOrphans(opf, zipPaths);
  });

  it('never completes a download cancelled during the cover fetch', async function() {
    const isbn = '9781919191919';
    let releaseCover;
    const coverGate = new Promise(resolve => { releaseCover = resolve; });
    const origFetch = window.fetch;
    const origExtract = Fetcher.extractIsbn;
    const origClick = HTMLAnchorElement.prototype.click;
    try {
      Fetcher.extractIsbn = () => isbn;
      window.fetch = coverScenarioFetchMock(origFetch, {
        isbn, coverUrl: `https://learning.oreilly.com/library/cover/${isbn}/`, includeCoverImage: false,
      });
      HTMLAnchorElement.prototype.click = function() {};
      ChromeMock.setMessageResponder('fetchImage', () =>
        coverGate.then(() => ({ ok: true, data: TINY_JPG_B64, contentType: 'image/jpeg' })));

      await ChromeMock.dispatchTo(0, { action: 'cancelDownload' });
      ChromeMock.clearMessages();
      ChromeMock.dispatchTo(0, { action: 'startDownload' });
      await waitFor(() => ChromeMock.sentMessages.some(m => m.action === 'fetchImage'),
        { timeout: 15000, label: 'cover fetch to start' });
      await ChromeMock.dispatchTo(0, { action: 'cancelDownload' });
      releaseCover();
      await new Promise(r => setTimeout(r, 400));
      assert(!ChromeMock.sentMessages.some(m => m.action === 'downloadComplete'),
        'a download cancelled during the cover fetch must not complete');
    } finally {
      ChromeMock.clearResponders();
      window.fetch = origFetch;
      Fetcher.extractIsbn = origExtract;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });
});

// Proxy assertions for the classes of epubcheck failures the in-browser
// suite can check itself. The real epubcheck run remains the final gate.
describe('content.js OPF metadata proxy assertions (epubcheck stand-ins)', function() {
  it('emits a structurally valid short dc:language tag', async function() {
    const { opf } = await getComplianceEpub();
    const m = opf.match(/<dc:language>([^<]+)<\/dc:language>/);
    assert(m, 'OPF must declare dc:language');
    let structurallyValid = true;
    try { Intl.getCanonicalLocales(m[1]); } catch (e) { structurallyValid = false; }
    assert(structurallyValid && /^[a-zA-Z]{2,3}(-|$)/.test(m[1]),
      `dc:language "${m[1]}" would draw epubcheck OPF-092`);
  });
  it('emits dc:date only in ISO prefix form', async function() {
    const { opf } = await getComplianceEpub();
    const m = opf.match(/<dc:date>([^<]+)<\/dc:date>/);
    if (m) {
      assert(/^\d{4}(-\d{2}){0,2}$/.test(m[1]), `dc:date "${m[1]}" is not YYYY[-MM[-DD]]`);
    }
  });
  it('contains no XML-1.0-illegal code points', async function() {
    const { opf } = await getComplianceEpub();
    assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(opf),
      'OPF contains XML-1.0-illegal code points');
  });
});
