const EinkOptimizer = {
  // Namespaces for attribute prefixes that legitimately appear in O'Reilly
  // chapter markup but arrive UNBOUND through Fetcher.parseXhtml's text/html
  // fallback: the HTML parser stores e.g. epub:type as a plain attribute
  // whose name contains a colon and whose namespaceURI is null, and
  // XMLSerializer emits it verbatim with no declaration — making the packaged
  // chapter non-well-formed XML ("Attribute epub:type prefix is unbound").
  // Newer O'Reilly books use epub:type structural semantics on nearly every
  // section, so without repair the validator flags nearly every chapter.
  KNOWN_ATTR_PREFIX_NS: {
    epub: 'http://www.idpf.org/2007/ops',
    xlink: 'http://www.w3.org/1999/xlink',
  },

  // Make colon-named, namespace-less attributes serializable: bind known
  // prefixes by declaring them on the root (a literal xmlns:* attribute
  // serializes into exactly the declaration a strict reparse needs), and
  // strip unknown ones (there is nothing meaningful to bind them to, and an
  // unbound prefix would fail every conforming XML parser downstream).
  fixUnboundAttrPrefixes(doc) {
    const root = doc.documentElement;
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.namespaceURI !== null) continue; // properly bound already
        const colon = attr.name.indexOf(':');
        if (colon <= 0) continue;
        const prefix = attr.name.slice(0, colon);
        // xml: is implicitly bound in XML; xmlns: IS a declaration
        if (prefix === 'xml' || prefix === 'xmlns') continue;
        const ns = this.KNOWN_ATTR_PREFIX_NS[prefix];
        if (ns) {
          if (!root.hasAttribute('xmlns:' + prefix)) {
            root.setAttribute('xmlns:' + prefix, ns);
          }
        } else {
          el.removeAttribute(attr.name);
        }
      }
    }
  },

  injectOverrideCss(doc) {
    const head = doc.querySelector('head');
    if (head) {
      const link = doc.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('type', 'text/css');
      link.setAttribute('href', '../Styles/eink-override.css');
      head.appendChild(link);
    }
  },

  rewriteImagePaths(doc, imageMap) {
    // Rewrite <img src="...">
    doc.querySelectorAll('img[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (imageMap[src]) {
        el.setAttribute('src', `../Images/${imageMap[src]}`);
      }
    });

    // Rewrite <image href="..."> and <image xlink:href="..."> (SVG)
    doc.querySelectorAll('image').forEach(el => {
      const href = el.getAttribute('href');
      if (href && imageMap[href]) {
        el.setAttribute('href', `../Images/${imageMap[href]}`);
      }
      const xlinkNs = 'http://www.w3.org/1999/xlink';
      const xhref = el.getAttributeNS(xlinkNs, 'href');
      if (xhref && imageMap[xhref]) {
        el.setAttributeNS(xlinkNs, 'xlink:href', `../Images/${imageMap[xhref]}`);
      }
    });

    // Rewrite <object data="...">
    doc.querySelectorAll('object[data]').forEach(el => {
      const data = el.getAttribute('data');
      if (data && imageMap[data]) {
        el.setAttribute('data', `../Images/${imageMap[data]}`);
      }
    });
  },

  rewriteCssLinks(doc) {
    doc.querySelectorAll('link[href$=".css"]').forEach(el => {
      const href = el.getAttribute('href');
      const filename = href.split('/').pop();
      el.setAttribute('href', `../Styles/${filename}`);
    });
  },

  // Process a chapter: rewrite paths in DOM, serialize back to string
  processChapter(xhtml, imageMap) {
    const doc = Fetcher.parseXhtml(xhtml);

    // Remove O'Reilly reader-specific wrapper divs
    doc.querySelectorAll('div.readable-text.intended-text').forEach(el => el.remove());

    this.rewriteCssLinks(doc);
    this.rewriteImagePaths(doc, imageMap);
    this.injectOverrideCss(doc);
    this.fixUnboundAttrPrefixes(doc);

    if (!doc.documentElement.getAttribute('xmlns')) {
      doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    }

    const serializer = new XMLSerializer();
    let result = serializer.serializeToString(doc.documentElement);

    // Ensure XML declaration is present
    if (!result.startsWith('<?xml')) {
      result = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' + result;
    } else {
      // If it has XML declaration, make sure it has DOCTYPE
      if (!result.includes('<!DOCTYPE html>')) {
        result = result.replace(/^<\?xml[^>]+>\s*/i, '$&\n<!DOCTYPE html>\n');
      }
    }
    return result;
  },
};
