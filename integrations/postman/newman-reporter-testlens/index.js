/**
 * newman-reporter-testlens — sends failed executions (4xx/5xx, request errors, failed assertions)
 * to a TestLens Hub as Postman payloads, one incident per failed request.
 *
 *   newman run collection.json -r cli,testlens --reporter-testlens-hub http://localhost:7331
 *   options: --reporter-testlens-hub <url>   (default http://localhost:7331 or $TL_HUB)
 *            --reporter-testlens-all          send every execution, not only failures
 *
 * Delivery happens from a short-lived detached helper process so it completes even though
 * newman exits as soon as the run finishes.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = function TestLensReporter(emitter, reporterOptions, collectionRunOptions) {
  const hub = (reporterOptions.hub || process.env.TL_HUB || 'http://localhost:7331').replace(/\/+$/, '');
  const sendAll = Boolean(reporterOptions.all);
  const collectionName = collectionRunOptions && collectionRunOptions.collection && collectionRunOptions.collection.name;
  const envName = collectionRunOptions && collectionRunOptions.environment && collectionRunOptions.environment.name;
  const payloads = [];
  const byItem = new Map(); // `${item id}:${iteration}` → { item, iteration, request, response, error, tests[] }
  const key = (args) => `${args.item && args.item.id}:${args.cursor ? args.cursor.iteration : 0}`;

  emitter.on('request', (err, args) => {
    const entry = byItem.get(key(args)) || { tests: [] };
    Object.assign(entry, { item: args.item, iteration: args.cursor ? args.cursor.iteration : 0, request: args.request, response: args.response, error: err ? err.message : undefined });
    byItem.set(key(args), entry);
  });

  emitter.on('assertion', (err, args) => {
    const entry = byItem.get(key(args)) || { tests: [] };
    entry.tests.push({ name: args.assertion, passed: !err, error: err ? err.message : undefined });
    byItem.set(key(args), entry);
  });

  emitter.on('item', (err, args) => {
    const e = byItem.get(key(args));
    byItem.delete(key(args));
    if (!e || !e.request) return;
    const code = e.response ? e.response.code : 0;
    const failed = e.error || code >= 400 || code === 0 || e.tests.some((t) => !t.passed);
    if (!failed && !sendAll) return;
    const headers = (hl) => (hl && hl.members ? hl.members.map((h) => ({ key: h.key, value: String(h.value) })) : []);
    let resBody = '';
    try {
      resBody = e.response && e.response.stream ? Buffer.from(e.response.stream).toString('utf8') : '';
    } catch (_) {
      /* binary */
    }
    payloads.push({
      source: 'postman',
      snippetVersion: 'newman-1',
      timestamp: new Date().toISOString(),
      collection: collectionName,
      requestName: e.item && e.item.name,
      iteration: e.iteration,
      environment: { name: envName },
      request: { method: e.request.method, url: e.request.url ? e.request.url.toString() : '', headers: headers(e.request.headers), body: e.request.body ? { mode: e.request.body.mode, raw: e.request.body.raw } : undefined },
      response: e.response ? { code: e.response.code, status: e.response.status, headers: headers(e.response.headers), body: resBody.slice(0, 262144), responseTime: e.response.responseTime, responseSize: e.response.responseSize } : undefined,
      error: e.error,
      tests: e.tests,
      postmanVersion: 'newman',
    });
  });

  emitter.on('beforeDone', () => {
    if (!payloads.length) return;
    const file = path.join(os.tmpdir(), `testlens-newman-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ hub, payloads }));
    const child = spawn(process.execPath, [path.join(__dirname, 'send.js'), file], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`[testlens] ${payloads.length} failed execution(s) queued for ${hub} — review in the TestLens side panel (Incidents → Sync from Hub)`);
  });
};
