// DOM -> Markdown converter tuned for the Tailwind/Radix pages of the learning hub.
globalThis.BuckeyeMarkdown = (function () {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'SVG', 'CANVAS', 'PATH',
  ]);

  const HEADING_LEVEL = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
    'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'VIDEO', 'AUDIO', 'IFRAME',
  ]);

  const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',').toLowerCase();

  function isChecked(el) {
    return el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked';
  }

  function isSkipped(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute('data-md-consumed')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('role') === 'tooltip') return true;
    return false;
  }

  function isBlock(el) {
    if (BLOCK_TAGS.has(el.tagName)) return true;
    return !!el.querySelector(BLOCK_SELECTOR);
  }

  function escapeText(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/([`*])/g, '\\$1')
      .replace(/([[\]])/g, '\\$1')
      .replace(/(^|[\s(])_/g, '$1\\_')
      .replace(/_($|[\s).,;:!?])/g, '\\_$1');
  }

  // Stops a paragraph from accidentally becoming a heading / list / quote.
  function escapeLineStarts(text) {
    return text.replace(/^(\s*)(#{1,6}\s|[-+]\s|\d+\.\s|>\s|\|)/gm, '$1\\$2');
  }

  function collapse(text) {
    return text
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function wrapEmphasis(inner, mark) {
    if (!inner.trim()) return inner.trim();
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return `${match[1]}${mark}${match[2]}${mark}${match[3]}`;
  }

  function absolute(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  function createContext(options) {
    return {
      baseUrl: options.baseUrl || location.href,
      media: [],
      links: [],
      features: new Set(),
    };
  }

  /* ------------------------------- inline ------------------------------- */

  // Elements the content script marked as flex/grid/inline-block boxes are
  // visually separated from their neighbours even without whitespace in the
  // source, e.g. a numbered badge next to a label. Give them a space.
  function inlineChildren(el, ctx) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += escapeText(node.nodeValue.replace(/\s+/g, ' '));
      } else if (node.nodeType === Node.ELEMENT_NODE && !isSkipped(node)) {
        const rendered = inlineElement(node, ctx);
        out += rendered && node.hasAttribute('data-md-gap') ? ` ${rendered} ` : rendered;
      }
    }
    return out;
  }

  function inlineElement(el, ctx) {
    const tag = el.tagName;
    switch (tag) {
      case 'BR':
        return '\n';
      case 'IMG': {
        const src = absolute(el.getAttribute('src') || '', ctx.baseUrl);
        if (!src) return '';
        ctx.media.push({ type: 'image', url: src });
        ctx.features.add('image');
        return `![${(el.getAttribute('alt') || '').trim()}](${src})`;
      }
      case 'A': {
        const href = el.getAttribute('href');
        const text = collapse(inlineChildren(el, ctx)) || (el.getAttribute('aria-label') || '').trim();
        if (!href || href === '#') return text;
        const url = absolute(href, ctx.baseUrl);
        ctx.links.push(url);
        return text ? `[${text}](${url})` : `<${url}>`;
      }
      case 'STRONG':
      case 'B':
        return wrapEmphasis(inlineChildren(el, ctx), '**');
      case 'EM':
      case 'I':
        return wrapEmphasis(inlineChildren(el, ctx), '*');
      case 'DEL':
      case 'S':
        return wrapEmphasis(inlineChildren(el, ctx), '~~');
      case 'CODE':
      case 'KBD':
      case 'SAMP': {
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        if (!text) return '';
        ctx.features.add('code');
        const ticks = '`'.repeat(Math.max(...[...text.matchAll(/`+/g)].map((m) => m[0].length), 0) + 1);
        return `${ticks}${text}${ticks}`;
      }
      case 'INPUT': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return isChecked(el) ? '[x]' : '[ ]';
        const value = (el.value || '').trim();
        return value ? escapeText(value) : '';
      }
      case 'TEXTAREA': {
        const value = (el.value || '').trim();
        return value ? escapeText(value) : '';
      }
      default:
        return inlineChildren(el, ctx);
    }
  }

  /* ------------------------------- blocks ------------------------------- */

  function blocks(el, ctx) {
    const out = [];
    let buffer = '';
    const flush = () => {
      const text = collapse(buffer);
      buffer = '';
      if (text) out.push(escapeLineStarts(text.split('\n').join('  \n')));
    };

    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += escapeText(node.nodeValue.replace(/\s+/g, ' '));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || isSkipped(node)) continue;

      if (isBlock(node)) {
        flush();
        const rendered = blockElement(node, ctx);
        for (const piece of Array.isArray(rendered) ? rendered : [rendered]) {
          if (piece && piece.trim()) out.push(piece);
        }
      } else {
        const rendered = inlineElement(node, ctx);
        buffer += rendered && node.hasAttribute('data-md-gap') ? ` ${rendered} ` : rendered;
      }
    }
    flush();
    return out;
  }

  function blockElement(el, ctx) {
    const tag = el.tagName;

    if (HEADING_LEVEL[tag]) {
      const text = collapse(inlineChildren(el, ctx)).replace(/\n+/g, ' ');
      return text ? `${'#'.repeat(HEADING_LEVEL[tag])} ${text}` : '';
    }

    switch (tag) {
      case 'HR':
        return '---';
      case 'PRE':
        return codeFence(el, ctx);
      case 'UL':
      case 'OL':
        return renderList(el, ctx, tag === 'OL');
      case 'BLOCKQUOTE':
        return prefixLines(blocks(el, ctx).join('\n\n'), '> ');
      case 'TABLE':
        return renderTable(el, ctx);
      case 'DETAILS': {
        const summary = el.querySelector(':scope > summary');
        const head = summary ? collapse(inlineChildren(summary, ctx)) : '';
        if (summary) summary.setAttribute('data-md-consumed', '1');
        const body = blocks(el, ctx).join('\n\n');
        return [head ? `**${head}**` : '', body].filter(Boolean).join('\n\n');
      }
      // A link wrapping block content (card-style links). Keep the target.
      case 'A': {
        const inner = blocks(el, ctx);
        const href = el.getAttribute('href');
        if (!href || href === '#') return inner;
        const url = absolute(href, ctx.baseUrl);
        ctx.links.push(url);
        if (inner.length === 1 && !inner[0].includes('\n') && !/^(#|[-+*] |\d+\. |>|\||```)/.test(inner[0])) {
          return `[${inner[0]}](${url})`;
        }
        return [...inner, `<${url}>`];
      }
      case 'SUMMARY': {
        const text = collapse(inlineChildren(el, ctx));
        return text ? `**${text}**` : '';
      }
      case 'VIDEO':
      case 'AUDIO': {
        const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
        if (!src) return '';
        const url = absolute(src, ctx.baseUrl);
        const kind = tag === 'VIDEO' ? 'video' : 'audio';
        ctx.media.push({ type: kind, url });
        ctx.features.add(kind);
        return `[${kind === 'video' ? 'Video' : 'Audio'}: ${url.split('/').pop()}](${url})`;
      }
      case 'IFRAME': {
        const src = el.getAttribute('src');
        if (!src) return '';
        const url = absolute(src, ctx.baseUrl);
        ctx.features.add('embed');
        return `[Embedded: ${el.getAttribute('title') || url}](${url})`;
      }
      case 'FIGURE': {
        const caption = el.querySelector(':scope > figcaption');
        if (caption) caption.setAttribute('data-md-caption', '1');
        return blocks(el, ctx);
      }
      case 'FIGCAPTION': {
        const text = collapse(inlineChildren(el, ctx));
        return text ? `*${text}*` : '';
      }
      default:
        return blocks(el, ctx);
    }
  }

  function prefixLines(text, prefix) {
    return text
      .split('\n')
      .map((line) => (line ? prefix + line : prefix.trimEnd()))
      .join('\n');
  }

  function codeFence(pre, ctx) {
    const code = pre.querySelector('code') || pre;
    const className = `${pre.className || ''} ${code.className || ''}`;
    const lang = (/language-([\w-]+)/.exec(className) || [])[1] || '';
    const text = code.textContent.replace(/\s+$/, '');
    if (!text.trim()) return '';
    ctx.features.add('code');
    const longest = Math.max(...[...text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length), 2);
    const fence = '`'.repeat(longest + 1);
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  // A checkbox that belongs to this <li> rather than to a nested list item.
  function ownCheckbox(li) {
    for (const candidate of li.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      if (candidate.closest('li') === li) return candidate;
    }
    return null;
  }

  // Nested lists read better without a blank line separating them.
  function tightenNestedLists(text) {
    return text.replace(/\n\n(?=\s*(?:[-+*]|\d+\.)\s)/g, '\n');
  }

  function renderList(el, ctx, ordered) {
    const items = [...el.children].filter((c) => c.tagName === 'LI' && !isSkipped(c));
    if (!items.length) return '';
    let counter = parseInt(el.getAttribute('start') || '1', 10) || 1;
    const lines = [];

    for (const li of items) {
      let marker = ordered ? `${counter++}. ` : '- ';
      const checkbox = ownCheckbox(li);
      if (checkbox) {
        // Consume it so the inline pass does not emit a second [x].
        checkbox.setAttribute('data-md-consumed', '1');
        marker += isChecked(checkbox) ? '[x] ' : '[ ] ';
      }
      const body = tightenNestedLists(blocks(li, ctx).join('\n\n').trim());
      if (!body) continue;
      const indent = ' '.repeat(marker.length);
      const [first, ...rest] = body.split('\n');
      lines.push(marker + first + (rest.length ? `\n${rest.map((l) => (l ? indent + l : '')).join('\n')}` : ''));
    }
    return lines.join('\n');
  }

  function renderTable(table, ctx) {
    const rows = [...table.querySelectorAll('tr')].filter((r) => !isSkipped(r));
    if (!rows.length) return '';

    const grid = rows.map((row) =>
      [...row.children]
        .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map((cell) => collapse(inlineChildren(cell, ctx)).replace(/\n+/g, ' ').replace(/\|/g, '\\|'))
    );
    const width = Math.max(...grid.map((r) => r.length));
    if (!width) return '';
    const normalized = grid.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill('')]);

    const hasHeader = !!rows[0].querySelector('th');
    const header = hasHeader ? normalized[0] : new Array(width).fill('');
    const body = hasHeader ? normalized.slice(1) : normalized;

    ctx.features.add('table');
    return [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  }

  function tidy(markdown) {
    return `${markdown
      .replace(/[ \t]+$/gm, (m) => (m.length >= 2 ? '  ' : ''))
      .replace(/\n{3,}/g, '\n\n')
      .trim()}\n`;
  }

  /**
   * @param {Element} root  element to convert (usually a detached clone)
   * @param {{baseUrl?: string}} options
   */
  function convert(root, options = {}) {
    const ctx = createContext(options);
    const markdown = tidy(blocks(root, ctx).join('\n\n'));
    return {
      markdown,
      media: dedupeBy(ctx.media, (m) => m.url),
      links: [...new Set(ctx.links)],
      features: [...ctx.features],
    };
  }

  function dedupeBy(list, key) {
    const seen = new Set();
    return list.filter((item) => {
      const k = key(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  return { convert, tidy, slugSafeEscape: escapeText };
})();
