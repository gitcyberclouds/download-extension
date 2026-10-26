// Builds a ZIP with lib/zip.js and writes it to disk so python's zipfile can
// validate the headers, CRCs and directory structure.
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {
  Blob, Response, CompressionStream, TextEncoder, DataView, Uint8Array, Uint32Array, Date, console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('../lib/zip.js', 'utf8'), sandbox, { filename: 'zip.js' });

const entries = [
  { path: 'Project Violet Instructions/Welcome.md', text: `🌸 Welcome\n\n# Welcome to Project Violet\n\n${'Long body text that should compress well. '.repeat(60)}` },
  { path: 'Project Violet Instructions/📣 Bulletin Board.md', text: '# 📣 Bulletin Board\n' },
  { path: 'Project Violet Instructions/❓ Common Questions/❓ Common Questions.md', text: '# ❓ Common Questions\n' },
  { path: 'Project Violet Instructions/❓ Common Questions/⚡ Slack Workflows.md', text: '# ⚡ Slack Workflows\n' },
  { path: 'Project Violet Instructions/🌻 Phase II Instructions/🔍 User in the Loop： Deep Dive.md', text: '# 🔍 User in the Loop: Deep Dive\n' },
  { path: 'Project Violet Instructions/_index.json', text: JSON.stringify({ count: 5, unicode: 'em—dash ✅' }, null, 2) },
  { path: '/leading/slash/../escape.md', text: 'normalized path\n' },
  { path: 'Project Violet Instructions/Welcome.md', text: 'duplicate path gets renamed\n' },
];

const blob = await sandbox.BuckeyeZip.create(entries);
const bytes = Buffer.from(await blob.arrayBuffer());
fs.writeFileSync('out.zip', bytes);
console.log('entries:', entries.length, 'zip bytes:', bytes.length, 'type:', blob.type);
