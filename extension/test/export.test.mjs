// Loads content.js against the saved page with a stubbed chrome API, then
// prints the file plan (tag-named folders) and the full document for the
// page the snapshot was taken on, with and without front matter.
import { createDom, createSandbox, loadScripts, fakeChrome } from './fixture.mjs';

const { dom, fixture } = createDom();
const { window } = dom;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);
const api = sandbox.__buckeyeInternals;

console.log('fixture:', fixture.file);

const options = { skipSections: 'Support', numbered: false };
const all = api.collectSidebarPages();
const state = { folder: api.siteName(), options, queue: all.filter((p) => !api.isSkipped(p, options)), index: 0 };
api.planAll(state);

console.log(`\n--- file plan (${state.queue.length} pages, skipped ${all.length - state.queue.length}) ---`);
for (const p of state.queue) console.log(p.file);

const numbered = { ...state, options: { ...options, numbered: true }, queue: state.queue.map((p) => ({ ...p })) };
api.planAll(numbered);
console.log('\n--- numbered variant ---');
for (const p of numbered.queue) console.log(p.file);

const pathToFile = new Map(state.queue.map((p) => [p.path, p.file]));
const current = window.location.pathname.replace(/\/+$/, '') || '/';
const page = state.queue.find((p) => p.path === current) || state.queue[0];

const doc = await api.extractCurrentPage(page, pathToFile, { ...options, frontMatter: true });
console.log('\n--- exported document ---');
console.log(doc.markdown);
console.log('--- meta ---', { heading: doc.heading, words: doc.words, tags: doc.tags, pager: doc.pager });

// Front matter must be YAML-shaped: delimiters plus key/value or list lines.
const fm = doc.markdown.split('---\n')[1] || '';
const badLines = fm.split('\n').filter((l) => l && !/^([a-z_]+:|\s+-\s)/.test(l));
console.log('\nfront-matter lines failing shape check:', badLines);
console.log('pager text left in body:', /\bPrevious\b|\bNext\b/.test(doc.markdown.split('---\n').slice(2).join('')));
