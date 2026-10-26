// Small helpers shared by the content script, the service worker and the
// markdown converter.
globalThis.BuckeyeDom = (function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, { timeout = 15000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value;
      try {
        value = await predicate();
      } catch {
        value = false;
      }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  // Resolves once the subtree has stopped mutating for `quiet` ms.
  function settle(target, { quiet = 400, timeout = 8000 } = {}) {
    return new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      const hardStop = setTimeout(done, timeout);
      function done() {
        clearTimeout(timer);
        clearTimeout(hardStop);
        observer.disconnect();
        resolve();
      }
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(done, quiet);
    });
  }

  const DIACRITICS = /[\u0300-\u036f]/g;

  // ASCII-only identifier, used for tags in front matter and URL-ish places.
  function slug(text, max = 64) {
    const base = String(text || '')
      .normalize('NFKD')
      .replace(DIACRITICS, '')
      .replace(/[’'"]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return (base || 'untitled').slice(0, max).replace(/-+$/g, '') || 'untitled';
  }

  const pad = (n, width = 2) => String(n).padStart(width, '0');

  // Characters Windows/Chrome refuse in file names, swapped for look-alikes so
  // the sidebar's tag names survive as folder/file names (emoji included).
  const LOOKALIKES = {
    '<': '‹', '>': '›', ':': '：', '"': '”', '/': '⁄', '\\': '⁄', '|': '｜', '?': '？', '*': '✱',
  };
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function safeName(text, max = 120) {
    let name = String(text || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[<>:"/\\|?*]/g, (c) => LOOKALIKES[c])
      .trim()
      .replace(/[. ]+$/g, '');
    if (RESERVED.test(name)) name = `_${name}`;
    name = name.slice(0, max).trim().replace(/[. ]+$/g, '');
    return name || 'untitled';
  }

  // A whole relative path made download-safe, one segment at a time.
  function sanitizePath(path) {
    return String(path)
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => safeName(seg))
      .join('/');
  }

  // Relative path from one file to another, both archive-root relative.
  function relativePath(fromFile, toFile) {
    const from = fromFile.split('/').slice(0, -1);
    const to = toFile.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = new Array(from.length - i).fill('..');
    const down = to.slice(i);
    return [...up, ...down].join('/') || to[to.length - 1];
  }

  // Markdown link targets cannot contain spaces or parentheses unescaped.
  function linkHref(path) {
    return path.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  return { sleep, waitFor, settle, slug, pad, safeName, sanitizePath, relativePath, linkHref };
})();
