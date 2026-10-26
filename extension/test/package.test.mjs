// Full-pipeline check: drive content.js against the saved page, capture every
// SAVE_FILE the crawl would emit (real content for the saved page, stubs for
// the rest), add the optional index files, then package them with lib/zip.js
// exactly as the background/offscreen pair does. Writes package.zip for an
// external validator, e.g. python -c "import zipfile; print(zipfile.ZipFile('package.zip').testzip())".
import fs from 'node:fs';
import { createDom, createSandbox, loadScripts, fakeChrome } from './fixture.mjs';

const { dom } = createDom();
const { window } = dom;
const { chrome, files } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), [
  '../lib/dom-utils.js', '../lib/markdown.js', '../lib/zip.js', '../content.js',
]);
const api = sandbox.__buckeyeInternals;

const options = { skipSections: 'Support', numbered: false, indexFiles: true };
const state = {
  folder: api.siteName(),
  options,
  queue: api.collectSidebarPages().filter((p) => !api.isSkipped(p, options)),
  index: 0,
};
api.planAll(state);

const current = window.location.pathname.replace(/\/+$/, '') || '/';
const real = state.queue.find((p) => p.path === current) || state.queue[0];
const doc = await api.extractCurrentPage(real, new Map(state.queue.map((p) => [p.path, p.file])), options);

for (const page of state.queue) {
  page.done = true;
  page.heading = page === real ? doc.heading : page.title;
  page.words = page === real ? doc.words : 2;
  page.media = page === real ? doc.media.map((m) => m.url) : [];
  page.tags = page === real ? doc.tags : api.pageTags(page);
  files.set(page.file, page === real ? doc.markdown : `# ${page.title}\n\nstub\n`);
}

await api.writeIndexes(state);

// ALL-PAGES.md is assembled by the background from the buffered page files.
const combined = [`# ${state.folder} — complete export`, ''];
for (const page of state.queue) combined.push('\n<!-- ==================== -->\n', files.get(page.file));
files.set(`${state.folder}/ALL-PAGES.md`, combined.join('\n'));

const entries = [...files.entries()]
  .map(([path, text]) => ({ path, text }))
  .sort((a, b) => a.path.localeCompare(b.path));

const blob = await sandbox.BuckeyeZip.create(entries);
fs.writeFileSync('package.zip', Buffer.from(await blob.arrayBuffer()));
console.log(`buffered ${entries.length} files -> package.zip (${blob.size} bytes)`);
for (const entry of entries) console.log('  ', entry.path);
