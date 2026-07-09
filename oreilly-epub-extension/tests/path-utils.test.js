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

describe('PathUtils.isAllowedImageUrl', function() {
  it('accepts the O\'Reilly hosts over https', function() {
    assertEqual(PathUtils.isAllowedImageUrl('https://learning.oreilly.com/library/cover/x/'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://cdn.oreillystatic.com/a.png'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://oreillystatic.com/a.png'), true);
    assertEqual(PathUtils.isAllowedImageUrl('https://www.safaribooksonline.com/a.jpg'), true);
  });
  it('rejects suffix-spoofing and lookalike hosts', function() {
    assertEqual(PathUtils.isAllowedImageUrl('https://oreillystatic.com.evil.example/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('https://xlearning.oreilly.com/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('https://notoreillystatic.com/a.png'), false);
  });
  it('rejects non-https schemes and junk', function() {
    assertEqual(PathUtils.isAllowedImageUrl('http://learning.oreilly.com/a.png'), false);
    assertEqual(PathUtils.isAllowedImageUrl('not a url'), false);
  });
});

describe('PathUtils.sanitizeFilename', function() {
  const FB = 'book-9781234567890';
  it('preserves CJK titles unchanged', function() {
    assertEqual(PathUtils.sanitizeFilename('深入理解计算机系统', FB), '深入理解计算机系统');
  });
  it('preserves accented characters and case', function() {
    assertEqual(PathUtils.sanitizeFilename('Café Sécurité', FB), 'Café Sécurité');
  });
  it('keeps ASCII titles readable instead of kebab-lowercase', function() {
    assertEqual(
      PathUtils.sanitizeFilename('Designing Data-Intensive Applications', FB),
      'Designing Data-Intensive Applications'
    );
  });
  it('replaces filesystem-illegal characters with spaces and collapses', function() {
    assertEqual(PathUtils.sanitizeFilename('C++: Design/Use?', FB), 'C++ Design Use');
  });
  it('falls back for punctuation-only titles', function() {
    assertEqual(PathUtils.sanitizeFilename('???', FB), FB);
  });
  it('falls back for empty and whitespace-only titles', function() {
    assertEqual(PathUtils.sanitizeFilename('', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('   ', FB), FB);
    assertEqual(PathUtils.sanitizeFilename(null, FB), FB);
  });
  it('falls back for Windows reserved device names', function() {
    assertEqual(PathUtils.sanitizeFilename('con', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('COM7', FB), FB);
    assertEqual(PathUtils.sanitizeFilename('LPT1', FB), FB);
  });
  it('trims leading and trailing dots and spaces', function() {
    assertEqual(PathUtils.sanitizeFilename('Title...', FB), 'Title');
    assertEqual(PathUtils.sanitizeFilename('.hidden', FB), 'hidden');
  });
  it('strips zero-width, bidi-override, and control characters', function() {
    assertEqual(PathUtils.sanitizeFilename('A\u200BB\u202EC\u0007D', FB), 'A B C D');
  });
  it('truncates byte-aware without splitting a code point', function() {
    // 100 CJK chars = 300 UTF-8 bytes; cap is 200 bytes = 66 chars (198 bytes)
    const long = '书'.repeat(100);
    const out = PathUtils.sanitizeFilename(long, FB);
    assertEqual(out, '书'.repeat(66));
  });
  it('re-trims trailing dots or spaces exposed by truncation', function() {
    // 66 CJK chars (198 bytes) + '. ' — the cap cuts inside the padding
    const tricky = '书'.repeat(66) + '.  X';
    const out = PathUtils.sanitizeFilename(tricky, FB);
    assertEqual(out, '书'.repeat(66));
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
