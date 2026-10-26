const $ = (id) => document.getElementById(id);
const OPTIONS_KEY = 'buckeye:options';

const els = {
  site: $('site'), folder: $('folder'), delay: $('delay'), skip: $('skip'), zip: $('zip'),
  numbered: $('numbered'), frontmatter: $('frontmatter'), index: $('index'), pager: $('pager'),
  media: $('media'), start: $('start'), stop: $('stop'), single: $('single'), fill: $('fill'),
  status: $('status'), log: $('log'),
};

function addLog(message) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  els.log.textContent += `${time}  ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setRunning(running) {
  els.start.disabled = running;
  els.stop.disabled = !running;
  els.single.disabled = running;
}

function readOptions() {
  return {
    folder: els.folder.value.trim(),
    delayMs: Math.max(0, Number(els.delay.value) || 0),
    skipSections: els.skip.value.trim(),
    zip: els.zip.checked,
    numbered: els.numbered.checked,
    frontMatter: els.frontmatter.checked,
    indexFiles: els.index.checked,
    followPager: els.pager.checked,
    downloadMedia: els.media.checked,
  };
}

function applyOptions(options = {}) {
  if (options.folder != null) els.folder.value = options.folder;
  if (options.delayMs != null) els.delay.value = options.delayMs;
  if (options.skipSections != null) els.skip.value = options.skipSections;
  if (options.zip != null) els.zip.checked = options.zip;
  if (options.numbered != null) els.numbered.checked = options.numbered;
  if (options.frontMatter != null) els.frontmatter.checked = options.frontMatter;
  if (options.indexFiles != null) els.index.checked = options.indexFiles;
  if (options.followPager != null) els.pager.checked = options.followPager;
  if (options.downloadMedia != null) els.media.checked = options.downloadMedia;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const supported = /learn\.joinhandshake\.com/.test(tab?.url || '');
  els.site.textContent = supported ? new URL(tab.url).host : 'Open the learning hub tab to enable export.';
  els.start.disabled = !supported;
  els.single.disabled = !supported;

  const stored = await chrome.storage.local.get([OPTIONS_KEY, 'buckeye:state']);
  applyOptions(stored[OPTIONS_KEY]);

  const state = stored['buckeye:state'];
  if (state?.running) {
    setRunning(true);
    const total = state.queue?.length || 0;
    els.status.textContent = total ? `Running — ${state.index}/${total}` : 'Running — discovering pages…';
    els.fill.style.width = total ? `${(state.index / total) * 100}%` : '5%';
  }
}

els.start.addEventListener('click', async () => {
  const options = readOptions();
  await chrome.storage.local.set({ [OPTIONS_KEY]: options });
  els.log.textContent = '';
  setRunning(true);
  els.status.textContent = 'Starting…';
  const result = await chrome.runtime.sendMessage({ type: 'START', options });
  if (!result?.ok) {
    setRunning(false);
    els.status.textContent = result?.error || 'Could not start.';
    addLog(result?.error || 'Could not start.');
  }
});

els.stop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP' });
  setRunning(false);
  els.status.textContent = 'Stopping after current page…';
});

els.single.addEventListener('click', async () => {
  const options = readOptions();
  await chrome.storage.local.set({ [OPTIONS_KEY]: options });
  els.status.textContent = 'Exporting current page…';
  const result = await chrome.runtime.sendMessage({ type: 'EXPORT_CURRENT', options });
  if (result?.ok) {
    els.status.textContent = `Saved ${result.file}`;
    addLog(`Saved ${result.file}`);
  } else {
    els.status.textContent = result?.error || 'Export failed.';
    addLog(result?.error || 'Export failed.');
  }
});

// Content-script messages reach the popup directly *and* via the service
// worker's relay; only act on the relayed copy so nothing shows up twice.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender?.tab) return;

  if (message.type === 'PROGRESS') {
    const percent = message.total ? ((message.index + 1) / message.total) * 100 : 0;
    els.fill.style.width = `${percent}%`;
    els.status.textContent = `${message.index + 1}/${message.total} · ${message.section} › ${message.title}`;
  } else if (message.type === 'LOG') {
    addLog(message.message);
  } else if (message.type === 'SAVED') {
    addLog(`${message.buffered ? '+' : '↓'} ${message.path}`);
  } else if (message.type === 'DONE') {
    setRunning(false);
    els.fill.style.width = '100%';
    els.status.textContent = message.ok ? `Finished — ${message.total} pages` : 'Finished with errors';
  }
});

refresh();
