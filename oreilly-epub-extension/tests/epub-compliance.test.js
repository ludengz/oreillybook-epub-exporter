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
const TINY_PNG = b64ToBuf('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
const TINY_JPG = b64ToBuf('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==');

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
