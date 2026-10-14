// Screenshots the standalone site at several viewport sizes for a visual check.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@playwright/cli'), process.cwd()] }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = fs.readdirSync(path.join(os.homedir(), 'AppData/Local/ms-playwright')).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => path.join(os.homedir(), 'AppData/Local/ms-playwright', d, 'chrome-win64/chrome.exe')).find((p) => fs.existsSync(p));
const browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const sizes = [[1920, 1080], [1366, 768], [2560, 1440], [390, 844]];
const out = path.join(root, 'e2e/.out');
fs.mkdirSync(out, { recursive: true });
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto('file:///' + path.join(root, 'site/index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `site-${w}x${h}.png`) });
  const metrics = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, winW: innerWidth, heroH: document.querySelector('.hero')?.getBoundingClientRect().height, canvas: !!document.querySelector('#stage canvas'), canvasW: document.querySelector('#stage canvas')?.width, h1: getComputedStyle(document.querySelector('h1')).fontSize }));
  console.log(`${w}x${h}`, JSON.stringify(metrics));
  await page.close();
}
await browser.close();
