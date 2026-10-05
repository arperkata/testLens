/**
 * @testlens/evidence-engine
 *
 * Deterministic, explainable evidence selection. No AI here.
 *
 *  1. classify exchanges (static / telemetry / polling / api)
 *  2. score focal candidates (failed requests, uncaught errors, assertion failures, console.error)
 *  3. pick focal event, define the evidence window around it
 *  4. relate surrounding events (correlation ids, url similarity, causality, proximity)
 *  5. emit observations the composer may state as facts
 *  6. build artifacts: HAR, focused HAR, console log, network log text
 */
import type { BugContext, EvidenceItem, EvidenceSelection, FocalEvent, HttpExchange, TimelineRef } from '@testlens/schema';

export const ENGINE_VERSION = '1.0.0';

export interface EngineOptions {
  /** Half-width of the evidence window around the focal event, ms. */
  windowBeforeMs: number;
  windowAfterMs: number;
  /** Hostname fragments considered telemetry/noise. */
  telemetryHosts: string[];
  /** Header names treated as correlation ids. */
  correlationHeaders: string[];
  /** Exchanges slower than this are flagged. */
  slowMs: number;
  maxItems: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  windowBeforeMs: 30_000,
  windowAfterMs: 10_000,
  telemetryHosts: [
    'google-analytics.com',
    'googletagmanager.com',
    'analytics.',
    'segment.io',
    'segment.com',
    'mixpanel.com',
    'hotjar.com',
    'sentry.io',
    'datadoghq.com',
    'newrelic.com',
    'nr-data.net',
    'fullstory.com',
    'intercom.io',
    'doubleclick.net',
    'facebook.net',
    'clarity.ms',
    'amplitude.com',
    'launchdarkly.com',
  ],
  correlationHeaders: ['x-request-id', 'x-correlation-id', 'x-trace-id', 'traceparent', 'x-amzn-trace-id', 'x-b3-traceid', 'request-id', 'x-cloud-trace-context', 'cf-ray'],
  slowMs: 5_000,
  maxItems: 60,
};

const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)(\?|$)/i;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyExchanges(exchanges: HttpExchange[], opts: EngineOptions = DEFAULT_ENGINE_OPTIONS): HttpExchange[] {
  // polling detection: same method+url ≥ 4 times with roughly regular spacing
  const byKey = new Map<string, number[]>();
  for (const e of exchanges) {
    const k = `${e.method} ${stripQuery(e.url)}`;
    const arr = byKey.get(k) ?? [];
    arr.push(e.ts);
    byKey.set(k, arr);
  }
  const polling = new Set<string>();
  for (const [k, tss] of byKey) {
    if (tss.length < 4) continue;
    tss.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < tss.length; i++) gaps.push(tss[i]! - tss[i - 1]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
    if (mean > 500 && Math.sqrt(variance) / mean < 0.35) polling.add(k);
  }

  return exchanges.map((e) => {
    let host = '';
    try {
      host = new URL(e.url).hostname;
    } catch {
      /* ignore */
    }
    const isTelemetry = opts.telemetryHosts.some((h) => host.includes(h));
    const mime = e.response?.mimeType ?? headerValue(e.response?.headers ?? [], 'content-type') ?? '';
    const isStatic =
      STATIC_EXT.test(e.url) ||
      ['script', 'img', 'css', 'font', 'media'].includes(e.initiator?.type ?? '') ||
      /^(image|font|video|audio|text\/css|application\/javascript|text\/javascript)/i.test(mime);
    const isApi = !isStatic && !isTelemetry && (e.initiator?.type === 'fetch' || e.initiator?.type === 'xhr' || e.initiator?.type === 'tool' || /json|xml|graphql/i.test(mime));
    return {
      ...e,
      classification: { isApi, isStatic, isTelemetry, isPolling: polling.has(`${e.method} ${stripQuery(e.url)}`) },
      correlationIds: e.correlationIds.length ? e.correlationIds : extractCorrelationIds(e, opts),
    };
  });
}

export function extractCorrelationIds(e: HttpExchange, opts: EngineOptions = DEFAULT_ENGINE_OPTIONS) {
  const out: { header: string; value: string }[] = [];
  const all = [...e.request.headers, ...(e.response?.headers ?? [])];
  for (const h of all) {
    if (opts.correlationHeaders.includes(h.name.toLowerCase()) && h.value) out.push({ header: h.name.toLowerCase(), value: h.value });
  }
  return dedupe(out, (c) => `${c.header}:${c.value}`);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function recencyBoost(ts: number, triggerAt: number): number {
  // 1.0 at trigger, decays to ~0 at -5 min; events after trigger (post window) still count
  const dt = Math.abs(triggerAt - ts);
  return Math.max(0, 1 - dt / 300_000);
}

export function scoreCandidates(ctx: BugContext, opts: EngineOptions): FocalEvent[] {
  const out: FocalEvent[] = [];
  const t0 = ctx.trigger.at;

  for (const e of ctx.exchanges) {
    if (e.classification.isTelemetry) continue;
    const reasons: string[] = [];
    let score = 0;
    const status = e.response?.status;
    if (e.error) {
      score += 70;
      reasons.push(`request failed (${e.error.kind}${e.error.message ? `: ${e.error.message}` : ''})`);
    } else if (status !== undefined && status >= 500) {
      score += 90;
      reasons.push(`server error ${status}`);
    } else if (status === 401 || status === 403) {
      score += 45;
      reasons.push(`auth/permission error ${status}`);
    } else if (status !== undefined && status >= 400) {
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
      reasons.push('API call');
    }
    if (e.classification.isStatic) score -= 25;
    if (e.classification.isPolling) {
      score -= 15;
      reasons.push('looks like polling');
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method.toUpperCase())) {
      score += 8;
      reasons.push('mutating request');
    }
    const rb = recencyBoost(e.ts, t0);
    score = score * (0.4 + 0.6 * rb);
    reasons.push(`${describeOffset(e.ts, t0)} Report Issue`);
    out.push({ kind: 'exchange', refId: e.id, score: round(score), reasons });
  }

  for (const er of ctx.errors) {
    const base = er.kind === 'uncaught' ? 60 : er.kind === 'unhandledrejection' ? 55 : er.kind === 'csp' ? 35 : 25;
    const score = base * (0.4 + 0.6 * recencyBoost(er.ts, t0));
    out.push({ kind: 'error', refId: er.id, score: round(score), reasons: [`${er.kind} error: ${truncate(er.message, 80)}`, `${describeOffset(er.ts, t0)} Report Issue`] });
  }

  for (const a of ctx.assertions) {
    if (a.passed) continue;
    const score = 85 * (0.5 + 0.5 * recencyBoost(a.ts, t0));
    out.push({ kind: 'assertion', refId: a.id, score: round(score), reasons: [`assertion failed: ${truncate(a.name, 80)}`] });
  }

  for (const c of ctx.console) {
    if (c.level !== 'error') continue;
    const score = 30 * (0.4 + 0.6 * recencyBoost(c.ts, t0));
    out.push({ kind: 'console', refId: c.id, score: round(score), reasons: [`console.error: ${truncate(c.args.join(' '), 80)}`, `${describeOffset(c.ts, t0)} Report Issue`] });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function runEvidenceEngine(input: BugContext, options: Partial<EngineOptions> = {}, overrideFocal?: { kind: FocalEvent['kind']; refId: string }): BugContext {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const ctx: BugContext = { ...input, exchanges: classifyExchanges(input.exchanges, opts) };
  const candidates = scoreCandidates(ctx, opts);
  let focal = candidates[0];
  if (overrideFocal) {
    focal = candidates.find((c) => c.kind === overrideFocal.kind && c.refId === overrideFocal.refId) ?? { ...overrideFocal, score: 100, reasons: ['selected by tester'] };
  }

  const focalTs = focal ? tsOf(ctx, focal.kind, focal.refId) ?? ctx.trigger.at : ctx.trigger.at;
  const window = { start: focalTs - opts.windowBeforeMs, end: Math.max(focalTs + opts.windowAfterMs, ctx.trigger.at + ctx.trigger.postWindowMs) };

  const focalExchange = focal?.kind === 'exchange' ? ctx.exchanges.find((e) => e.id === focal!.refId) : undefined;
  const focalCorr = new Set((focalExchange?.correlationIds ?? []).map((c) => c.value));
  const focalPath = focalExchange ? pathOf(focalExchange.url) : undefined;
  const focalError = focal?.kind === 'error' ? ctx.errors.find((e) => e.id === focal!.refId) : undefined;

  const items: EvidenceItem[] = [];
  const push = (kind: TimelineRef['kind'], refId: string, score: number, reasons: string[]) => {
    items.push({ kind, refId, score: round(score), reasons, include: true });
  };

  if (focal) push(focal.kind, focal.refId, 100, ['focal event']);

  for (const e of ctx.exchanges) {
    if (focal && e.id === focal.refId) continue;
    if (e.classification.isTelemetry) continue;
    const reasons: string[] = [];
    let score = 0;
    const inWindow = e.ts >= window.start && e.ts <= window.end;
    if (e.correlationIds.some((c) => focalCorr.has(c.value))) {
      score += 60;
      reasons.push('shares correlation id with focal request');
    }
    if (focalPath && pathOf(e.url) === focalPath) {
      score += 35;
      reasons.push('same endpoint as focal request');
    }
    if (focalError?.stack && focalError.stack.includes(pathOf(e.url))) {
      score += 30;
      reasons.push('endpoint appears in error stack');
    }
    const st = e.response?.status;
    if (e.error || (st !== undefined && st >= 400)) {
      score += inWindow ? 40 : 15;
      reasons.push(`failed (${e.error?.kind ?? st})`);
    }
    if (inWindow && e.classification.isApi && !e.classification.isPolling) {
      score += 20;
      reasons.push('API call inside evidence window');
    }
    if (e.classification.isStatic) score -= 30;
    if (score <= 0) continue;
    push('exchange', e.id, score, reasons);
  }

  for (const er of ctx.errors) {
    if (focal && er.id === focal.refId) continue;
    const inWindow = er.ts >= window.start && er.ts <= window.end;
    const reasons = [inWindow ? 'error inside evidence window' : 'error in buffer'];
    let score = inWindow ? 55 : 20;
    if (focalPath && er.stack?.includes(focalPath)) {
      score += 25;
      reasons.push('stack mentions focal endpoint');
    }
    push('error', er.id, score, reasons);
  }

  for (const c of ctx.console) {
    if (focal && c.id === focal.refId) continue;
    const inWindow = c.ts >= window.start && c.ts <= window.end;
    if (c.level === 'error' || c.level === 'warn') {
      let score = (c.level === 'error' ? 40 : 20) * (inWindow ? 1 : 0.4);
      const reasons = [`console.${c.level}${inWindow ? ' inside evidence window' : ''}`];
      if (focalPath && c.args.some((a) => a.includes(focalPath))) {
        score += 25;
        reasons.push('mentions focal endpoint');
      }
      push('console', c.id, score, reasons);
    } else if (inWindow && focalPath && c.args.some((a) => a.includes(focalPath))) {
      push('console', c.id, 25, ['console output mentions focal endpoint']);
    }
  }

  for (const i of ctx.interactions) {
    const inWindow = i.ts >= window.start && i.ts <= window.end;
    if (!inWindow) continue;
    let score = 15;
    const reasons = ['interaction inside evidence window'];
    if (focalExchange && focalExchange.ts - i.ts >= 0 && focalExchange.ts - i.ts < 3000 && (i.kind === 'click' || i.kind === 'submit')) {
      score += 45;
      reasons.push(`${i.kind} ${Math.round(focalExchange.ts - i.ts)} ms before focal request (likely cause)`);
    }
    if (i.kind === 'click' || i.kind === 'submit') score += 10;
    push('interaction', i.id, score, reasons);
  }

  for (const n of ctx.navigation) {
    const inWindow = n.ts >= window.start && n.ts <= window.end;
    push('navigation', n.id, inWindow ? 30 : 8, [inWindow ? 'navigation inside evidence window' : 'navigation in buffer']);
  }

  for (const a of ctx.assertions) {
    if (focal && a.id === focal.refId) continue;
    push('assertion', a.id, a.passed ? 10 : 70, [a.passed ? 'passing assertion' : 'failed assertion']);
  }

  items.sort((a, b) => b.score - a.score);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (i >= opts.maxItems || it.score < 15) it.include = false;
  }

  const observations = observe(ctx, focalExchange);
  const captureQuality = assessCaptureQuality(ctx);

  const evidence: EvidenceSelection = {
    engineVersion: ENGINE_VERSION,
    focal,
    candidates: candidates.slice(0, 10),
    items,
    window,
    observations,
    captureQuality,
  };
  return { ...ctx, evidence };
}

// ---------------------------------------------------------------------------
// Observations (facts the composer may state)
// ---------------------------------------------------------------------------

export function observe(ctx: BugContext, focal?: HttpExchange): string[] {
  const out: string[] = [];
  if (focal) {
    const path = pathOf(focal.url);
    const same = ctx.exchanges.filter((e) => e.id !== focal.id && e.method === focal.method && pathOf(e.url) === path);
    const okBefore = same.filter((e) => e.ts < focal.ts && e.response && e.response.status < 400);
    const failBefore = same.filter((e) => e.ts < focal.ts && (e.error || (e.response && e.response.status >= 400)));
    if (okBefore.length && !failBefore.length) {
      out.push(`${focal.method} ${path} succeeded ${okBefore.length} time(s) in the preceding ${minutes(ctx.trigger.preWindowMs)} and then failed — intermittent or state-dependent.`);
    } else if (failBefore.length) {
      out.push(`${focal.method} ${path} failed ${failBefore.length + 1} time(s) in the buffer — consistently failing.`);
    } else if (!same.length) {
      out.push(`${focal.method} ${path} was called once in the buffer; no baseline for comparison.`);
    }
    const retries = same.filter((e) => Math.abs(e.ts - focal.ts) < 5000 && e.ts > focal.ts);
    if (retries.length) out.push(`${retries.length} retry/retries of the same endpoint within 5 s after the failure.`);
    if (focal.correlationIds.length) out.push(`Correlation id(s) available: ${focal.correlationIds.map((c) => `${c.header}=${c.value}`).join(', ')}.`);
    if (focal.bodyCapture.response !== 'full') out.push(`Response body capture for the focal request: ${focal.bodyCapture.response}.`);
  }
  const uncaught = ctx.errors.filter((e) => e.kind === 'uncaught' || e.kind === 'unhandledrejection');
  if (uncaught.length) out.push(`${uncaught.length} uncaught JavaScript error(s) in the buffer.`);
  const failed = ctx.exchanges.filter((e) => !e.classification.isTelemetry && (e.error || (e.response && e.response.status >= 400)));
  if (failed.length) out.push(`${failed.length} failed/4xx/5xx request(s) in the buffer (excluding telemetry).`);
  return out;
}

export function assessCaptureQuality(ctx: BugContext): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 100;
  const api = ctx.exchanges.filter((e) => e.classification.isApi);
  if (api.length) {
    const withBody = api.filter((e) => e.bodyCapture.response === 'full' || e.bodyCapture.response === 'truncated').length;
    const pct = Math.round((withBody / api.length) * 100);
    if (pct < 100) {
      notes.push(`${pct}% of API responses have a captured body (others were not page fetch/XHR or exceeded limits).`);
      score -= Math.round((100 - pct) * 0.3);
    }
  } else {
    notes.push('No API calls observed in the buffer.');
    score -= 10;
  }
  const kinds = new Set(ctx.artifacts.map((a) => a.kind));
  if (!kinds.has('screenshot')) {
    notes.push('No screenshot captured.');
    score -= 15;
  }
  if (!kinds.has('rrweb') && !kinds.has('video')) {
    notes.push('No visual recording (DOM replay or video) available.');
    score -= 20;
  } else if (!kinds.has('video')) {
    notes.push('DOM replay available; no pixel video (enable "Record this tab" for video).');
  }
  if (ctx.console.length === 0 && ctx.errors.length === 0) notes.push('No console output or errors observed; the page may have loaded before TestLens was active.');
  return { score: Math.max(0, Math.min(100, score)), notes };
}

// ---------------------------------------------------------------------------
// Artifact builders
// ---------------------------------------------------------------------------

export function buildHar(ctx: BugContext, onlyIds?: Set<string>): string {
  const entries = ctx.exchanges
    .filter((e) => !onlyIds || onlyIds.has(e.id))
    .map((e) => {
      const started = new Date(e.ts).toISOString();
      const reqBody = e.request.body;
      const resBody = e.response?.body;
      return {
        startedDateTime: started,
        time: e.timing?.totalMs ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: e.request.headers,
          queryString: queryOf(e.url),
          postData: reqBody ? { mimeType: reqBody.mimeType ?? 'application/octet-stream', text: reqBody.data, encoding: reqBody.encoding === 'base64' ? 'base64' : undefined } : undefined,
          headersSize: -1,
          bodySize: e.request.bodyBytes ?? -1,
        },
        response: e.response
          ? {
              status: e.response.status,
              statusText: e.response.statusText ?? '',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: e.response.headers,
              content: {
                size: e.response.bodyBytes ?? resBody?.data.length ?? 0,
                mimeType: e.response.mimeType ?? headerValue(e.response.headers, 'content-type') ?? '',
                text: resBody?.data,
                encoding: resBody?.encoding === 'base64' ? 'base64' : undefined,
                comment: `testlens.bodyCapture=${e.bodyCapture.response}`,
              },
              redirectURL: '',
              headersSize: -1,
              bodySize: e.response.bodyBytes ?? -1,
            }
          : { status: 0, statusText: e.error ? `${e.error.kind}${e.error.message ? `: ${e.error.message}` : ''}` : '', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: e.timing?.ttfbMs ?? e.timing?.totalMs ?? 0, receive: e.timing ? Math.max(0, e.timing.totalMs - (e.timing.ttfbMs ?? e.timing.totalMs)) : 0 },
        comment: JSON.stringify({ id: e.id, initiator: e.initiator?.type, classification: e.classification, correlationIds: e.correlationIds }),
      };
    });
  return JSON.stringify(
    {
      log: {
        version: '1.2',
        creator: { name: 'TestLens', version: ENGINE_VERSION },
        browser: ctx.browser ? { name: ctx.browser.name, version: ctx.browser.version } : undefined,
        pages: [{ startedDateTime: new Date(ctx.trigger.at - ctx.trigger.preWindowMs).toISOString(), id: 'page_1', title: ctx.application.title ?? ctx.application.url ?? '', pageTimings: {} }],
        entries,
      },
    },
    null,
    2,
  );
}

export function buildConsoleLog(ctx: BugContext): string {
  const lines: string[] = [];
  lines.push(`# TestLens console & error log — incident ${ctx.incidentId}`);
  lines.push(`# Report Issue at ${new Date(ctx.trigger.at).toISOString()} | window -${minutes(ctx.trigger.preWindowMs)} / +${Math.round(ctx.trigger.postWindowMs / 1000)}s`);
  lines.push('');
  const rows: { ts: number; line: string }[] = [];
  for (const c of ctx.console) rows.push({ ts: c.ts, line: `${iso(c.ts)} [console.${c.level}] ${c.args.join(' ')}${c.stack ? `\n    ${c.stack.split('\n').join('\n    ')}` : ''}` });
  for (const e of ctx.errors) rows.push({ ts: e.ts, line: `${iso(e.ts)} [${e.kind}] ${e.message}${e.source ? ` (${e.source}:${e.line ?? '?'}:${e.column ?? '?'})` : ''}${e.stack ? `\n    ${e.stack.split('\n').join('\n    ')}` : ''}` });
  rows.push({ ts: ctx.trigger.at, line: `${iso(ctx.trigger.at)} ===== TESTER CLICKED "REPORT ISSUE" =====` });
  rows.sort((a, b) => a.ts - b.ts);
  for (const r of rows) lines.push(r.line);
  return lines.join('\n');
}

/**
 * Human-readable network log: an index of every request, then a full block per
 * selected/API request with request headers, payload, response headers and body.
 * Correlation ids are marked with ">>>" so they stand out in any text viewer.
 */
export function buildNetworkLog(ctx: BugContext, opts: { maxBodyChars?: number; detailIds?: Set<string> } = {}): string {
  const maxBody = opts.maxBodyChars ?? 20_000;
  const sorted = [...ctx.exchanges].sort((a, b) => a.ts - b.ts);
  const focalId = ctx.evidence?.focal?.kind === 'exchange' ? ctx.evidence.focal.refId : undefined;
  const detail = opts.detailIds ?? new Set(sorted.filter((e) => e.classification.isApi || e.error || (e.response && e.response.status >= 400) || e.id === focalId).map((e) => e.id));

  const lines: string[] = [`# TestLens network log — incident ${ctx.incidentId}`, `# Report Issue at ${iso(ctx.trigger.at)} | ${sorted.length} requests | ${detail.size} with full detail below`, '', '## INDEX', '# time | status | method | url | duration | initiator | flags', ''];
  for (const e of sorted) {
    const flags = [e.id === focalId ? 'FOCAL' : '', e.classification.isApi ? 'api' : '', e.classification.isStatic ? 'static' : '', e.classification.isTelemetry ? 'telemetry' : '', e.classification.isPolling ? 'polling' : '', e.correlationIds.length ? `>>> ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(',')}` : '']
      .filter(Boolean)
      .join(' ');
    const status = e.error ? `ERR(${e.error.kind})` : String(e.response?.status ?? '-');
    lines.push(`${iso(e.ts)} | ${status.padEnd(9)} | ${e.method.padEnd(6)} | ${e.url} | ${e.timing ? `${Math.round(e.timing.totalMs)}ms` : '-'} | ${e.initiator?.type ?? '-'} | ${flags}`);
  }

  lines.push('', '## DETAIL', '');
  for (const e of sorted) {
    if (!detail.has(e.id)) continue;
    const corr = new Set(e.correlationIds.map((c) => c.header.toLowerCase()));
    const hdr = (hs: { name: string; value: string }[]) => (hs.length ? hs.map((h) => `${corr.has(h.name.toLowerCase()) ? '>>> ' : '    '}${h.name}: ${h.value}`) : ['    (none captured)']);
    const body = (b: HttpExchange['request']['body'], status: string) => {
      if (!b || b.encoding === 'base64') return [`    <${status}>`];
      const text = b.data.length > maxBody ? `${b.data.slice(0, maxBody)}\n    … ${b.data.length - maxBody} more chars (see HAR)` : b.data;
      return text.split('\n').map((l) => `    ${l}`);
    };
    lines.push('='.repeat(100));
    lines.push(`${e.id === focalId ? '[FOCAL] ' : ''}${e.method} ${e.url}`);
    lines.push(`${iso(e.ts)}  ${e.error ? `FAILED ${e.error.kind}${e.error.message ? `: ${e.error.message}` : ''}` : `HTTP ${e.response?.status}${e.response?.statusText ? ` ${e.response.statusText}` : ''}`}${e.timing ? `  ${Math.round(e.timing.totalMs)} ms` : ''}  initiator=${e.initiator?.type ?? '-'}`);
    if (e.correlationIds.length) lines.push(`>>> correlation: ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(', ')}`);
    lines.push('', '--- request headers', ...hdr(e.request.headers));
    lines.push('', `--- request payload (${e.bodyCapture.request}${e.request.body?.mimeType ? `, ${e.request.body.mimeType}` : ''})`, ...body(e.request.body, e.bodyCapture.request));
    lines.push('', `--- response headers${e.response ? ` (${e.response.status})` : ''}`, ...hdr(e.response?.headers ?? []));
    lines.push('', `--- response body (${e.bodyCapture.response}${e.response?.mimeType ? `, ${e.response.mimeType}` : ''})`, ...body(e.response?.body, e.bodyCapture.response));
    if (e.initiator?.stack) lines.push('', '--- initiator stack', ...e.initiator.stack.split('\n').map((l) => `    ${l}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function selectedExchangeIds(ctx: BugContext): Set<string> {
  const ids = new Set<string>();
  for (const it of ctx.evidence?.items ?? []) if (it.include && it.kind === 'exchange') ids.add(it.refId);
  return ids;
}

/** Stable signature for duplicate detection: METHOD /normalized/path STATUS | top error message */
export function focalSignature(ctx: BugContext): string | undefined {
  const f = ctx.evidence?.focal;
  if (!f) return undefined;
  if (f.kind === 'exchange') {
    const e = ctx.exchanges.find((x) => x.id === f.refId);
    if (!e) return undefined;
    const path = pathOf(e.url).replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/{uuid}');
    return `${e.method.toUpperCase()} ${path} ${e.error ? e.error.kind : e.response?.status ?? ''}`.trim();
  }
  if (f.kind === 'error') {
    const er = ctx.errors.find((x) => x.id === f.refId);
    return er ? `JS ${er.kind} ${truncate(er.message, 60)}` : undefined;
  }
  if (f.kind === 'assertion') {
    const a = ctx.assertions.find((x) => x.id === f.refId);
    return a ? `ASSERT ${truncate(a.name, 60)}` : undefined;
  }
  const c = ctx.console.find((x) => x.id === f.refId);
  return c ? `CONSOLE ${truncate(c.args.join(' '), 60)}` : undefined;
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
function stripQuery(url: string) {
  return url.split('?')[0] ?? url;
}
function queryOf(url: string) {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}
export function headerValue(headers: { name: string; value: string }[], name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === n)?.value;
}
function tsOf(ctx: BugContext, kind: FocalEvent['kind'], id: string): number | undefined {
  switch (kind) {
    case 'exchange':
      return ctx.exchanges.find((e) => e.id === id)?.ts;
    case 'error':
      return ctx.errors.find((e) => e.id === id)?.ts;
    case 'assertion':
      return ctx.assertions.find((e) => e.id === id)?.ts;
    case 'console':
      return ctx.console.find((e) => e.id === id)?.ts;
  }
}
function describeOffset(ts: number, t0: number) {
  const d = Math.round((t0 - ts) / 1000);
  if (d >= 0) return d < 1 ? 'at the moment of' : `${d}s before`;
  return `${-d}s after`;
}
function round(n: number) {
  return Math.round(n * 10) / 10;
}
function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function minutes(ms: number) {
  const m = ms / 60000;
  return m >= 1 ? `${Math.round(m)} min` : `${Math.round(ms / 1000)} s`;
}
function iso(ts: number) {
  return new Date(ts).toISOString();
}
function dedupe<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
