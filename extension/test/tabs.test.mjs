// "Evaluation questions": topic buttons (aria-pressed, not role="tab") swap
// the question list, each question is an accordion, and a "Show questions
// for: All formats / Slides / …" select filters the list. Needs snapshots of
// /evaluation-questions — one per topic, as the topic shown is the one pressed.
// The page is wired to behave like the live hub; the export must contain every
// topic's questions and answers exactly once, and must not step the filter.
import assert from 'node:assert/strict';
import { createDom, createSandbox, loadScripts, fakeChrome, fixturesFor } from './fixture.mjs';

const PAGE = '/evaluation-questions';
const snapshots = fixturesFor(PAGE).map((file) => createDom({ file }));
const topicOf = ({ dom }) => dom.window.document.querySelector('nav[aria-label="Question topics"] [aria-pressed="true"]')?.textContent.trim();
const byTopic = new Map(snapshots.map((s) => [topicOf(s), s]));
const live = byTopic.get('Task & sources');
if (!live || byTopic.size < 3) {
  console.log(`need snapshots of ${PAGE} for all three topics (have: ${[...byTopic.keys()].join(', ') || 'none'}); skipping.`);
  process.exit(0);
}

const { window } = live.dom;
const { document } = window;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);
const api = sandbox.__buckeyeInternals;
console.log('fixture:', live.fixture.file);

const later = (fn) => setTimeout(fn, 20);
const listHtml = new Map([...byTopic].map(([topic, s]) => [topic, s.dom.window.document.querySelector('main nav[aria-label="Question topics"] + section').innerHTML]));
const questions = new Map([...listHtml].map(([topic, html]) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return [topic, [...div.querySelectorAll('button[aria-expanded]')].map((b) => ({ id: b.parentElement.id, text: b.textContent.trim() }))];
}));

const section = () => document.querySelector('main nav[aria-label="Question topics"] + section');
let format = 'all';

// Single-open accordion per question; the answer depends on the filter so a
// stepped filter would show up as repeated or "slides only" answers.
function wireQuestions() {
  const buttons = [...section().querySelectorAll('button[aria-expanded]')];
  buttons.forEach((button) => button.addEventListener('click', () => later(() => {
    const open = button.getAttribute('aria-expanded') === 'true';
    for (const other of buttons) {
      other.setAttribute('aria-expanded', 'false');
      other.parentElement.querySelector('[id$="-answer"]')?.remove();
    }
    if (open) return;
    button.setAttribute('aria-expanded', 'true');
    const answer = document.createElement('div');
    answer.id = `${button.parentElement.id}-answer`;
    answer.innerHTML = `<p>Answer to ${button.parentElement.id} (${format}).</p>`;
    button.after(answer);
  })));
}

const topics = [...document.querySelectorAll('nav[aria-label="Question topics"] button')];
topics.forEach((topic) => topic.addEventListener('click', () => later(() => {
  topics.forEach((t) => t.setAttribute('aria-pressed', String(t === topic)));
  section().innerHTML = listHtml.get(topic.textContent.trim());
  wireQuestions();
})));
wireQuestions();

const select = document.querySelector('#question-format');
select.addEventListener('change', () => later(() => {
  format = select.value;
  section().insertAdjacentHTML('afterbegin', `<p>Filtered to ${format}.</p>`);
}));

const doc = await api.extractCurrentPage({ path: PAGE, title: 'Evaluation questions', file: 'P/Evaluation questions.md', section: 'S', ancestors: [] }, new Map(), {});
const md = doc.markdown;
console.log(md.slice(md.indexOf('Show questions'), md.indexOf('For the evaluation process')).split('\n').filter(Boolean).join('\n'));

let at = -1;
for (const [topic, list] of questions) {
  for (const { id, text } of list) {
    assert.equal(md.split(text).length, 2, `question once: ${text}`);
    assert.equal(md.split(`Answer to ${id} (all).`).length, 2, `answer once: ${id}`);
    const pos = md.indexOf(`Answer to ${id} (all).`);
    assert.ok(pos > at, `${topic}: ${id} in page order`);
    at = pos;
  }
}
assert.ok(!/Filtered to|\((slides|docs|sheets)\)/.test(md), 'format filter left on "All formats"');
assert.equal(topics[0].getAttribute('aria-pressed'), 'true', 'first topic re-selected');
assert.equal(document.querySelectorAll('[data-md-acc], [data-md-panel], [data-md-trigger]').length, 0, 'markers cleaned up');

const total = [...questions.values()].reduce((n, l) => n + l.length, 0);
console.log(`\nok — ${questions.size} topics, ${total} questions with answers`);
