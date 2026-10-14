// Embeds the extension's real icon and logo into the explainer page as data URIs.
// The source artwork has a white background; pixels near white are made transparent so the
// logo sits on the dark page without a box. Re-runnable: replaces placeholders or earlier data URIs.
// Usage: node e2e/inject-logo.cjs <path-to-testlens-site.html>
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');

/**
 * Remove ONLY the outside white background: flood-fill from the image border through near-white
 * pixels, so white inside the artwork (robot face, bug card) is untouched. Edge pixels get a
 * feathered alpha and are de-fringed (their colour pulled toward the artwork, not the white).
 * The source is kept at full resolution; `width` only caps it.
 */
async function transparentLogo(width) {
  const src = sharp(path.join(root, 'apps/extension/public/icon/source.webp'));
  const meta = await src.metadata();
  const w = Math.min(width, meta.width);
  const { data, info } = await src.resize(w, null, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const whiteness = (i) => Math.min(data[i], data[i + 1], data[i + 2]); // 255 = pure white
  const BG = 228; // pixels at least this bright can be background
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (whiteness(p * 4) >= BG) queue[tail++] = p;
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  const isBg = new Uint8Array(W * H);
  while (head < tail) {
    const p = queue[head++];
    isBg[p] = 1;
    const x = p % W, y = (p / W) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  // alpha: background → 0; artwork pixels adjacent to background get feathered by how white they are
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (isBg[p]) { data[i + 3] = 0; continue; }
    const x = p % W, y = (p / W) | 0;
    const nearBg = (x > 0 && isBg[p - 1]) || (x < W - 1 && isBg[p + 1]) || (y > 0 && isBg[p - W]) || (y < H - 1 && isBg[p + W]);
    if (!nearBg) continue;
    const wv = whiteness(i);
    if (wv > 160) {
      // edge pixel blended with white: estimate coverage from brightness and un-premultiply the white out
      const a = Math.max(0.15, Math.min(1, (255 - wv) / 95));
      for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - 255 * (1 - a)) / a)));
      data[i + 3] = Math.round(a * 255);
    }
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
}

(async () => {
  const target = process.argv[2];
  if (!target) throw new Error('page path required');
  const icon = fs.readFileSync(path.join(root, 'apps/extension/public/icon/128.png')).toString('base64');
  const logoBuf = await transparentLogo(4096); // capped by the source's own resolution (1254 px)
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'logo-transparent.png'), logoBuf); // also kept as a file for other uses
  const logo = logoBuf.toString('base64');
  let html = fs.readFileSync(target, 'utf8');
  const before = html.length;
  const iconUri = `data:image/png;base64,${icon}`;
  const logoUri = `data:image/png;base64,${logo}`;
  html = html.replace(/(class="mark" src=")(?:__ICON__|data:image\/png;base64,[A-Za-z0-9+/=]+)(")/, `$1${iconUri}$2`);
  html = html.replace(/(class="hero-logo" src=")(?:__LOGO__|data:image\/png;base64,[A-Za-z0-9+/=]+)(")/, `$1${logoUri}$2`);
  if (!html.includes(iconUri) || !html.includes(logoUri)) throw new Error('logo slots not found');
  fs.writeFileSync(target, html);
  console.log(`embedded icon ${Math.round(icon.length / 1024)} KB + transparent logo ${Math.round(logo.length / 1024)} KB; page ${Math.round(before / 1024)} → ${Math.round(html.length / 1024)} KB`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
