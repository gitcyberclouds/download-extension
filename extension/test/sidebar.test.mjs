// Sidebar discovery with collapsible parents. The saved page has them
// collapsed (buttons with data-tour-path, no children in the DOM), so this
// test wires the buttons to render children when clicked, the way the live
// hub does, and checks the resulting folder tree. Three shapes are covered:
// a nested sub-menu (with a collapsible grandchild), an accordion that closes
// the other groups when one opens, and children rendered outside the
// parent's <li> (nested by URL instead).
import assert from 'node:assert/strict';
import { createDom, createSandbox, loadScripts, fakeChrome } from './fixture.mjs';

const { dom, fixture } = createDom();
const { window } = dom;
const { document } = window;
const { chrome } = fakeChrome();
const sandbox = loadScripts(createSandbox(window, { chrome }), ['../lib/dom-utils.js', '../lib/markdown.js', '../content.js']);
const api = sandbox.__buckeyeInternals;

console.log('fixture:', fixture.file);

const button = (path) => document.querySelector(`[data-sidebar="content"] button[data-tour-path="${path}"]`);
const missing = ['/onboarding/how-to-task', '/reviewer-instructions', '/golden-examples', '/getting-help'].filter((p) => !button(p));
if (missing.length) {
  console.log(`fixture has no collapsible buttons for ${missing.join(', ')}; skipping.`);
  process.exit(0);
}

function subMenu(items) {
  const ul = document.createElement('ul');
  ul.setAttribute('data-sidebar', 'menu-sub');
  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('data-sidebar', 'menu-sub-item');
    if (item.children) {
      const b = document.createElement('button');
      b.setAttribute('data-sidebar', 'menu-sub-button');
      b.setAttribute('data-tour-path', item.path);
      b.setAttribute('aria-expanded', 'false');
      b.innerHTML = `<span class="flex-1">${item.title}</span>`;
      collapsible(b, () => subMenu(item.children));
      li.append(b);
    } else {
      li.innerHTML = `<a data-sidebar="menu-sub-button" href="${window.location.origin}${item.path}"><span>${item.title}</span></a>`;
    }
    ul.append(li);
  }
  return ul;
}

const accordion = [];
function collapsible(b, render, { exclusive = false, outside = false } = {}) {
  let rendered = null;
  const close = () => {
    rendered?.remove();
    rendered = null;
    b.setAttribute('aria-expanded', 'false');
  };
  if (exclusive) accordion.push(close);
  b.addEventListener('click', () => {
    if (rendered) return close();
    if (exclusive) accordion.forEach((fn) => fn());
    // Render after a tick, as React would.
    setTimeout(() => {
      rendered = render();
      const li = b.closest('li');
      if (outside) li.after(...rendered.querySelectorAll(':scope > li'));
      else li.append(rendered);
      if (outside) rendered = { remove: () => {} };
      b.setAttribute('aria-expanded', 'true');
    }, 30);
  });
}

collapsible(button('/onboarding/how-to-task'), () =>
  subMenu([
    { title: 'Before you start', path: '/onboarding/how-to-task/before-you-start' },
    {
      title: 'Step by step',
      path: '/onboarding/how-to-task/steps',
      children: [
        { title: 'Step 1: Read the prompt', path: '/onboarding/how-to-task/steps/read' },
        { title: 'Step 2: Score', path: '/onboarding/how-to-task/steps/score' },
      ],
    },
  ])
);
collapsible(button('/reviewer-instructions'), () => subMenu([
  { title: 'Review checklist', path: '/reviewer-instructions/checklist' },
  { title: 'Feedback: tone & format', path: '/reviewer-instructions/feedback' },
  {
    title: 'Rubric',
    path: '/reviewer-instructions/rubric',
    children: [{ title: 'Accuracy', path: '/reviewer-instructions/rubric/accuracy' }],
  },
]), { exclusive: true });
collapsible(button('/golden-examples'), () => subMenu([
  { title: 'Example 1 — Slides', path: '/golden-examples/slides' },
  { title: 'Example 2 — Sheets', path: '/golden-examples/sheets' },
]), { exclusive: true });
collapsible(button('/getting-help'), () => subMenu([
  { title: 'Slack channels', path: '/getting-help/slack' },
  { title: 'Office hours', path: '/getting-help/office-hours' },
]), { outside: true });

const pages = await api.discoverSidebar();
const options = { skipSections: '', numbered: false };
const state = { folder: api.siteName(), options, queue: pages, index: 0 };
api.planAll(state);

console.log('\n--- file plan ---');
for (const p of state.queue) console.log(`${p.file}   <- ${p.path}`);

const fileOf = (path) => state.queue.find((p) => p.path === path)?.file;
const root = state.folder;
const expected = {
  '/overview': `${root}/Overview.md`,
  '/onboarding/how-to-task': `${root}/Tasking Guide/Tasking Guide.md`,
  '/onboarding/how-to-task/before-you-start': `${root}/Tasking Guide/Before you start.md`,
  '/onboarding/how-to-task/steps': `${root}/Tasking Guide/Step by step/Step by step.md`,
  '/onboarding/how-to-task/steps/read': `${root}/Tasking Guide/Step by step/Step 1： Read the prompt.md`,
  '/onboarding/how-to-task/steps/score': `${root}/Tasking Guide/Step by step/Step 2： Score.md`,
  '/reviewer-instructions/checklist': `${root}/Reviewing Guide/Review checklist.md`,
  '/reviewer-instructions/feedback': `${root}/Reviewing Guide/Feedback： tone & format.md`,
  // nested collapsible inside a group that the accordion closes again later
  '/reviewer-instructions/rubric/accuracy': `${root}/Reviewing Guide/Rubric/Accuracy.md`,
  '/golden-examples/slides': `${root}/Example tasks/Example 1 — Slides.md`,
  '/golden-examples/sheets': `${root}/Example tasks/Example 2 — Sheets.md`,
  '/getting-help': `${root}/Getting help/Getting help.md`,
  '/getting-help/slack': `${root}/Getting help/Slack channels.md`,
  '/getting-help/office-hours': `${root}/Getting help/Office hours.md`,
};
for (const [path, file] of Object.entries(expected)) assert.equal(fileOf(path), file, path);

// Children follow their parent in the queue, in sidebar order.
const order = state.queue.map((p) => p.path);
const after = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
after('/onboarding/how-to-task', '/onboarding/how-to-task/before-you-start');
after('/onboarding/how-to-task/before-you-start', '/onboarding/how-to-task/steps');
after('/onboarding/how-to-task/steps/score', '/reviewer-instructions');
after('/reviewer-instructions/rubric/accuracy', '/evaluation-questions');
after('/golden-examples/sheets', '/access-issues');
after('/getting-help/office-hours', '/faqs');
assert.equal(state.queue.find((p) => p.path === '/getting-help/slack').section, 'Updates & support');

// Numbered variant keeps the tree.
const numbered = { ...state, options: { ...options, numbered: true }, queue: state.queue.map((p) => ({ ...p })) };
api.planAll(numbered);
assert.match(numbered.queue.find((p) => p.path === '/onboarding/how-to-task/steps/read').file, /\/\d\d Tasking Guide\/\d\d Step by step\/01 Step 1/);

// A parent page whose sub-pages appear only as links in its content.
const parent = state.queue.find((p) => p.path === '/getting-help');
const main = document.querySelector('main');
const extra = document.createElement('div');
extra.innerHTML = `<a href="/getting-help/escalations">Escalations</a><a href="/getting-help/slack">Slack channels</a><a href="/faqs">FAQs</a>`;
main.append(extra);
window.history.pushState({}, '', '/getting-help');
state.index = state.queue.indexOf(parent);
await api.mergeDiscovered(state, parent);
extra.remove();
assert.equal(fileOf('/getting-help/escalations'), `${root}/Getting help/Escalations.md`);
assert.equal(state.queue.filter((p) => p.path === '/faqs').length, 1);

console.log(`\nok — ${state.queue.length} pages, collapsible sections nested as folders`);
