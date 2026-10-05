/**
 * @testlens/connectors-postman — Postman (in-app script push) and Newman (CLI run JSON) → BugContext.
 * Pure functions; no I/O.
 */
import { buildTimeline, newId, SCHEMA_VERSION } from '@testlens/schema';
import type { AssertionEntry, BugContext, ConsoleEntry, Header, HttpExchange } from '@testlens/schema';

export const CONNECTOR_ID = 'postman';
export const CONNECTOR_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Payload sent by the TestLens snippet from a Postman Tests script
// ---------------------------------------------------------------------------

export interface PostmanIngestPayload {
  source: 'postman';
  snippetVersion?: string;
  timestamp?: string | number;
  note?: string;
  collection?: string;
  folder?: string;
  requestName?: string;
  iteration?: number;
  environment?: { name?: string; values?: Record<string, string> };
  request: {
    method: string;
    url: string;
    headers?: { key: string; value: string }[] | Record<string, string>;
    body?: { mode?: string; raw?: string; mimeType?: string } | string;
  };
  response?: {
    code: number;
    status?: string;
    headers?: { key: string; value: string }[] | Record<string, string>;
    body?: string;
    responseTime?: number;
    responseSize?: number;
  };
  error?: string;
  tests?: Record<string, boolean> | { name: string; passed: boolean; error?: string }[];
  console?: { level?: string; message: string; timestamp?: string | number }[];
  postmanVersion?: string;
}

export function isPostmanPayload(x: unknown): x is PostmanIngestPayload {
  return Boolean(x && typeof x === 'object' && (x as { source?: string }).source === 'postman' && (x as { request?: unknown }).request);
}

export function normalizePostmanPayload(p: PostmanIngestPayload): BugContext {
  const at = toMs(p.timestamp) ?? Date.now();
  const ex = exchangeFrom(p.request, p.response, p.error, at, p.response?.responseTime);
  const assertions: AssertionEntry[] = testsToAssertions(p.tests, at, ex.id);
  const console: ConsoleEntry[] = (p.console ?? []).map((c) => ({ id: newId('c'), ts: toMs(c.timestamp) ?? at, level: level(c.level), args: [String(c.message)] }));
  const failed = assertions.filter((a) => !a.passed);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId('inc_'),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID, connectorVersion: CONNECTOR_VERSION, tool: { name: 'Postman', version: p.postmanVersion }, captureMode: 'on-demand' as const },
    trigger: { at, preWindowMs: 0, postWindowMs: 0, initiatedBy: failed.length ? ('assertion-failure' as const) : ('user' as const), userNote: p.note },
    environment: { name: p.environment?.name },
    application: { name: p.collection, baseUrl: originOf(p.request.url), url: p.request.url, title: [p.collection, p.folder, p.requestName].filter(Boolean).join(' / ') || undefined },
    exchanges: [ex],
    console,
    errors: [],
    interactions: [],
    navigation: [],
    assertions,
    execution: { collection: p.collection, suite: p.folder, testName: p.requestName, iteration: p.iteration, durationMs: p.response?.responseTime, variables: p.environment?.values },
    artifacts: [],
    redaction: { appliedAt: [] as ('capture' | 'export')[], rulesVersion: '0', counts: {} },
  };
  return { ...base, timeline: buildTimeline(base) };
}

// ---------------------------------------------------------------------------
// Newman run JSON (newman run ... -r json --reporter-json-export run.json)
// ---------------------------------------------------------------------------

export interface NewmanRunJson {
  collection?: { info?: { name?: string } };
  environment?: { name?: string; values?: { key: string; value: string }[] };
  run?: {
    timings?: { started?: number; completed?: number };
    executions?: {
      cursor?: { iteration?: number };
      item?: { name?: string };
      request?: { method?: string; url?: unknown; header?: { key: string; value: string }[]; body?: { mode?: string; raw?: string } };
      response?: { code?: number; status?: string; header?: { key: string; value: string }[]; stream?: { data?: number[] } | { type: 'Buffer'; data: number[] } | string; responseTime?: number; responseSize?: number };
      requestError?: { message?: string };
      assertions?: { assertion: string; error?: { message?: string; name?: string } }[];
    }[];
    failures?: unknown[];
  };
}

export function isNewmanRun(x: unknown): x is NewmanRunJson {
  return Boolean(x && typeof x === 'object' && (x as { run?: { executions?: unknown } }).run?.executions);
}

/** One incident for the whole run: every execution is an exchange; failed assertions and 4xx/5xx become focal candidates. */
export function normalizeNewmanRun(run: NewmanRunJson): BugContext {
  const started = run.run?.timings?.started ?? Date.now();
  const completed = run.run?.timings?.completed ?? started;
  const exchanges: HttpExchange[] = [];
  const assertions: AssertionEntry[] = [];
  const execs = run.run?.executions ?? [];
  let cursorTs = started;
  for (const e of execs) {
    const url = urlToString(e.request?.url);
    const ts = cursorTs;
    const body = decodeStream(e.response?.stream);
    const ex = exchangeFrom(
      { method: e.request?.method ?? 'GET', url, headers: e.request?.header, body: e.request?.body ? { mode: e.request.body.mode, raw: e.request.body.raw } : undefined },
      e.response ? { code: e.response.code ?? 0, status: e.response.status, headers: e.response.header, body, responseTime: e.response.responseTime, responseSize: e.response.responseSize } : undefined,
      e.requestError?.message,
      ts,
      e.response?.responseTime,
    );
    exchanges.push(ex);
    for (const a of e.assertions ?? []) assertions.push({ id: newId('a'), ts: ts + (e.response?.responseTime ?? 0), name: `${e.item?.name ?? ''}: ${a.assertion}`.replace(/^: /, ''), passed: !a.error, message: a.error?.message, exchangeId: ex.id });
    cursorTs += (e.response?.responseTime ?? 50) + 10;
  }
  const failed = assertions.filter((a) => !a.passed);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId('inc_'),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID, connectorVersion: CONNECTOR_VERSION, tool: { name: 'Newman' }, captureMode: 'import' as const },
    trigger: { at: completed, preWindowMs: Math.max(0, completed - started), postWindowMs: 0, initiatedBy: failed.length ? ('assertion-failure' as const) : ('import' as const) },
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
    redaction: { appliedAt: [] as ('capture' | 'export')[], rulesVersion: '0', counts: {} },
  };
  return { ...base, timeline: buildTimeline(base) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function exchangeFrom(
  req: PostmanIngestPayload['request'],
  res: PostmanIngestPayload['response'] | undefined,
  error: string | undefined,
  ts: number,
  durationMs: number | undefined,
): HttpExchange {
  const reqBody = typeof req.body === 'string' ? req.body : req.body?.raw;
  const reqMime = typeof req.body === 'object' && req.body ? req.body.mimeType ?? (req.body.mode === 'raw' ? guessMime(req.body.raw) : undefined) : undefined;
  const resHeaders = toHeaders(res?.headers);
  const ex: HttpExchange = {
    id: newId('x'),
    ts,
    method: (req.method || 'GET').toUpperCase(),
    url: req.url,
    initiator: { type: 'tool' },
    request: { headers: toHeaders(req.headers), body: reqBody ? { encoding: 'utf8', data: reqBody, truncated: false, originalBytes: reqBody.length, mimeType: reqMime } : undefined, bodyBytes: reqBody?.length },
    correlationIds: [],
    classification: { isApi: true, isStatic: false, isTelemetry: false },
    bodyCapture: { request: reqBody ? 'full' : 'unavailable', response: res?.body ? 'full' : 'unavailable' },
    timing: durationMs !== undefined ? { totalMs: durationMs } : undefined,
  };
  if (error) ex.error = { kind: 'network', message: error };
  if (res) {
    const mime = resHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    ex.response = { status: res.code, statusText: res.status, headers: resHeaders, body: res.body ? { encoding: 'utf8', data: res.body, truncated: false, originalBytes: res.responseSize ?? res.body.length, mimeType: mime } : undefined, bodyBytes: res.responseSize, mimeType: mime };
  }
  return ex;
}

function testsToAssertions(tests: PostmanIngestPayload['tests'], ts: number, exchangeId: string): AssertionEntry[] {
  if (!tests) return [];
  if (Array.isArray(tests)) return tests.map((t) => ({ id: newId('a'), ts, name: t.name, passed: t.passed, message: t.error, exchangeId }));
  return Object.entries(tests).map(([name, passed]) => ({ id: newId('a'), ts, name, passed: Boolean(passed), exchangeId }));
}

function toHeaders(h: PostmanIngestPayload['request']['headers']): Header[] {
  if (!h) return [];
  if (Array.isArray(h)) return h.filter((x) => x && x.key).map((x) => ({ name: x.key, value: String(x.value ?? '') }));
  return Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
}

function level(l?: string): ConsoleEntry['level'] {
  const s = (l ?? 'log').toLowerCase();
  return s === 'error' || s === 'warn' || s === 'info' || s === 'debug' ? s : 'log';
}

function toMs(t: string | number | undefined): number | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isNaN(n) ? undefined : n;
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function guessMime(raw?: string) {
  const t = (raw ?? '').trimStart();
  return t.startsWith('{') || t.startsWith('[') ? 'application/json' : undefined;
}

function urlToString(u: unknown): string {
  if (!u) return '';
  if (typeof u === 'string') return u;
  const o = u as { protocol?: string; host?: string[] | string; path?: string[] | string; query?: { key: string; value: string }[]; port?: string };
  const host = Array.isArray(o.host) ? o.host.join('.') : (o.host ?? '');
  const path = Array.isArray(o.path) ? o.path.join('/') : (o.path ?? '');
  const q = o.query?.length ? `?${o.query.map((x) => `${x.key}=${x.value}`).join('&')}` : '';
  return `${o.protocol ?? 'https'}://${host}${o.port ? `:${o.port}` : ''}/${path}${q}`;
}

function decodeStream(s: { data?: number[] } | { type: 'Buffer'; data: number[] } | string | undefined): string | undefined {
  if (!s) return undefined;
  if (typeof s === 'string') return s;
  const data = (s as { data?: number[] }).data;
  if (!data) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(data));
  } catch {
    return undefined;
  }
}
