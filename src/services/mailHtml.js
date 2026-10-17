const sanitizeHtml = require('sanitize-html');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function plainTextHtml(text = '') {
  let depth = 0, html = '';
  for (const line of text.split(/\r?\n/)) {
    const quoted = line.match(/^((?:>[ \t]?)+)(.*)$/);
    const nextDepth = quoted ? Math.min(20, (quoted[1].match(/>/g) || []).length) : 0;
    while (depth < nextDepth) { html += '<blockquote style="margin:0 0 0 16px;padding:0">'; depth++; }
    while (depth > nextDepth) { html += '</blockquote>'; depth--; }
    const content = escapeHtml(quoted ? quoted[2] : line);
    html += `<div style="white-space:pre-wrap">${content || '<br />'}</div>`;
  }
  return html + '</blockquote>'.repeat(depth);
}

function contentId(value) {
  try { return decodeURIComponent(value).trim().replace(/^<|>$/g, '').toLowerCase(); }
  catch { return ''; }
}

// Output is only for the sandboxed email document, never the portal's DOM.
// Email styles are retained inside that isolated document; its CSP blocks all
// scripts, forms, nested frames, fonts and external CSS/network resources.
function formatMailBody(parsed, attachments = []) {
  const embedded = new Map(), used = new Set();
  attachments.forEach((item, index) => {
    if (item.contentId && /^data:image\/webp;base64,[a-z\d+/=]+$/i.test(item.preview?.dataUrl || '')) embedded.set(contentId(item.contentId), { index, preview: item.preview });
  });
  let hasRemoteImages = false;
  const source = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : plainTextHtml(parsed.text || '');
  const html = sanitizeHtml(source, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'style', 'font', 'center'],
    allowVulnerableTags: true, // Styles are safe only inside the script-free sandbox.
    allowedAttributes: {
      '*': ['style', 'class', 'dir', 'lang', 'title', 'align', 'width', 'height'],
      a: ['href', 'target', 'rel', 'title', 'style', 'class'],
      img: ['src', 'alt', 'width', 'height', 'style', 'class'],
      table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'style', 'class', 'align'],
      td: ['colspan', 'rowspan', 'width', 'height', 'valign', 'align', 'bgcolor', 'style', 'class'],
      th: ['colspan', 'rowspan', 'width', 'height', 'valign', 'align', 'bgcolor', 'style', 'class'],
      font: ['color', 'face', 'size'], ol: ['start', 'type', 'reversed'], li: ['value'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel', 'data'],
    allowedSchemesByTag: { img: ['https', 'http', 'data'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'iframe', 'object', 'template'],
    transformTags: {
      body: (tagName, attribs) => ({ tagName: 'div', attribs }),
      a: (tagName, attribs) => {
        const href = (attribs.href || '').trim();
        return { tagName, attribs: { ...attribs, href: /^(?:https?:\/\/|mailto:|tel:)/i.test(href) ? href : '', target: '_blank', rel: 'noopener noreferrer' } };
      },
      img: (tagName, attribs) => {
        const src = (attribs.src || '').trim();
        if (/^cid:/i.test(src)) {
          const image = embedded.get(contentId(src.slice(4)));
          if (image) { used.add(image.index); return { tagName, attribs: { ...attribs, src: image.preview.dataUrl } }; }
        } else if (/^https?:\/\//i.test(src)) {
          hasRemoteImages = true;
          return { tagName, attribs: { ...attribs, src } };
        }
        return { tagName, attribs: { alt: attribs.alt || 'Image unavailable' } };
      },
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
  });
  // This also catches remote background images in retained sender styles.
  hasRemoteImages ||= /url\(\s*['"]?(?:https?:)?\/\//i.test(html);
  return { html, hasRemoteImages, attachments: attachments.map((item, index) => ({ ...item, renderedInline: used.has(index) })) };
}

module.exports = { formatMailBody, plainTextHtml };
