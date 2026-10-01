/**
 * Network capture: chrome.webRequest observers give metadata for every request;
 * MAIN-world fetch/XHR wrapping gives bodies. This module joins the two into one
 * HttpExchange per request and writes through to the ring buffer.
 */
import type { HttpExchange } from '@testlens/schema';
import { redactBodyString, redactHeaders, redactUrl, newStats, type RedactionRules, type RedactionStats } from '@testlens/redaction';
import { newId } from '@testlens/schema';
import { putEvent, updateExchange, findRecentExchanges } from '../buffer/db';
import type { PageExchange } from '../messages';

export interface NetworkCaptureDeps {
  isMonitoredTab(tabId: number): boolean;
  rules(): RedactionRules;
  captureBodies(): boolean;
  maxBodyBytes(): number;
  onRedaction(stats: RedactionStats): void;
}

interface Pending {
  id: string;
  tabId: number;
  ts: number;
  method: string;
  url: string;
  type: string;
  frameId: number;
  initiatorUrl?: string;
  requestHeaders: { name: string; value: string }[];
  requestBody?: HttpExchange['request']['body'];
  requestBodyBytes?: number;
  status?: number;
  statusText?: string;
  responseHeaders: { name: string; value: string }[];
  ttfbTs?: number;
  fromCache?: boolean;
}

const pending = new Map<string, Pending>();
/** Recently finalized webRequest exchanges, per tab, kept briefly to join late page-world bodies. */
const recent = new Map<number, { id: string; method: string; url: string; ts: number; joined: boolean }[]>();
/** Page exchanges that arrived before webRequest finalized. */
const pendingPage = new Map<number, (PageExchange & { arrived: number })[]>();

const MATCH_MS = 4000;

export function installNetworkCapture(deps: NetworkCaptureDeps) {
  const filter: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0 || !deps.isMonitoredTab(d.tabId)) return;
      const p: Pending = { id: newId('w'), tabId: d.tabId, ts: d.timeStamp, method: d.method, url: d.url, type: d.type, frameId: d.frameId, initiatorUrl: d.initiator, requestHeaders: [], responseHeaders: [] };
      if (d.requestBody && deps.captureBodies()) {
        const body = requestBodyFromWebRequest(d.requestBody, deps.maxBodyBytes());
        if (body) {
          p.requestBody = body.body;
          p.requestBodyBytes = body.bytes;
        }
      }
      pending.set(d.requestId, p);
    },
    filter,
    ['requestBody'],
  );

  chrome.webRequest.onSendHeaders.addListener(
    (d) => {
      const p = pending.get(d.requestId);
      if (p) p.requestHeaders = (d.requestHeaders ?? []).map((h) => ({ name: h.name, value: h.value ?? '' }));
    },
    filter,
    safeExtra(['requestHeaders', 'extraHeaders']),
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      const p = pending.get(d.requestId);
      if (!p) return;
      p.status = d.statusCode;
      p.statusText = d.statusLine?.split(' ').slice(2).join(' ');
      p.responseHeaders = (d.responseHeaders ?? []).map((h) => ({ name: h.name, value: h.value ?? '' }));
      p.ttfbTs = d.timeStamp;
    },
    filter,
    safeExtra(['responseHeaders', 'extraHeaders']),
  );

  chrome.webRequest.onCompleted.addListener(
    (d) => {
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      p.status = d.statusCode;
      p.fromCache = d.fromCache;
      if (!p.responseHeaders.length && d.responseHeaders) p.responseHeaders = d.responseHeaders.map((h) => ({ name: h.name, value: h.value ?? '' }));
      void finalize(p, d.timeStamp, undefined, deps);
    },
    filter,
    safeExtra(['responseHeaders']),
  );

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const p = pending.get(d.requestId);
    if (!p) return;
    pending.delete(d.requestId);
    void finalize(p, d.timeStamp, d.error, deps);
  }, filter);

  // periodic cleanup of join caches
  setInterval(() => {
    const now = Date.now();
    for (const [tab, arr] of recent) {
      const kept = arr.filter((r) => now - r.ts < 30_000);
      if (kept.length) recent.set(tab, kept);
      else recent.delete(tab);
    }
    for (const [tab, arr] of pendingPage) {
      const kept = arr.filter((r) => now - r.arrived < 10_000);
      // orphaned page exchanges (no webRequest counterpart, e.g. handled by a service worker) become standalone exchanges
      for (const orphan of arr.filter((r) => now - r.arrived >= 10_000)) void writeStandalonePageExchange(tab, orphan, deps);
      if (kept.length) pendingPage.set(tab, kept);
      else pendingPage.delete(tab);
    }
    for (const [reqId, p] of pending) if (now - p.ts > 120_000) pending.delete(reqId);
  }, 5000);
}

function safeExtra(extra: string[]): string[] {
  // 'extraHeaders' is Chromium-only; Firefox ignores unknown values but may throw on some versions.
  return extra;
}

async function finalize(p: Pending, endTs: number, error: string | undefined, deps: NetworkCaptureDeps) {
  const rules = deps.rules();
  const stats = newStats();
  const ex: HttpExchange = {
    id: p.id,
    ts: p.ts,
    method: p.method,
    url: redactUrl(p.url, rules, stats),
    initiator: { type: mapType(p.type), frameUrl: p.initiatorUrl },
    request: {
      headers: redactHeaders(p.requestHeaders, rules, stats),
      body: p.requestBody ? { ...p.requestBody, data: p.requestBody.encoding === 'base64' ? p.requestBody.data : redactBodyString(p.requestBody.data, p.requestBody.mimeType, rules, stats) } : undefined,
      bodyBytes: p.requestBodyBytes,
    },
    correlationIds: [],
    classification: { isApi: p.type === 'xmlhttprequest', isStatic: false, isTelemetry: false },
    bodyCapture: { request: p.requestBody ? (p.requestBody.truncated ? 'truncated' : 'full') : 'unavailable', response: 'unavailable' },
    timing: { totalMs: Math.max(0, endTs - p.ts), ttfbMs: p.ttfbTs ? Math.max(0, p.ttfbTs - p.ts) : undefined },
  };
  if (error) {
    ex.error = { kind: classifyError(error), message: error };
  } else if (p.status !== undefined) {
    ex.response = { status: p.status, statusText: p.statusText, headers: redactHeaders(p.responseHeaders, rules, stats), fromCache: p.fromCache, mimeType: p.responseHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value };
  }
  deps.onRedaction(stats);

  // join with a page-world exchange that arrived earlier
  const pp = pendingPage.get(p.tabId);
  if (pp) {
    const idx = pp.findIndex((x) => x.method === p.method && sameUrl(x.url, p.url) && Math.abs(x.ts - p.ts) < MATCH_MS);
    if (idx >= 0) {
      const [page] = pp.splice(idx, 1);
      mergePage(ex, page!, rules, stats, deps.maxBodyBytes());
      putEvent(p.tabId, 'exchange', ex);
      return;
    }
  }
  const arr = recent.get(p.tabId) ?? [];
  arr.push({ id: ex.id, method: ex.method, url: p.url, ts: ex.ts, joined: false });
  recent.set(p.tabId, arr);
  putEvent(p.tabId, 'exchange', ex);
}

export async function ingestPageExchange(tabId: number, page: PageExchange, deps: NetworkCaptureDeps) {
  const rules = deps.rules();
  const stats = newStats();
  // 1. try a recently finalized webRequest record
  const arr = recent.get(tabId) ?? [];
  const hit = arr.find((r) => !r.joined && r.method === page.method && sameUrl(r.url, page.url) && Math.abs(r.ts - page.ts) < MATCH_MS);
  if (hit) {
    hit.joined = true;
    const ok = await updateExchange(tabId, hit.id, (ex) => mergePage(ex, page, rules, stats, deps.maxBodyBytes()));
    deps.onRedaction(stats);
    if (ok) return;
  }
  // 2. maybe the webRequest record was written earlier than our `recent` cache knows (SW restart) — search the buffer
  const candidates = await findRecentExchanges(tabId, page.ts - MATCH_MS);
  const c = candidates.find((e) => e.bodyCapture.response === 'unavailable' && e.method === page.method && sameUrl(e.url, page.url) && Math.abs(e.ts - page.ts) < MATCH_MS);
  if (c) {
    await updateExchange(tabId, c.id, (ex) => mergePage(ex, page, rules, stats, deps.maxBodyBytes()));
    deps.onRedaction(stats);
    return;
  }
  // 3. wait for webRequest to finalize
  const pp = pendingPage.get(tabId) ?? [];
  pp.push({ ...page, arrived: Date.now() });
  pendingPage.set(tabId, pp);
}

async function writeStandalonePageExchange(tabId: number, page: PageExchange, deps: NetworkCaptureDeps) {
  const rules = deps.rules();
  const stats = newStats();
  const ex: HttpExchange = {
    id: page.id,
    ts: page.ts,
    method: page.method,
    url: page.url,
    initiator: { type: page.kind },
    request: { headers: [] },
    correlationIds: [],
    classification: { isApi: true, isStatic: false, isTelemetry: false },
    bodyCapture: { request: 'unavailable', response: 'unavailable' },
    timing: { totalMs: Math.max(0, page.endTs - page.ts) },
  };
  mergePage(ex, page, rules, stats, deps.maxBodyBytes());
  ex.url = redactUrl(ex.url, rules, stats);
  deps.onRedaction(stats);
  putEvent(tabId, 'exchange', ex);
}

function mergePage(ex: HttpExchange, page: PageExchange, rules: RedactionRules, stats: RedactionStats, maxBytes: number): HttpExchange {
  ex.initiator = { ...(ex.initiator ?? { type: page.kind }), type: page.kind, stack: page.stack };
  ex.classification = { ...ex.classification, isApi: true };
  // request headers: webRequest has the complete set; page-world adds those set by JS (already included). Prefer webRequest, fall back to page.
  if (!ex.request.headers.length && page.requestHeaders.length) ex.request.headers = redactHeaders(page.requestHeaders, rules, stats);
  if (page.requestBody && !page.requestBody.omitted) {
    const data = redactBodyString(page.requestBody.data, page.requestBody.mimeType ?? headerVal(ex.request.headers, 'content-type'), rules, stats);
    ex.request.body = { encoding: 'utf8', data, truncated: page.requestBody.truncated || data.length > maxBytes, originalBytes: page.requestBody.originalBytes, mimeType: page.requestBody.mimeType ?? headerVal(ex.request.headers, 'content-type') };
    ex.request.bodyBytes = page.requestBody.originalBytes;
    ex.bodyCapture.request = ex.request.body.truncated ? 'truncated' : 'full';
  } else if (page.requestBody?.omitted) {
    ex.bodyCapture.request = 'omitted';
    ex.request.bodyBytes = page.requestBody.originalBytes;
  }
  if (page.error && !ex.error && ex.response === undefined) ex.error = { kind: classifyError(page.error), message: page.error };
  if (page.status !== undefined) {
    if (!ex.response) ex.response = { status: page.status, statusText: page.statusText, headers: redactHeaders(page.responseHeaders ?? [], rules, stats), mimeType: page.responseBody?.mimeType };
    else if (!ex.response.headers.length && page.responseHeaders?.length) ex.response.headers = redactHeaders(page.responseHeaders, rules, stats);
    if (page.responseBody && !page.responseBody.omitted) {
      const mime = page.responseBody.mimeType ?? ex.response.mimeType;
      const data = redactBodyString(page.responseBody.data, mime, rules, stats);
      ex.response.body = { encoding: 'utf8', data, truncated: page.responseBody.truncated, originalBytes: page.responseBody.originalBytes, mimeType: mime };
      ex.response.bodyBytes = page.responseBody.originalBytes;
      ex.response.mimeType = ex.response.mimeType ?? mime;
      ex.bodyCapture.response = page.responseBody.truncated ? 'truncated' : 'full';
    } else if (page.responseBody?.omitted) {
      ex.bodyCapture.response = 'omitted';
      ex.response.bodyBytes = page.responseBody.originalBytes;
    }
  }
  if (!ex.timing || ex.timing.totalMs === 0) ex.timing = { totalMs: Math.max(0, page.endTs - page.ts) };
  return ex;
}

function requestBodyFromWebRequest(rb: chrome.webRequest.WebRequestBody, max: number): { body: HttpExchange['request']['body']; bytes: number } | undefined {
  if (rb.formData) {
    const p = new URLSearchParams();
    for (const [k, vs] of Object.entries(rb.formData)) for (const v of vs) p.append(k, v);
    const s = p.toString();
    return { body: { encoding: 'utf8', data: s.slice(0, max), truncated: s.length > max, originalBytes: s.length, mimeType: 'application/x-www-form-urlencoded' }, bytes: s.length };
  }
  if (rb.raw?.length) {
    let total = 0;
    const chunks: Uint8Array[] = [];
    for (const r of rb.raw) {
      if (r.bytes) {
        chunks.push(new Uint8Array(r.bytes));
        total += r.bytes.byteLength;
      } else if (r.file) total += 0;
    }
    if (!chunks.length) return undefined;
    const merged = new Uint8Array(Math.min(total, max));
    let off = 0;
    for (const c of chunks) {
      const n = Math.min(c.byteLength, merged.byteLength - off);
      merged.set(c.subarray(0, n), off);
      off += n;
      if (off >= merged.byteLength) break;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
      return { body: { encoding: 'utf8', data: text, truncated: total > max, originalBytes: total }, bytes: total };
    } catch {
      return { body: { encoding: 'base64', data: '', truncated: true, originalBytes: total }, bytes: total };
    }
  }
  return undefined;
}

function mapType(t: string): NonNullable<HttpExchange['initiator']>['type'] {
  switch (t) {
    case 'main_frame':
    case 'sub_frame':
      return 'navigation';
    case 'xmlhttprequest':
      return 'fetch';
    case 'script':
      return 'script';
    case 'image':
      return 'img';
    case 'stylesheet':
      return 'css';
    case 'font':
      return 'font';
    case 'media':
      return 'media';
    default:
      return 'other';
  }
}

function classifyError(e: string): NonNullable<HttpExchange['error']>['kind'] {
  const s = e.toLowerCase();
  if (s.includes('abort')) return 'aborted';
  if (s.includes('timed out') || s.includes('timeout')) return 'timeout';
  if (s.includes('blocked') || s.includes('client')) return 'blocked';
  if (s.includes('cert') || s.includes('ssl') || s.includes('tls')) return 'tls';
  if (s.includes('cors')) return 'cors';
  if (s.includes('failed') || s.includes('refused') || s.includes('reset') || s.includes('resolved') || s.includes('network')) return 'network';
  return 'unknown';
}

function sameUrl(a: string, b: string) {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return false;
  }
}

function headerVal(h: { name: string; value: string }[], name: string) {
  return h.find((x) => x.name.toLowerCase() === name)?.value;
}
