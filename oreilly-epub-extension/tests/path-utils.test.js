describe('PathUtils.normalizePath', function() {
  it('resolves .. segments', function() {
    assertEqual(PathUtils.normalizePath('OEBPS/Text/../Images/fig.png'), 'OEBPS/Images/fig.png');
  });
  it('strips leading slashes', function() {
    assertEqual(PathUtils.normalizePath('/OEBPS/ch1.xhtml'), 'OEBPS/ch1.xhtml');
  });
  it('removes . segments and empty parts', function() {
    assertEqual(PathUtils.normalizePath('a/./b//c'), 'a/b/c');
  });
  it('does not go above the root', function() {
    assertEqual(PathUtils.normalizePath('../../img.png'), 'img.png');
  });
});

describe('PathUtils.resolveImagePath', function() {
  it('resolves relative src against the chapter directory', function() {
    const r = PathUtils.resolveImagePath('../images/fig.png', 'OEBPS/Text/ch1.xhtml');
    assertEqual(r.resolved, 'OEBPS/images/fig.png');
    assertEqual(r.isAbsolute, false);
  });
  it('passes through absolute URLs with query stripped', function() {
    const r = PathUtils.resolveImagePath('https://cdn.example.com/a.png?v=1', 'Text/ch1.xhtml');
    assertEqual(r.resolved, 'https://cdn.example.com/a.png');
    assertEqual(r.isAbsolute, true);
  });
  it('strips query and hash before resolving relative paths', function() {
    const r = PathUtils.resolveImagePath('fig.png?v=2#top', 'ch1.xhtml');
    assertEqual(r.resolved, 'fig.png');
  });
  it('handles chapters at the EPUB root', function() {
    const r = PathUtils.resolveImagePath('images/fig.png', 'ch1.xhtml');
    assertEqual(r.resolved, 'images/fig.png');
  });
});

describe('PathUtils.createUniqueNamer', function() {
  it('returns names unchanged when unique', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('a.png'), 'a.png');
    assertEqual(namer('b.png'), 'b.png');
  });
  it('suffixes duplicate basenames before the extension', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('fig.png'), 'fig.png');
    assertEqual(namer('fig.png'), 'fig_1.png');
    assertEqual(namer('fig.png'), 'fig_2.png');
  });
  it('handles names without an extension', function() {
    const namer = PathUtils.createUniqueNamer();
    assertEqual(namer('README'), 'README');
    assertEqual(namer('README'), 'README_1');
  });
  it('keeps separate namers independent', function() {
    const a = PathUtils.createUniqueNamer();
    const b = PathUtils.createUniqueNamer();
    assertEqual(a('x.png'), 'x.png');
    assertEqual(b('x.png'), 'x.png');
  });
});

describe('PathUtils.stripQueryAndHash', function() {
  it('strips query and hash', function() {
    assertEqual(PathUtils.stripQueryAndHash('img.png?w=100#x'), 'img.png');
  });
  it('returns unchanged path when clean', function() {
    assertEqual(PathUtils.stripQueryAndHash('path/to/image.jpg'), 'path/to/image.jpg');
  });
});
