// Smoke test for the single-file Hub: starts dist/testlens-hub.mjs on its own (no repo imports),
// then exercises health, snippet, ingest, list and detail. Run: node e2e/hub-bundle-smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/hub/dist/testlens-hub.mjs');
if (!fs.existsSync(dist)) throw new Error('build the hub first: npm run hub:build');
// copy the bundle somewhere outside the repo so it cannot resolve anything from node_modules
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-hub-bundle-'));
const exe = path.join(tmp, 'testlens-hub.mjs');
fs.copyFileSync(dist, exe);
const PORT = 7339;
const HUB = `http://localhost:${PORT}`;
const proc = spawn(process.execPath, [exe], { env: { ...process.env, TL_HUB_PORT: String(PORT), TL_HUB_DATA: path.join(tmp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
proc.stderr.on('data', (d) => (stderr += String(d)));
const failures = [];
const check = (c, m) => {
  console.log(`${c ? '  ✓' : '  ✗'} ${m}`);
  if (!c) failures.push(m);
};
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start\n${stderr}`)), 15000);
    const poll = async () => {
      try {
        if ((await fetch(`${HUB}/health`)).ok) {
          clearTimeout(t);
          return resolve();
        }
      } catch {}
      setTimeout(poll, 200);
    };
    void poll();
  });
  const health = await (await fetch(`${HUB}/health`)).json();
  check(health.ok && health.port === PORT, `health ok (version ${health.version}, data ${health.dataDir})`);
  const snippet = await (await fetch(`${HUB}/snippet`)).text();
  check(snippet.includes('TestLens snippet') && snippet.includes(`localhost:${PORT}`), 'snippet served from the bundle with the port baked in');
  const page = await (await fetch(`${HUB}/`)).text();
  check(page.includes('TestLens Hub') && page.includes(`port ${PORT}`), 'landing page served from the bundle');
  const payload = { source: 'postman', collection: 'Smoke', requestName: 'Create', request: { method: 'POST', url: 'https://api.example.com/x', headers: [{ key: 'Authorization', value: 'Bearer secret-token-abcdefghijklmnop' }], body: { mode: 'raw', raw: '{"password":"hunter2"}' } }, response: { code: 500, status: 'Internal Server Error', headers: [], body: '{"error":"boom"}', responseTime: 10 }, tests: [{ name: 'status 201', passed: false, error: 'expected 500 to equal 201' }] };
  const ing = await fetch(`${HUB}/ingest/postman`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const ingBody = await ing.json();
  check(ing.status === 201 && ingBody.incidentId, `ingest created an incident (${ingBody.title ?? ingBody.error})`);
  const list = await (await fetch(`${HUB}/incidents`)).json();
  check(list.length === 1 && list[0].source === 'postman', 'list shows the incident');
  const full = await (await fetch(`${HUB}/incidents/${ingBody.incidentId}`)).json();
  const json = JSON.stringify(full.context);
  check(!json.includes('hunter2') && !json.includes('secret-token-abcdefghijklmnop'), 'secrets redacted inside the bundle pipeline');
  check(full.draft.stepsToReproduce.some((s) => s.includes('Smoke')), 'draft composed by the bundled composer');
  const har = await fetch(`${HUB}/incidents/${ingBody.incidentId}/artifacts/${encodeURIComponent(`${ingBody.incidentId}:har-focused`)}`);
  check(har.ok && (await har.text()).includes('"version": "1.2"'), 'artifact download works');
} catch (e) {
  failures.push(`crash: ${e.message}`);
  console.error(e);
} finally {
  proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nBUNDLE SMOKE PASSED');
process.exit(failures.length ? 1 : 0);
