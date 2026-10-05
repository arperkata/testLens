/**
 * End-to-end: load the built extension into Chromium, monitor the fixture app,
 * plant failures, Report Issue, verify the BugContext, and create the Jira issue
 * against the mock Jira. Run: `node e2e/run.mjs` (after `TL_E2E=1 npm run build`).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture/server.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [process.cwd(), path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@playwright/cli'), path.join(os.homedir(), 'AppData/Roaming/npm/node_modules')];
  for (const c of candidates) {
    try {
      return require(require.resolve('playwright', { paths: [c] }));
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found; npm i -D playwright');
}
const { chromium } = loadPlaywright();

function findPlaywrightChromium() {
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extPath = path.join(root, 'apps/extension/.output/chrome-mv3');
if (!fs.existsSync(path.join(extPath, 'manifest.json'))) throw new Error(`extension not built at ${extPath}`);
const outDir = path.join(root, 'e2e/.out');
fs.mkdirSync(outDir, { recursive: true });

const PORT = 4317;
const { server } = await startFixture(PORT);
const APP = `http://localhost:${PORT}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-'));

const failures = [];
const check = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures.push(msg);
};

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  // Google Chrome ≥137 no longer honours --load-extension; use Chromium (Playwright's or your own via TL_EXE).
  channel: process.env.TL_CHANNEL || undefined,
  executablePath: process.env.TL_EXE || findPlaywrightChromium(),
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-first-run', '--window-size=1400,900'],
  viewport: { width: 1300, height: 800 },
});

try {
  // ---- find the extension service worker ----
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);

  // close the options tab the install opened, keep one page for the app
  for (const p of context.pages()) if (p.url().includes('options.html')) await p.close();

  // ---- configure via an extension page (has chrome.* APIs) ----
  const cfgPage = await context.newPage();
  await cfgPage.goto(`chrome-extension://${extId}/options.html`);
  await cfgPage.evaluate(
    async ({ APP }) => {
      const settings = {
        monitoredOrigins: [APP],
        preWindowMs: 300000,
        postWindowMs: 3000,
        captureBodies: true,
        maxBodyBytes: 262144,
        domReplay: true,
        maskAllInputs: true,
        environmentName: 'QA',
        appNames: { [APP]: 'Fixture Shop' },
        redaction: { extraKeys: [], extraPatterns: [] },
        traceLinkTemplates: { 'x-request-id': 'https://logs.example.com/?q={value}' },
        telemetryHostsExtra: [],
        retentionDays: 7,
        onboarded: true,
        tracker: {
          trackerId: 'jira-cloud',
          baseUrl: `${APP}/jira`,
          email: 'tester@example.com',
          token: 'tok',
          projectKey: 'SHOP',
          issueTypeId: '10004',
          issueTypeName: 'Bug',
          mapping: { trackerId: 'jira-cloud', projectKey: 'SHOP', issueTypeId: '10004', fields: { labels: ['$labels', 'e2e'], priority: 'High', customfield_10042: '{{draft.environmentSummary}}' }, attachKinds: [], maxDescriptionChars: 30000 },
        },
      };
      await chrome.storage.local.set({ 'tl.settings': settings });
      await chrome.runtime.sendMessage({ type: 'tl:apply-monitoring' });
    },
    { APP },
  );
  const regs = await cfgPage.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  check(regs.length === 2, `content scripts registered for monitored origin (${regs.map((r) => r.id).join(',')})`);
  if (regs.length !== 2) {
    const diag = await cfgPage.evaluate(async () => {
      const out = { perms: await chrome.permissions.getAll(), contains: await chrome.permissions.contains({ origins: ['http://localhost/*'] }) };
      try {
        await chrome.scripting.registerContentScripts([{ id: 'diag', js: ['content-scripts/content.js'], matches: ['http://localhost/*'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true }]);
        out.manual = 'ok';
        await chrome.scripting.unregisterContentScripts({ ids: ['diag'] });
      } catch (e) {
        out.manual = String(e?.message ?? e);
      }
      return out;
    });
    console.log('  registration diagnostics:', JSON.stringify(diag));
  }

  // ---- drive the app under test ----
  const app = context.pages()[0] ?? (await context.newPage());
  await app.goto(APP + '/');
  await app.waitForTimeout(800);
  await app.click('#ok');
  await app.waitForTimeout(300);
  await app.fill('#amount', '99');
  await app.click('#submit'); // 200
  await app.waitForTimeout(300);
  await app.click('#submit'); // 200
  await app.waitForTimeout(300);
  await app.click('#route');
  await app.waitForTimeout(200);
  await app.click('#boom');
  await app.waitForTimeout(200);
  await app.click('#submit'); // 500 + console.error + unhandled rejection
  await app.waitForTimeout(1200);

  const tabId = await cfgPage.evaluate(async ({ APP }) => (await chrome.tabs.query({ url: `${APP}/*` }))[0].id, { APP });
  const status = await cfgPage.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'tl:get-tab-status', tabId }), tabId);
  console.log('tab status', JSON.stringify(status.data.counts));
  check(status.data.monitored, 'tab is monitored');
  check(status.data.counts.exchanges >= 4, 'network exchanges buffered');
  check(status.data.counts.console >= 2, 'console entries buffered');
  check(status.data.counts.errors >= 2, 'errors buffered');
  check(status.data.counts.interactions >= 5, 'interactions buffered');
  check(status.data.counts.rrwebChunks >= 1, 'rrweb chunks buffered');

  // ---- Report Issue ----
  await app.bringToFront();
  const inc0 = await cfgPage.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'tl:report-issue', tabId, note: 'Receipt submit shows error' }), tabId);
  check(inc0.ok, `incident started: ${inc0.ok ? inc0.data.incidentId : inc0.error}`);
  const incidentId = inc0.data.incidentId;

  let inc;
  for (let i = 0; i < 20; i++) {
    await cfgPage.waitForTimeout(500);
    const r = await cfgPage.evaluate((id) => chrome.runtime.sendMessage({ type: 'tl:get-incident', incidentId: id }), incidentId);
    inc = r.data;
    if (inc && inc.status !== 'collecting') break;
  }
  check(inc?.status === 'ready', `incident finalized (status=${inc?.status}${inc?.error ? ` error=${inc.error.split('\n')[0]}` : ''})`);
  const ctx = inc.context;
  const draft = inc.draft;
  fs.writeFileSync(path.join(outDir, 'context.json'), JSON.stringify(ctx, null, 2));
  fs.writeFileSync(path.join(outDir, 'draft.json'), JSON.stringify(draft, null, 2));

  if (ctx) {
    const fail = ctx.exchanges.find((e) => e.url.endsWith('/api/merchant/receipt') && e.response?.status === 500);
    check(Boolean(fail), 'the 500 exchange is in the context');
    check(fail?.bodyCapture.response === 'full', `500 response body captured (${fail?.bodyCapture.response})`);
    check(fail?.response?.body?.data.includes('db timeout'), 'response body content present');
    check(fail?.request.body?.data && !fail.request.body.data.includes('hunter2'), 'password in request body redacted');
    check(!JSON.stringify(ctx.exchanges).includes('secret-token-value'), 'bearer token redacted');
    check(!JSON.stringify(ctx.exchanges).includes('sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'api key redacted');
    check(!JSON.stringify(ctx.exchanges).includes('4111111111111111'), 'card number redacted');
    check(fail?.correlationIds.some((c) => c.header === 'x-request-id'), 'correlation id extracted');
    check(ctx.evidence?.focal?.refId === fail?.id, `focal event is the 500 (${ctx.evidence?.focal?.reasons[0]})`);
    check(ctx.errors.some((e) => e.kind === 'uncaught' && e.message.includes('Kaboom')), 'uncaught error captured');
    check(ctx.errors.some((e) => e.kind === 'unhandledrejection'), 'unhandled rejection captured');
    check(ctx.console.some((c) => c.level === 'error' && c.args[0].includes('Failed to submit')), 'console.error captured');
    check(ctx.interactions.some((i) => i.kind === 'click' && i.target.text === 'Submit receipt'), 'click interaction with button text captured');
    check(ctx.navigation.some((n) => n.kind === 'pushState' && n.to.endsWith('/orders')), 'SPA pushState navigation captured');
    check(ctx.application.version === '2.3.1-rc4', `app version from meta tag (${ctx.application.version})`);
    check(ctx.application.name === 'Fixture Shop', 'app name from settings');
    const kinds = ctx.artifacts.map((a) => a.kind);
    check(kinds.includes('screenshot'), 'screenshot artifact');
    check(kinds.includes('rrweb'), 'rrweb artifact');
    check(kinds.includes('har-focused') && kinds.includes('console-log') && kinds.includes('incident-viewer'), `text artifacts (${kinds.join(',')})`);
    check(ctx.evidence?.observations.some((o) => o.includes('succeeded 2 time(s)')), 'success-then-fail observation');
    check(ctx.evidence?.items.some((i) => i.kind === 'interaction' && i.reasons.join().includes('likely cause')), 'click→request causality detected');
    console.log('  summary:', draft.summary);
    console.log('  steps:', JSON.stringify(draft.stepsToReproduce));
    check(draft.summary.includes('POST /api/merchant/receipt returns 500'), 'summary names the failed request');
    check(draft.stepsToReproduce.some((s) => s.includes('Submit receipt')), 'steps include the click');
    check(draft.sections.some((s) => s.id === 'trace-links' && s.body.includes('logs.example.com')), 'trace link rendered');
    check(draft.sections.some((s) => s.id === 'curl'), 'curl section present');

    // save the viewer & screenshot for manual inspection
    if (inc.warnings?.length) console.log('  warnings:', inc.warnings.join(' | '));
    for (const kind of ['incident-viewer', 'screenshot', 'har-focused', 'network-log']) {
      const a = ctx.artifacts.find((x) => x.kind === kind);
      if (!a) continue;
      const b = await cfgPage.evaluate((ref) => chrome.runtime.sendMessage({ type: 'tl:get-blob', blobId: ref }), a.storage.ref);
      const data = Buffer.from(b.data.dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(outDir, a.fileName), data);
    }
  }

  // ---- side panel renders ----
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForTimeout(1500);
  const panelText = await panel.textContent('body');
  check(panelText.includes('Focal event') || panelText.includes('Incidents'), 'side panel renders');
  await panel.screenshot({ path: path.join(outDir, 'sidepanel.png'), fullPage: true });
  // Evidence tab: expand the focal exchange to verify the request/response detail view
  await panel.click('.tabs button:nth-child(2)');
  await panel.waitForTimeout(500);
  const focalItem = panel.locator('.item.focal .body').first();
  if (await focalItem.count()) {
    await focalItem.click();
    await panel.waitForTimeout(300);
    const detailText = await panel.textContent('body');
    check(detailText.includes('Request payload') && detailText.includes('Response body'), 'evidence tab shows request/response detail');
    check((await panel.locator('mark').count()) > 0, 'correlation id highlighted in detail view');
  }
  await panel.screenshot({ path: path.join(outDir, 'sidepanel-evidence.png'), fullPage: true });
  // Jira tab: destination comes from settings and can be changed per incident
  await panel.click('.tabs button:nth-child(3)');
  await panel.waitForTimeout(1200);
  const jiraText = await panel.textContent('body');
  check(jiraText.includes('SHOP · Bug'), 'jira tab shows destination from settings');
  const changeBtn = panel.getByRole('button', { name: 'Change' });
  if (await changeBtn.count()) {
    await changeBtn.click();
    await panel.waitForTimeout(1200);
    const projectSelect = panel.locator('select').first();
    const options = await projectSelect.locator('option').allTextContents();
    check(options.some((o) => o.includes('SHOP')), `project dropdown lists projects (${options.join(' | ')})`);
    check((await panel.textContent('body')).includes('Required fields'), 'required fields shown while changing destination');
  } else {
    check(false, 'Change button present on Jira tab (issue already created hides it)');
  }
  await panel.screenshot({ path: path.join(outDir, 'sidepanel-jira.png'), fullPage: true });
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  await popupPage.waitForTimeout(800);
  await popupPage.screenshot({ path: path.join(outDir, 'popup.png') });
  const optPage = await context.newPage();
  await optPage.goto(`chrome-extension://${extId}/options.html`);
  await optPage.waitForTimeout(800);
  await optPage.screenshot({ path: path.join(outDir, 'options.png'), fullPage: true });
  // ---- Jira preview + create against the mock ----
  const prev = await cfgPage.evaluate((id) => chrome.runtime.sendMessage({ type: 'tl:tracker-preview', incidentId: id }), incidentId);
  check(prev.ok, `jira preview ok (${prev.ok ? '' : prev.error})`);
  if (prev.ok) {
    check(prev.data.validation.ok, `jira validation ok (${JSON.stringify(prev.data.validation.problems)})`);
    check(prev.data.payload.fields.customfield_10042?.includes('Chrome'), 'template-mapped custom field filled');
    check(prev.data.payload.fields.priority?.id === '2', 'priority resolved by name');
  }
  const sim = await cfgPage.evaluate((id) => chrome.runtime.sendMessage({ type: 'tl:tracker-similar', incidentId: id }), incidentId);
  check(sim.ok && sim.data.length === 1 && sim.data[0].key === 'SHOP-1', 'similar issue search returned SHOP-1');

  const created = await cfgPage.evaluate((id) => chrome.runtime.sendMessage({ type: 'tl:tracker-create', incidentId: id }), incidentId);
  check(created.ok, `jira create ok (${created.ok ? created.data.created.key : created.error})`);
  if (created.ok) {
    const att = created.data.created.attachments;
    console.log('  attachments:', att.map((a) => `${a.fileName}:${a.ok ? 'ok' : a.error}`).join(', '));
    check(att.length >= 5 && att.every((a) => a.ok), 'all attachments uploaded');
    const state = await (await fetch(`${APP}/__state`)).json();
    const issue = state.jira.issues[0];
    check(issue.payload.fields.description.type === 'doc', 'description posted as ADF');
    check(issue.payload.fields.labels.includes('testlens') && issue.payload.fields.labels.includes('e2e'), 'labels merged');
    check(!JSON.stringify(issue).includes('hunter2') && !JSON.stringify(issue).includes('secret-token-value'), 'no secrets reached Jira payload');
  }

} catch (e) {
  console.error('E2E crashed:', e);
  failures.push(`crash: ${e.message}`);
} finally {
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
