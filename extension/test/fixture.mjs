// Shared helpers for the offline tests: loads a saved hub page (an .mhtml
// snapshot or a plain .html save) into jsdom and prepares a vm sandbox with
// the browser globals the extension scripts expect.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const CANDIDATES = ['Project Violet Instructions.mhtml', 'Project Buckeye — Fellow Instructions.html'];

function decodeQuotedPrintable(body) {
  const joined = body.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// FIXTURE=/path/to/page.mhtml picks a specific snapshot; otherwise the known
// names are tried, then any .mhtml in the repository root. `page` limits the
// choice to snapshots of that path (e.g. '/common-mistakes').
function snapshotPath(file) {
  const head = fs.readFileSync(file, 'latin1').slice(0, 2000);
  const url = /Snapshot-Content-Location:\s*(\S+)/.exec(head)?.[1];
  return url ? new URL(url).pathname.replace(/\/+$/, '') : null;
}

function fixtureFiles(root, page) {
  if (process.env.FIXTURE) return [path.resolve(process.env.FIXTURE)];
  const others = fs.readdirSync(root).filter((n) => n.endsWith('.mhtml') && !CANDIDATES.includes(n)).sort();
  const files = [...CANDIDATES, ...others].map((name) => path.join(root, name)).filter((f) => fs.existsSync(f));
  return page ? files.filter((f) => f.endsWith('.mhtml') && snapshotPath(f) === page) : files;
}

export function hasFixture(page, root = path.resolve('../..')) {
  return fixtureFiles(root, page).length > 0;
}

export function loadFixture(root = path.resolve('../..'), page = null) {
  for (const file of fixtureFiles(root, page)) {
    const name = path.basename(file);
    if (!fs.existsSync(file)) continue;

    if (file.endsWith('.mhtml')) {
      const raw = fs.readFileSync(file, 'latin1');
      const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
      const url = /Snapshot-Content-Location:\s*(\S+)/.exec(raw)?.[1] || 'https://example.learn.joinhandshake.com/';
      const part = raw.split(`--${boundary}`).find((p) => /Content-Type:\s*text\/html/i.test(p.split(/\r?\n\r?\n/)[0]));
      if (!part) throw new Error(`${name}: no text/html part`);
      let html = decodeQuotedPrintable(part.slice(part.search(/\r?\n\r?\n/)).trimStart());
      // The live DOM nests <li> > <div> > <li>, which the HTML parser cannot
      // reproduce. Encode list items as divs and restore them via DOM later.
      html = html.replace(/<li(?=[\s>])/g, '<div data-tag="li"').replace(/<\/li>/g, '</div>');
      return { file, html, url, restoreListItems: true };
    }

    return {
      file,
      html: fs.readFileSync(file, 'utf8'),
      url: 'https://project-buckeye-learning-hub.learn.joinhandshake.com/onboarding',
      restoreListItems: false,
    };
  }
  throw new Error(`No fixture found in ${root} (expected one of: ${CANDIDATES.join(', ')}, any .mhtml, or FIXTURE=path)`);
}

export function createDom({ page = null } = {}) {
  const fixture = loadFixture(path.resolve('../..'), page);
  // jsdom cannot navigate; its notice about that is noise for these tests.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (e) => console.error(e));
  virtualConsole.on('jsdomError', (e) => {
    if (!/navigation to another Document/.test(e.message)) console.error(e.message);
  });
  const dom = new JSDOM(fixture.html, { url: fixture.url, pretendToBeVisual: true, virtualConsole });
  const { document } = dom.window;
  if (fixture.restoreListItems) {
    for (const el of [...document.querySelectorAll('div[data-tag="li"]')]) {
      const li = document.createElement('li');
      for (const attr of el.attributes) if (attr.name !== 'data-tag') li.setAttribute(attr.name, attr.value);
      while (el.firstChild) li.appendChild(el.firstChild);
      el.replaceWith(li);
    }
  }
  return { dom, fixture };
}

export function createSandbox(window, extra = {}) {
  const sandbox = {
    window,
    document: window.document,
    Node: window.Node,
    location: window.location,
    URL: window.URL,
    MutationObserver: window.MutationObserver,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    NodeFilter: window.NodeFilter,
    Event: window.Event,
    PopStateEvent: window.PopStateEvent,
    history: window.history,
    getComputedStyle: window.getComputedStyle.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    console,
    setTimeout,
    clearTimeout,
    Blob,
    Response,
    CompressionStream,
    TextEncoder,
    DataView,
    Uint8Array,
    Uint32Array,
    Date,
    ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

export function loadScripts(sandbox, files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

// chrome.runtime stub that records SAVE_FILE payloads like the worker buffer.
export function fakeChrome(files = new Map()) {
  return {
    files,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === 'SAVE_FILE') files.set(message.path, message.text);
          if (message.type === 'GET_STATE') return null;
          return { ok: true };
        },
        onMessage: { addListener() {} },
      },
    },
  };
}
