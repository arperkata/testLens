// Embeds the extension's real icon and logo into the explainer page as data URIs.
// The source artwork has a white background; pixels near white are made transparent so the
// logo sits on the dark page without a box. Re-runnable: replaces placeholders or earlier data URIs.
// Usage: node e2e/inject-logo.cjs <path-to-testlens-site.html>
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');

async function transparentLogo(width) {
  const img = sharp(path.join(root, 'apps/extension/public/icon/source.webp')).resize(width).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const min = Math.min(r, g, b);
    if (min > 236) data[i + 3] = 0; // white background
    else if (min > 200) data[i + 3] = Math.round(((236 - min) / 36) * 255); // soft edge
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

(async () => {
  const target = process.argv[2];
  if (!target) throw new Error('page path required');
  const icon = fs.readFileSync(path.join(root, 'apps/extension/public/icon/128.png')).toString('base64');
  const logo = (await transparentLogo(520)).toString('base64');
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
