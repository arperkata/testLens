import { describe, expect, it } from 'vitest';
import { runEvidenceEngine } from '@testlens/evidence-engine';
import { compose } from '@testlens/composer';
import { isHar, normalizeHar, type Har } from './index';

const har: Har = {
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    browser: { name: 'Chrome', version: '130' },
    pages: [{ startedDateTime: '2026-10-05T10:00:00.000Z', title: 'Checkout', id: 'page_1' }],
    entries: [
      { startedDateTime: '2026-10-05T10:00:00.000Z', time: 120, request: { method: 'GET', url: 'https://app.example.com/checkout', headers: [{ name: ':authority', value: 'x' }, { name: 'Accept', value: 'text/html' }] }, response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'text/html' }], content: { size: 10, mimeType: 'text/html', text: '<html>' } }, _resourceType: 'document' },
      { startedDateTime: '2026-10-05T10:00:01.000Z', time: 30, request: { method: 'GET', url: 'https://app.example.com/app.js', headers: [] }, response: { status: 200, headers: [], content: { size: 3, mimeType: 'application/javascript' } }, _resourceType: 'script' },
      { startedDateTime: '2026-10-05T10:00:05.000Z', time: 2100, request: { method: 'POST', url: 'https://api.example.com/api/merchant/receipt', headers: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnopqrstuvwxyz0123' }], postData: { mimeType: 'application/json', text: '{"amount":42}' } }, response: { status: 500, statusText: 'Internal Server Error', headers: [{ name: 'x-request-id', value: 'r-9' }], content: { size: 20, mimeType: 'application/json', text: '{"error":"timeout"}' } }, _resourceType: 'xhr' },
      { startedDateTime: '2026-10-05T10:00:06.000Z', time: 0, request: { method: 'GET', url: 'https://api.example.com/api/ping', headers: [] }, response: { status: 0, headers: [], _error: 'net::ERR_CONNECTION_RESET' } },
    ],
  },
};

describe('HAR connector', () => {
  it('detects HAR and maps entries to exchanges with initiator types', () => {
    expect(isHar(har)).toBe(true);
    const ctx = normalizeHar(har, { fileName: 'session.har' });
    expect(ctx.source.connectorId).toBe('har');
    expect(ctx.source.tool.name).toBe('WebInspector');
    expect(ctx.browser?.name).toBe('Chrome');
    expect(ctx.exchanges.map((e) => e.initiator?.type)).toEqual(['navigation', 'script', 'xhr', 'other']);
    expect(ctx.exchanges[0]!.request.headers.some((h) => h.name.startsWith(':'))).toBe(false);
    expect(ctx.exchanges[2]!.response?.body?.data).toBe('{"error":"timeout"}');
    expect(ctx.exchanges[3]!.error?.message).toBe('net::ERR_CONNECTION_RESET');
    expect(ctx.application.url).toBe('https://app.example.com/checkout');
    expect(ctx.trigger.preWindowMs).toBe(6000);
  });

  it('is picked up by the evidence engine and composer', () => {
    const ctx = runEvidenceEngine(normalizeHar(har, { fileName: 'session.har' }));
    expect(ctx.evidence?.focal?.kind).toBe('exchange');
    const focal = ctx.exchanges.find((e) => e.id === ctx.evidence!.focal!.refId)!;
    expect(focal.response?.status).toBe(500);
    expect(focal.correlationIds).toEqual([{ header: 'x-request-id', value: 'r-9' }]);
    expect(ctx.exchanges[1]!.classification.isStatic).toBe(true);
    const draft = compose(ctx);
    expect(draft.summary).toContain('POST /api/merchant/receipt returns 500');
    expect(draft.stepsToReproduce[0]).toContain('Reproduce the traffic captured in session.har');
  });
});
