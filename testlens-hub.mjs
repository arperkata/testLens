#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// apps/hub/src/server.ts
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// apps/hub/src/embedded.ts
var HUB_VERSION = "0.1.0";
var LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>TestLens Hub</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e6e8ee;--muted:#8b93a7;--acc:#4f8cff;--ok:#3ecf8e}
body{margin:0;background:var(--bg);color:var(--fg);font:14px ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:26px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin:10px 0}
pre{background:#0b0d12;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}
code{font-family:ui-monospace,Consolas,monospace}.ok{color:var(--ok)}.muted{color:var(--muted)}
ol li{margin:4px 0}button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
</style>
</head>
<body>
<main>
  <h1>TestLens Hub <span class="ok">\u25CF running on port {{PORT}}</span></h1>
  <p class="muted">Receives evidence from API-testing tools and turns it into reviewed bug reports. Nothing is created in your tracker from here: open the TestLens side panel in Chrome/Edge \u2192 <b>Incidents</b> \u2192 <b>Sync from Hub</b> to review and create.</p>

  <h2>Postman \u2014 paste once into your collection</h2>
  <div class="card">
    <ol>
      <li>In Postman, open the collection \u2192 <b>Scripts</b> \u2192 <b>Post-response</b> (older versions: <b>Tests</b>).</li>
      <li>Paste the snippet below. It sends a request to this Hub only when the response is 4xx/5xx, a request error occurred, or a <code>pm.test</code> in the same script failed.</li>
      <li>To force a report for a specific request, set <code>pm.variables.set("TL_REPORT", "reason")</code> before the snippet runs.</li>
      <li>Run requests as usual. Failures appear in the TestLens side panel after <b>Sync from Hub</b>.</li>
    </ol>
    <button onclick="navigator.clipboard.writeText(document.getElementById('snip').textContent)">Copy snippet</button>
    <pre id="snip">{{SNIPPET}}</pre>
  </div>

  <h2>Newman (CLI / CI)</h2>
  <div class="card">
    <p>Install the reporter from this repo (<code>integrations/postman/newman-reporter-testlens</code>) and run:</p>
    <pre>newman run collection.json -e env.json -r cli,testlens --reporter-testlens-hub http://localhost:{{PORT}}</pre>
    <p class="muted">Or export a run as JSON (<code>-r json --reporter-json-export run.json</code>) and import the file in the side panel or with the command below.</p>
  </div>

  <h2>Import a file (HAR, Newman run JSON, Postman payload)</h2>
  <div class="card">
    <pre>curl -X POST http://localhost:{{PORT}}/import -H "Content-Type: application/json" -H "X-TestLens-Filename: run.json" --data-binary @run.json</pre>
    <p class="muted">HAR files from DevTools, Charles, Fiddler, Proxyman or Insomnia work too. The TestLens side panel can also import these files directly without the Hub.</p>
  </div>

  <h2>API</h2>
  <div class="card">
    <pre>GET  /health
POST /ingest/postman
POST /import
GET  /incidents
GET  /incidents/:id
GET  /incidents/:id/artifacts/:artifactId
DELETE /incidents/:id</pre>
  </div>
</main>
</body>
</html>
`;
var SNIPPET_JS = `// ---- TestLens snippet v1 \u2014 paste into the collection's Post-response (Tests) script ----
// Sends evidence to your local TestLens Hub ONLY when something failed:
//   \u2022 response status >= 400, or a request error
//   \u2022 a pm.test(...) in this script failed (wrap your tests below the "pm.test = tlTest" line)
//   \u2022 you set pm.variables.set("TL_REPORT", "why") before this script runs
// Review and create the bug in the TestLens side panel (Incidents \u2192 Sync from Hub).
(function () {
  var TL_HUB = pm.variables.get('TL_HUB') || 'http://localhost:7331';
  var tlTests = [];
  var _test = pm.test;
  // wrapper that records assertion outcomes without changing Postman's own reporting
  pm.test = function tlTest(name, fn) {
    return _test(name, function () {
      try {
        fn();
        tlTests.push({ name: name, passed: true });
      } catch (e) {
        tlTests.push({ name: name, passed: false, error: e && e.message ? e.message : String(e) });
        throw e;
      }
    });
  };

  // Put your own pm.test(...) calls here (or in request-level scripts that run in this sandbox).

  var forced = pm.variables.get('TL_REPORT');
  var code = pm.response ? pm.response.code : 0;
  var failedTests = tlTests.filter(function (t) { return !t.passed; });
  if (!(forced || code >= 400 || code === 0 || failedTests.length)) return;
  if (forced) pm.variables.unset('TL_REPORT');

  var headersOf = function (list) {
    var out = [];
    try { list.each(function (h) { out.push({ key: h.key, value: String(h.value) }); }); } catch (e) {}
    return out;
  };
  var reqBody = '';
  try { reqBody = pm.request.body ? (pm.request.body.raw || JSON.stringify(pm.request.body.toJSON())) : ''; } catch (e) {}
  var resBody = '';
  try { resBody = pm.response ? pm.response.text() : ''; } catch (e) {}
  if (resBody && resBody.length > 262144) resBody = resBody.slice(0, 262144) + '\\n...[truncated by TestLens]';

  var info = (pm.info || {});
  var payload = {
    source: 'postman',
    snippetVersion: '1',
    timestamp: new Date().toISOString(),
    note: typeof forced === 'string' && forced !== 'true' ? forced : undefined,
    collection: (pm.collectionVariables && pm.collectionVariables.get('TL_COLLECTION')) || undefined,
    requestName: info.requestName,
    iteration: info.iteration,
    environment: { name: pm.environment ? pm.environment.name : undefined },
    request: {
      method: pm.request.method,
      url: pm.request.url.toString(),
      headers: headersOf(pm.request.headers),
      body: { mode: pm.request.body ? pm.request.body.mode : undefined, raw: reqBody }
    },
    response: pm.response ? {
      code: pm.response.code,
      status: pm.response.status,
      headers: headersOf(pm.response.headers),
      body: resBody,
      responseTime: pm.response.responseTime,
      responseSize: pm.response.responseSize
    } : undefined,
    tests: tlTests
  };

  pm.sendRequest({
    url: TL_HUB + '/ingest/postman',
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: { mode: 'raw', raw: JSON.stringify(payload) }
  }, function (err, res) {
    if (err) console.warn('TestLens Hub not reachable at ' + TL_HUB + ' (' + err + '). Start it with: npx testlens-hub');
    else console.log('TestLens: incident sent \u2192 open the side panel \u2192 Incidents \u2192 Sync from Hub');
  });
})();
`;

// packages/redaction/src/index.ts
var RULES_VERSION = "1.0";
var DEFAULT_RULES = {
  sensitiveKeys: [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "clientsecret",
    "token",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "id_token",
    "idtoken",
    "api_key",
    "apikey",
    "private_key",
    "privatekey",
    "session",
    "sessionid",
    "session_id",
    "otp",
    "pin",
    "ssn",
    "cvv",
    "card_number",
    "cardnumber"
  ],
  patterns: [
    { id: "jwt", regex: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b", flags: "g", hint: "eyJ" },
    { id: "bearer", regex: "\\b[Bb]earer\\s+[A-Za-z0-9._~+/=-]{16,}", flags: "g", hint: "earer" },
    { id: "aws-access-key", regex: "\\bAKIA[0-9A-Z]{16}\\b", flags: "g", hint: "AKIA" },
    { id: "openai-key", regex: "\\bsk-[A-Za-z0-9_-]{20,}\\b", flags: "g", hint: "sk-" },
    { id: "github-token", regex: "\\bgh[pousr]_[A-Za-z0-9]{30,}\\b", flags: "g", hint: "gh" },
    { id: "slack-token", regex: "\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b", flags: "g", hint: "xox" },
    { id: "credit-card", regex: "\\b(?:\\d[ -]?){13,19}\\b", flags: "g", hint: "digits13" }
  ],
  maxBodyBytes: 256 * 1024
};
function newStats() {
  return { counts: {} };
}
function bump(stats, key) {
  stats.counts[key] = (stats.counts[key] ?? 0) + 1;
}
function fnv1a(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function mask(value) {
  return `\xABredacted:${fnv1a(value)}\xBB`;
}
var keyCache = /* @__PURE__ */ new WeakMap();
function normalizeKey(k) {
  return k.toLowerCase().replace(/[-_\s]/g, "");
}
function sensitiveKeys(rules) {
  let c = keyCache.get(rules);
  if (!c) {
    const norm = rules.sensitiveKeys.map(normalizeKey);
    c = { exact: new Set(norm), suffixes: norm };
    keyCache.set(rules, c);
  }
  return c;
}
function isSensitiveKey(key, rules) {
  const k = normalizeKey(key);
  const { exact, suffixes } = sensitiveKeys(rules);
  if (exact.has(k)) return true;
  for (const s of suffixes) if (k.endsWith(s)) return true;
  return false;
}
var compiledCache = /* @__PURE__ */ new WeakMap();
function compiled(rules) {
  let c = compiledCache.get(rules);
  if (!c) {
    c = rules.patterns.map((p) => ({ id: p.id, re: new RegExp(p.regex, p.flags ?? "g"), hint: p.hint }));
    compiledCache.set(rules, c);
  }
  return c;
}
var DIGIT_RUN = /\d/g;
function mayMatch(text, hint) {
  if (!hint) return true;
  if (hint === "digits13") {
    let n = 0;
    DIGIT_RUN.lastIndex = 0;
    while (DIGIT_RUN.exec(text)) if (++n >= 13) return true;
    return false;
  }
  return text.includes(hint);
}
function redactHeaders(headers2, rules, stats) {
  return headers2.map((h) => {
    if (isSensitiveKey(h.name, rules)) {
      bump(stats, `header.${h.name.toLowerCase()}`);
      return { name: h.name, value: mask(h.value) };
    }
    return { name: h.name, value: redactText(h.value, rules, stats, "header-value") };
  });
}
function redactUrl(url, rules, stats) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of Array.from(u.searchParams.entries())) {
      if (isSensitiveKey(k, rules)) {
        u.searchParams.set(k, mask(v));
        bump(stats, `query.${k.toLowerCase()}`);
        changed = true;
      }
    }
    if (u.username || u.password) {
      u.username = u.username ? "redacted" : "";
      u.password = u.password ? "redacted" : "";
      bump(stats, "url.userinfo");
      changed = true;
    }
    const out = changed ? u.toString() : url;
    return redactText(out, rules, stats, "url");
  } catch {
    return redactText(url, rules, stats, "url");
  }
}
function redactText(text, rules, stats, where = "text") {
  if (text.length < 8) return text;
  let out = text;
  for (const { id, re, hint } of compiled(rules)) {
    if (!mayMatch(out, hint)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      bump(stats, `pattern.${id}@${where}`);
      return mask(m);
    });
  }
  return out;
}
function redactJsonValue(value, rules, stats, depth = 0) {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, rules, stats, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k, rules) && (typeof v === "string" || typeof v === "number")) {
        bump(stats, `json.${k.toLowerCase()}`);
        out[k] = mask(String(v));
      } else {
        out[k] = redactJsonValue(v, rules, stats, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string") return redactText(value, rules, stats, "json");
  return value;
}
function redactBodyString(body, mimeType, rules, stats) {
  const mt = (mimeType ?? "").toLowerCase();
  const trimmed = body.trimStart();
  if (mt.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(redactJsonValue(parsed, rules, stats));
    } catch {
    }
  }
  if (mt.includes("x-www-form-urlencoded")) {
    const p = new URLSearchParams(body);
    for (const [k, v] of Array.from(p.entries())) {
      if (isSensitiveKey(k, rules)) {
        p.set(k, mask(v));
        bump(stats, `form.${k.toLowerCase()}`);
      }
    }
    return redactText(p.toString(), rules, stats, "form");
  }
  return redactText(body, rules, stats, "body");
}
function redactExchange(ex, rules, stats) {
  const out = {
    ...ex,
    url: redactUrl(ex.url, rules, stats),
    correlationIds: ex.correlationIds.filter((c) => !isSensitiveKey(c.header, rules)),
    request: {
      ...ex.request,
      headers: redactHeaders(ex.request.headers, rules, stats),
      body: ex.request.body ? { ...ex.request.body, data: ex.request.body.encoding === "base64" ? ex.request.body.data : redactBodyString(ex.request.body.data, ex.request.body.mimeType, rules, stats) } : void 0
    }
  };
  if (ex.response) {
    out.response = {
      ...ex.response,
      headers: redactHeaders(ex.response.headers, rules, stats),
      body: ex.response.body ? { ...ex.response.body, data: ex.response.body.encoding === "base64" ? ex.response.body.data : redactBodyString(ex.response.body.data, ex.response.body.mimeType, rules, stats) } : void 0
    };
  }
  return out;
}
function redactContext(ctx, rules = DEFAULT_RULES) {
  const stats = newStats();
  const out = {
    ...ctx,
    exchanges: ctx.exchanges.map((e) => redactExchange(e, rules, stats)),
    console: ctx.console.map((c) => ({ ...c, args: c.args.map((a) => redactText(a, rules, stats, "console")) })),
    errors: ctx.errors.map((e) => ({ ...e, message: redactText(e.message, rules, stats, "error"), stack: e.stack ? redactText(e.stack, rules, stats, "error") : void 0 })),
    navigation: ctx.navigation.map((n) => ({ ...n, to: redactUrl(n.to, rules, stats), from: n.from ? redactUrl(n.from, rules, stats) : void 0 })),
    application: { ...ctx.application, url: ctx.application.url ? redactUrl(ctx.application.url, rules, stats) : void 0 },
    execution: ctx.execution ? { ...ctx.execution, variables: ctx.execution.variables ? redactJsonValue(ctx.execution.variables, rules, stats) : void 0 } : void 0,
    redaction: {
      appliedAt: Array.from(/* @__PURE__ */ new Set([...ctx.redaction.appliedAt, "export"])),
      rulesVersion: RULES_VERSION,
      counts: mergeCounts(ctx.redaction.counts, stats.counts)
    }
  };
  return out;
}
function mergeCounts(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

// packages/evidence-engine/src/index.ts
var ENGINE_VERSION = "1.0.0";
var DEFAULT_ENGINE_OPTIONS = {
  windowBeforeMs: 3e4,
  windowAfterMs: 1e4,
  telemetryHosts: [
    "google-analytics.com",
    "googletagmanager.com",
    "analytics.",
    "segment.io",
    "segment.com",
    "mixpanel.com",
    "hotjar.com",
    "sentry.io",
    "datadoghq.com",
    "newrelic.com",
    "nr-data.net",
    "fullstory.com",
    "intercom.io",
    "doubleclick.net",
    "facebook.net",
    "clarity.ms",
    "amplitude.com",
    "launchdarkly.com"
  ],
  correlationHeaders: ["x-request-id", "x-correlation-id", "x-trace-id", "traceparent", "x-amzn-trace-id", "x-b3-traceid", "request-id", "x-cloud-trace-context", "cf-ray"],
  slowMs: 5e3,
  maxItems: 60
};
var STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)(\?|$)/i;
function classifyExchanges(exchanges, opts = DEFAULT_ENGINE_OPTIONS) {
  const byKey = /* @__PURE__ */ new Map();
  for (const e of exchanges) {
    const k = `${e.method} ${stripQuery(e.url)}`;
    const arr = byKey.get(k) ?? [];
    arr.push(e.ts);
    byKey.set(k, arr);
  }
  const polling = /* @__PURE__ */ new Set();
  for (const [k, tss] of byKey) {
    if (tss.length < 4) continue;
    tss.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < tss.length; i++) gaps.push(tss[i] - tss[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
    if (mean > 500 && Math.sqrt(variance) / mean < 0.35) polling.add(k);
  }
  return exchanges.map((e) => {
    let host = "";
    try {
      host = new URL(e.url).hostname;
    } catch {
    }
    const isTelemetry = opts.telemetryHosts.some((h) => host.includes(h));
    const mime = e.response?.mimeType ?? headerValue(e.response?.headers ?? [], "content-type") ?? "";
    const isStatic = STATIC_EXT.test(e.url) || ["script", "img", "css", "font", "media"].includes(e.initiator?.type ?? "") || /^(image|font|video|audio|text\/css|application\/javascript|text\/javascript)/i.test(mime);
    const isApi = !isStatic && !isTelemetry && (e.initiator?.type === "fetch" || e.initiator?.type === "xhr" || e.initiator?.type === "tool" || /json|xml|graphql/i.test(mime));
    return {
      ...e,
      classification: { isApi, isStatic, isTelemetry, isPolling: polling.has(`${e.method} ${stripQuery(e.url)}`) },
      correlationIds: e.correlationIds.length ? e.correlationIds : extractCorrelationIds(e, opts)
    };
  });
}
function extractCorrelationIds(e, opts = DEFAULT_ENGINE_OPTIONS) {
  const out = [];
  const all = [...e.request.headers, ...e.response?.headers ?? []];
  for (const h of all) {
    if (opts.correlationHeaders.includes(h.name.toLowerCase()) && h.value) out.push({ header: h.name.toLowerCase(), value: h.value });
  }
  return dedupe(out, (c) => `${c.header}:${c.value}`);
}
function recencyBoost(ts, triggerAt) {
  const dt = Math.abs(triggerAt - ts);
  return Math.max(0, 1 - dt / 3e5);
}
function scoreCandidates(ctx, opts) {
  const out = [];
  const t0 = ctx.trigger.at;
  for (const e of ctx.exchanges) {
    if (e.classification.isTelemetry) continue;
    const reasons = [];
    let score = 0;
    const status = e.response?.status;
    if (e.error) {
      score += 70;
      reasons.push(`request failed (${e.error.kind}${e.error.message ? `: ${e.error.message}` : ""})`);
    } else if (status !== void 0 && status >= 500) {
      score += 90;
      reasons.push(`server error ${status}`);
    } else if (status === 401 || status === 403) {
      score += 45;
      reasons.push(`auth/permission error ${status}`);
    } else if (status !== void 0 && status >= 400) {
      score += 55;
      reasons.push(`client error ${status}`);
    }
    if (e.timing && e.timing.totalMs > opts.slowMs) {
      score += 20;
      reasons.push(`slow response (${Math.round(e.timing.totalMs)} ms)`);
    }
    if (score === 0) continue;
    if (e.classification.isApi) {
      score += 10;
      reasons.push("API call");
    }
    if (e.classification.isStatic) score -= 25;
    if (e.classification.isPolling) {
      score -= 15;
      reasons.push("looks like polling");
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(e.method.toUpperCase())) {
      score += 8;
      reasons.push("mutating request");
    }
    const rb = recencyBoost(e.ts, t0);
    score = score * (0.4 + 0.6 * rb);
    reasons.push(`${describeOffset(e.ts, t0)} Report Issue`);
    out.push({ kind: "exchange", refId: e.id, score: round(score), reasons });
  }
  for (const er of ctx.errors) {
    const base = er.kind === "uncaught" ? 60 : er.kind === "unhandledrejection" ? 55 : er.kind === "csp" ? 35 : 25;
    const score = base * (0.4 + 0.6 * recencyBoost(er.ts, t0));
    out.push({ kind: "error", refId: er.id, score: round(score), reasons: [`${er.kind} error: ${truncate(er.message, 80)}`, `${describeOffset(er.ts, t0)} Report Issue`] });
  }
  for (const a of ctx.assertions) {
    if (a.passed) continue;
    const score = 85 * (0.5 + 0.5 * recencyBoost(a.ts, t0));
    out.push({ kind: "assertion", refId: a.id, score: round(score), reasons: [`assertion failed: ${truncate(a.name, 80)}`] });
  }
  for (const c of ctx.console) {
    if (c.level !== "error") continue;
    const score = 30 * (0.4 + 0.6 * recencyBoost(c.ts, t0));
    out.push({ kind: "console", refId: c.id, score: round(score), reasons: [`console.error: ${truncate(c.args.join(" "), 80)}`, `${describeOffset(c.ts, t0)} Report Issue`] });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
function runEvidenceEngine(input, options = {}, overrideFocal) {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const ctx = { ...input, exchanges: classifyExchanges(input.exchanges, opts) };
  const candidates = scoreCandidates(ctx, opts);
  let focal = candidates[0];
  if (overrideFocal) {
    focal = candidates.find((c) => c.kind === overrideFocal.kind && c.refId === overrideFocal.refId) ?? { ...overrideFocal, score: 100, reasons: ["selected by tester"] };
  }
  const focalTs = focal ? tsOf(ctx, focal.kind, focal.refId) ?? ctx.trigger.at : ctx.trigger.at;
  const window = { start: focalTs - opts.windowBeforeMs, end: Math.max(focalTs + opts.windowAfterMs, ctx.trigger.at + ctx.trigger.postWindowMs) };
  const focalExchange = focal?.kind === "exchange" ? ctx.exchanges.find((e) => e.id === focal.refId) : void 0;
  const focalCorr = new Set((focalExchange?.correlationIds ?? []).map((c) => c.value));
  const focalPath = focalExchange ? pathOf(focalExchange.url) : void 0;
  const focalError = focal?.kind === "error" ? ctx.errors.find((e) => e.id === focal.refId) : void 0;
  const items = [];
  const push = (kind, refId, score, reasons) => {
    items.push({ kind, refId, score: round(score), reasons, include: true });
  };
  if (focal) push(focal.kind, focal.refId, 100, ["focal event"]);
  for (const e of ctx.exchanges) {
    if (focal && e.id === focal.refId) continue;
    if (e.classification.isTelemetry) continue;
    const reasons = [];
    let score = 0;
    const inWindow = e.ts >= window.start && e.ts <= window.end;
    if (e.correlationIds.some((c) => focalCorr.has(c.value))) {
      score += 60;
      reasons.push("shares correlation id with focal request");
    }
    if (focalPath && pathOf(e.url) === focalPath) {
      score += 35;
      reasons.push("same endpoint as focal request");
    }
    if (focalError?.stack && focalError.stack.includes(pathOf(e.url))) {
      score += 30;
      reasons.push("endpoint appears in error stack");
    }
    const st = e.response?.status;
    if (e.error || st !== void 0 && st >= 400) {
      score += inWindow ? 40 : 15;
      reasons.push(`failed (${e.error?.kind ?? st})`);
    }
    if (inWindow && e.classification.isApi && !e.classification.isPolling) {
      score += 20;
      reasons.push("API call inside evidence window");
    }
    if (e.classification.isStatic) score -= 30;
    if (score <= 0) continue;
    push("exchange", e.id, score, reasons);
  }
  for (const er of ctx.errors) {
    if (focal && er.id === focal.refId) continue;
    const inWindow = er.ts >= window.start && er.ts <= window.end;
    const reasons = [inWindow ? "error inside evidence window" : "error in buffer"];
    let score = inWindow ? 55 : 20;
    if (focalPath && er.stack?.includes(focalPath)) {
      score += 25;
      reasons.push("stack mentions focal endpoint");
    }
    push("error", er.id, score, reasons);
  }
  for (const c of ctx.console) {
    if (focal && c.id === focal.refId) continue;
    const inWindow = c.ts >= window.start && c.ts <= window.end;
    if (c.level === "error" || c.level === "warn") {
      let score = (c.level === "error" ? 40 : 20) * (inWindow ? 1 : 0.4);
      const reasons = [`console.${c.level}${inWindow ? " inside evidence window" : ""}`];
      if (focalPath && c.args.some((a) => a.includes(focalPath))) {
        score += 25;
        reasons.push("mentions focal endpoint");
      }
      push("console", c.id, score, reasons);
    } else if (inWindow && focalPath && c.args.some((a) => a.includes(focalPath))) {
      push("console", c.id, 25, ["console output mentions focal endpoint"]);
    }
  }
  for (const i of ctx.interactions) {
    const inWindow = i.ts >= window.start && i.ts <= window.end;
    if (!inWindow) continue;
    let score = 15;
    const reasons = ["interaction inside evidence window"];
    if (focalExchange && focalExchange.ts - i.ts >= 0 && focalExchange.ts - i.ts < 3e3 && (i.kind === "click" || i.kind === "submit")) {
      score += 45;
      reasons.push(`${i.kind} ${Math.round(focalExchange.ts - i.ts)} ms before focal request (likely cause)`);
    }
    if (i.kind === "click" || i.kind === "submit") score += 10;
    push("interaction", i.id, score, reasons);
  }
  for (const n of ctx.navigation) {
    const inWindow = n.ts >= window.start && n.ts <= window.end;
    push("navigation", n.id, inWindow ? 30 : 8, [inWindow ? "navigation inside evidence window" : "navigation in buffer"]);
  }
  for (const a of ctx.assertions) {
    if (focal && a.id === focal.refId) continue;
    push("assertion", a.id, a.passed ? 10 : 70, [a.passed ? "passing assertion" : "failed assertion"]);
  }
  items.sort((a, b) => b.score - a.score);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i >= opts.maxItems || it.score < 15) it.include = false;
  }
  const observations = observe(ctx, focalExchange);
  const captureQuality = assessCaptureQuality(ctx);
  const evidence = {
    engineVersion: ENGINE_VERSION,
    focal,
    candidates: candidates.slice(0, 10),
    items,
    window,
    observations,
    captureQuality
  };
  return { ...ctx, evidence };
}
function observe(ctx, focal) {
  const out = [];
  if (focal) {
    const path2 = pathOf(focal.url);
    const same = ctx.exchanges.filter((e) => e.id !== focal.id && e.method === focal.method && pathOf(e.url) === path2);
    const okBefore = same.filter((e) => e.ts < focal.ts && e.response && e.response.status < 400);
    const failBefore = same.filter((e) => e.ts < focal.ts && (e.error || e.response && e.response.status >= 400));
    if (okBefore.length && !failBefore.length) {
      out.push(`${focal.method} ${path2} succeeded ${okBefore.length} time(s) in the preceding ${minutes(ctx.trigger.preWindowMs)} and then failed \u2014 intermittent or state-dependent.`);
    } else if (failBefore.length) {
      out.push(`${focal.method} ${path2} failed ${failBefore.length + 1} time(s) in the buffer \u2014 consistently failing.`);
    } else if (!same.length) {
      out.push(`${focal.method} ${path2} was called once in the buffer; no baseline for comparison.`);
    }
    const retries = same.filter((e) => Math.abs(e.ts - focal.ts) < 5e3 && e.ts > focal.ts);
    if (retries.length) out.push(`${retries.length} retry/retries of the same endpoint within 5 s after the failure.`);
    if (focal.correlationIds.length) out.push(`Correlation id(s) available: ${focal.correlationIds.map((c) => `${c.header}=${c.value}`).join(", ")}.`);
    if (focal.bodyCapture.response !== "full") out.push(`Response body capture for the focal request: ${focal.bodyCapture.response}.`);
  }
  const uncaught = ctx.errors.filter((e) => e.kind === "uncaught" || e.kind === "unhandledrejection");
  if (uncaught.length) out.push(`${uncaught.length} uncaught JavaScript error(s) in the buffer.`);
  const failed = ctx.exchanges.filter((e) => !e.classification.isTelemetry && (e.error || e.response && e.response.status >= 400));
  if (failed.length) out.push(`${failed.length} failed/4xx/5xx request(s) in the buffer (excluding telemetry).`);
  return out;
}
function assessCaptureQuality(ctx) {
  const notes = [];
  let score = 100;
  const api = ctx.exchanges.filter((e) => e.classification.isApi);
  if (api.length) {
    const withBody = api.filter((e) => e.bodyCapture.response === "full" || e.bodyCapture.response === "truncated").length;
    const pct = Math.round(withBody / api.length * 100);
    if (pct < 100) {
      notes.push(`${pct}% of API responses have a captured body (others were not page fetch/XHR or exceeded limits).`);
      score -= Math.round((100 - pct) * 0.3);
    }
  } else {
    notes.push("No API calls observed in the buffer.");
    score -= 10;
  }
  const kinds = new Set(ctx.artifacts.map((a) => a.kind));
  const isBrowser = ctx.source.connectorId === "browser";
  if (isBrowser) {
    if (!kinds.has("screenshot")) {
      notes.push("No screenshot captured.");
      score -= 15;
    }
    if (!kinds.has("rrweb") && !kinds.has("video")) {
      notes.push("No visual recording (DOM replay or video) available.");
      score -= 20;
    } else if (!kinds.has("video")) {
      notes.push('DOM replay available; no pixel video (enable "Record this tab" for video).');
    }
    if (ctx.console.length === 0 && ctx.errors.length === 0) notes.push("No console output or errors observed; the page may have loaded before TestLens was active.");
  } else {
    if (ctx.assertions.length === 0) notes.push("No assertions were reported; failure detection relies on HTTP status only.");
    if (!ctx.exchanges.some((e) => e.response?.body)) {
      notes.push("No response bodies in the imported data.");
      score -= 15;
    }
  }
  return { score: Math.max(0, Math.min(100, score)), notes };
}
function buildHar(ctx, onlyIds) {
  const entries = ctx.exchanges.filter((e) => !onlyIds || onlyIds.has(e.id)).map((e) => {
    const started = new Date(e.ts).toISOString();
    const reqBody = e.request.body;
    const resBody = e.response?.body;
    return {
      startedDateTime: started,
      time: e.timing?.totalMs ?? 0,
      request: {
        method: e.method,
        url: e.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: e.request.headers,
        queryString: queryOf(e.url),
        postData: reqBody ? { mimeType: reqBody.mimeType ?? "application/octet-stream", text: reqBody.data, encoding: reqBody.encoding === "base64" ? "base64" : void 0 } : void 0,
        headersSize: -1,
        bodySize: e.request.bodyBytes ?? -1
      },
      response: e.response ? {
        status: e.response.status,
        statusText: e.response.statusText ?? "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: e.response.headers,
        content: {
          size: e.response.bodyBytes ?? resBody?.data.length ?? 0,
          mimeType: e.response.mimeType ?? headerValue(e.response.headers, "content-type") ?? "",
          text: resBody?.data,
          encoding: resBody?.encoding === "base64" ? "base64" : void 0,
          comment: `testlens.bodyCapture=${e.bodyCapture.response}`
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: e.response.bodyBytes ?? -1
      } : { status: 0, statusText: e.error ? `${e.error.kind}${e.error.message ? `: ${e.error.message}` : ""}` : "", httpVersion: "HTTP/1.1", cookies: [], headers: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
      cache: {},
      timings: { send: 0, wait: e.timing?.ttfbMs ?? e.timing?.totalMs ?? 0, receive: e.timing ? Math.max(0, e.timing.totalMs - (e.timing.ttfbMs ?? e.timing.totalMs)) : 0 },
      comment: JSON.stringify({ id: e.id, initiator: e.initiator?.type, classification: e.classification, correlationIds: e.correlationIds })
    };
  });
  return JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: { name: "TestLens", version: ENGINE_VERSION },
        browser: ctx.browser ? { name: ctx.browser.name, version: ctx.browser.version } : void 0,
        pages: [{ startedDateTime: new Date(ctx.trigger.at - ctx.trigger.preWindowMs).toISOString(), id: "page_1", title: ctx.application.title ?? ctx.application.url ?? "", pageTimings: {} }],
        entries
      }
    },
    null,
    2
  );
}
function buildConsoleLog(ctx) {
  const lines = [];
  lines.push(`# TestLens console & error log \u2014 incident ${ctx.incidentId}`);
  lines.push(`# Report Issue at ${new Date(ctx.trigger.at).toISOString()} | window -${minutes(ctx.trigger.preWindowMs)} / +${Math.round(ctx.trigger.postWindowMs / 1e3)}s`);
  lines.push("");
  const rows = [];
  for (const c of ctx.console) rows.push({ ts: c.ts, line: `${iso(c.ts)} [console.${c.level}] ${c.args.join(" ")}${c.stack ? `
    ${c.stack.split("\n").join("\n    ")}` : ""}` });
  for (const e of ctx.errors) rows.push({ ts: e.ts, line: `${iso(e.ts)} [${e.kind}] ${e.message}${e.source ? ` (${e.source}:${e.line ?? "?"}:${e.column ?? "?"})` : ""}${e.stack ? `
    ${e.stack.split("\n").join("\n    ")}` : ""}` });
  rows.push({ ts: ctx.trigger.at, line: `${iso(ctx.trigger.at)} ===== TESTER CLICKED "REPORT ISSUE" =====` });
  rows.sort((a, b) => a.ts - b.ts);
  for (const r of rows) lines.push(r.line);
  return lines.join("\n");
}
function buildNetworkLog(ctx, opts = {}) {
  const maxBody = opts.maxBodyChars ?? 2e4;
  const sorted = [...ctx.exchanges].sort((a, b) => a.ts - b.ts);
  const focalId = ctx.evidence?.focal?.kind === "exchange" ? ctx.evidence.focal.refId : void 0;
  const detail = opts.detailIds ?? new Set(sorted.filter((e) => e.classification.isApi || e.error || e.response && e.response.status >= 400 || e.id === focalId).map((e) => e.id));
  const lines = [`# TestLens network log \u2014 incident ${ctx.incidentId}`, `# Report Issue at ${iso(ctx.trigger.at)} | ${sorted.length} requests | ${detail.size} with full detail below`, "", "## INDEX", "# time | status | method | url | duration | initiator | flags", ""];
  for (const e of sorted) {
    const flags = [e.id === focalId ? "FOCAL" : "", e.classification.isApi ? "api" : "", e.classification.isStatic ? "static" : "", e.classification.isTelemetry ? "telemetry" : "", e.classification.isPolling ? "polling" : "", e.correlationIds.length ? `>>> ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(",")}` : ""].filter(Boolean).join(" ");
    const status = e.error ? `ERR(${e.error.kind})` : String(e.response?.status ?? "-");
    lines.push(`${iso(e.ts)} | ${status.padEnd(9)} | ${e.method.padEnd(6)} | ${e.url} | ${e.timing ? `${Math.round(e.timing.totalMs)}ms` : "-"} | ${e.initiator?.type ?? "-"} | ${flags}`);
  }
  lines.push("", "## DETAIL", "");
  for (const e of sorted) {
    if (!detail.has(e.id)) continue;
    const corr = new Set(e.correlationIds.map((c) => c.header.toLowerCase()));
    const hdr = (hs) => hs.length ? hs.map((h) => `${corr.has(h.name.toLowerCase()) ? ">>> " : "    "}${h.name}: ${h.value}`) : ["    (none captured)"];
    const body = (b, status) => {
      if (!b || b.encoding === "base64") return [`    <${status}>`];
      const text = b.data.length > maxBody ? `${b.data.slice(0, maxBody)}
    \u2026 ${b.data.length - maxBody} more chars (see HAR)` : b.data;
      return text.split("\n").map((l) => `    ${l}`);
    };
    lines.push("=".repeat(100));
    lines.push(`${e.id === focalId ? "[FOCAL] " : ""}${e.method} ${e.url}`);
    lines.push(`${iso(e.ts)}  ${e.error ? `FAILED ${e.error.kind}${e.error.message ? `: ${e.error.message}` : ""}` : `HTTP ${e.response?.status}${e.response?.statusText ? ` ${e.response.statusText}` : ""}`}${e.timing ? `  ${Math.round(e.timing.totalMs)} ms` : ""}  initiator=${e.initiator?.type ?? "-"}`);
    if (e.correlationIds.length) lines.push(`>>> correlation: ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(", ")}`);
    lines.push("", "--- request headers", ...hdr(e.request.headers));
    lines.push("", `--- request payload (${e.bodyCapture.request}${e.request.body?.mimeType ? `, ${e.request.body.mimeType}` : ""})`, ...body(e.request.body, e.bodyCapture.request));
    lines.push("", `--- response headers${e.response ? ` (${e.response.status})` : ""}`, ...hdr(e.response?.headers ?? []));
    lines.push("", `--- response body (${e.bodyCapture.response}${e.response?.mimeType ? `, ${e.response.mimeType}` : ""})`, ...body(e.response?.body, e.bodyCapture.response));
    if (e.initiator?.stack) lines.push("", "--- initiator stack", ...e.initiator.stack.split("\n").map((l) => `    ${l}`));
    lines.push("");
  }
  return lines.join("\n");
}
function selectedExchangeIds(ctx) {
  const ids = /* @__PURE__ */ new Set();
  for (const it of ctx.evidence?.items ?? []) if (it.include && it.kind === "exchange") ids.add(it.refId);
  return ids;
}
function focalSignature(ctx) {
  const f = ctx.evidence?.focal;
  if (!f) return void 0;
  if (f.kind === "exchange") {
    const e = ctx.exchanges.find((x) => x.id === f.refId);
    if (!e) return void 0;
    const path2 = pathOf(e.url).replace(/\/\d+(?=\/|$)/g, "/{id}").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/{uuid}");
    return `${e.method.toUpperCase()} ${path2} ${e.error ? e.error.kind : e.response?.status ?? ""}`.trim();
  }
  if (f.kind === "error") {
    const er = ctx.errors.find((x) => x.id === f.refId);
    return er ? `JS ${er.kind} ${truncate(er.message, 60)}` : void 0;
  }
  if (f.kind === "assertion") {
    const a = ctx.assertions.find((x) => x.id === f.refId);
    return a ? `ASSERT ${truncate(a.name, 60)}` : void 0;
  }
  const c = ctx.console.find((x) => x.id === f.refId);
  return c ? `CONSOLE ${truncate(c.args.join(" "), 60)}` : void 0;
}
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
function stripQuery(url) {
  return url.split("?")[0] ?? url;
}
function queryOf(url) {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}
function headerValue(headers2, name) {
  const n = name.toLowerCase();
  return headers2.find((h) => h.name.toLowerCase() === n)?.value;
}
function tsOf(ctx, kind, id) {
  switch (kind) {
    case "exchange":
      return ctx.exchanges.find((e) => e.id === id)?.ts;
    case "error":
      return ctx.errors.find((e) => e.id === id)?.ts;
    case "assertion":
      return ctx.assertions.find((e) => e.id === id)?.ts;
    case "console":
      return ctx.console.find((e) => e.id === id)?.ts;
  }
}
function describeOffset(ts, t0) {
  const d = Math.round((t0 - ts) / 1e3);
  if (d >= 0) return d < 1 ? "at the moment of" : `${d}s before`;
  return `${-d}s after`;
}
function round(n) {
  return Math.round(n * 10) / 10;
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}
function minutes(ms) {
  const m = ms / 6e4;
  return m >= 1 ? `${Math.round(m)} min` : `${Math.round(ms / 1e3)} s`;
}
function iso(ts) {
  return new Date(ts).toISOString();
}
function dedupe(arr, key) {
  const seen = /* @__PURE__ */ new Set();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// packages/composer/src/index.ts
function compose(ctx, opts = {}) {
  const maxBody = opts.maxBodyPreviewChars ?? 1200;
  const maxConsole = opts.maxConsoleLines ?? 10;
  const maxSteps = opts.maxSteps ?? 12;
  const focal = ctx.evidence?.focal;
  const focalExchange = focal?.kind === "exchange" ? ctx.exchanges.find((e) => e.id === focal.refId) : void 0;
  const focalError = focal?.kind === "error" ? ctx.errors.find((e) => e.id === focal.refId) : void 0;
  const focalAssertion = focal?.kind === "assertion" ? ctx.assertions.find((a) => a.id === focal.refId) : void 0;
  const focalConsole = focal?.kind === "console" ? ctx.console.find((c) => c.id === focal.refId) : void 0;
  const page = ctx.application.title ? `"${ctx.application.title}"` : ctx.application.url ? pathOf(ctx.application.url) : "the page";
  let summary;
  if (focalExchange) {
    const st = focalExchange.error ? `fails (${focalExchange.error.kind})` : `returns ${focalExchange.response?.status}`;
    summary = `${focalExchange.method.toUpperCase()} ${pathOf(focalExchange.url)} ${st} on ${page}`;
  } else if (focalError) {
    summary = `JavaScript ${focalError.kind === "unhandledrejection" ? "unhandled rejection" : "error"}: ${firstLine(focalError.message, 90)} on ${page}`;
  } else if (focalAssertion) {
    summary = `Assertion failed: ${firstLine(focalAssertion.name, 100)}`;
  } else if (focalConsole) {
    summary = `Console error: ${firstLine(focalConsole.args.join(" "), 100)} on ${page}`;
  } else {
    summary = `Issue reported on ${page}`;
  }
  if (ctx.trigger.userNote) summary = `${firstLine(ctx.trigger.userNote, 80)} \u2014 ${summary}`;
  const steps = deriveSteps(ctx, maxSteps);
  let expected = "";
  let actual = "";
  if (focalExchange) {
    const path2 = pathOf(focalExchange.url);
    const prior = ctx.exchanges.filter((e) => e.id !== focalExchange.id && e.method === focalExchange.method && pathOf(e.url) === path2 && e.response && e.response.status < 400);
    expected = prior.length ? `${focalExchange.method.toUpperCase()} ${path2} responds successfully (observed ${prior[0].response.status} on ${prior.length} earlier call(s) in the same session) and the UI completes the action.` : `${focalExchange.method.toUpperCase()} ${path2} responds successfully and the UI completes the action.`;
    actual = focalExchange.error ? `The request failed at network level (${focalExchange.error.kind}${focalExchange.error.message ? `: ${focalExchange.error.message}` : ""}).` : `The request returned HTTP ${focalExchange.response?.status}${focalExchange.response?.statusText ? ` ${focalExchange.response.statusText}` : ""}${focalExchange.timing ? ` after ${Math.round(focalExchange.timing.totalMs)} ms` : ""}.`;
    const relatedErr = ctx.errors.find((e) => e.ts >= focalExchange.ts && e.ts - focalExchange.ts < 5e3);
    if (relatedErr) actual += ` A JavaScript ${relatedErr.kind === "unhandledrejection" ? "unhandled rejection" : relatedErr.kind + " error"} followed: ${firstLine(relatedErr.message, 120)}`;
  } else if (focalError) {
    expected = "The page operates without JavaScript errors.";
    actual = `${focalError.kind}: ${firstLine(focalError.message, 200)}`;
  } else if (focalAssertion) {
    expected = focalAssertion.expected ?? `Assertion "${focalAssertion.name}" passes.`;
    actual = focalAssertion.actual ?? focalAssertion.message ?? "Assertion failed.";
  } else {
    expected = "<describe the expected behaviour>";
    actual = ctx.trigger.userNote ?? "<describe what happened>";
  }
  const sections = [];
  if (ctx.trigger.userNote) sections.push({ id: "tester-note", title: "Tester's note", body: ctx.trigger.userNote, provenance: "user" });
  sections.push({ id: "environment", title: "Environment", body: environmentBlock(ctx), provenance: "captured" });
  if (focalExchange) {
    sections.push({ id: "failed-request", title: "Failed request", body: exchangeBlock(focalExchange, maxBody), provenance: "captured", code: true });
    const links = traceLinks(focalExchange, opts.traceLinkTemplates);
    if (links.length) sections.push({ id: "trace-links", title: "Backend trace links", body: links.join("\n"), provenance: "derived" });
    sections.push({ id: "curl", title: "Reproduce request (cURL, secrets masked)", body: toCurl(focalExchange), provenance: "derived", code: true });
  }
  if (focalError) sections.push({ id: "error-details", title: "Error details", body: `${focalError.message}
${focalError.stack ?? ""}`.trim(), provenance: "captured", code: true });
  if (focalAssertion) sections.push({ id: "assertion", title: "Assertion", body: `${focalAssertion.name}
expected: ${focalAssertion.expected ?? "-"}
actual:   ${focalAssertion.actual ?? "-"}
${focalAssertion.message ?? ""}`.trim(), provenance: "captured", code: true });
  const consoleLines = relatedConsole(ctx, maxConsole);
  if (consoleLines) sections.push({ id: "console", title: "Related console output", body: consoleLines, provenance: "captured", code: true });
  const related = relatedExchanges(ctx, focalExchange);
  if (related) sections.push({ id: "related-requests", title: "Related requests", body: related, provenance: "derived", code: true });
  if (ctx.evidence?.observations.length) sections.push({ id: "observations", title: "Observations (derived from captured data)", body: ctx.evidence.observations.map((o) => `\u2022 ${o}`).join("\n"), provenance: "derived" });
  if (ctx.analysis) {
    const a = ctx.analysis;
    const body = [a.technicalAnalysis, a.possibleComponent ? `Possible component: ${a.possibleComponent}` : "", `Confidence: ${a.confidence}`, ...a.caveats.map((c) => `\u26A0 ${c}`)].filter(Boolean).join("\n");
    sections.push({ id: "ai-analysis", title: `AI analysis (${a.provider}/${a.model}) \u2014 not verified`, body, provenance: "ai" });
  }
  sections.push({ id: "evidence-index", title: "Evidence attached", body: evidenceIndex(ctx), provenance: "derived" });
  const labels = ["testlens"];
  if (ctx.environment.name) labels.push(slug(ctx.environment.name));
  if (focalExchange?.response && focalExchange.response.status >= 500) labels.push("server-error");
  if (focalError) labels.push("js-error");
  return {
    summary: summary.slice(0, 250),
    stepsToReproduce: steps,
    expectedResult: expected,
    actualResult: actual,
    sections,
    labels,
    environmentSummary: envOneLine(ctx),
    focalSignature: focalSignature(ctx)
  };
}
function deriveSteps(ctx, max) {
  if (ctx.source.connectorId !== "browser" && ctx.interactions.length === 0) {
    const focal = ctx.evidence?.focal;
    const ex = focal?.kind === "exchange" ? ctx.exchanges.find((e) => e.id === focal.refId) : focal?.kind === "assertion" ? ctx.exchanges.find((e) => e.id === ctx.assertions.find((a) => a.id === focal.refId)?.exchangeId) : ctx.exchanges.find((e) => e.error || e.response && e.response.status >= 400);
    const steps2 = [];
    const exec = ctx.execution;
    if (exec?.collection) steps2.push(`Open the ${ctx.source.tool.name} collection "${exec.collection}"${ctx.environment.name ? ` with environment "${ctx.environment.name}"` : ""}`);
    else if (ctx.source.captureMode === "import") steps2.push(`Reproduce the traffic captured in ${ctx.application.name ?? "the imported file"}`);
    if (exec?.testName) steps2.push(`Run the request "${exec.testName}"${exec.iteration !== void 0 ? ` (iteration ${exec.iteration + 1})` : ""}`);
    if (ex) steps2.push(`Send ${ex.method} ${ex.url}${ex.request.body ? " with the request body shown below" : ""}`);
    const failedAssertions = ctx.assertions.filter((a) => !a.passed);
    if (failedAssertions.length) steps2.push(`Check the assertion${failedAssertions.length > 1 ? "s" : ""}: ${failedAssertions.slice(0, 3).map((a) => `"${a.name}"`).join(", ")}${failedAssertions.length > 3 ? ", \u2026" : ""}`);
    steps2.push("Observe the failure (see Actual result).");
    return steps2.slice(0, max);
  }
  const window = ctx.evidence?.window;
  const start = window ? window.start - 6e4 : ctx.trigger.at - 12e4;
  const end = ctx.trigger.at;
  const events = [];
  const firstNav = [...ctx.navigation].sort((a, b) => a.ts - b.ts).find((n) => n.ts <= end);
  for (const n of ctx.navigation) if (n.ts >= start && n.ts <= end) events.push({ ts: n.ts, text: navText(n) });
  for (const i of ctx.interactions) if (i.ts >= start && i.ts <= end && (i.kind === "click" || i.kind === "submit" || i.kind === "change" || i.kind === "input")) events.push({ ts: i.ts, text: interactionText(i) });
  events.sort((a, b) => a.ts - b.ts);
  const collapsed = [];
  for (const e of events) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.text === e.text) continue;
    collapsed.push(e);
  }
  let steps = collapsed.map((e) => e.text);
  if (steps.length > max) steps = ["\u2026", ...steps.slice(steps.length - (max - 1))];
  const openStep = ctx.application.url ? `Open ${firstNav && firstNav.ts < start ? firstNav.to : ctx.application.url}` : void 0;
  if (openStep && !steps.some((s) => s.startsWith("Navigate") || s.startsWith("Open"))) steps.unshift(openStep);
  steps.push("Observe the failure (see Actual result).");
  return steps;
}
function navText(n) {
  switch (n.kind) {
    case "load":
    case "committed":
      return `Navigate to ${n.to}`;
    case "reload":
      return `Reload ${n.to}`;
    default:
      return `Route changes to ${pathOf(n.to)}${n.title ? ` (${n.title})` : ""}`;
  }
}
function interactionText(i) {
  const label = i.target.text?.trim() || i.target.name || i.target.role || i.target.tag;
  const what = `"${firstLine(label, 50)}"${i.target.text ? "" : ` (${i.target.selector})`}`;
  switch (i.kind) {
    case "click":
      return `Click ${what}`;
    case "submit":
      return `Submit form ${what}`;
    case "change":
    case "input":
      return `Enter a value in ${what}${i.valueMasked ? " (value masked)" : ""}`;
    default:
      return `${i.kind} on ${what}`;
  }
}
function environmentBlock(ctx) {
  const rows = [
    ["Environment", ctx.environment.name],
    ["Application", ctx.application.name],
    ["URL", ctx.application.url],
    ["Page title", ctx.application.title],
    ["App version", ctx.application.version],
    ["Browser", ctx.browser ? `${ctx.browser.name} ${ctx.browser.version}` : void 0],
    ["Viewport", ctx.browser ? `${ctx.browser.viewport.width}\xD7${ctx.browser.viewport.height}${ctx.browser.viewport.dpr ? ` @${ctx.browser.viewport.dpr}x` : ""}` : void 0],
    ["OS", ctx.environment.os ? `${ctx.environment.os.name} ${ctx.environment.os.version ?? ""}`.trim() : void 0],
    ["Locale / TZ", [ctx.environment.locale, ctx.environment.timezone].filter(Boolean).join(" / ") || void 0],
    ["Reported at", new Date(ctx.trigger.at).toISOString()],
    ["Capture window", `-${Math.round(ctx.trigger.preWindowMs / 6e4)} min / +${Math.round(ctx.trigger.postWindowMs / 1e3)} s`],
    ["Source", `${ctx.source.tool.name}${ctx.source.tool.version ? ` ${ctx.source.tool.version}` : ""} via TestLens ${ctx.source.connectorId} connector ${ctx.source.connectorVersion}`]
  ];
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
}
function envOneLine(ctx) {
  return [ctx.browser ? `${ctx.browser.name} ${ctx.browser.version}` : ctx.source.tool.name, ctx.environment.os?.name, ctx.environment.name].filter(Boolean).join(" \xB7 ");
}
function exchangeBlock(e, maxBody) {
  const lines = [];
  lines.push(`${e.method.toUpperCase()} ${e.url}`);
  lines.push(`\u2192 ${e.error ? `FAILED ${e.error.kind}${e.error.message ? `: ${e.error.message}` : ""}` : `HTTP ${e.response?.status}${e.response?.statusText ? ` ${e.response.statusText}` : ""}`}${e.timing ? `  (${Math.round(e.timing.totalMs)} ms)` : ""}`);
  lines.push(`at ${new Date(e.ts).toISOString()}${e.initiator ? `  initiator: ${e.initiator.type}` : ""}`);
  if (e.correlationIds.length) lines.push(`>>> correlation: ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(", ")}`);
  const corr = new Set(e.correlationIds.map((c) => c.header.toLowerCase()));
  const hdr = (hs) => hs.length ? hs.map((h) => `${corr.has(h.name.toLowerCase()) ? ">>> " : "    "}${h.name}: ${h.value}`) : ["    (none captured)"];
  lines.push("", "--- request headers", ...hdr(e.request.headers));
  lines.push("", `--- request payload (${e.bodyCapture.request}${e.request.body?.mimeType ? `, ${e.request.body.mimeType}` : ""})`, indent(e.request.body ? preview(e.request.body.data, maxBody) : `<${e.bodyCapture.request}>`));
  if (e.response) {
    lines.push("", `--- response headers (${e.response.status})`, ...hdr(e.response.headers));
    lines.push("", `--- response body (${e.bodyCapture.response}${e.response.mimeType ? `, ${e.response.mimeType}` : ""})`, indent(e.response.body ? preview(e.response.body.data, maxBody) : `<${e.bodyCapture.response}>`));
  }
  return lines.join("\n");
}
function toCurl(e) {
  const parts = [`curl -X ${e.method.toUpperCase()} '${e.url.replace(/'/g, "'\\''")}'`];
  for (const h of e.request.headers) {
    if (/^(content-length|host|connection|accept-encoding|sec-|:)/i.test(h.name)) continue;
    parts.push(`  -H '${h.name}: ${h.value.replace(/'/g, "'\\''")}'`);
  }
  if (e.request.body && e.request.body.encoding !== "base64") parts.push(`  --data-raw '${e.request.body.data.replace(/'/g, "'\\''")}'`);
  else if (e.request.body) parts.push(`  # request body omitted (binary, ${e.request.bodyBytes ?? "?"} bytes)`);
  return parts.join(" \\\n");
}
function traceLinks(e, templates) {
  if (!templates) return [];
  const out = [];
  for (const c of e.correlationIds) {
    const t = templates[c.header] ?? templates["*"];
    if (t) out.push(`${c.header}=${c.value}: ${t.replace("{value}", encodeURIComponent(c.value)).replace("{header}", c.header)}`);
  }
  return out;
}
function relatedConsole(ctx, max) {
  const ids = new Set((ctx.evidence?.items ?? []).filter((i) => i.include && (i.kind === "console" || i.kind === "error")).map((i) => i.refId));
  const rows = [];
  for (const c of ctx.console) if (ids.has(c.id)) rows.push({ ts: c.ts, line: `${hhmmss(c.ts)} console.${c.level}: ${firstLine(c.args.join(" "), 300)}` });
  for (const e of ctx.errors) if (ids.has(e.id)) rows.push({ ts: e.ts, line: `${hhmmss(e.ts)} ${e.kind}: ${firstLine(e.message, 300)}${e.stack ? `
    ${firstLine(e.stack.split("\n").slice(1, 3).join(" | "), 300)}` : ""}` });
  rows.sort((a, b) => a.ts - b.ts);
  const sliced = rows.length > max ? rows.slice(rows.length - max) : rows;
  if (!sliced.length) return void 0;
  return (rows.length > max ? [`\u2026 ${rows.length - max} earlier line(s) in console.log attachment`] : []).concat(sliced.map((r) => r.line)).join("\n");
}
function relatedExchanges(ctx, focal) {
  const items = (ctx.evidence?.items ?? []).filter((i) => i.include && i.kind === "exchange" && i.refId !== focal?.id).slice(0, 8);
  if (!items.length) return void 0;
  const lines = items.map((it) => {
    const e = ctx.exchanges.find((x) => x.id === it.refId);
    const st = e.error ? `ERR ${e.error.kind}` : String(e.response?.status ?? "-");
    return `${hhmmss(e.ts)} ${st.padEnd(7)} ${e.method.toUpperCase().padEnd(6)} ${pathOf(e.url)}  \u2014 ${it.reasons[0] ?? ""}`;
  });
  return lines.join("\n");
}
function withEvidenceIndex(draft, ctx) {
  const section = { id: "evidence-index", title: "Evidence attached", body: evidenceIndex(ctx), provenance: "derived" };
  const idx = draft.sections.findIndex((s) => s.id === "evidence-index");
  const sections = idx >= 0 ? draft.sections.map((s, i) => i === idx ? section : s) : [...draft.sections, section];
  return { ...draft, sections };
}
function evidenceIndex(ctx) {
  const inc = ctx.artifacts.filter((a) => a.include);
  const exc = ctx.artifacts.filter((a) => !a.include);
  const q = ctx.evidence?.captureQuality;
  const lines = inc.map((a) => `\u2022 ${a.fileName} (${a.kind}, ${kb(a.bytes)})`);
  if (exc.length) lines.push(`Not attached by tester's choice: ${exc.map((a) => a.fileName).join(", ")}`);
  if (q) lines.push(`Capture quality: ${q.score}/100${q.notes.length ? ` \u2014 ${q.notes.join(" ")}` : ""}`);
  return lines.join("\n");
}
function firstLine(s, n) {
  const l = (s.split("\n")[0] ?? "").trim();
  return l.length > n ? `${l.slice(0, n - 1)}\u2026` : l;
}
function preview(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}
\u2026 (${s.length - n} more chars; full body in HAR)`;
}
function indent(s) {
  return s.split("\n").map((l) => `  ${l}`).join("\n");
}
function hhmmss(ts) {
  return new Date(ts).toISOString().slice(11, 23);
}
function kb(b) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path2, errorMaps, issueData } = params;
  const fullPath = [...path2, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path2, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path2;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask2) {
    const shape = {};
    for (const key of util.objectKeys(mask2)) {
      if (mask2[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask2) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask2[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask2) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask2 && !mask2[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask2) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask2 && !mask2[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// packages/schema/src/index.ts
var SCHEMA_VERSION = "1.0";
var Header = external_exports.object({ name: external_exports.string(), value: external_exports.string() });
var Body = external_exports.object({
  encoding: external_exports.enum(["utf8", "base64", "json"]),
  data: external_exports.string(),
  truncated: external_exports.boolean(),
  originalBytes: external_exports.number().int().nonnegative().optional(),
  mimeType: external_exports.string().optional()
});
var BodyCaptureStatus = external_exports.enum(["full", "truncated", "omitted", "unavailable"]);
var HttpExchange = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  // epoch ms, request start
  method: external_exports.string(),
  url: external_exports.string(),
  initiator: external_exports.object({
    type: external_exports.enum(["fetch", "xhr", "navigation", "script", "img", "css", "font", "media", "other", "tool"]),
    stack: external_exports.string().optional(),
    interactionId: external_exports.string().optional(),
    frameUrl: external_exports.string().optional()
  }).optional(),
  request: external_exports.object({
    headers: external_exports.array(Header),
    body: Body.optional(),
    bodyBytes: external_exports.number().int().nonnegative().optional()
  }),
  response: external_exports.object({
    status: external_exports.number().int(),
    statusText: external_exports.string().optional(),
    headers: external_exports.array(Header),
    body: Body.optional(),
    bodyBytes: external_exports.number().int().nonnegative().optional(),
    fromCache: external_exports.boolean().optional(),
    mimeType: external_exports.string().optional()
  }).optional(),
  error: external_exports.object({
    kind: external_exports.enum(["network", "aborted", "timeout", "blocked", "cors", "tls", "unknown"]),
    message: external_exports.string().optional()
  }).optional(),
  timing: external_exports.object({
    totalMs: external_exports.number().nonnegative(),
    ttfbMs: external_exports.number().nonnegative().optional()
  }).optional(),
  correlationIds: external_exports.array(external_exports.object({ header: external_exports.string(), value: external_exports.string() })),
  classification: external_exports.object({
    isApi: external_exports.boolean(),
    isStatic: external_exports.boolean(),
    isTelemetry: external_exports.boolean(),
    isPolling: external_exports.boolean().optional()
  }),
  bodyCapture: external_exports.object({ request: BodyCaptureStatus, response: BodyCaptureStatus })
});
var ConsoleEntry = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  level: external_exports.enum(["log", "info", "warn", "error", "debug"]),
  args: external_exports.array(external_exports.string()),
  // serialized, bounded, redacted
  stack: external_exports.string().optional(),
  frameUrl: external_exports.string().optional()
});
var ErrorEntry = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  kind: external_exports.enum(["uncaught", "unhandledrejection", "resource", "csp"]),
  message: external_exports.string(),
  stack: external_exports.string().optional(),
  source: external_exports.string().optional(),
  line: external_exports.number().optional(),
  column: external_exports.number().optional(),
  frameUrl: external_exports.string().optional()
});
var InteractionEntry = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  kind: external_exports.enum(["click", "input", "change", "submit", "keydown", "scroll", "focus"]),
  target: external_exports.object({
    selector: external_exports.string(),
    tag: external_exports.string(),
    text: external_exports.string().optional(),
    role: external_exports.string().optional(),
    name: external_exports.string().optional(),
    type: external_exports.string().optional()
  }),
  valueMasked: external_exports.boolean().optional(),
  frameUrl: external_exports.string().optional()
});
var NavigationEntry = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  kind: external_exports.enum(["load", "pushState", "replaceState", "popstate", "hashchange", "reload", "committed"]),
  from: external_exports.string().optional(),
  to: external_exports.string(),
  title: external_exports.string().optional()
});
var AssertionEntry = external_exports.object({
  id: external_exports.string(),
  ts: external_exports.number(),
  name: external_exports.string(),
  passed: external_exports.boolean(),
  expected: external_exports.string().optional(),
  actual: external_exports.string().optional(),
  message: external_exports.string().optional(),
  exchangeId: external_exports.string().optional()
});
var ArtifactKind = external_exports.enum([
  "screenshot",
  "video",
  "rrweb",
  "har",
  "har-focused",
  "console-log",
  "network-log",
  "incident-viewer",
  "raw-connector-payload",
  "file"
]);
var Artifact = external_exports.object({
  id: external_exports.string(),
  kind: ArtifactKind,
  fileName: external_exports.string(),
  mime: external_exports.string(),
  bytes: external_exports.number().int().nonnegative(),
  sha256: external_exports.string().optional(),
  storage: external_exports.object({
    type: external_exports.enum(["indexeddb", "inline", "hub"]),
    ref: external_exports.string()
    // idb key, data URL, or hub URL
  }),
  timeRange: external_exports.object({ start: external_exports.number(), end: external_exports.number() }).optional(),
  redaction: external_exports.object({
    status: external_exports.enum(["redacted", "not-applicable", "unredacted"]),
    rulesApplied: external_exports.array(external_exports.string())
  }),
  /** User decision in the review UI. Default: engine recommendation. */
  include: external_exports.boolean().default(true)
});
var TimelineRef = external_exports.object({
  ts: external_exports.number(),
  kind: external_exports.enum(["exchange", "console", "error", "interaction", "navigation", "assertion", "trigger"]),
  refId: external_exports.string()
});
var FocalEvent = external_exports.object({
  kind: external_exports.enum(["exchange", "error", "assertion", "console"]),
  refId: external_exports.string(),
  score: external_exports.number(),
  reasons: external_exports.array(external_exports.string())
});
var EvidenceItem = external_exports.object({
  kind: TimelineRef.shape.kind,
  refId: external_exports.string(),
  score: external_exports.number(),
  reasons: external_exports.array(external_exports.string()),
  include: external_exports.boolean()
});
var EvidenceSelection = external_exports.object({
  engineVersion: external_exports.string(),
  focal: FocalEvent.optional(),
  candidates: external_exports.array(FocalEvent),
  items: external_exports.array(EvidenceItem),
  window: external_exports.object({ start: external_exports.number(), end: external_exports.number() }),
  /** Deterministic observations the composer can state as facts. */
  observations: external_exports.array(external_exports.string()),
  captureQuality: external_exports.object({
    score: external_exports.number().min(0).max(100),
    notes: external_exports.array(external_exports.string())
  })
});
var Analysis = external_exports.object({
  provenance: external_exports.literal("ai"),
  provider: external_exports.string(),
  model: external_exports.string(),
  generatedAt: external_exports.number(),
  inputHash: external_exports.string(),
  summary: external_exports.string().optional(),
  description: external_exports.string().optional(),
  stepsToReproduce: external_exports.array(external_exports.string()).optional(),
  expectedResult: external_exports.string().optional(),
  actualResult: external_exports.string().optional(),
  technicalAnalysis: external_exports.string().optional(),
  suspectedExchangeIds: external_exports.array(external_exports.string()).optional(),
  relatedErrorIds: external_exports.array(external_exports.string()).optional(),
  possibleComponent: external_exports.string().optional(),
  confidence: external_exports.enum(["low", "medium", "high"]),
  caveats: external_exports.array(external_exports.string())
});
var BugContext = external_exports.object({
  schemaVersion: external_exports.literal(SCHEMA_VERSION),
  incidentId: external_exports.string(),
  createdAt: external_exports.number(),
  source: external_exports.object({
    connectorId: external_exports.string(),
    connectorVersion: external_exports.string(),
    tool: external_exports.object({ name: external_exports.string(), version: external_exports.string().optional() }),
    captureMode: external_exports.enum(["rolling", "on-demand", "import"])
  }),
  trigger: external_exports.object({
    at: external_exports.number(),
    preWindowMs: external_exports.number(),
    postWindowMs: external_exports.number(),
    initiatedBy: external_exports.enum(["user", "assertion-failure", "import"]),
    userNote: external_exports.string().optional()
  }),
  environment: external_exports.object({
    name: external_exports.string().optional(),
    os: external_exports.object({ name: external_exports.string(), version: external_exports.string().optional() }).optional(),
    locale: external_exports.string().optional(),
    timezone: external_exports.string().optional(),
    online: external_exports.boolean().optional()
  }),
  application: external_exports.object({
    name: external_exports.string().optional(),
    baseUrl: external_exports.string().optional(),
    url: external_exports.string().optional(),
    title: external_exports.string().optional(),
    version: external_exports.string().optional()
  }),
  browser: external_exports.object({
    name: external_exports.string(),
    version: external_exports.string(),
    userAgent: external_exports.string(),
    viewport: external_exports.object({ width: external_exports.number(), height: external_exports.number(), dpr: external_exports.number().optional() }),
    tabId: external_exports.number().optional(),
    extensionVersion: external_exports.string()
  }).optional(),
  exchanges: external_exports.array(HttpExchange),
  console: external_exports.array(ConsoleEntry),
  errors: external_exports.array(ErrorEntry),
  interactions: external_exports.array(InteractionEntry),
  navigation: external_exports.array(NavigationEntry),
  assertions: external_exports.array(AssertionEntry),
  execution: external_exports.object({
    suite: external_exports.string().optional(),
    collection: external_exports.string().optional(),
    testName: external_exports.string().optional(),
    iteration: external_exports.number().optional(),
    runId: external_exports.string().optional(),
    durationMs: external_exports.number().optional(),
    variables: external_exports.record(external_exports.string()).optional()
  }).optional(),
  artifacts: external_exports.array(Artifact),
  timeline: external_exports.array(TimelineRef),
  redaction: external_exports.object({
    appliedAt: external_exports.array(external_exports.enum(["capture", "export"])),
    rulesVersion: external_exports.string(),
    counts: external_exports.record(external_exports.number())
  }),
  evidence: EvidenceSelection.optional(),
  analysis: Analysis.optional(),
  extensions: external_exports.record(external_exports.unknown()).optional()
});
var BugDraftSection = external_exports.object({
  id: external_exports.string(),
  title: external_exports.string(),
  /** Markdown-ish plain text. Trackers render to their native format. */
  body: external_exports.string(),
  provenance: external_exports.enum(["captured", "derived", "ai", "user"]),
  code: external_exports.boolean().optional()
});
var BugDraft = external_exports.object({
  summary: external_exports.string(),
  stepsToReproduce: external_exports.array(external_exports.string()),
  expectedResult: external_exports.string(),
  actualResult: external_exports.string(),
  sections: external_exports.array(BugDraftSection),
  labels: external_exports.array(external_exports.string()),
  environmentSummary: external_exports.string(),
  focalSignature: external_exports.string().optional(),
  /** Draft fields the tester replaced with AI suggestions (kept so the description can mark them). */
  aiApplied: external_exports.array(external_exports.enum(["summary", "stepsToReproduce", "expectedResult", "actualResult"])).optional()
});
function buildTimeline(ctx) {
  const refs = [];
  for (const e of ctx.exchanges) refs.push({ ts: e.ts, kind: "exchange", refId: e.id });
  for (const e of ctx.console) refs.push({ ts: e.ts, kind: "console", refId: e.id });
  for (const e of ctx.errors) refs.push({ ts: e.ts, kind: "error", refId: e.id });
  for (const e of ctx.interactions) refs.push({ ts: e.ts, kind: "interaction", refId: e.id });
  for (const e of ctx.navigation) refs.push({ ts: e.ts, kind: "navigation", refId: e.id });
  for (const e of ctx.assertions) refs.push({ ts: e.ts, kind: "assertion", refId: e.id });
  refs.push({ ts: ctx.trigger.at, kind: "trigger", refId: "trigger" });
  refs.sort((a, b) => a.ts - b.ts);
  return refs;
}
var counter = 0;
function newId(prefix = "") {
  counter = (counter + 1) % 65535;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 16777215).toString(36).padStart(5, "0");
  return `${prefix}${t}${counter.toString(36).padStart(3, "0")}${r}`;
}

// packages/connectors-postman/src/index.ts
var CONNECTOR_ID = "postman";
var CONNECTOR_VERSION = "1.0.0";
function isPostmanPayload(x) {
  return Boolean(x && typeof x === "object" && x.source === "postman" && x.request);
}
function normalizePostmanPayload(p) {
  const at = toMs(p.timestamp) ?? Date.now();
  const ex = exchangeFrom(p.request, p.response, p.error, at, p.response?.responseTime);
  const assertions = testsToAssertions(p.tests, at, ex.id);
  const console2 = (p.console ?? []).map((c) => ({ id: newId("c"), ts: toMs(c.timestamp) ?? at, level: level(c.level), args: [String(c.message)] }));
  const failed = assertions.filter((a) => !a.passed);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId("inc_"),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID, connectorVersion: CONNECTOR_VERSION, tool: { name: "Postman", version: p.postmanVersion }, captureMode: "on-demand" },
    trigger: { at, preWindowMs: 0, postWindowMs: 0, initiatedBy: failed.length ? "assertion-failure" : "user", userNote: p.note },
    environment: { name: p.environment?.name },
    application: { name: p.collection, baseUrl: originOf(p.request.url), url: p.request.url, title: [p.collection, p.folder, p.requestName].filter(Boolean).join(" / ") || void 0 },
    exchanges: [ex],
    console: console2,
    errors: [],
    interactions: [],
    navigation: [],
    assertions,
    execution: { collection: p.collection, suite: p.folder, testName: p.requestName, iteration: p.iteration, durationMs: p.response?.responseTime, variables: p.environment?.values },
    artifacts: [],
    redaction: { appliedAt: [], rulesVersion: "0", counts: {} }
  };
  return { ...base, timeline: buildTimeline(base) };
}
function isNewmanRun(x) {
  return Boolean(x && typeof x === "object" && x.run?.executions);
}
function normalizeNewmanRun(run) {
  const started = run.run?.timings?.started ?? Date.now();
  const completed = run.run?.timings?.completed ?? started;
  const exchanges = [];
  const assertions = [];
  const execs = run.run?.executions ?? [];
  let cursorTs = started;
  for (const e of execs) {
    const url = urlToString(e.request?.url);
    const ts = cursorTs;
    const body = decodeStream(e.response?.stream);
    const ex = exchangeFrom(
      { method: e.request?.method ?? "GET", url, headers: e.request?.header, body: e.request?.body ? { mode: e.request.body.mode, raw: e.request.body.raw } : void 0 },
      e.response ? { code: e.response.code ?? 0, status: e.response.status, headers: e.response.header, body, responseTime: e.response.responseTime, responseSize: e.response.responseSize } : void 0,
      e.requestError?.message,
      ts,
      e.response?.responseTime
    );
    exchanges.push(ex);
    for (const a of e.assertions ?? []) assertions.push({ id: newId("a"), ts: ts + (e.response?.responseTime ?? 0), name: `${e.item?.name ?? ""}: ${a.assertion}`.replace(/^: /, ""), passed: !a.error, message: a.error?.message, exchangeId: ex.id });
    cursorTs += (e.response?.responseTime ?? 50) + 10;
  }
  const failed = assertions.filter((a) => !a.passed);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId("inc_"),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID, connectorVersion: CONNECTOR_VERSION, tool: { name: "Newman" }, captureMode: "import" },
    trigger: { at: completed, preWindowMs: Math.max(0, completed - started), postWindowMs: 0, initiatedBy: failed.length ? "assertion-failure" : "import" },
    environment: { name: run.environment?.name },
    application: { name: run.collection?.info?.name, url: exchanges[0]?.url, title: run.collection?.info?.name },
    exchanges,
    console: [],
    errors: [],
    interactions: [],
    navigation: [],
    assertions,
    execution: { collection: run.collection?.info?.name, durationMs: completed - started, variables: Object.fromEntries((run.environment?.values ?? []).map((v) => [v.key, v.value])) },
    artifacts: [],
    redaction: { appliedAt: [], rulesVersion: "0", counts: {} }
  };
  return { ...base, timeline: buildTimeline(base) };
}
function exchangeFrom(req, res, error, ts, durationMs) {
  const reqBody = typeof req.body === "string" ? req.body : req.body?.raw;
  const reqMime = typeof req.body === "object" && req.body ? req.body.mimeType ?? (req.body.mode === "raw" ? guessMime(req.body.raw) : void 0) : void 0;
  const resHeaders = toHeaders(res?.headers);
  const ex = {
    id: newId("x"),
    ts,
    method: (req.method || "GET").toUpperCase(),
    url: req.url,
    initiator: { type: "tool" },
    request: { headers: toHeaders(req.headers), body: reqBody ? { encoding: "utf8", data: reqBody, truncated: false, originalBytes: reqBody.length, mimeType: reqMime } : void 0, bodyBytes: reqBody?.length },
    correlationIds: [],
    classification: { isApi: true, isStatic: false, isTelemetry: false },
    bodyCapture: { request: reqBody ? "full" : "unavailable", response: res?.body ? "full" : "unavailable" },
    timing: durationMs !== void 0 ? { totalMs: durationMs } : void 0
  };
  if (error) ex.error = { kind: "network", message: error };
  if (res) {
    const mime = resHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value;
    ex.response = { status: res.code, statusText: res.status, headers: resHeaders, body: res.body ? { encoding: "utf8", data: res.body, truncated: false, originalBytes: res.responseSize ?? res.body.length, mimeType: mime } : void 0, bodyBytes: res.responseSize, mimeType: mime };
  }
  return ex;
}
function testsToAssertions(tests, ts, exchangeId) {
  if (!tests) return [];
  if (Array.isArray(tests)) return tests.map((t) => ({ id: newId("a"), ts, name: t.name, passed: t.passed, message: t.error, exchangeId }));
  return Object.entries(tests).map(([name, passed]) => ({ id: newId("a"), ts, name, passed: Boolean(passed), exchangeId }));
}
function toHeaders(h) {
  if (!h) return [];
  if (Array.isArray(h)) return h.filter((x) => x && x.key).map((x) => ({ name: x.key, value: String(x.value ?? "") }));
  return Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
}
function level(l) {
  const s = (l ?? "log").toLowerCase();
  return s === "error" || s === "warn" || s === "info" || s === "debug" ? s : "log";
}
function toMs(t) {
  if (t === void 0 || t === null) return void 0;
  if (typeof t === "number") return t < 1e12 ? t * 1e3 : t;
  const n = Date.parse(t);
  return Number.isNaN(n) ? void 0 : n;
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return void 0;
  }
}
function guessMime(raw) {
  const t = (raw ?? "").trimStart();
  return t.startsWith("{") || t.startsWith("[") ? "application/json" : void 0;
}
function urlToString(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  const o = u;
  const host = Array.isArray(o.host) ? o.host.join(".") : o.host ?? "";
  const path2 = Array.isArray(o.path) ? o.path.join("/") : o.path ?? "";
  const q = o.query?.length ? `?${o.query.map((x) => `${x.key}=${x.value}`).join("&")}` : "";
  return `${o.protocol ?? "https"}://${host}${o.port ? `:${o.port}` : ""}/${path2}${q}`;
}
function decodeStream(s) {
  if (!s) return void 0;
  if (typeof s === "string") return s;
  const data = s.data;
  if (!data) return void 0;
  try {
    return new TextDecoder().decode(Uint8Array.from(data));
  } catch {
    return void 0;
  }
}

// packages/connectors-har/src/index.ts
var CONNECTOR_ID2 = "har";
var CONNECTOR_VERSION2 = "1.0.0";
function isHar(x) {
  return Boolean(x && typeof x === "object" && Array.isArray(x.log?.entries));
}
function normalizeHar(har, opts = {}) {
  const entries = [...har.log.entries].filter((e) => e.request?.url).sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  const exchanges = entries.map((e) => {
    const ts = Date.parse(e.startedDateTime) || Date.now();
    const reqH = headers(e.request.headers);
    const resH = headers(e.response?.headers);
    const ex = {
      id: newId("x"),
      ts,
      method: e.request.method.toUpperCase(),
      url: e.request.url,
      initiator: { type: initiator(e) },
      request: {
        headers: reqH,
        body: e.request.postData?.text ? { encoding: e.request.postData.encoding === "base64" ? "base64" : "utf8", data: e.request.postData.text, truncated: false, originalBytes: e.request.postData.text.length, mimeType: e.request.postData.mimeType } : void 0
      },
      correlationIds: [],
      classification: { isApi: false, isStatic: false, isTelemetry: false },
      bodyCapture: { request: e.request.postData?.text ? "full" : "unavailable", response: e.response?.content?.text ? "full" : "unavailable" },
      timing: e.time !== void 0 ? { totalMs: Math.max(0, e.time), ttfbMs: e.timings?.wait } : void 0
    };
    if (e.response && e.response.status > 0) {
      const text = e.response.content?.text;
      ex.response = {
        status: e.response.status,
        statusText: e.response.statusText,
        headers: resH,
        body: text ? { encoding: e.response.content?.encoding === "base64" ? "base64" : "utf8", data: text, truncated: false, originalBytes: e.response.content?.size ?? text.length, mimeType: e.response.content?.mimeType } : void 0,
        bodyBytes: e.response.content?.size,
        mimeType: e.response.content?.mimeType ?? resH.find((h) => h.name.toLowerCase() === "content-type")?.value
      };
    } else {
      ex.error = { kind: "network", message: e.response?._error ?? "no response" };
    }
    return ex;
  });
  const first = exchanges[0]?.ts ?? Date.now();
  const last = exchanges[exchanges.length - 1]?.ts ?? first;
  const page = har.log.pages?.[0];
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId("inc_"),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID2, connectorVersion: CONNECTOR_VERSION2, tool: { name: har.log.creator?.name ?? "HAR", version: har.log.creator?.version }, captureMode: "import" },
    trigger: { at: last, preWindowMs: Math.max(0, last - first), postWindowMs: 0, initiatedBy: "import", userNote: opts.note },
    environment: {},
    application: { url: pageUrl(har, exchanges), title: page?.title ?? opts.fileName, name: opts.fileName },
    browser: har.log.browser?.name ? { name: har.log.browser.name, version: har.log.browser.version ?? "", userAgent: "", viewport: { width: 0, height: 0 }, extensionVersion: "" } : void 0,
    exchanges,
    console: [],
    errors: [],
    interactions: [],
    navigation: [],
    assertions: [],
    artifacts: [],
    redaction: { appliedAt: [], rulesVersion: "0", counts: {} }
  };
  return { ...base, timeline: buildTimeline(base) };
}
function headers(h) {
  return (h ?? []).filter((x) => x && x.name && !x.name.startsWith(":")).map((x) => ({ name: x.name, value: String(x.value ?? "") }));
}
function initiator(e) {
  const t = (e._resourceType ?? e._initiator?.type ?? "").toLowerCase();
  if (t === "xhr") return "xhr";
  if (t === "fetch") return "fetch";
  if (t === "document") return "navigation";
  if (t === "script") return "script";
  if (t === "image") return "img";
  if (t === "stylesheet") return "css";
  if (t === "font") return "font";
  if (t === "media") return "media";
  return "other";
}
function pageUrl(har, exchanges) {
  const doc = exchanges.find((e) => e.initiator?.type === "navigation");
  return doc?.url ?? exchanges[0]?.url;
}

// apps/hub/src/server.ts
var PORT = Number(process.env.TL_HUB_PORT ?? 7331);
var DATA_DIR = process.env.TL_HUB_DATA ?? path.join(os.homedir(), ".testlens", "hub");
var MAX_BODY = 50 * 1024 * 1024;
async function processContext(raw, rawPayload, rawName) {
  const redacted = redactContext(raw, DEFAULT_RULES);
  const ctx = runEvidenceEngine(redacted);
  const dir = path.join(DATA_DIR, "incidents", ctx.incidentId);
  await fs.mkdir(dir, { recursive: true });
  const files = {};
  const artifacts = [];
  const add = async (kind, fileName, mime, content, include = true) => {
    const id = `${ctx.incidentId}:${kind}`;
    await fs.writeFile(path.join(dir, fileName), content, "utf8");
    files[id] = fileName;
    artifacts.push({ id, kind, fileName, mime, bytes: Buffer.byteLength(content), storage: { type: "hub", ref: `/incidents/${ctx.incidentId}/artifacts/${encodeURIComponent(id)}` }, redaction: { status: "redacted", rulesApplied: ["default"] }, include });
  };
  await add("console-log", "console.log", "text/plain", buildConsoleLog(ctx), ctx.console.length > 0);
  await add("network-log", "network.log", "text/plain", buildNetworkLog(ctx));
  await add("har-focused", "network-focused.har", "application/json", buildHar(ctx, selectedExchangeIds(ctx)));
  await add("har", "network-full.har", "application/json", buildHar(ctx), false);
  await add("raw-connector-payload", rawName, "application/json", JSON.stringify(rawPayload, null, 2), false);
  const withArtifacts = { ...ctx, artifacts };
  const draft = withEvidenceIndex(compose(withArtifacts), withArtifacts);
  const inc = { incidentId: ctx.incidentId, createdAt: ctx.createdAt, source: ctx.source.connectorId, title: draft.summary, status: "ready", context: withArtifacts, draft, files };
  await fs.writeFile(path.join(dir, "incident.json"), JSON.stringify(inc), "utf8");
  const { context: _c, draft: _d, ...meta } = inc;
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  return inc;
}
function detectAndNormalize(payload, fileName) {
  if (isPostmanPayload(payload)) return { ctx: normalizePostmanPayload(payload), rawName: "postman-payload.json" };
  if (isNewmanRun(payload)) return { ctx: normalizeNewmanRun(payload), rawName: fileName ?? "newman-run.json" };
  if (isHar(payload)) return { ctx: normalizeHar(payload, { fileName }), rawName: fileName ?? "import.har" };
  throw new HttpError(400, "Unrecognised payload: expected a TestLens Postman payload, a Newman run JSON or a HAR 1.2 file");
}
async function listIncidents() {
  const root = path.join(DATA_DIR, "incidents");
  await fs.mkdir(root, { recursive: true });
  const ids = await fs.readdir(root);
  const out = [];
  for (const id of ids) {
    try {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(root, id, "meta.json"), "utf8")));
      } catch {
        const inc = JSON.parse(await fs.readFile(path.join(root, id, "incident.json"), "utf8"));
        const { context: _c, draft: _d, ...rest } = inc;
        out.push(rest);
      }
    } catch {
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
async function getIncident(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, "incidents", safeId(id), "incident.json"), "utf8"));
  } catch {
    return void 0;
  }
}
function safeId(id) {
  if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, "bad id");
  return id;
}
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TestLens-Filename");
}
function send(res, status, body, type = "application/json") {
  cors(res);
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, "payload too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function snippetForThisHub() {
  return SNIPPET_JS.replace("'http://localhost:7331'", `'http://localhost:${PORT}'`);
}
async function landing() {
  return LANDING_HTML.split("{{PORT}}").join(String(PORT)).replace("{{SNIPPET}}", snippetForThisHub().replace(/</g, "&lt;"));
}
function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, await landing(), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, name: "testlens-hub", version: HUB_VERSION, dataDir: DATA_DIR, port: PORT });
      if (req.method === "GET" && url.pathname === "/snippet") return send(res, 200, snippetForThisHub(), "text/javascript; charset=utf-8");
      if (req.method === "POST" && (url.pathname === "/ingest/postman" || url.pathname === "/import")) {
        const buf = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(buf.toString("utf8"));
        } catch {
          throw new HttpError(400, "body must be JSON");
        }
        const fileName = req.headers["x-testlens-filename"] ?? url.searchParams.get("name") ?? void 0;
        const { ctx, rawName } = detectAndNormalize(payload, fileName);
        const inc = await processContext(ctx, payload, rawName);
        console.log(`[hub] incident ${inc.incidentId} (${inc.source}): ${inc.title}`);
        return send(res, 201, { incidentId: inc.incidentId, title: inc.title, source: inc.source, reviewHint: "Open the TestLens side panel \u2192 Incidents \u2192 Sync from Hub" });
      }
      if (req.method === "GET" && url.pathname === "/incidents") return send(res, 200, await listIncidents());
      const m = url.pathname.match(/^\/incidents\/([^/]+)(?:\/artifacts\/(.+))?$/);
      if (m) {
        const inc = await getIncident(decodeURIComponent(m[1]));
        if (!inc) throw new HttpError(404, "incident not found");
        if (req.method === "DELETE") {
          await fs.rm(path.join(DATA_DIR, "incidents", inc.incidentId), { recursive: true, force: true });
          return send(res, 200, { ok: true });
        }
        if (!m[2]) return send(res, 200, inc);
        const fileName = inc.files[decodeURIComponent(m[2])];
        if (!fileName) throw new HttpError(404, "artifact not found");
        const data = await fs.readFile(path.join(DATA_DIR, "incidents", inc.incidentId, fileName));
        cors(res);
        res.writeHead(200, { "content-type": fileName.endsWith(".har") || fileName.endsWith(".json") ? "application/json" : "text/plain", "content-disposition": `attachment; filename="${fileName}"` });
        return res.end(data);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error("[hub]", e);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
var runDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && (pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url || /testlens-hub(\.mjs|\.js)?$|server\.(ts|mjs|js)$/.test(process.argv[1]));
  } catch {
    return false;
  }
})();
if (runDirectly && !process.env.TL_HUB_NO_LISTEN) {
  createServer().listen(PORT, "127.0.0.1", () => {
    console.log(`TestLens Hub ${HUB_VERSION} listening on http://localhost:${PORT}  (data: ${DATA_DIR})`);
    console.log("Open that URL for the Postman snippet. Incidents appear in the TestLens side panel \u2192 API testing.");
  });
}
export {
  createServer,
  detectAndNormalize
};
