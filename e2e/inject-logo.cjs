// Embeds the extension's real icon and logo into the explainer page as data URIs.
// Usage: node e2e/inject-logo.cjs <path-to-testlens-site.html>
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
(async () => {
  const target = process.argv[2];
  if (!target) throw new Error('page path required');
  const icon = fs.readFileSync(path.join(root, 'apps/extension/public/icon/128.png')).toString('base64');
  const logoBuf = await sharp(path.join(root, 'apps/extension/public/icon/source.webp')).resize(420).png({ compressionLevel: 9 }).toBuffer();
  const logo = logoBuf.toString('base64');
  let html = fs.readFileSync(target, 'utf8');
  const before = html.length;
  html = html.replace('__ICON__', `data:image/png;base64,${icon}`).replace('__LOGO__', `data:image/png;base64,${logo}`);
  if (html.includes('__ICON__') || html.includes('__LOGO__')) throw new Error('placeholders not replaced');
  fs.writeFileSync(target, html);
  console.log(`embedded icon ${Math.round(icon.length / 1024)} KB + logo ${Math.round(logo.length / 1024)} KB; page ${Math.round(before / 1024)} → ${Math.round(html.length / 1024)} KB`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
