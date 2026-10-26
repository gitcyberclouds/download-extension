// In-page widgets that show one view at a time (stepper, tabs, slide dots)
// and "Read announcement" buttons that open a dialog. The saved page is
// static, so the controls are wired here to re-render like the live hub;
// the export must contain every view and the dialog text, in page order.
import assert from 'node:assert/strict';
import { createDom, createSandbox, loadScripts, fakeChrome, hasFixture } from './fixture.mjs';

if (!hasFixture('/overview')) {
  console.log('no snapshot of /overview; skipping.');
  process.exit(0);
}
const { dom, fixture } = createDom({ page: '/overview' });
const { window } = dom;
const { document } = window;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);
const api = sandbox.__buckeyeInternals;

console.log('fixture:', fixture.file);
const main = document.querySelector('main');
const later = (fn) => setTimeout(fn, 20); // React re-renders after the click

// Stepper: one form per axis.
const steps = [...main.querySelectorAll('ol[aria-label="Practice axes"] button')];
if (!steps.length) {
  console.log('fixture has no practice stepper; skipping.');
  process.exit(0);
}
steps.forEach((button, i) => button.addEventListener('click', () => later(() => {
  steps.forEach((b) => b.removeAttribute('aria-current'));
  button.setAttribute('aria-current', 'step');
  const name = button.textContent.replace(/^\d+\./, '').trim();
  main.querySelector('form[data-testid="practice-step"]').innerHTML =
    `<div><p>${i + 1} of 8</p><h4>${name}</h4><p>Guidance for ${name} axis.</p></div>`;
})));

// Slide dots inside a deck panel.
function wireSlides(panel, deck, count) {
  const dots = [...panel.querySelectorAll('[role="group"] button')];
  dots.forEach((dot, i) => dot.addEventListener('click', () => later(() => {
    dots.forEach((d) => d.removeAttribute('aria-current'));
    dot.setAttribute('aria-current', 'true');
    panel.querySelector('figcaption').textContent = `DECK ${deck} · ${i + 1} / ${count} · Slide ${deck}${i + 1} title`;
    panel.querySelector('img').setAttribute('src', `/assets/${deck}${i + 1}.svg`);
    panel.querySelector('details > div').innerHTML = `<p>Transcript of ${deck}${i + 1}.</p>`;
  })));
}
const deckPanel = main.querySelector('#deck-panel');
const deckA = deckPanel.innerHTML;
wireSlides(deckPanel, 'A', 6);

// Tabs: Deck B renders a fresh panel with three slides.
const tabs = [...main.querySelectorAll('[role="tab"]')];
tabs.forEach((tab) => tab.addEventListener('click', () => later(() => {
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  const deck = tab.id.slice(-1);
  deckPanel.innerHTML = deck === 'A' ? deckA : `<div><figure><img src="/assets/B1.svg" alt="B1"><figcaption>DECK B · 1 / 3 · Slide B1 title</figcaption></figure>
    <div><p>Deck B · Slide 1 of 3</p><div role="group" aria-label="Go to slide (Deck B)"><button aria-current="true">B1</button><button>B2</button><button>B3</button></div></div>
    <details open><summary>Slide text (transcript)</summary><div><p>Transcript of B1.</p></div></details></div>`;
  wireSlides(deckPanel, deck, deck === 'A' ? 6 : 3);
})));

// A "Read announcement" button that opens a dialog in a portal.
const card = document.createElement('section');
card.innerHTML = '<h2>Announcements</h2><article><h3>New rubric</h3><p>Short teaser.</p><button type="button" aria-haspopup="dialog">Read announcement</button></article>';
main.querySelector('header').after(card);
card.querySelector('button').addEventListener('click', () => later(() => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<h2>New rubric</h2><p>The full announcement body with every detail.</p><ul><li>Point one</li></ul><button aria-label="Close">×</button>';
  dialog.querySelector('button').addEventListener('click', () => dialog.remove());
  document.body.append(dialog);
}));

const doc = await api.extractCurrentPage({ path: '/overview', title: 'Overview', file: 'P/Overview.md', section: 'S', ancestors: [] }, new Map(), {});
const md = doc.markdown;
console.log(md.slice(md.indexOf('## Announcements'), md.indexOf('## Announcements') + 300));
console.log("…\n" + md.slice(md.indexOf("Training preview") > 0 ? md.indexOf("Deck A") : 0, md.indexOf("Guidance for Recap") + 40));

const inOrder = (...parts) => {
  let at = -1;
  for (const part of parts) {
    const next = md.indexOf(part, at + 1);
    assert.ok(next > at, `"${part}" missing or out of order`);
    at = next;
  }
};
inOrder('Short teaser', 'The full announcement body with every detail.', 'Point one', 'Score each axis');
assert.ok(!md.includes('Read announcement'), 'trigger button text removed');
assert.equal(document.querySelectorAll('[role="dialog"]').length, 0, 'dialog closed');

inOrder('Transcript of A1', 'Transcript of A2', 'Transcript of A6', 'Transcript of B1', 'Transcript of B3');
inOrder('Slide A1 title', 'Slide A6 title', 'Slide B3 title');
for (const axis of ['Content Quality', 'Storytelling', 'Writing Style', 'Aesthetics', 'Layout', 'Editability', 'Overall', 'Recap']) {
  assert.ok(md.includes(`Guidance for ${axis} axis.`), axis);
}
inOrder('Guidance for Content Quality axis.', 'Guidance for Overall axis.', 'Guidance for Recap axis.');

// The page is left as it was found.
assert.equal(steps[0].getAttribute('aria-current'), 'step');
assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
assert.equal(document.querySelectorAll('[data-md-panel], [data-md-popup]').length, 0, 'markers cleaned up');

console.log('\nok — stepper, tabs, slides and announcement dialog exported');
