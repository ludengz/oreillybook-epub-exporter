describe('EinkOptimizer.processChapter', function() {
  it('injects eink-override.css link', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="styles.css"/></head><body></body></html>';
    const result = EinkOptimizer.processChapter(xhtml, {});
    assertContains(result, 'eink-override.css');
    assert(result.indexOf('styles.css') < result.indexOf('eink-override.css'),
      'eink-override must come after existing stylesheets');
  });

  it('handles XHTML with no existing stylesheets', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body></body></html>';
    assertContains(EinkOptimizer.processChapter(xhtml, {}), 'eink-override.css');
  });

  it('rewrites img src paths to EPUB Images/ dir', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><img src="../graphics/fig1.png"/></body></html>';
    const result = EinkOptimizer.processChapter(xhtml, { '../graphics/fig1.png': 'fig1.png' });
    assertContains(result, '../Images/fig1.png');
    assert(!result.includes('../graphics/fig1.png'), 'original path should be replaced');
  });

  it('rewrites CSS link href to ../Styles/', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="css/book.css"/></head><body></body></html>';
    const result = EinkOptimizer.processChapter(xhtml, {});
    assertContains(result, '../Styles/book.css');
  });

  it('rewrites SVG image href attributes', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><svg xmlns="http://www.w3.org/2000/svg"><image href="diagram.svg"/></svg></body></html>';
    const result = EinkOptimizer.processChapter(xhtml, { 'diagram.svg': 'diagram.svg' });
    assertContains(result, '../Images/diagram.svg');
  });

  it('handles HTML entities in image paths correctly', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><img src="img/a&amp;b.png"/></body></html>';
    // getAttribute('src') decodes &amp; to &, so imageMap key should use decoded form
    const result = EinkOptimizer.processChapter(xhtml, { 'img/a&b.png': 'ab.png' });
    assertContains(result, '../Images/ab.png');
  });

  it('removes OReilly reader-specific wrapper divs', function() {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><div class="readable-text intended-text">Duplicate content</div><p>Original content</p></body></html>';
    const result = EinkOptimizer.processChapter(xhtml, {});
    assert(!result.includes('Duplicate content'), 'duplicate content wrapper should be removed');
    assertContains(result, 'Original content');
  });

  it('produces valid XHTML without duplicate html tags and includes xmlns', function() {
    const html = '<!DOCTYPE html><html><head><title>T</title></head><body><p>Text</p></body></html>';
    const result = EinkOptimizer.processChapter(html, {});
    assertContains(result, '<?xml version="1.0"');
    assertContains(result, '<!DOCTYPE html>');
    assertContains(result, 'xmlns="http://www.w3.org/1999/xhtml"');

    // It should not have <html> wrapped inside another <html>
    const matchCount = (result.match(/<html/gi) || []).length;
    assert(matchCount === 1, `Expected exactly 1 <html tag, found ${matchCount}`);
  });
});

// --- Namespace-prefixed attributes surviving the text/html fallback ---
// O'Reilly's newer books ship chapters as HTML fragments carrying epub:type
// attributes (structural semantics). The text/html fallback stores them as
// namespace-less colon-named attributes; a naive XMLSerializer pass emits
// them with an unbound prefix, making the packaged chapter non-well-formed
// XHTML (the validator's strict reparse then flags every such chapter).
describe('EinkOptimizer.processChapter namespace repair', function() {
  // The validator's exact check (epub-validator.js): strict parse, no fallback
  function strictParseError(xhtml) {
    const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
    const err = doc.querySelector('parsererror');
    return err ? err.textContent : null;
  }

  it('binds epub:type from an HTML-fragment source into well-formed XHTML', function() {
    // Modeled on a real O'Reilly chapter (titlepage01.html of 9798341662681)
    const src = '<div id="sbo-rt-content"><section data-type="titlepage" epub:type="titlepage">' +
      '<h1>Title</h1></section></div>';
    const result = EinkOptimizer.processChapter(src, {});
    const err = strictParseError(result);
    assert(err === null, `output must be well-formed XHTML, got: ${err}`);
    assertContains(result, 'epub:type="titlepage"');
    assertContains(result, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  });

  it('repairs every occurrence, not just the first element', function() {
    const src = '<div id="sbo-rt-content"><section epub:type="chapter">' +
      '<aside epub:type="sidebar"><p>Note</p></aside>' +
      '<a href="#fn1" epub:type="noteref">1</a></section></div>';
    const result = EinkOptimizer.processChapter(src, {});
    assert(strictParseError(result) === null, 'all epub:type occurrences must be bound');
    assertContains(result, 'epub:type="sidebar"');
    assertContains(result, 'epub:type="noteref"');
  });

  it('strips attributes with unknown unbindable prefixes', function() {
    const src = '<div id="sbo-rt-content"><p custom:thing="x">Text</p></div>';
    const result = EinkOptimizer.processChapter(src, {});
    assert(strictParseError(result) === null,
      'an unbindable prefix must not survive into the output');
    assert(!result.includes('custom:thing'), 'unknown-prefix attribute must be stripped');
    assertContains(result, 'Text');
  });

  it('leaves well-formed XHTML with a declared epub namespace untouched', function() {
    const src = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" ' +
      'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>T</title></head>' +
      '<body><section epub:type="chapter"><p>Body</p></section></body></html>';
    const result = EinkOptimizer.processChapter(src, {});
    assert(strictParseError(result) === null, 'already-valid XHTML must stay valid');
    assertContains(result, 'epub:type="chapter"');
  });

  it('does not disturb xml:lang (implicitly bound in XML)', function() {
    const src = '<div id="sbo-rt-content"><p xml:lang="en">Text</p></div>';
    const result = EinkOptimizer.processChapter(src, {});
    assert(strictParseError(result) === null, 'xml: prefix needs no declaration');
    assertContains(result, 'Text');
  });
});
