// Copies the published explainer page into site/index.html with a standalone HTML skeleton
// (the artifact host adds that skeleton itself; a file opened from disk needs its own).
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) throw new Error('source html path required');
const outDir = path.resolve(__dirname, '..', 'site');
fs.mkdirSync(outDir, { recursive: true });
const body = fs.readFileSync(src, 'utf8');
const html = ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">', '</head>', '<body>', body, '</body>', '</html>', ''].join('\n');
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`saved ${Math.round(html.length / 1024)} KB -> site/index.html`);
