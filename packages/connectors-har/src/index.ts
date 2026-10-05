/**
 * @testlens/connectors-har — HAR 1.2 → BugContext (exchanges only). Works for exports from any
 * browser DevTools, Charles, Fiddler, Proxyman, Insomnia, etc.
 */
import { buildTimeline, newId, SCHEMA_VERSION } from '@testlens/schema';
import type { BugContext, Header, HttpExchange } from '@testlens/schema';

export const CONNECTOR_ID = 'har';
export const CONNECTOR_VERSION = '1.0.0';

export interface Har {
  log: {
    version?: string;
    creator?: { name?: string; version?: string };
    browser?: { name?: string; version?: string };
    pages?: { startedDateTime?: string; title?: string; id?: string }[];
    entries: HarEntry[];
  };
}
export interface HarEntry {
  startedDateTime: string;
  time?: number;
  request: { method: string; url: string; headers?: { name: string; value: string }[]; postData?: { mimeType?: string; text?: string; encoding?: string } };
  response?: { status: number; statusText?: string; headers?: { name: string; value: string }[]; content?: { size?: number; mimeType?: string; text?: string; encoding?: string }; _error?: string };
  timings?: { wait?: number };
  _resourceType?: string;
  _initiator?: { type?: string };
}

export function isHar(x: unknown): x is Har {
  return Boolean(x && typeof x === 'object' && Array.isArray((x as { log?: { entries?: unknown } }).log?.entries));
}

export function normalizeHar(har: Har, opts: { note?: string; fileName?: string } = {}): BugContext {
  const entries = [...har.log.entries].filter((e) => e.request?.url).sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  const exchanges: HttpExchange[] = entries.map((e) => {
    const ts = Date.parse(e.startedDateTime) || Date.now();
    const reqH = headers(e.request.headers);
    const resH = headers(e.response?.headers);
    const ex: HttpExchange = {
      id: newId('x'),
      ts,
      method: e.request.method.toUpperCase(),
      url: e.request.url,
      initiator: { type: initiator(e) },
      request: {
        headers: reqH,
        body: e.request.postData?.text ? { encoding: e.request.postData.encoding === 'base64' ? 'base64' : 'utf8', data: e.request.postData.text, truncated: false, originalBytes: e.request.postData.text.length, mimeType: e.request.postData.mimeType } : undefined,
      },
      correlationIds: [],
      classification: { isApi: false, isStatic: false, isTelemetry: false },
      bodyCapture: { request: e.request.postData?.text ? 'full' : 'unavailable', response: e.response?.content?.text ? 'full' : 'unavailable' },
      timing: e.time !== undefined ? { totalMs: Math.max(0, e.time), ttfbMs: e.timings?.wait } : undefined,
    };
    if (e.response && e.response.status > 0) {
      const text = e.response.content?.text;
      ex.response = {
        status: e.response.status,
        statusText: e.response.statusText,
        headers: resH,
        body: text ? { encoding: e.response.content?.encoding === 'base64' ? 'base64' : 'utf8', data: text, truncated: false, originalBytes: e.response.content?.size ?? text.length, mimeType: e.response.content?.mimeType } : undefined,
        bodyBytes: e.response.content?.size,
        mimeType: e.response.content?.mimeType ?? resH.find((h) => h.name.toLowerCase() === 'content-type')?.value,
      };
    } else {
      ex.error = { kind: 'network', message: e.response?._error ?? 'no response' };
    }
    return ex;
  });
  const first = exchanges[0]?.ts ?? Date.now();
  const last = exchanges[exchanges.length - 1]?.ts ?? first;
  const page = har.log.pages?.[0];
  const base = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: newId('inc_'),
    createdAt: Date.now(),
    source: { connectorId: CONNECTOR_ID, connectorVersion: CONNECTOR_VERSION, tool: { name: har.log.creator?.name ?? 'HAR', version: har.log.creator?.version }, captureMode: 'import' as const },
    trigger: { at: last, preWindowMs: Math.max(0, last - first), postWindowMs: 0, initiatedBy: 'import' as const, userNote: opts.note },
    environment: {},
    application: { url: pageUrl(har, exchanges), title: page?.title ?? opts.fileName, name: opts.fileName },
    browser: har.log.browser?.name ? { name: har.log.browser.name, version: har.log.browser.version ?? '', userAgent: '', viewport: { width: 0, height: 0 }, extensionVersion: '' } : undefined,
    exchanges,
    console: [],
    errors: [],
    interactions: [],
    navigation: [],
    assertions: [],
    artifacts: [],
    redaction: { appliedAt: [] as ('capture' | 'export')[], rulesVersion: '0', counts: {} },
  };
  return { ...base, timeline: buildTimeline(base) };
}

function headers(h?: { name: string; value: string }[]): Header[] {
  return (h ?? []).filter((x) => x && x.name && !x.name.startsWith(':')).map((x) => ({ name: x.name, value: String(x.value ?? '') }));
}

function initiator(e: HarEntry): NonNullable<HttpExchange['initiator']>['type'] {
  const t = (e._resourceType ?? e._initiator?.type ?? '').toLowerCase();
  if (t === 'xhr') return 'xhr';
  if (t === 'fetch') return 'fetch';
  if (t === 'document') return 'navigation';
  if (t === 'script') return 'script';
  if (t === 'image') return 'img';
  if (t === 'stylesheet') return 'css';
  if (t === 'font') return 'font';
  if (t === 'media') return 'media';
  return 'other';
}

function pageUrl(har: Har, exchanges: HttpExchange[]) {
  const doc = exchanges.find((e) => e.initiator?.type === 'navigation');
  return doc?.url ?? exchanges[0]?.url;
}
