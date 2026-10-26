// "Find the issue you need to resolve" on /common-mistakes: twelve accordion
// items (button aria-expanded, no aria-controls) where opening one closes the
// others, and each panel has a "Related example" <select> that swaps the
// example shown. The saved page is static, so the controls are wired here the
// way the live hub behaves; the export must hold every panel and every example.
import assert from 'node:assert/strict';
import { createDom, createSandbox, loadScripts, fakeChrome, hasFixture } from './fixture.mjs';

if (!hasFixture('/common-mistakes')) {
  console.log('no snapshot of /common-mistakes; skipping.');
  process.exit(0);
}
const { dom, fixture } = createDom({ page: '/common-mistakes' });
const { window } = dom;
const { document } = window;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);
const api = sandbox.__buckeyeInternals;
console.log('fixture:', fixture.file);

const table = document.querySelector('main [role="table"][aria-label="Error pattern"]');
const triggers = [...table.querySelectorAll(':scope > div > button[aria-expanded]')];
assert.equal(triggers.length, 12);
const later = (fn) => setTimeout(fn, 20);

function panelFor(n, name) {
  const panel = document.createElement('div');
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = `<h3>${name} in detail</h3>
    <div><div><h4>Severity or handling</h4><div><p><strong>Minor</strong> rule for item ${n}.</p></div></div>
    <div><h4>What to do</h4><div><p>Fix for item ${n}.</p></div></div></div>
    <section><h4>Related example</h4>
      <select aria-label="Related example"><option value="0">Example ${n}a</option><option value="1">Example ${n}b</option><option value="2">Example ${n}c</option></select>
      <div><div><p>Weak/better pair ${n}a.</p></div></div>
      <p>The examples illustrate the reasoning to repair.</p></section>`;
  const select = panel.querySelector('select');
  select.addEventListener('change', () => later(() => {
    const letter = 'abc'[Number(select.value)];
    panel.querySelector('section > div').innerHTML = `<div><p>Weak/better pair ${n}${letter}.</p></div>`;
  }));
  return panel;
}

// Single-open accordion.
triggers.forEach((button, i) => button.addEventListener('click', () => later(() => {
  const open = button.getAttribute('aria-expanded') === 'true';
  for (const other of triggers) {
    other.setAttribute('aria-expanded', 'false');
    other.parentElement.querySelector('[aria-live]')?.remove();
  }
  if (open) return;
  button.setAttribute('aria-expanded', 'true');
  const name = button.querySelector('span > span').textContent;
  button.after(panelFor(i + 1, name));
})));

const doc = await api.extractCurrentPage({ path: '/common-mistakes', title: 'Common errors & feedback', file: 'P/Common.md', section: 'S', ancestors: [] }, new Map(), {});
const md = doc.markdown;
const start = md.indexOf('## Find the issue');
console.log(md.slice(start, md.indexOf('## Reviewer reference')).split('\n').filter(Boolean).slice(0, 40).join('\n'));

const inOrder = (...parts) => {
  let at = -1;
  for (const part of parts) {
    const next = md.indexOf(part, at + 1);
    assert.ok(next > at, `"${part}" missing or out of order`);
    at = next;
  }
};
for (let n = 1; n <= 12; n++) {
  inOrder('## Find the issue', `Unclear or reused reasons`, `rule for item ${n}.`, `Fix for item ${n}.`,
    `Example ${n}a`, `Weak/better pair ${n}a.`, `Example ${n}b`, `Weak/better pair ${n}b.`, `Example ${n}c`, `Weak/better pair ${n}c.`, '## Reviewer reference');
}
inOrder('rule for item 1.', 'Wrong scoring dimension', 'rule for item 12.');
assert.equal(md.split('Fix for item 3.').length, 2, 'each panel written once');
assert.equal(document.querySelectorAll('[data-md-acc], [data-md-panel]').length, 0, 'markers cleaned up');

console.log('\nok — 12 accordion items with 3 related examples each exported');
