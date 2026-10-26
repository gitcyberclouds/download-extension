// Service worker: owns crawl state, buffers generated files and delivers them
// either as one ZIP or as individual downloads.
importScripts('lib/dom-utils.js', 'lib/zip.js');

const STATE_KEY = 'buckeye:state';
const FILE_PREFIX = 'buckeye:file:';
const MEDIA_KEY = 'buckeye:media';

const DEFAULT_OPTIONS = {
  folder: '',
  delayMs: 400,
  zip: true,
  numbered: false,
  frontMatter: false,
  indexFiles: false,
  followPager: true,
  downloadMedia: false,
  openPopups: true,
  expandWidgets: true,
  skipSections: 'Support',
  maxPages: 400,
};

const MIME_BY_EXT = {
  md: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
  zip: 'application/zip',
};

/* ------------------------------- state ---------------------------------- */

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || null;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function getOptions() {
  const state = await getState();
  return { ...DEFAULT_OPTIONS, ...(state?.options || {}) };
}

function relay(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const log = (message) => relay({ type: 'LOG', message });

/* ------------------------------ file buffer ------------------------------ */

async function bufferFile(path, text) {
  await chrome.storage.local.set({ [FILE_PREFIX + path]: text });
}

async function bufferedPaths() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((key) => key.startsWith(FILE_PREFIX));
}

async function clearBuffer() {
  const keys = await bufferedPaths();
  await chrome.storage.local.remove([...keys, MEDIA_KEY]);
}

/* ------------------------------ downloads -------------------------------- */

const { sanitizePath } = BuckeyeDom;

async function downloadFile(path, url) {
  const filename = sanitizePath(path);
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    return { ok: true, id, filename };
  } catch (error) {
    log(`Download failed for ${filename}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

// Service workers have no URL.createObjectURL, so text files are handed to the
// downloads API as base64 data URLs (cheaper than percent-encoding for UTF-8).
function toBase64DataUrl(input, mime) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function saveText(path, text) {
  const ext = path.split('.').pop().toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'text/plain';
  return downloadFile(path, toBase64DataUrl(text, `${mime};charset=utf-8`));
}

function waitForDownload(id, timeout = 120000) {
  return new Promise((resolve) => {
    const finish = (result) => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(result);
    };
    const listener = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete') finish('complete');
      else if (delta.state?.current === 'interrupted') finish('interrupted');
    };
    const timer = setTimeout(() => finish('timeout'), timeout);
    chrome.downloads.onChanged.addListener(listener);
  });
}

/* ------------------------------- offscreen ------------------------------- */

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('Offscreen API unavailable');
  if (await chrome.offscreen.hasDocument?.()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Build the export ZIP archive and create its download URL.',
    });
  }
  try {
    await creatingOffscreen;
  } catch (error) {
    if (!/single offscreen document/i.test(error.message)) throw error;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch {
    /* already gone */
  }
}

/* --------------------------------- zip ----------------------------------- */

async function readBufferedEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(FILE_PREFIX))
    .map(([key, text]) => ({ path: key.slice(FILE_PREFIX.length), text }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Preferred path: the offscreen document builds the archive and returns a blob
// URL, which keeps large exports off the message/data-URL size limits.
async function zipViaOffscreen(folder, media) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'BUILD_ZIP',
    prefix: FILE_PREFIX,
    folder,
    media,
  });
  if (!result?.ok) throw new Error(result?.error || 'Offscreen ZIP build failed');

  const download = await downloadFile(`${folder}.zip`, result.url);
  if (!download.ok) throw new Error(download.error);
  const outcome = await waitForDownload(download.id);

  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'REVOKE', url: result.url }).catch(() => {});
  await closeOffscreen();

  if (outcome === 'interrupted') throw new Error('ZIP download was interrupted');
  return { ...result, filename: download.filename };
}

// Fallback for browsers without the offscreen API: build in the worker and ship
// the bytes as a base64 data URL.
async function zipInWorker(folder) {
  const entries = await readBufferedEntries();
  const blob = await BuckeyeZip.create(entries);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const download = await downloadFile(`${folder}.zip`, toBase64DataUrl(bytes, 'application/zip'));
  if (!download.ok) throw new Error(download.error);
  return { ok: true, size: blob.size, count: entries.length, filename: download.filename };
}

async function deliverZip(folder) {
  const media = (await chrome.storage.local.get(MEDIA_KEY))[MEDIA_KEY] || [];
  log('Building ZIP…');
  try {
    return await zipViaOffscreen(folder, media);
  } catch (error) {
    log(`Offscreen ZIP failed (${error.message}); retrying in the worker.`);
  }
  try {
    return await zipInWorker(folder);
  } catch (error) {
    log(`ZIP build failed (${error.message}); saving individual files instead.`);
    for (const entry of await readBufferedEntries()) await saveText(entry.path, entry.text);
    return { ok: false, error: error.message };
  }
}

/* ------------------------------- finalize -------------------------------- */

async function buildCombined(folder, order) {
  const all = await chrome.storage.local.get(order.map((file) => FILE_PREFIX + file));
  const parts = [
    '# Project Buckeye — complete export',
    '',
    `Captured ${new Date().toISOString()} · ${order.length} pages`,
    '',
  ];
  for (const file of order) {
    const text = all[FILE_PREFIX + file];
    if (text) parts.push('\n\n<!-- ==================== -->\n', text);
  }
  return parts.join('\n');
}

async function finalize(message) {
  const options = await getOptions();
  const { folder, order = [] } = message;

  if (options.indexFiles && order.length) {
    const combined = await buildCombined(folder, order);
    await bufferFile(`${folder}/ALL-PAGES.md`, combined);
    if (!options.zip) await saveText(`${folder}/ALL-PAGES.md`, combined);
  }

  let result = { ok: true };
  if (options.zip) {
    result = await deliverZip(folder);
    if (result.ok) {
      const mb = (result.size / 1048576).toFixed(2);
      log(`Saved ${result.filename} — ${result.count} files, ${mb} MB.`);
    }
  }

  await clearBuffer();
  return result;
}

/* --------------------------------- crawl --------------------------------- */

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/dom-utils.js', 'lib/markdown.js', 'content.js'],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function startCrawl(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/learn\.joinhandshake\.com/.test(tab.url || '')) {
    return { ok: false, error: 'Open a learn.joinhandshake.com page first.' };
  }

  const merged = { ...DEFAULT_OPTIONS, ...options };
  await clearBuffer();
  await setState({
    running: true,
    tabId: tab.id,
    options: merged,
    // Empty folder = the content script names it after the site title.
    folder: sanitizePath(merged.folder || ''),
    queue: [],
    index: 0,
    saved: 0,
    attempts: {},
    startedAt: Date.now(),
    error: null,
  });

  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: 'BEGIN' });
  return { ok: true };
}

async function stopCrawl() {
  const state = await getState();
  if (state) await setState({ ...state, running: false });
  return { ok: true };
}

/* ------------------------------- messaging ------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;

  (async () => {
    switch (message.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;

      case 'SET_STATE':
        await setState(message.state);
        sendResponse({ ok: true });
        break;

      case 'SAVE_FILE': {
        // download:true (single-page export) always writes a real file and
        // never touches the crawl buffer.
        if (message.download) {
          sendResponse(await saveText(message.path, message.text));
          break;
        }
        const options = await getOptions();
        await bufferFile(message.path, message.text);
        const result = options.zip ? { ok: true, buffered: true } : await saveText(message.path, message.text);
        relay({ type: 'SAVED', path: message.path, buffered: !!options.zip });
        sendResponse(result);
        break;
      }

      case 'SAVE_URL': {
        const options = await getOptions();
        if (options.zip) {
          const stored = (await chrome.storage.local.get(MEDIA_KEY))[MEDIA_KEY] || [];
          if (!stored.some((item) => item.url === message.url)) {
            stored.push({ url: message.url, path: message.path });
            await chrome.storage.local.set({ [MEDIA_KEY]: stored });
          }
          sendResponse({ ok: true, buffered: true });
        } else {
          sendResponse(await downloadFile(message.path, message.url));
        }
        break;
      }

      case 'FINALIZE':
        sendResponse(await finalize(message));
        break;

      case 'START':
        sendResponse(await startCrawl(message.options));
        break;

      case 'STOP':
        sendResponse(await stopCrawl());
        break;

      case 'EXPORT_CURRENT': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab.' });
          break;
        }
        await ensureContentScript(tab.id);
        const options = { ...DEFAULT_OPTIONS, ...(message.options || {}) };
        sendResponse(await chrome.tabs.sendMessage(tab.id, { type: 'EXPORT_CURRENT', options }));
        break;
      }

      case 'LOG':
      case 'PROGRESS':
      case 'DONE':
        relay(message);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: `Unknown message ${message.type}` });
    }
  })();
  return true;
});
