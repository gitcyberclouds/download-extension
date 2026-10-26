// Converter checks: sidebar discovery on the saved page, the full Markdown
// for the page that was saved, and unit cases on synthetic markup.
import { createDom, createSandbox, loadScripts, fakeChrome } from './fixture.mjs';

const { dom, fixture } = createDom();
const { window } = dom;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);

const MD = sandbox.BuckeyeMarkdown;
const { slug, safeName, relativePath } = sandbox.BuckeyeDom;
const api = sandbox.__buckeyeInternals;

console.log('fixture:', fixture.file);

/* ---- 1. sidebar discovery ---- */
const pages = api.collectSidebarPages();
console.log('\n--- discovered sidebar pages ---');
for (const p of pages) {
  console.log(`${p.section} | ${'  '.repeat(p.depth)}${p.title}${p.isParent ? ' (parent)' : ''} -> ${p.path}`);
}
console.log('\nsafeName check:', ['🔍 User in the Loop: Deep Dive', 'What? *Really*', 'CON'].map((s) => safeName(s)));
console.log('slug check:', slug('🎙️ Live Sessions Master Calendar'));
console.log('relativePath check:', relativePath('P/A/x.md', 'P/B/C/y.md'));

/* ---- 2. extraction of the current page ---- */
const state = { folder: api.siteName(), options: {}, queue: pages, index: 0 };
api.planAll(state);
const page = pages.find((p) => p.path === window.location.pathname.replace(/\/+$/, '') || p.path === '/') || pages[0];
const doc = await api.extractCurrentPage(page, new Map(pages.map((p) => [p.path, p.file])), {});
console.log('\n--- markdown output ---');
console.log(doc.markdown);
console.log('--- pager:', doc.pager, 'features/tags:', doc.tags);

/* ---- 3. converter unit checks on synthetic markup ---- */
const cases = {
  headings: '<div><h2>Title</h2><p>Body <strong>bold</strong> and <em>italic</em> and <code>x = 1</code>.</p></div>',
  lists: '<div><ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><ol start="3"><li>Third</li></ol></div>',
  table: '<table><thead><tr><th>A</th><th>B|pipe</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>',
  code: '<pre><code class="language-js">const a = 1;\nconsole.log(a);</code></pre>',
  quote: '<blockquote><p>Quoted line</p><p>Second</p></blockquote>',
  links: '<p>See <a href="/rules">the rules</a> and <a href="https://x.com">x</a>.</p>',
  cardLink: '<a href="/about"><div><p>Card title</p></div></a>',
  gap: '<p><span data-md-gap="1">1</span>Project Overview</p>',
  details: '<details><summary>More</summary><p>Hidden body</p></details>',
  media: '<div><video src="/get-oriented.mp4"></video><img src="/a.png" alt="Diagram"></div>',
  checklist: '<ul><li><input type="checkbox" checked>Done item</li><li><input type="checkbox">Todo item</li></ul>',
  escapes: '<p>Use snake_case, 2 * 3, [brackets] and # hash.</p>',
  hidden: '<div><p>Visible</p><div hidden><p>Collapsed</p></div><div aria-hidden="true"><p>Decor</p></div></div>',
};
console.log('\n--- unit cases ---');
for (const [name, markup] of Object.entries(cases)) {
  const wrapper = window.document.createElement('div');
  wrapper.innerHTML = markup;
  console.log(`\n[${name}]\n${MD.convert(wrapper, { baseUrl: window.location.href }).markdown.trim()}`);
}
