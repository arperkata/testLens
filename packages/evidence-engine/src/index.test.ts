import { describe, expect, it } from 'vitest';
import { buildTimeline, type BugContext, type HttpExchange } from '@testlens/schema';
import { buildHar, focalSignature, runEvidenceEngine } from './index';

const T0 = 1_750_000_000_000;

function ex(partial: Partial<HttpExchange> & { id: string; ts: number; method: string; url: string }): HttpExchange {
  return {
    initiator: { type: 'fetch' },
    request: { headers: [{ name: 'content-type', value: 'application/json' }] },
    correlationIds: [],
    classification: { isApi: true, isStatic: false, isTelemetry: false },
    bodyCapture: { request: 'full', response: 'full' },
    timing: { totalMs: 120 },
    ...partial,
  };
}

export function fixture(): BugContext {
  const base = {
    schemaVersion: '1.0' as const,
    incidentId: 'inc_test',
    createdAt: T0,
    source: { connectorId: 'browser', connectorVersion: '1.0.0', tool: { name: 'Chrome', version: '130' }, captureMode: 'rolling' as const },
    trigger: { at: T0, preWindowMs: 300_000, postWindowMs: 15_000, initiatedBy: 'user' as const },
    environment: { name: 'QA', os: { name: 'Windows', version: '11' } },
    application: { url: 'https://app.example.com/checkout', title: 'Checkout', name: 'Shop' },
    browser: { name: 'Chrome', version: '130', userAgent: 'ua', viewport: { width: 1440, height: 900 }, extensionVersion: '0.1.0' },
    exchanges: [
      ex({ id: 'ok1', ts: T0 - 240_000, method: 'POST', url: 'https://api.example.com/api/merchant/receipt', response: { status: 200, headers: [{ name: 'x-request-id', value: 'r-1' }] } }),
      ex({ id: 'ok2', ts: T0 - 120_000, method: 'POST', url: 'https://api.example.com/api/merchant/receipt', response: { status: 200, headers: [{ name: 'x-request-id', value: 'r-2' }] } }),
      ex({ id: 'static', ts: T0 - 10_000, method: 'GET', url: 'https://app.example.com/assets/app.js', initiator: { type: 'script' }, classification: { isApi: false, isStatic: true, isTelemetry: false }, response: { status: 200, headers: [] } }),
      ex({ id: 'tele', ts: T0 - 5_000, method: 'POST', url: 'https://www.google-analytics.com/collect', response: { status: 500, headers: [] } }),
      ex({
        id: 'fail',
        ts: T0 - 4_000,
        method: 'POST',
        url: 'https://api.example.com/api/merchant/receipt',
        response: { status: 500, statusText: 'Internal Server Error', headers: [{ name: 'x-request-id', value: 'r-3' }], body: { encoding: 'json', data: '{"error":"db timeout"}', truncated: false } },
        timing: { totalMs: 3200 },
      }),
      ex({ id: 'related', ts: T0 - 3_500, method: 'GET', url: 'https://api.example.com/api/merchant/status', request: { headers: [{ name: 'x-request-id', value: 'r-3' }] }, response: { status: 200, headers: [] } }),
      ...Array.from({ length: 6 }, (_, i) => ex({ id: `poll${i}`, ts: T0 - 60_000 + i * 10_000, method: 'GET', url: 'https://api.example.com/api/heartbeat', response: { status: 200, headers: [] } })),
    ],
    console: [
      { id: 'c1', ts: T0 - 3_900, level: 'error' as const, args: ['Failed to submit receipt: 500'] },
      { id: 'c2', ts: T0 - 200_000, level: 'log' as const, args: ['app booted'] },
    ],
    errors: [{ id: 'e1', ts: T0 - 3_800, kind: 'unhandledrejection' as const, message: 'TypeError: Cannot read properties of undefined (reading "receiptId")', stack: 'at submit (/api/merchant/receipt)' }],
    interactions: [
      { id: 'i1', ts: T0 - 4_300, kind: 'click' as const, target: { selector: '#submit', tag: 'button', text: 'Submit receipt' } },
      { id: 'i0', ts: T0 - 30_000, kind: 'input' as const, target: { selector: '#amount', tag: 'input', name: 'amount' }, valueMasked: true },
    ],
    navigation: [{ id: 'n1', ts: T0 - 250_000, kind: 'load' as const, to: 'https://app.example.com/checkout', title: 'Checkout' }],
    assertions: [],
    artifacts: [{ id: 'a1', kind: 'screenshot' as const, fileName: 'screenshot.png', mime: 'image/png', bytes: 1000, storage: { type: 'indexeddb' as const, ref: 'a1' }, redaction: { status: 'not-applicable' as const, rulesApplied: [] }, include: true }],
    redaction: { appliedAt: ['capture' as const], rulesVersion: '1.0', counts: {} },
  };
  return { ...base, timeline: buildTimeline(base) };
}

describe('evidence engine', () => {
  it('picks the 500 on the API call as focal, not telemetry or static', () => {
    const out = runEvidenceEngine(fixture());
    expect(out.evidence?.focal?.refId).toBe('fail');
    expect(out.evidence?.focal?.reasons.join(' ')).toContain('server error 500');
  });

  it('classifies polling and telemetry', () => {
    const out = runEvidenceEngine(fixture());
    expect(out.exchanges.find((e) => e.id === 'poll3')?.classification.isPolling).toBe(true);
    expect(out.exchanges.find((e) => e.id === 'tele')?.classification.isTelemetry).toBe(true);
    expect(out.exchanges.find((e) => e.id === 'static')?.classification.isStatic).toBe(true);
  });

  it('relates by correlation id, causality and endpoint', () => {
    const out = runEvidenceEngine(fixture());
    const items = out.evidence!.items;
    const by = (id: string) => items.find((i) => i.refId === id);
    expect(by('related')?.include).toBe(true);
    expect(by('related')?.reasons.join()).toContain('correlation id');
    expect(by('i1')?.reasons.join()).toContain('likely cause');
    expect(by('ok2')?.reasons.join()).toContain('same endpoint');
    expect(by('tele')).toBeUndefined();
    expect(by('c1')?.include).toBe(true);
    expect(by('e1')?.include).toBe(true);
    expect(by('poll3')?.include ?? false).toBe(false);
  });

  it('extracts correlation ids from headers', () => {
    const out = runEvidenceEngine(fixture());
    expect(out.exchanges.find((e) => e.id === 'fail')?.correlationIds).toEqual([{ header: 'x-request-id', value: 'r-3' }]);
  });

  it('observes success-then-fail', () => {
    const out = runEvidenceEngine(fixture());
    expect(out.evidence?.observations.some((o) => o.includes('succeeded 2 time(s)'))).toBe(true);
  });

  it('honours a focal override', () => {
    const out = runEvidenceEngine(fixture(), {}, { kind: 'error', refId: 'e1' });
    expect(out.evidence?.focal?.refId).toBe('e1');
  });

  it('produces a stable focal signature', () => {
    const out = runEvidenceEngine(fixture());
    expect(focalSignature(out)).toBe('POST /api/merchant/receipt 500');
  });

  it('writes a valid HAR 1.2', () => {
    const out = runEvidenceEngine(fixture());
    const har = JSON.parse(buildHar(out, new Set(['fail'])));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].response.status).toBe(500);
    expect(har.log.entries[0].response.content.text).toContain('db timeout');
  });
});
