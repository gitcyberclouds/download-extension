// Runs on the learning hub. Discovers the sidebar tree, walks every page and
// streams Markdown back to the service worker, filed by sidebar tag name.
(function () {
  if (globalThis.__buckeyeExporterLoaded) return;
  globalThis.__buckeyeExporterLoaded = true;

  const { sleep, waitFor, settle, slug, pad, safeName, relativePath, linkHref } = globalThis.BuckeyeDom;
  const MD = globalThis.BuckeyeMarkdown;

  const SIDEBAR = '[data-sidebar="content"]';
  const GROUP = '[data-sidebar="group"]';
  // Sidebar entries are links (<a href>) or, for collapsible parents such as
  // "Tasking Guide", buttons that carry the page path in data-tour-path and
  // only render their children once expanded.
  const MENU_HEAD = '[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]';
  const MENU_LINK = 'a[data-sidebar="menu-button"][href], a[data-sidebar="menu-sub-button"][href]';
  const MENU_ITEM = 'li';
  const TOUR_ATTRS = ['data-tour-path', 'data-path', 'data-href'];
  const MAX_ATTEMPTS = 3;
  const UNLISTED = '_unlisted';

  let crawling = false;

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);
  const getState = () => send({ type: 'GET_STATE' });
  const setState = (state) => send({ type: 'SET_STATE', state });
  const log = (message) => {
    console.log('[Hub Exporter]', message);
    return send({ type: 'LOG', message });
  };

  const currentPath = () => location.pathname.replace(/\/+$/, '') || '/';
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();

  function pathOf(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return null;
      return url.pathname.replace(/\/+$/, '') || '/';
    } catch {
      return null;
    }
  }

  function siteName() {
    const title = clean(document.title).split(/\s[|·—-]\s/)[0];
    return safeName(title) || safeName(location.hostname.split('.')[0]) || 'Learning-Hub';
  }

  /* --------------------------- sidebar discovery -------------------------- */

  function linkTitle(head) {
    const label = head.querySelector('span.flex-1') || head.querySelector('span');
    return clean(label?.textContent || head.textContent);
  }

  function headPath(head) {
    if (head.tagName === 'A') return pathOf(head.getAttribute('href'));
    for (const attr of TOUR_ATTRS) {
      const value = head.getAttribute(attr);
      if (value) return pathOf(value);
    }
    return null;
  }

  // The menu button that labels a list item (not one of its descendants').
  function itemHead(item) {
    for (const head of item.querySelectorAll(MENU_HEAD)) {
      if (head.closest(MENU_ITEM) === item) return head;
    }
    return null;
  }

  const isCollapsible = (head) => head.tagName !== 'A' && head.hasAttribute('aria-expanded');

  // Group headings are sometimes buttons (collapsible groups) and sometimes a
  // plain uppercase <div>; the first group may have no heading at all.
  function groupLabel(group) {
    const button = group.querySelector('[data-sidebar="group-label"]');
    if (button) return clean(button.textContent);
    for (const child of group.children) {
      if (child.matches('[data-sidebar="group-content"]') || child.querySelector(MENU_HEAD)) continue;
      const text = clean(child.textContent);
      if (text) return text;
    }
    return 'General';
  }

  // A section heading inside a menu: a text-only block outside any list item,
  // e.g. <div class="uppercase">Fellow Guide</div>.
  function isSectionLabel(el) {
    if (el.matches('[data-sidebar="group-label"]')) return true;
    if (el.closest(MENU_ITEM) || el.matches(MENU_HEAD) || el.querySelector(`${MENU_ITEM}, ${MENU_HEAD}, input, button`)) return false;
    if (!clean(el.textContent)) return false;
    return ![...el.children].some((child) => clean(child.textContent));
  }

  function collectSidebarPages() {
    const root = document.querySelector(SIDEBAR);
    if (!root) return [];

    let groups = [...root.querySelectorAll(GROUP)].filter((g) => !g.parentElement.closest(GROUP));
    if (!groups.length) groups = [root];

    const pages = [];
    const seen = new Set();
    let sectionOrder = 0;

    for (const group of groups) {
      let section = groupLabel(group);
      let counted = false;

      for (const el of group.querySelectorAll('*')) {
        if (isSectionLabel(el)) {
          const label = clean(el.textContent);
          if (label !== section || !counted) {
            section = label;
            sectionOrder++;
            counted = true;
          }
          continue;
        }
        if (!el.matches(MENU_HEAD)) continue;

        const path = headPath(el);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        if (!counted) {
          sectionOrder++;
          counted = true;
        }

        const item = el.closest(MENU_ITEM);
        const ancestors = [];
        let above = item?.parentElement?.closest(MENU_ITEM);
        while (above && root.contains(above)) {
          const head = itemHead(above);
          if (head) ancestors.unshift({ title: linkTitle(head), path: headPath(head) });
          above = above.parentElement?.closest(MENU_ITEM);
        }

        // Collapsed parents show a chevron or aria-expanded and hide their
        // children; expanded ones have nested items.
        const hasNested = !!item && [...item.querySelectorAll(MENU_HEAD)].some((h) => h !== el);
        const hasChevron = !!el.querySelector('svg[class*="chevron"]');

        pages.push({
          path,
          title: linkTitle(el) || path,
          section,
          sectionOrder,
          ancestors,
          isParent: hasNested || hasChevron || isCollapsible(el),
          collapsible: isCollapsible(el),
          read: !!el.querySelector('svg[aria-label="Read"]'),
          origin: 'sidebar',
        });
      }
    }

    // Children rendered outside their parent's <li> are nested by URL:
    // /getting-help/slack belongs under the collapsible "Getting help".
    const parents = pages.filter((p) => p.collapsible);
    for (const page of pages) {
      if (page.ancestors.length) continue;
      let best = null;
      for (const parent of parents) {
        if (parent !== page && page.path.startsWith(`${parent.path}/`) && (!best || parent.path.length > best.path.length)) best = parent;
      }
      if (best && !best.ancestors.some((a) => a.path === page.path)) {
        page.ancestors = [...best.ancestors, { title: best.title, path: best.path }];
      }
    }

    return pages.map(({ ancestors, collapsible, ...page }) => ({
      ...page,
      depth: ancestors.length,
      parent: ancestors.length ? ancestors[ancestors.length - 1].title : null,
      parentPath: ancestors.length ? ancestors[ancestors.length - 1].path : null,
      ancestors: ancestors.map((a) => a.title),
      ancestorPaths: ancestors.map((a) => a.path),
    }));
  }

  // Adds pages from `found` that `list` lacks, each right after the nearest
  // earlier page of `found` that `list` already has (so children land after
  // their parent). Updates parent flags/ancestry of pages not yet exported.
  // Returns the number of pages added.
  function mergePages(list, found, minIndex = 0) {
    const known = new Map(list.map((p) => [p.path, p]));
    let added = 0;
    found.forEach((page, i) => {
      const existing = known.get(page.path);
      if (existing) {
        if (!existing.done) {
          if (page.isParent) existing.isParent = true;
          if (page.depth > (existing.depth || 0) && existing.origin !== 'pager') {
            Object.assign(existing, {
              depth: page.depth, parent: page.parent, parentPath: page.parentPath,
              ancestors: page.ancestors, ancestorPaths: page.ancestorPaths,
            });
          }
        }
        return;
      }
      let insertAt = list.length;
      for (let j = i - 1; j >= 0; j--) {
        const idx = list.findIndex((p) => p.path === found[j].path);
        if (idx >= 0) {
          insertAt = idx + 1;
          while (insertAt < list.length && (list[insertAt].ancestorPaths || []).includes(found[j].path)) insertAt++;
          break;
        }
      }
      if (insertAt < minIndex) insertAt = minIndex;
      list.splice(insertAt, 0, page);
      known.set(page.path, page);
      added++;
    });
    return added;
  }

  function skipList(options) {
    return String(options.skipSections || '')
      .split(/[,\n;]/)
      .map((s) => clean(s).toLowerCase())
      .filter(Boolean);
  }

  function isSkipped(page, options) {
    const skip = skipList(options);
    if (!skip.length) return false;
    const names = [page.section, page.title, ...(page.ancestors || [])].map((n) => clean(n).toLowerCase());
    return names.some((name) => skip.includes(name));
  }

  const headCount = (item) => (item ? item.querySelectorAll(MENU_HEAD).length : 0);
  const TOGGLE = `${MENU_ITEM} button[aria-expanded="false"], ${MENU_ITEM} button[aria-label^="Expand"]`;

  // Expands every collapsed parent and returns the union of the pages seen
  // along the way. The sidebar is re-read after each click because some
  // accordions close one group when another opens; for the same reason nested
  // collapsibles are opened right after their parent, before moving on.
  // Clicking a chevron inside a link may navigate to that page, which is
  // fine — the crawl navigates anyway.
  async function discoverSidebar(maxPasses = 6) {
    const root = document.querySelector(SIDEBAR);
    const pages = collectSidebarPages();
    if (!root) return pages;
    const tried = new Set();
    const absorb = () => mergePages(pages, collectSidebarPages());

    async function expand(button, levels) {
      const key = headPath(button) || linkTitle(button);
      if (tried.has(key) || !button.isConnected || button.getAttribute('aria-haspopup')) return 0;
      tried.add(key);
      const item = button.closest(MENU_ITEM);
      const scope = item.parentElement || item;
      const before = headCount(scope);
      button.click();
      await waitFor(() => button.getAttribute('aria-expanded') === 'true' && headCount(scope) > before, { timeout: 1500, interval: 60 });
      await sleep(80);
      absorb();
      let clicks = 1;
      if (levels > 0) {
        for (const inner of item.querySelectorAll(TOGGLE)) if (inner !== button) clicks += await expand(inner, levels - 1);
      }
      return clicks;
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      let clicks = 0;

      for (const button of root.querySelectorAll('button[data-sidebar="group-label"][aria-expanded="false"]')) {
        button.click();
        clicks++;
        await sleep(70);
      }
      absorb();

      for (const button of [...root.querySelectorAll(TOGGLE)]) clicks += await expand(button, 5);

      for (const chevron of root.querySelectorAll(`${MENU_LINK} svg[class*="chevron"]`)) {
        const item = chevron.closest(MENU_ITEM);
        if (!item || !item.isConnected || headCount(item) > 1) continue;
        const key = pathOf(chevron.closest('a').getAttribute('href'));
        if (tried.has(key)) continue;
        tried.add(key);
        const before = location.href;
        chevron.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        clicks++;
        await sleep(150);
        if (location.href !== before) await sleep(700);
        absorb();
      }

      if (!clicks) break;
      await sleep(250);
      absorb();
    }
    return pages;
  }

  /* ------------------------------ file plan ------------------------------- */

  // 1-based position among pages that share the same parent (sidebar order).
  function siblingIndex(page, queue) {
    let n = 0;
    for (const other of queue) {
      if (other.origin === 'pager') continue;
      if ((other.parentPath || null) !== (page.parentPath || null)) continue;
      n++;
      if (other === page) return n;
    }
    return n || 1;
  }

  function displayName(page, state) {
    const name = safeName(page.title);
    return state.options.numbered ? `${pad(siblingIndex(page, state.queue))} ${name}` : name;
  }

  // Folder = tag name. A page with children lives inside its own folder next
  // to them; a leaf is a single .md in its parent's folder.
  function planFile(page, state) {
    if (page.done) return;
    const byPath = new Map(state.queue.map((p) => [p.path, p]));
    const parts = [state.folder];

    if (page.origin === 'pager') {
      parts.push(UNLISTED);
    } else {
      for (const ancestorPath of page.ancestorPaths || []) {
        const ancestor = byPath.get(ancestorPath);
        parts.push(ancestor ? displayName(ancestor, state) : safeName(page.ancestors[parts.length - 1] || 'untitled'));
      }
      const hasChildren = page.isParent || state.queue.some((p) => p.parentPath === page.path);
      if (hasChildren) parts.push(displayName(page, state));
    }

    page.dir = parts.join('/');
    page.file = `${page.dir}/${displayName(page, state)}.md`;
  }

  function planAll(state) {
    for (const page of state.queue) planFile(page, state);
  }

  function pageTags(page) {
    const tags = [page.section, ...(page.ancestors || []), page.title].map(clean).filter(Boolean);
    return [...new Set(tags)];
  }

  // Sidebar re-scan after arriving on a page: collapsed groups usually open
  // when their page is active, which is when hidden children first appear.
  // Read-only — clicking a collapsible here could navigate away from the page
  // about to be extracted. On a parent page, in-content links below the
  // parent's path are children too (covers hubs whose sidebar never lists them).
  async function mergeDiscovered(state, page = null) {
    const found = collectSidebarPages().filter((p) => !isSkipped(p, state.options));
    if (page?.isParent && page.origin !== 'pager') found.push(...childLinksInContent(page, found, state));
    const added = mergePages(state.queue, found, state.index + 1);
    planAll(state);
    return added;
  }

  function childLinksInContent(page, found, state) {
    const main = document.querySelector('main');
    if (!main) return [];
    const known = new Set([...state.queue, ...found].map((p) => p.path));
    const children = [];
    for (const anchor of main.querySelectorAll('a[href]')) {
      const path = pathOf(anchor.getAttribute('href'));
      if (!path || known.has(path) || !path.startsWith(`${page.path}/`)) continue;
      known.add(path);
      const child = {
        path,
        title: clean(anchor.textContent) || path.split('/').pop(),
        section: page.section,
        sectionOrder: page.sectionOrder,
        depth: (page.depth || 0) + 1,
        parent: page.title,
        parentPath: page.path,
        ancestors: [...(page.ancestors || []), page.title],
        ancestorPaths: [...(page.ancestorPaths || []), page.path],
        isParent: false,
        read: false,
        origin: 'content',
      };
      if (!isSkipped(child, state.options)) children.push(child);
    }
    // Anchored after the parent so they queue right behind it.
    return children.length ? [{ ...page }, ...children] : [];
  }

  /* ------------------------------ navigation ------------------------------ */

  const mainText = () => (document.querySelector('main')?.innerText || '').trim();

  function fingerprint() {
    const main = document.querySelector('main');
    const h1 = clean(main?.querySelector('h1')?.textContent);
    return `${h1}|${mainText().slice(0, 400)}`;
  }

  function findSidebarHead(path) {
    for (const head of document.querySelectorAll(`${SIDEBAR} ${MENU_HEAD.split(', ').join(`, ${SIDEBAR} `)}`)) {
      if (headPath(head) === path) return head;
    }
    return null;
  }

  // Returns { ok, moved }. ok=false means a full reload is in flight and this
  // script instance is about to be torn down; the crawl resumes on load.
  async function navigateTo(path) {
    if (currentPath() === path) return { ok: true, moved: false };
    const before = fingerprint();

    // Links navigate; a collapsible button may navigate as it expands, but
    // clicking an open one would only collapse it.
    const head = findSidebarHead(path);
    if (head && (head.tagName === 'A' || head.getAttribute('aria-expanded') === 'false')) {
      head.click();
      if (await waitFor(() => currentPath() === path, { timeout: head.tagName === 'A' ? 5000 : 2000, interval: 80 })) return { ok: true, moved: true };
    }

    // The link is inside a collapsed group: ask the SPA router directly.
    try {
      history.pushState({}, '', path);
      dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      const changed = await waitFor(() => fingerprint() !== before, { timeout: 5000, interval: 100 });
      if (changed) return { ok: true, moved: true };
    } catch {
      /* fall through to a real navigation */
    }

    log(`Full reload for ${path}`);
    const state = await getState();
    if (state?.running) await setState({ ...state, reloadTarget: path });
    location.assign(location.origin + path);
    await sleep(15000);
    return { ok: false, moved: true };
  }

  /* ------------------------------ extraction ------------------------------ */

  const NOISE_SELECTORS = [
    '[aria-hidden="true"]',
    'script', 'style', 'noscript', 'template', 'svg',
    '[data-radix-popper-content-wrapper]',
    '[role="tooltip"]',
    '[data-sonner-toaster]',
    'plasmo-csui',
    '[hidden]',
    '[style*="display: none"]',
    '[style*="display:none"]',
  ];

  const GAP_DISPLAY = /^(block|flex|inline-flex|grid|inline-grid|inline-block|table|list-item)$/;

  // Clones <main> while dropping anything the browser is not actually showing
  // (inline display:none, hidden via CSS classes) and marking boxes that are
  // visually separated so the converter can put a space between them.
  function cloneVisible(root) {
    const clone = root.cloneNode(true);
    const live = root.querySelectorAll('*');
    const copy = clone.querySelectorAll('*');
    const doomed = [];
    for (let i = 0; i < live.length && i < copy.length; i++) {
      const style = getComputedStyle(live[i]);
      if (style.display === 'none' || style.visibility === 'hidden') {
        doomed.push(copy[i]);
      } else if (GAP_DISPLAY.test(style.display)) {
        copy[i].setAttribute('data-md-gap', '1');
      }
    }
    for (const node of doomed) node.remove();
    return clone;
  }

  // Opens accordions / collapsibles so their text is captured. Restricted to
  // disclosure widgets; menus, comboboxes and other controls are left alone.
  async function expandInPageSections(main, maxPasses = 6) {
    for (let pass = 0; pass < maxPasses; pass++) {
      const triggers = [...main.querySelectorAll('[aria-expanded="false"]')].filter((el) => {
        if (el.getAttribute('aria-haspopup') || el.getAttribute('role') === 'combobox') return false;
        if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
        return el.getAttribute('data-state') === 'closed' || el.hasAttribute('aria-controls');
      });
      const details = [...main.querySelectorAll('details:not([open])')];
      if (!triggers.length && !details.length) break;

      for (const trigger of triggers) {
        trigger.click();
        await sleep(60);
      }
      for (const node of details) node.open = true;
      await sleep(200);
    }
  }

  const PAGER_WORD = /^(previous|prev|next|back|forward)$/i;
  const PAGER_WORDS_G = /(previous|prev|next|back|forward)/gi;
  const PAGER_LABEL = /^(previous|prev|next)\b\s*:?\s*/i;

  // Finds the Previous/Next controls, records where they point, and removes
  // the whole pager block from the clone (whether it is a <nav> or a <div>).
  function extractPager(clone) {
    const links = {};
    const controls = [...clone.querySelectorAll('a, button')].filter((el) => {
      const text = clean(el.textContent);
      const label = el.getAttribute('aria-label') || '';
      return PAGER_WORD.test(text) || PAGER_LABEL.test(label);
    });

    for (const el of controls) {
      const text = clean(el.textContent);
      const label = el.getAttribute('aria-label') || '';
      const kind = /^(prev|back)/i.test(text) || /^prev/i.test(label) ? 'previous' : 'next';
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      const path = href ? pathOf(href) : null;
      if (path) {
        const title = PAGER_LABEL.test(label) ? clean(label.replace(PAGER_LABEL, '')) : PAGER_WORD.test(text) ? clean(label) : text;
        links[kind] = { path, title };
      }
    }

    // True when nothing but Previous/Next words (and punctuation) is left,
    // even when they are run together like "PreviousNext".
    const onlyPagerText = (el) => {
      const text = clean(el.textContent);
      return text.length > 0 && text.replace(PAGER_WORDS_G, '').replace(/[^\p{L}\p{N}]+/gu, '') === '';
    };
    for (const el of controls) {
      if (!clone.contains(el)) continue; // already removed with a sibling
      let top = el;
      while (top.parentElement && top.parentElement !== clone && onlyPagerText(top.parentElement)) top = top.parentElement;
      if (top === el && !onlyPagerText(el)) {
        // A "Next: Title" link carrying the title text; remove just the link.
        el.remove();
      } else {
        top.remove();
      }
    }
    for (const nav of clone.querySelectorAll('nav')) {
      if (nav.querySelector('a[aria-label^="Previous"], a[aria-label^="Next"]') || onlyPagerText(nav)) nav.remove();
    }
    return links;
  }

  function cleanClone(clone) {
    for (const selector of NOISE_SELECTORS) {
      for (const node of clone.querySelectorAll(selector)) node.remove();
    }
    return clone;
  }

  function yamlString(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function frontMatter(page, extra) {
    const lines = [
      '---',
      `title: ${yamlString(page.title)}`,
      `heading: ${yamlString(extra.heading || page.title)}`,
      `path: ${yamlString(page.path)}`,
      `url: ${yamlString(location.origin + page.path)}`,
      `section: ${yamlString(page.section)}`,
      `depth: ${page.depth}`,
      `parent: ${page.parent ? yamlString(page.parent) : 'null'}`,
      'tags:',
      ...extra.tags.map((tag) => `  - ${yamlString(tag)}`),
    ];
    if (extra.prev) lines.push(`prev: ${yamlString(extra.prev.path)}`);
    if (extra.next) lines.push(`next: ${yamlString(extra.next.path)}`);
    lines.push(`captured: ${yamlString(new Date().toISOString())}`, `source: ${yamlString(location.host)}`, '---', '');
    return lines.join('\n');
  }

  // Turn in-site links into relative links between the exported files.
  function rewriteInternalLinks(markdown, page, pathToFile) {
    const host = location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\]\\((?:${host})?(/[^)\\s]*)\\)`, 'g');
    return markdown.replace(pattern, (match, path) => {
      const target = pathToFile.get(path.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/');
      if (!target || target === page.file) return match;
      return `](${linkHref(relativePath(page.file, target))})`;
    });
  }

  async function extractCurrentPage(page, pathToFile, options = {}) {
    const main = document.querySelector('main') || document.body;
    await expandInPageSections(main);
    await settle(main, { quiet: 300, timeout: 3000 });

    const clone = cloneVisible(main);
    const pager = extractPager(clone);
    cleanClone(clone);

    const heading = clone.querySelector('h1');
    const headingText = clean(heading?.textContent) || page.title;

    const { markdown, media, features } = MD.convert(clone, { baseUrl: location.href });
    const body = heading ? markdown : `# ${page.title}\n\n${markdown}`;
    const withLinks = rewriteInternalLinks(body, page, pathToFile);
    const tags = [...pageTags(page), ...features.map((f) => `has-${f}`)];

    const text = (options.frontMatter ? frontMatter(page, { heading: headingText, tags, prev: pager.previous, next: pager.next }) : '') + withLinks;

    return {
      markdown: text,
      heading: headingText,
      tags,
      media,
      pager,
      words: withLinks.split(/\s+/).filter(Boolean).length,
    };
  }

  /* -------------------------------- crawl -------------------------------- */

  async function runCrawl() {
    if (crawling) return;
    crawling = true;
    try {
      let state = await getState();
      if (!state?.running) return;

      const options = state.options || {};
      if (!state.folder) {
        state.folder = siteName();
        await setState(state);
      }
      state.attempts = state.attempts || {};

      if (!state.queue?.length) {
        log('Expanding sidebar…');
        const discovered = (await discoverSidebar()).filter((p) => !isSkipped(p, options));
        if (!discovered.length) {
          log('No sidebar links found — is this the learning hub?');
          await setState({ ...state, running: false, error: 'No sidebar links found' });
          await send({ type: 'DONE', ok: false });
          return;
        }
        state.queue = discovered;
        state.index = 0;
        planAll(state);
        await setState(state);
        const parents = discovered.filter((p) => p.isParent).length;
        log(`Found ${discovered.length} pages in the sidebar (${parents} with sub-pages); hidden children are picked up as their parents are visited.`);
      }

      while (state.running && state.index < state.queue.length) {
        const page = state.queue[state.index];

        state.attempts[page.path] = (state.attempts[page.path] || 0) + 1;
        if (state.attempts[page.path] > MAX_ATTEMPTS) {
          log(`Skipping ${page.path} after ${MAX_ATTEMPTS} failed attempts.`);
          page.error = 'unreachable';
          state.index++;
          await setState(state);
          continue;
        }
        await setState(state);

        await send({
          type: 'PROGRESS',
          index: state.index,
          total: state.queue.length,
          title: page.title,
          section: page.section,
        });

        // Back from a full reload that landed somewhere else: the page
        // redirects (typically a parent with no page of its own).
        const reloaded = state.reloadTarget === page.path;
        if (state.reloadTarget) {
          delete state.reloadTarget;
          await setState(state);
        }

        const before = fingerprint();
        const nav = reloaded ? { ok: true, moved: false } : await navigateTo(page.path);
        if (!nav.ok) return; // full reload in flight; resumes on load
        if (nav.moved) await waitFor(() => fingerprint() !== before, { timeout: 6000, interval: 100 });
        await waitFor(() => mainText().length > 20, { timeout: 10000, interval: 120 });
        await settle(document.querySelector('main') || document.body, { quiet: 300, timeout: 3000 });

        // Some parents have no page of their own and redirect (often to their
        // first child); their sub-pages are still queued and exported.
        const landed = currentPath();
        if (landed !== page.path) {
          log(`${page.path} redirects to ${landed}; skipping it, sub-pages are exported separately.`);
          page.error = 'redirect';
          const added = await mergeDiscovered(state, page);
          if (added) log(`Discovered ${added} more page(s) under "${page.title}".`);
          state.index++;
          await setState(state);
          continue;
        }

        const added = await mergeDiscovered(state, page);
        if (added) log(`Discovered ${added} more page(s) under "${page.title}".`);
        planFile(page, state);
        const pathToFile = new Map(state.queue.map((p) => [p.path, p.file]));

        let result;
        try {
          result = await extractCurrentPage(page, pathToFile, options);
        } catch (error) {
          log(`Failed on ${page.path}: ${error.message}`);
          state.index++;
          await setState(state);
          continue;
        }

        const saved = await send({ type: 'SAVE_FILE', path: page.file, text: result.markdown });
        if (!saved?.ok) {
          log(`Could not save ${page.file}: ${saved?.error || 'no response from the extension'}; retrying.`);
          await setState(state);
          await sleep(1000);
          continue;
        }

        if (options.downloadMedia) {
          for (const item of result.media) {
            if (!item.url.startsWith(location.origin)) continue;
            const name = decodeURIComponent(item.url.split('/').pop().split('?')[0]) || 'file';
            await send({ type: 'SAVE_URL', path: `${state.folder}/_media/${name}`, url: item.url });
          }
        }

        page.heading = result.heading;
        page.tags = result.tags;
        page.words = result.words;
        page.media = result.media.map((m) => m.url);
        page.done = true;

        // Pages reachable only through the Previous/Next pager.
        if (options.followPager) {
          for (const link of [result.pager.next, result.pager.previous]) {
            if (!link || state.queue.some((p) => p.path === link.path)) continue;
            if (state.queue.length >= (options.maxPages || 400)) break;
            const extra = {
              path: link.path, title: link.title || link.path.split('/').pop() || link.path,
              section: 'Unlisted', sectionOrder: 99, depth: 0, parent: null, parentPath: null,
              ancestors: [], ancestorPaths: [], isParent: false, read: false, origin: 'pager',
            };
            if (isSkipped(extra, options)) continue;
            state.queue.push(extra);
            planFile(extra, state);
            log(`Discovered unlisted page: ${link.path}`);
          }
        }

        state.index++;
        state.saved = (state.saved || 0) + 1;
        await setState(state);

        await sleep(options.delayMs || 0);
        const latest = await getState();
        if (!latest?.running) {
          log('Stopped.');
          return;
        }
        state = { ...latest, queue: state.queue, index: state.index, attempts: state.attempts };
        await setState(state);
      }

      if (state.index >= state.queue.length) {
        if (options.indexFiles) await writeIndexes(state);
        const done = state.queue.filter((p) => p.done);
        await send({ type: 'FINALIZE', folder: state.folder, order: done.map((p) => p.file) });
        await setState({ ...state, running: false, finishedAt: Date.now() });
        await send({ type: 'DONE', ok: true, total: done.length });
        log(`Done — ${done.length} pages exported to "${state.folder}".`);
      }
    } finally {
      crawling = false;
    }
  }

  /* ---------------------------- index + tags ----------------------------- */

  async function writeIndexes(state) {
    const { queue, folder } = state;
    const pages = queue.filter((p) => p.done);

    const bySection = new Map();
    for (const page of pages) {
      if (!bySection.has(page.section)) bySection.set(page.section, []);
      bySection.get(page.section).push(page);
    }

    const readme = [
      `# ${folder} — export`,
      '',
      `Source: ${location.origin}`,
      `Captured: ${new Date().toISOString()}`,
      `Pages: ${pages.length}`,
      '',
    ];
    for (const [section, items] of bySection) {
      readme.push(`## ${section}`, '');
      for (const page of items) {
        const indent = '  '.repeat(page.depth);
        const href = linkHref(relativePath(`${folder}/README.md`, page.file));
        readme.push(`${indent}- [${page.title}](${href}) — \`${page.path}\``);
      }
      readme.push('');
    }
    await send({ type: 'SAVE_FILE', path: `${folder}/README.md`, text: readme.join('\n') });

    await send({
      type: 'SAVE_FILE',
      path: `${folder}/_index.json`,
      text: JSON.stringify(
        {
          source: location.origin,
          captured: new Date().toISOString(),
          count: pages.length,
          pages: pages.map((p) => ({
            title: p.title, heading: p.heading, path: p.path, file: p.file, section: p.section,
            depth: p.depth, parent: p.parent, tags: p.tags, words: p.words, media: p.media, origin: p.origin,
          })),
        },
        null,
        2
      ),
    });

    const byTag = new Map();
    for (const page of pages) {
      for (const tag of page.tags || []) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(page);
      }
    }
    for (const [tag, items] of byTag) {
      const file = `${folder}/_tags/${safeName(tag)}.md`;
      const lines = [`# ${tag}`, '', `${items.length} page(s).`, ''];
      for (const page of items) {
        lines.push(`- [${page.title}](${linkHref(relativePath(file, page.file))}) — ${page.section}`);
      }
      await send({ type: 'SAVE_FILE', path: file, text: lines.join('\n') });
    }
    const tagIndex = [
      '# Tags',
      '',
      ...[...byTag.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([tag, items]) => `- [${tag}](${linkHref(`${safeName(tag)}.md`)}) (${items.length})`),
    ];
    await send({ type: 'SAVE_FILE', path: `${folder}/_tags/README.md`, text: tagIndex.join('\n') });
  }

  /* ------------------------- single page export -------------------------- */

  async function exportCurrentPage(options = {}) {
    const path = currentPath();
    const sidebarLink = findSidebarHead(path);
    const title = (sidebarLink && linkTitle(sidebarLink)) || clean(document.querySelector('main h1')?.textContent) || clean(document.title) || path;
    const folder = options.folder || siteName();
    const page = {
      path, title, section: 'Single page', sectionOrder: 1, depth: 0, parent: null, parentPath: null,
      ancestors: [], ancestorPaths: [], isParent: false, read: false, origin: 'manual',
      dir: folder, file: `${folder}/${safeName(title)}.md`,
    };
    const result = await extractCurrentPage(page, new Map(), options);
    const saved = await send({ type: 'SAVE_FILE', path: page.file, text: result.markdown, download: true });
    if (!saved?.ok) throw new Error(saved?.error || 'Download failed');
    return { ok: true, title, file: saved.filename || page.file };
  }

  /* ------------------------------ messaging ------------------------------ */

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'BEGIN') {
      respond({ ok: true });
      runCrawl().catch((error) => log(`Crawl error: ${error.message}`));
      return false;
    }
    if (message.type === 'EXPORT_CURRENT') {
      exportCurrentPage(message.options)
        .then(respond)
        .catch((error) => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'PING') {
      respond({ ok: true, path: currentPath() });
      return false;
    }
    return false;
  });

  // Exposed for the offline test harness in test/.
  globalThis.__buckeyeInternals = {
    collectSidebarPages, discoverSidebar, mergePages, planAll, planFile, pageTags, extractCurrentPage, cleanClone,
    cloneVisible, extractPager, writeIndexes, mergeDiscovered, isSkipped, siteName, exportCurrentPage,
  };

  // Resume automatically after a full page load mid-crawl.
  (async () => {
    const state = await getState();
    if (state?.running) {
      await sleep(1500);
      runCrawl().catch((error) => log(`Resume error: ${error.message}`));
    }
  })();
})();
