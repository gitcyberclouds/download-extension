# Learning Hub Exporter

Chrome extension (Manifest V3) that walks every page of a Handshake learning hub
(`*.learn.joinhandshake.com`, e.g. *Project Violet Instructions*), converts each page's content to
Markdown, and delivers the whole set as a single ZIP whose folders are named after the sidebar tags.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `extension` folder.
3. Open the learning hub in a tab, sign in, then click the extension icon.

Requires Chrome 116 or newer.

## Use

Click **Export all pages**. The extension reads the sidebar, visits each page through the app's own
navigation, waits for the content to settle, opens in-page accordions, converts `<main>` to Markdown
and buffers it.

Collapsible sidebar entries (e.g. *Tasking Guide*, *Reviewing Guide*, *Example tasks*, *Getting
help* — buttons with a chevron and no link of their own) are expanded before the crawl starts, one
at a time, and the sidebar is re-read after each click, so accordions that close one group when
another opens still yield every child. Nested collapsibles are expanded too. The pages found are
queued right after their parent and filed in a folder named after it. As a fallback, children that
the sidebar renders outside their parent are nested by URL (`/getting-help/slack` goes under
*Getting help*), and on a parent page, links in the page body that sit below the parent's URL are
queued as its children. A parent whose own URL redirects elsewhere gets no file, but its folder
and sub-pages are still exported. When the crawl finishes everything is packed into one `.zip` and downloaded.
Progress and a log appear in the popup; **Stop** halts after the current page, and re-running
resumes from where it left off.

Options in the popup:

| Option | Default | Effect |
| --- | --- | --- |
| Archive / root folder name | site title | ZIP filename and the root folder inside it |
| Delay between pages | 400 ms | Throttle between page visits |
| Skip sidebar sections or pages | `Support` | Comma-separated names to leave out (matched against section labels, page titles and parents) |
| Save everything as one `.zip` | on | Off writes each file as its own download |
| Prefix with sidebar order | off | `01 `, `02 `… prefixes on folders and files so the export sorts like the site |
| Metadata header | off | YAML front matter (title, url, section, tags, prev/next, captured) at the top of each file |
| Index files | off | Also write `README.md`, `_index.json`, `_tags/` and `ALL-PAGES.md` |
| Follow Previous/Next | on | Also captures pages missing from the sidebar (filed under `_unlisted/`) |
| Download images and videos | off | Fetches same-origin media into `_media/` inside the ZIP |
| Click “Read announcement” buttons | on | Opens each one and saves what it reveals in place of the button |
| Step through tabs, steppers and slide carousels | on | Clicks every tab / step / slide dot and saves each view one after another |

**This page only** downloads just the page currently open, as a single `.md`.

## Output layout

Folders and files carry the sidebar tag names verbatim (emoji included). A page that has children
lives inside its own folder next to them; a leaf page is a single `.md` in its parent's folder.

```
Project Condor/
  Overview.md
  Glossary.md
  Tasking Guide/
    Tasking Guide.md
    Before you start.md
    Step by step/              ← nested collapsible
      Step by step.md
      Step 1： Read the prompt.md
  Reviewing Guide/
    Reviewing Guide.md
    …
  Getting help/
    Getting help.md
    …

Project Violet Instructions/
  Welcome.md
  📣 Bulletin Board.md
  🚧 Ground rules.md
  🎙️ Live Sessions Master Calendar/
    🎙️ Live Sessions Master Calendar.md
    🔬 Researcher Sessions.md
    🤝 Violet Lab Sessions.md
    …
  ❓ Common Questions/
    ❓ Common Questions.md
    ⚡ Slack Workflows.md
    🤝 Meet Your Community Ambassadors.md
  🌻 Phase II Instructions/
    🌻 Phase II Instructions.md
    📜 Complete List of Rubric Principles.md
    🔍 User in the Loop： Deep Dive.md        ← ":" is not allowed in file names; swapped for "："
    …
```

Characters Windows forbids in names (`< > : " / \ | ? *`) are replaced with look-alike characters
so the names stay readable. Links between exported pages are rewritten to relative `.md` paths.

### Hidden content inside a page

Before a page is converted, everything it hides behind a click is opened:

- **Accordions** — `<details>` are opened; every collapsed `aria-expanded="false"` button in the
  page body (menus, comboboxes and dialog triggers excluded) is clicked one at a time, and the item
  that grows is captured right then, with anything nested inside it opened too. Each capture
  replaces its collapsed item in the export, so single-open accordions (opening one closes the
  rest, like the 12 error patterns on *Common errors & feedback*) still yield every panel. The
  item's button becomes its bold title.
- **“Read announcement”** (also “Read more”, “Read full post”, “View announcement”…) buttons are
  clicked one by one. A dialog that opens is captured and closed again, text that expands in place
  is kept, and a button that routes to another URL is captured and followed by *Back*. The
  captured text goes into the page's `.md` where the button was.
- **Tabs, steppers and slide carousels** — a `role="tablist"`, or a list/group of buttons where
  one carries `aria-current` (e.g. *1. Content Quality … 7. Overall, Recap*, or slide dots
  *A1…A6*) — are clicked through view by view. The parts of the widget that change are written
  out for every view, labelled with the control's name unless the view already starts with it;
  widgets nested in a view (slides inside a deck tab) are expanded too. A `<select>` that swaps
  the content next to it (*Related example*) is treated the same way, one option at a time. The
  original view is re-selected afterwards.

Only the page content is exported: the hero/heading block, body text, lists, tables, code, media
references and in-page accordions. Navigation (sidebar, Previous/Next pager), tooltips, toasts and
anything the browser is not displaying (`display: none`, `hidden`, `aria-hidden`) are dropped.

## Files

- `content.js` — sidebar discovery (labels, nesting, collapsed parents), SPA navigation, per-page
  extraction (accordions, announcement pop-ups, tabs/steppers/carousels), file planning by tag name, optional index/tag generation
- `lib/markdown.js` — DOM → Markdown converter (headings, lists, tables, code, quotes, media, links)
- `lib/zip.js` — dependency-free ZIP writer (deflate via `CompressionStream`, CRC32, UTF-8 names)
- `lib/dom-utils.js` — waiting/settling helpers, safe file names, path maths
- `background.js` — crawl state, file buffering, ZIP delivery
- `offscreen.*` — builds the archive and its blob URL, which a service worker cannot create
- `popup.*` — control panel

### How the ZIP is delivered

Pages are buffered in `chrome.storage.local` as the crawl runs, so a mid-crawl page reload or a
service-worker restart never loses work. At the end the offscreen document reads the buffer,
builds the archive and returns a blob URL for `chrome.downloads`. If the offscreen API is
unavailable the worker builds the ZIP itself and ships it as a base64 data URL; if that also
fails, each file is downloaded individually so an export is never lost.

## Tests

The converter and export pipeline can be exercised offline against a saved copy of a hub page —
either a Chrome "Webpage, Single File" `.mhtml` snapshot or a plain `.html` save placed in the
repository root (`Project Violet Instructions.mhtml`, `Project Buckeye — Fellow Instructions.html`,
or any other `.mhtml`; `FIXTURE=/path/to/page.mhtml` picks one explicitly; `widgets.test.mjs` and `accordion.test.mjs` look for snapshots of `/overview` and `/common-mistakes` and skip without them). Snapshots are
git-ignored because they hold hub content.

```bash
npm install jsdom
cd extension/test
node converter.test.mjs   # sidebar parsing + converter unit cases + full page
node export.test.mjs      # file plan (tag folders, numbered variant) + full document
node sidebar.test.mjs     # collapsible sections expanded into nested folders (asserts)
node widgets.test.mjs     # stepper, tabs, slide dots and announcement dialog captured (asserts)
node accordion.test.mjs   # single-open accordion + "Related example" selects (asserts)
node zip.test.mjs         # writes out.zip
node package.test.mjs     # whole pipeline -> package.zip
```

Validate a produced archive with
`python -c "import zipfile; print(zipfile.ZipFile('package.zip').testzip())"` (`None` means every
CRC matched), or simply extract it with Explorer/7-Zip.
