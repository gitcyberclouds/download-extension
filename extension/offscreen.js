// Offscreen document: builds the export ZIP and hands back a blob URL, which a
// service worker cannot create on its own.
const objectUrls = new Set();

async function collectEntries(prefix) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, text]) => ({ path: key.slice(prefix.length), text }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function fetchMedia(media, entries) {
  let added = 0;
  for (const item of media || []) {
    try {
      const response = await fetch(item.url, { credentials: 'include' });
      if (!response.ok) continue;
      entries.push({ path: item.path, bytes: new Uint8Array(await response.arrayBuffer()) });
      added++;
    } catch {
      /* skip unreachable media */
    }
  }
  return added;
}

async function buildZip(message) {
  const entries = await collectEntries(message.prefix);
  if (!entries.length) throw new Error('No files were buffered for the ZIP.');

  const mediaCount = await fetchMedia(message.media, entries);
  const blob = await BuckeyeZip.create(entries);
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);

  return { ok: true, url, size: blob.size, count: entries.length, mediaCount };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'BUILD_ZIP') {
    buildZip(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'REVOKE') {
    for (const url of message.url ? [message.url] : objectUrls) {
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
