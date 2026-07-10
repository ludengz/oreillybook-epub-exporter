// Unit tests for lib/epub-validator.js — the pre-package integrity gate.
// Pure module: builds small JSZip fixtures in-test, no download harness.

const VALIDATOR_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C1</title></head><body><h1>C1</h1></body></html>';

// Minimal but complete EPUB skeleton mirroring buildEpub's real assembly
// order (mimetype first, STORE) so the validator sees production shapes.
function makeEpubFixture({ mimetypeFirst = true, storeMimetype = true, chapterXhtml = VALIDATOR_XHTML } = {}) {
  const metadata = {
    title: 'Validator Book', authors: ['A'], isbn: '9781234567890',
    language: 'en', modified: '2024-01-01T00:00:00Z',
  };
  const chapters = [{ filename: 'chapter_01.xhtml', title: 'C1' }];
  const zip = new JSZip();
  if (mimetypeFirst) {
    zip.file('mimetype', 'application/epub+zip', { compression: storeMimetype ? 'STORE' : 'DEFLATE' });
    zip.file('META-INF/container.xml', EpubBuilder.generateContainer());
  } else {
    zip.file('META-INF/container.xml', EpubBuilder.generateContainer());
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  }
  zip.file('OEBPS/Text/chapter_01.xhtml', chapterXhtml);
  zip.file('OEBPS/Styles/eink-override.css', 'body {}');
  zip.file('OEBPS/Images/fig.png', new ArrayBuffer(4));
  const opf = EpubBuilder.generateOpf(metadata, chapters, ['fig.png'], ['eink-override.css'], null);
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/toc.xhtml', EpubBuilder.generateTocXhtml(metadata.title, chapters));
  zip.file('OEBPS/toc.ncx', EpubBuilder.generateTocNcx(metadata.isbn, metadata.title, chapters));
  return { zip, opf };
}

describe('EpubValidator.validateStructure', function() {
  it('passes a well-formed EPUB with no findings', async function() {
    const { zip, opf } = makeEpubFixture();
    const result = await EpubValidator.validateStructure(zip, opf);
    assertEqual(result.fatal.length, 0, `unexpected fatal: ${result.fatal.join('; ')}`);
    assertEqual(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join('; ')}`);
  });

  it('flags a ZIP entry missing from the manifest as a warning', async function() {
    const { zip, opf } = makeEpubFixture();
    zip.file('OEBPS/Images/orphan.png', new ArrayBuffer(4));
    const result = await EpubValidator.validateStructure(zip, opf);
    assertEqual(result.fatal.length, 0, 'orphans are non-fatal');
    assertEqual(result.warnings.length, 1);
    assertContains(result.warnings[0], 'OEBPS/Images/orphan.png');
  });

  it('flags a manifest href missing from the ZIP as fatal', async function() {
    const { zip, opf } = makeEpubFixture();
    const doctored = opf.replace('</manifest>',
      '<item id="ghost" href="Images/ghost.png" media-type="image/png"/></manifest>');
    const result = await EpubValidator.validateStructure(zip, doctored);
    assertEqual(result.fatal.length, 1);
    assertContains(result.fatal[0], 'OEBPS/Images/ghost.png');
  });

  it('flags a spine idref with no manifest item as fatal', async function() {
    const { zip, opf } = makeEpubFixture();
    const doctored = opf.replace('</spine>', '<itemref idref="ghost"/></spine>');
    const result = await EpubValidator.validateStructure(zip, doctored);
    assertEqual(result.fatal.length, 1);
    assertContains(result.fatal[0], 'ghost');
  });

  it('flags mimetype not being the first ZIP entry as fatal', async function() {
    const { zip, opf } = makeEpubFixture({ mimetypeFirst: false });
    const result = await EpubValidator.validateStructure(zip, opf);
    assert(result.fatal.some(f => f.includes('mimetype')),
      `expected a mimetype fatal, got: ${result.fatal.join('; ')}`);
  });

  it('flags a compressed mimetype entry as fatal', async function() {
    const { zip, opf } = makeEpubFixture({ storeMimetype: false });
    const result = await EpubValidator.validateStructure(zip, opf);
    assert(result.fatal.some(f => f.includes('mimetype')),
      `expected a mimetype fatal, got: ${result.fatal.join('; ')}`);
  });

  it('flags a chapter that fails a strict XHTML parse as a warning', async function() {
    const { zip, opf } = makeEpubFixture({ chapterXhtml: '<html><body><p>unclosed</body></html>' });
    const result = await EpubValidator.validateStructure(zip, opf);
    assertEqual(result.fatal.length, 0, 'parsererror chapters are non-fatal');
    assert(result.warnings.some(w => w.includes('chapter_01.xhtml')),
      `expected a chapter warning, got: ${result.warnings.join('; ')}`);
  });

  it('flags a malformed OPF as fatal', async function() {
    const { zip } = makeEpubFixture();
    const result = await EpubValidator.validateStructure(zip, '<package><unclosed</package>');
    assert(result.fatal.length >= 1);
    assertContains(result.fatal[0], 'OPF');
  });
});

describe('EpubValidator.validateBlob', function() {
  it('passes a blob whose first local file header is a stored mimetype', async function() {
    const { zip } = makeEpubFixture();
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    const result = await EpubValidator.validateBlob(blob);
    assertEqual(result.fatal.length, 0, `unexpected fatal: ${result.fatal.join('; ')}`);
  });

  it('flags a blob whose first entry is not mimetype as fatal', async function() {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<x/>');
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    const blob = await zip.generateAsync({ type: 'blob' });
    const result = await EpubValidator.validateBlob(blob);
    assertEqual(result.fatal.length, 1);
    assertContains(result.fatal[0], 'mimetype');
  });

  it('flags a non-ZIP blob as fatal', async function() {
    const result = await EpubValidator.validateBlob(new Blob(['not a zip at all']));
    assertEqual(result.fatal.length, 1);
  });
});
