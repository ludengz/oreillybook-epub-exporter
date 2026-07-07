(function() {
  'use strict';

  let abortController = null;

  // Extract book title from document.title which has format "ChapterTitle | BookTitle"
  function extractBookTitle() {
    const parts = document.title.split(' | ');
    return parts.length > 1 ? parts[parts.length - 1].trim() : document.title.trim();
  }

  // Fetch book metadata (title, authors) from O'Reilly API
  async function fetchBookMetadata(isbn) {
    try {
      const res = await fetch(`/api/v2/search/?query=${isbn}&limit=1`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const book = data.results?.[0];
        if (book) {
          return {
            title: book.title || extractBookTitle(),
            authors: book.authors?.length ? book.authors : null,
          };
        }
      }
    } catch (e) { console.warn('Metadata fetch failed:', e); }
    return { title: extractBookTitle(), authors: null };
  }

  // Detect book on page load
  async function detectBook() {
    const isbn = Fetcher.extractIsbn(window.location.href);
    if (!isbn) return;

    const meta = await fetchBookMetadata(isbn);
    const authors = meta.authors || ['Unknown Author'];

    chrome.runtime.sendMessage({
      action: 'bookDetected',
      bookInfo: { isbn, title: meta.title, authors },
    });
  }

  // Listen for commands
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startDownload') startDownload();
    else if (message.action === 'cancelDownload') cancelDownload();
    else if (message.action === 'getBookInfo') {
      sendResponse({ isbn: Fetcher.extractIsbn(window.location.href) });
      return true;
    }
  });

  function cancelDownload() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  // Fetch image via background service worker (CORS proxy)
  async function fetchImageViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error(response?.error || 'Background fetch failed'));
          return;
        }
        // Decode base64 back to ArrayBuffer
        const binary = atob(response.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        resolve(bytes.buffer);
      });
    });
  }

  async function startDownload() {
    if (abortController) return; // Already downloading
    const isbn = Fetcher.extractIsbn(window.location.href);
    if (!isbn) return;

    const controller = new AbortController();
    abortController = controller;
    const signal = controller.signal;
    const zip = new JSZip();

    try {
      // Fetch all pages of the file manifest (API is paginated, ~20 per page)
      const allFiles = [];
      let nextUrl = `/api/v2/epubs/urn:orm:book:${isbn}/files/?limit=200`;
      while (nextUrl) {
        const filesRes = await fetch(nextUrl, { credentials: 'include', signal });
        if (!filesRes.ok) throw new Error(`Manifest fetch failed: ${filesRes.status}`);
        const filesData = await filesRes.json();
        const results = filesData.results || filesData;
        allFiles.push(...(Array.isArray(results) ? results : []));
        // Follow pagination; convert absolute URL to relative path
        if (filesData.next) {
          const u = new URL(filesData.next);
          nextUrl = u.pathname + u.search;
        } else {
          nextUrl = null;
        }
      }
      console.log(`Manifest loaded: ${allFiles.length} files total`);

      const chapterFiles = [];
      const cssFiles = [];
      const imageFiles = [];

      for (const file of allFiles) {
        const path = file.full_path || file.filename || '';
        const kind = file.kind || '';
        const mediaType = file.media_type || '';
        const contentUrl = `/api/v2/epubs/urn:orm:book:${isbn}/files/${path}`;

        if (kind === 'chapter' || mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
          chapterFiles.push({ path, url: contentUrl });
        } else if (mediaType === 'text/css' || path.match(/\.css$/i)) {
          cssFiles.push({ path, url: contentUrl });
        } else if (mediaType.startsWith('image/') || path.match(/\.(png|jpe?g|gif|svg|webp)$/i)) {
          imageFiles.push({ path, url: contentUrl, mediaType });
        }
      }

      console.log(`Found: ${chapterFiles.length} chapters, ${cssFiles.length} CSS, ${imageFiles.length} images`);
      if (chapterFiles.length > 100) {
        console.warn(`Large book detected: ${chapterFiles.length} chapters. This may take a while.`);
      }

      await buildEpub(zip, isbn, chapterFiles, cssFiles, imageFiles, signal);

    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Download cancelled');
        return;
      }
      console.error('Download failed:', err);
      chrome.runtime.sendMessage({
        action: 'downloadError',
        error: err.message === 'SESSION_EXPIRED'
          ? 'Session expired. Please log in to O\'Reilly and try again.'
          : err.message,
      });
    } finally {
      // Reset the reentry guard on every exit path (success, error, cancel).
      // Guard against clobbering a newer download started after a cancel.
      if (abortController === controller) abortController = null;
    }
  }

  async function buildEpub(zip, isbn, chapterFiles, cssFiles, imageFiles, signal) {
    const totalChapters = chapterFiles.length;

    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', EpubBuilder.generateContainer());

    const einkRes = await fetch(chrome.runtime.getURL('styles/eink-override.css'));
    zip.file('OEBPS/Styles/eink-override.css', await einkRes.text());

    // Track filenames to avoid collisions (different dirs, same filename)
    const uniqueFilename = PathUtils.createUniqueNamer();

    const cssFilenames = [];
    const cssImageMap = {}; // tracks CSS background images: original url -> zip filename
    for (const cssFile of cssFiles) {
      try {
        const res = await Fetcher._fetchWithRetry(cssFile.url, { signal });
        let cssText = await res.text();
        // Unique name: same-basename CSS in different dirs must not overwrite
        // each other in the ZIP or duplicate OPF manifest entries
        const filename = uniqueFilename(cssFile.path.split('/').pop());
        cssFilenames.push(filename);

        // Extract and download background images referenced in CSS
        const cssImgUrls = Fetcher.extractCssImageUrls(cssText);
        for (const cssImgUrl of cssImgUrls) {
          if (cssImageMap[cssImgUrl]) continue; // Already downloaded
          const cleanUrl = Fetcher.stripQueryAndHash(cssImgUrl);
          const cssDir = cssFile.path.substring(0, cssFile.path.lastIndexOf('/'));
          const resolvedPath = PathUtils.normalizePath(cssDir + '/' + cleanUrl);
          const imgName = uniqueFilename(Fetcher.stripQueryAndHash(cleanUrl.split('/').pop()));
          const apiUrl = `/api/v2/epubs/urn:orm:book:${isbn}/files/${Fetcher.stripQueryAndHash(resolvedPath)}`;
          try {
            const imgRes = await Fetcher._fetchWithRetry(apiUrl, { signal });
            zip.file(`OEBPS/Images/${imgName}`, await imgRes.arrayBuffer());
            cssImageMap[cssImgUrl] = imgName;
          } catch (e) {
            console.warn(`CSS background image fetch failed: ${cssImgUrl}`, e);
          }
        }

        // Rewrite CSS url() paths to point to ../Images/
        for (const [original, newName] of Object.entries(cssImageMap)) {
          cssText = cssText.split(original).join(`../Images/${newName}`);
        }

        zip.file(`OEBPS/Styles/${filename}`, cssText);
      } catch (e) { console.warn(`CSS fetch failed: ${cssFile.path}`, e); }
    }

    // --- Phase 1: Pre-download all manifest images via API (same-origin, no CORS) ---
    const manifestImageMap = {}; // normalized path -> ZIP filename
    const imageMap = {};         // original src -> ZIP filename (for path rewriting)
    let downloadedImageCount = 0;

    console.log(`Pre-downloading ${imageFiles.length} images from manifest...`);
    for (let i = 0; i < imageFiles.length; i += 2) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (i > 0) await new Promise(r => setTimeout(r, 500));

      const batch = imageFiles.slice(i, i + 2);
      await Promise.all(batch.map(async (imgFile) => {
        const normalizedPath = PathUtils.normalizePath(imgFile.path);
        const rawFilename = Fetcher.stripQueryAndHash(normalizedPath.split('/').pop());
        const imgFilename = uniqueFilename(rawFilename);
        try {
          const res = await Fetcher._fetchWithRetry(imgFile.url, { signal });
          zip.file(`OEBPS/Images/${imgFilename}`, await res.arrayBuffer());
          manifestImageMap[normalizedPath] = imgFilename;
          downloadedImageCount++;
        } catch (e) {
          console.warn(`Manifest image fetch failed: ${imgFile.path}`, e);
        }
      }));

      chrome.runtime.sendMessage({
        action: 'progress',
        chapter: 0,
        totalChapters,
        images: downloadedImageCount,
        totalImages: imageFiles.length,
      });
    }
    console.log(`Pre-downloaded ${downloadedImageCount}/${imageFiles.length} manifest images`);

    // --- Phase 2: Process chapters and handle inline images ---
    const chapters = [];
    let completedChapters = 0;

    for (let i = 0; i < chapterFiles.length; i += 2) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // Throttle: wait 1s between batches to avoid 403 rate limiting
      if (i > 0) await new Promise(r => setTimeout(r, 1000));

      const batch = chapterFiles.slice(i, i + 2);
      const batchContents = await Promise.all(
        batch.map(async (chapterFile) => {
          try {
            const res = await Fetcher._fetchWithRetry(chapterFile.url, { signal });
            return await res.text();
          } catch (err) {
            if (err.name === 'AbortError' || err.message === 'SESSION_EXPIRED') throw err;
            console.warn(`Chapter fetch failed: ${chapterFile.path}`, err);
            return null;
          }
        })
      );

      for (let j = 0; j < batch.length; j++) {
        const chapterOriginalPath = batch[j].path;
        const chapterNum = i + j + 1;
        const filename = `chapter_${String(chapterNum).padStart(2, '0')}.xhtml`;

        let xhtml = batchContents[j];
        if (xhtml === null) {
          const placeholder = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>Chapter ${chapterNum}</title></head>
<body><p><em>Chapter ${chapterNum} could not be downloaded.</em></p></body>
</html>`;
          zip.file(`OEBPS/Text/${filename}`, placeholder);
          chapters.push({ filename, title: `Chapter ${chapterNum} (unavailable)` });
          completedChapters++;
          continue;
        }

        const doc = Fetcher.parseXhtml(xhtml);
        const h1 = doc.querySelector('h1');
        const titleEl = doc.querySelector('title');
        const chapterTitle = h1 ? h1.textContent.trim()
          : titleEl ? titleEl.textContent.trim()
          : `Chapter ${chapterNum}`;

        // Extract image URLs from chapter HTML
        const imgUrls = Fetcher.extractImageUrls(xhtml);
        const chapterImageMap = {};

        for (const imgSrc of imgUrls) {
          // Skip if already resolved in a previous chapter
          if (imageMap[imgSrc]) {
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          const { resolved, isAbsolute } = PathUtils.resolveImagePath(imgSrc, chapterOriginalPath);
          const normalizedResolved = PathUtils.normalizePath(resolved);

          // Strategy 1: Match against pre-downloaded manifest images
          if (manifestImageMap[normalizedResolved]) {
            imageMap[imgSrc] = manifestImageMap[normalizedResolved];
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          // Strategy 2: Match by filename against manifest (fallback for path differences)
          const srcFilename = imgSrc.split('/').pop().split('?')[0];
          const manifestMatch = Object.entries(manifestImageMap).find(
            ([path]) => path.split('/').pop() === srcFilename
          );
          if (manifestMatch) {
            imageMap[imgSrc] = manifestMatch[1];
            chapterImageMap[imgSrc] = imageMap[imgSrc];
            continue;
          }

          // Strategy 3: Fetch via O'Reilly API path (same-origin, relative URLs only)
          const cleanFilename = Fetcher.stripQueryAndHash(srcFilename);
          const imgFilename = uniqueFilename(`ch${String(chapterNum).padStart(2, '0')}_${cleanFilename}`);
          if (!isAbsolute) {
            const cleanResolved = Fetcher.stripQueryAndHash(normalizedResolved);
            const apiUrl = `/api/v2/epubs/urn:orm:book:${isbn}/files/${cleanResolved}`;
            try {
              const imgRes = await Fetcher._fetchWithRetry(apiUrl, { signal });
              zip.file(`OEBPS/Images/${imgFilename}`, await imgRes.arrayBuffer());
              imageMap[imgSrc] = imgFilename;
              chapterImageMap[imgSrc] = imgFilename;
              downloadedImageCount++;
              continue;
            } catch (e) {
              console.warn(`API image fetch failed: ${apiUrl}`, e);
            }
          }

          // Strategy 4: Fetch absolute URL via background SW (CORS proxy)
          // Only for absolute URLs — relative paths that failed Strategy 3 cannot be fetched this way
          if (isAbsolute) {
            try {
              const buffer = await fetchImageViaBackground(resolved);
              zip.file(`OEBPS/Images/${imgFilename}`, buffer);
              imageMap[imgSrc] = imgFilename;
              chapterImageMap[imgSrc] = imgFilename;
              downloadedImageCount++;
            } catch (e) {
              console.warn(`Image fetch failed (all strategies): ${imgSrc}`, e);
            }
          } else {
            console.warn(`Image not found in manifest or API: ${imgSrc}`);
          }
        }

        xhtml = EinkOptimizer.processChapter(xhtml, chapterImageMap);
        zip.file(`OEBPS/Text/${filename}`, xhtml);
        chapters.push({ filename, title: chapterTitle });

        completedChapters++;
        chrome.runtime.sendMessage({
          action: 'progress',
          chapter: completedChapters,
          totalChapters,
          images: downloadedImageCount,
          totalImages: imageFiles.length,
        });
      }
    }

    const meta = await fetchBookMetadata(isbn);
    const bookTitle = meta.title;
    const authors = meta.authors || ['Unknown Author'];

    const metadata = {
      title: bookTitle, authors, isbn,
      language: 'en',
      modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };

    const allCssFiles = [...cssFilenames, 'eink-override.css'];
    // Declare every image written into the ZIP: pre-downloaded manifest
    // images, CSS background images, and chapter-referenced images. Anything
    // in the ZIP but missing from the OPF manifest makes the EPUB invalid.
    const allImageFiles = [...new Set([
      ...Object.values(manifestImageMap),
      ...Object.values(cssImageMap),
      ...Object.values(imageMap),
    ])];

    const coverImage = EpubBuilder.findCoverImage(allImageFiles);
    if (coverImage) {
      zip.file('OEBPS/Text/cover.xhtml', EpubBuilder.generateCoverXhtml(bookTitle, coverImage));
      chapters.unshift({ filename: 'cover.xhtml', title: 'Cover' });
    }

    zip.file('OEBPS/content.opf', EpubBuilder.generateOpf(metadata, chapters, allImageFiles, allCssFiles, coverImage));
    zip.file('OEBPS/toc.xhtml', EpubBuilder.generateTocXhtml(metadata.title, chapters));
    zip.file('OEBPS/toc.ncx', EpubBuilder.generateTocNcx(isbn, metadata.title, chapters));

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    const url = URL.createObjectURL(blob);
    const sanitizedTitle = bookTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizedTitle}.epub`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    chrome.runtime.sendMessage({ action: 'downloadComplete' });
  }

  detectBook();
})();
