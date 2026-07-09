describe('EpubBuilder._escapeXml', function() {
  it('escapes ampersands', function() {
    assertEqual(EpubBuilder._escapeXml('A & B'), 'A &amp; B');
  });
  it('escapes angle brackets and quotes', function() {
    assertEqual(EpubBuilder._escapeXml('<"test">'), '&lt;&quot;test&quot;&gt;');
  });
});

describe('EpubBuilder._mimeType', function() {
  it('returns correct type for jpg', function() {
    assertEqual(EpubBuilder._mimeType('photo.jpg'), 'image/jpeg');
  });
  it('returns correct type for png', function() {
    assertEqual(EpubBuilder._mimeType('fig.png'), 'image/png');
  });
  it('returns correct type for svg', function() {
    assertEqual(EpubBuilder._mimeType('diagram.svg'), 'image/svg+xml');
  });
  it('returns octet-stream for unknown extension', function() {
    assertEqual(EpubBuilder._mimeType('file.xyz'), 'application/octet-stream');
  });
});

describe('EpubBuilder.generateContainer', function() {
  it('generates valid container.xml pointing to content.opf', function() {
    const xml = EpubBuilder.generateContainer();
    assertContains(xml, '<?xml version="1.0"');
    assertContains(xml, 'urn:oasis:names:tc:opendocument:xmlns:container');
    assertContains(xml, 'OEBPS/content.opf');
    assertContains(xml, 'application/oebps-package+xml');
  });
});

describe('EpubBuilder.generateOpf', function() {
  const metadata = {
    title: 'Test Book',
    authors: ['Author One', 'Author Two'],
    isbn: '9781234567890',
    language: 'en',
    modified: '2024-01-01T00:00:00Z',
  };
  const chapters = [
    { filename: 'chapter_01.xhtml', title: 'Chapter 1' },
    { filename: 'chapter_02.xhtml', title: 'Chapter 2' },
  ];
  const images = ['cover.jpg', 'fig_01.png', 'diagram.svg'];
  const cssFiles = ['original.css', 'eink-override.css'];

  it('includes dc:identifier with ISBN', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, '<dc:identifier id="bookid">urn:isbn:9781234567890</dc:identifier>');
  });
  it('includes dc:title', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, '<dc:title>Test Book</dc:title>');
  });
  it('includes dc:language', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, '<dc:language>en</dc:language>');
  });
  it('includes dcterms:modified', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, 'dcterms:modified');
  });
  it('includes all authors', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, '<dc:creator>Author One</dc:creator>');
    assertContains(opf, '<dc:creator>Author Two</dc:creator>');
  });
  it('lists chapters in manifest and spine', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, 'href="Text/chapter_01.xhtml"');
    assertContains(opf, 'idref="chapter_01"');
  });
  it('lists images with correct media types including SVG', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, 'href="Images/cover.jpg"');
    assertContains(opf, 'media-type="image/jpeg"');
    assertContains(opf, 'href="Images/diagram.svg"');
    assertContains(opf, 'media-type="image/svg+xml"');
  });
  it('lists CSS files in manifest', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, 'href="Styles/original.css"');
  });
  it('references nav and ncx', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assertContains(opf, 'properties="nav"');
    assertContains(opf, 'toc="ncx"');
  });
  it('marks cover image with properties="cover-image"', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles, 'cover.jpg');
    assertContains(opf, 'properties="cover-image"');
  });
  it('emits EPUB2 meta name="cover" pointing at the cover image manifest id', function() {
    // Older e-ink readers (e.g. Boox) only honour the EPUB2-style cover meta
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles, 'cover.jpg');
    const m = opf.match(/<meta name="cover" content="([^"]+)"\/>/);
    assert(m, 'OPF should contain <meta name="cover" .../> inside <metadata>');
    assertContains(opf, `<item id="${m[1]}" href="Images/cover.jpg"`,
      'cover meta must reference the manifest id of the cover image item');
  });
  it('omits the EPUB2 cover meta when there is no cover', function() {
    const opf = EpubBuilder.generateOpf(metadata, chapters, images, cssFiles);
    assert(!opf.includes('<meta name="cover"'), 'no cover meta expected without a cover');
  });
});

describe('EpubBuilder.generateTocXhtml', function() {
  const chapters = [
    { filename: 'chapter_01.xhtml', title: 'Introduction' },
    { filename: 'chapter_02.xhtml', title: 'Getting Started' },
  ];
  it('generates valid EPUB 3 nav document', function() {
    const toc = EpubBuilder.generateTocXhtml('Test Book', chapters);
    assertContains(toc, 'xmlns:epub="http://www.idpf.org/2007/ops"');
    assertContains(toc, 'epub:type="toc"');
  });
  it('links to all chapters', function() {
    const toc = EpubBuilder.generateTocXhtml('Test Book', chapters);
    assertContains(toc, 'href="Text/chapter_01.xhtml"');
    assertContains(toc, 'Introduction');
  });
});

describe('EpubBuilder.generateTocNcx', function() {
  const chapters = [
    { filename: 'chapter_01.xhtml', title: 'Introduction' },
    { filename: 'chapter_02.xhtml', title: 'Getting Started' },
  ];
  it('generates valid NCX with navPoints', function() {
    const ncx = EpubBuilder.generateTocNcx('9781234567890', 'Test Book', chapters);
    assertContains(ncx, 'xmlns="http://www.daisy.org/z3986/2005/ncx/"');
    assertContains(ncx, 'playOrder="1"');
    assertContains(ncx, 'Text/chapter_01.xhtml');
  });
});

describe('EpubBuilder.generateCoverXhtml', function() {
  it('generates cover page referencing cover image', function() {
    const cover = EpubBuilder.generateCoverXhtml('Test Book', 'cover.jpg');
    assertContains(cover, 'cover.jpg');
    assertContains(cover, 'Test Book');
  });
});

describe('EpubBuilder.normalizeMetadata', function() {
  it('keeps and canonicalizes valid BCP 47 language tags', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ language: 'en-US' }).language, 'en-US');
    assertEqual(EpubBuilder.normalizeMetadata({ language: 'EN-us' }).language, 'en-US');
    assertEqual(EpubBuilder.normalizeMetadata({ language: ['ja', 'en'] }).language, 'ja');
  });
  it('falls back to en for junk languages', function() {
    // "english" is RFC 5646 well-formed (5-8-alpha subtag): Intl alone
    // admits it, the 2-3-alpha primary-subtag requirement rejects it
    assertEqual(EpubBuilder.normalizeMetadata({ language: 'english' }).language, 'en');
    assertEqual(EpubBuilder.normalizeMetadata({ language: 'en-a' }).language, 'en');
    assertEqual(EpubBuilder.normalizeMetadata({ language: 'en-US-GB' }).language, 'en');
    assertEqual(EpubBuilder.normalizeMetadata({ language: [] }).language, 'en');
    assertEqual(EpubBuilder.normalizeMetadata({ language: 42 }).language, 'en');
  });
  it('extracts ISO date prefixes without Date roundtrips', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ issued: '2022-04-01T00:00:00Z' }).date, '2022-04-01');
    assertEqual(EpubBuilder.normalizeMetadata({ issued: '2023-05' }).date, '2023-05');
  });
  it('omits unparseable or out-of-range dates', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ issued: 'May 2023' }).date, null);
    assertEqual(EpubBuilder.normalizeMetadata({ issued: '2023-13' }).date, null);
    assertEqual(EpubBuilder.normalizeMetadata({ issued: '2023-05-32' }).date, null);
  });
  it('converges publishers from arrays, bare strings, and name objects', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ publishers: ["O'Reilly Media, Inc."] }).publishers.join('|'), "O'Reilly Media, Inc.");
    assertEqual(EpubBuilder.normalizeMetadata({ publishers: 'Acme' }).publishers.join('|'), 'Acme');
    assertEqual(EpubBuilder.normalizeMetadata({ publishers: [{ name: 'A' }, 'B', null, 42] }).publishers.join('|'), 'A|B');
  });
  it('converges and dedupes subjects (topics_payload shape)', function() {
    const subjects = EpubBuilder.normalizeMetadata({
      subjects: [{ uuid: 'x', slug: 'python', name: 'Python' }, 'Python', { name: 'Java' }],
    }).subjects;
    assertEqual(subjects.join('|'), 'Python|Java');
  });
  it('flattens HTML descriptions with block boundaries as spaces', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ description: '<p>A</p><p>B</p>' }).description, 'A B');
    assertEqual(EpubBuilder.normalizeMetadata({ description: '<span><div><p>X &amp; Y</p></div></span>' }).description, 'X & Y');
  });
  it('strips XML-illegal code points from text fields', function() {
    assertEqual(EpubBuilder.normalizeMetadata({ description: 'a\u0008b' }).description, 'ab');
  });
  it('never throws on junk input', function() {
    assertEqual(EpubBuilder.normalizeMetadata(null).language, 'en');
    const junk = EpubBuilder.normalizeMetadata({ language: 5, publishers: 7, subjects: {}, issued: 9, description: 4 });
    assertEqual(junk.publishers.length, 0);
    assertEqual(junk.date, null);
  });
});

describe('EpubBuilder.generateOpf optional metadata', function() {
  const minimal = {
    title: 'Test Book', authors: ['A'], isbn: '9781234567890',
    language: 'en', modified: '2024-01-01T00:00:00Z',
  };
  const chapters = [{ filename: 'chapter_01.xhtml', title: 'C1' }];

  it('emits no optional elements for minimal metadata', function() {
    const opf = EpubBuilder.generateOpf(minimal, chapters, [], []);
    assert(!opf.includes('<dc:publisher'), 'no dc:publisher expected');
    assert(!opf.includes('<dc:subject'), 'no dc:subject expected');
    assert(!opf.includes('<dc:description'), 'no dc:description expected');
    assert(!opf.includes('<dc:date'), 'no dc:date expected');
  });
  it('emits escaped optional elements when present', function() {
    const rich = Object.assign({}, minimal, {
      publishers: ["O'Reilly <Media> & Co"],
      subjects: ['Python', 'C & D'],
      date: '2022-04-01',
      description: 'Fast & <deep>',
    });
    const opf = EpubBuilder.generateOpf(rich, chapters, [], []);
    assertContains(opf, "<dc:publisher>O'Reilly &lt;Media&gt; &amp; Co</dc:publisher>");
    assertContains(opf, '<dc:subject>Python</dc:subject>');
    assertContains(opf, '<dc:subject>C &amp; D</dc:subject>');
    assertContains(opf, '<dc:date>2022-04-01</dc:date>');
    assertContains(opf, '<dc:description>Fast &amp; &lt;deep&gt;</dc:description>');
  });
  it('escapes the API-sourced dc:language value', function() {
    const opf = EpubBuilder.generateOpf(Object.assign({}, minimal, { language: 'pt-BR' }), chapters, [], []);
    assertContains(opf, '<dc:language>pt-BR</dc:language>');
  });
});
