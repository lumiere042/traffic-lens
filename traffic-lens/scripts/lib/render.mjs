// Inject the merged graph (and the vendored ELK layout engine) into the viewer
// template, producing one self-contained HTML file that works offline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(here, '..', '..', 'assets');
const ELK_CDN = 'https://cdn.jsdelivr.net/npm/elkjs@0.10.0/lib/elk.bundled.js';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHtml(graph) {
  const template = fs.readFileSync(path.join(ASSETS, 'viewer.html'), 'utf8');
  const vendored = path.join(ASSETS, 'vendor', 'elk.bundled.js');
  const elk = fs.existsSync(vendored)
    ? `<script>${fs.readFileSync(vendored, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`
    : `<script src="${ELK_CDN}"></script>`;
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  // function replacers: the payloads may contain "$&"-style sequences
  return template
    .replace('__TL_TITLE__', () => escapeHtml(graph.title || 'Traffic map'))
    .replace('__TL_DATA__', () => data)
    .replace('<!--__TL_ELK__-->', () => elk);
}
