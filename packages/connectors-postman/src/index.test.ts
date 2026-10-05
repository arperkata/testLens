import { describe, expect, it } from 'vitest';
import { runEvidenceEngine } from '@testlens/evidence-engine';
import { compose } from '@testlens/composer';
import { redactContext } from '@testlens/redaction';
import { isNewmanRun, isPostmanPayload, normalizeNewmanRun, normalizePostmanPayload, type NewmanRunJson, type PostmanIngestPayload } from './index';

const payload: PostmanIngestPayload = {
  source: 'postman',
  timestamp: '2026-10-05T10:00:00.000Z',
  collection: 'Merchant API',
  folder: 'Receipts',
  requestName: 'Create receipt',
  iteration: 0,
  environment: { name: 'QA', values: { baseUrl: 'https://api.example.com', apiKey: 'sk-live-ABCDEFGHIJKLMNOPQRSTUV' } },
  request: {
    method: 'POST',
    url: 'https://api.example.com/api/merchant/receipt',
    headers: [
      { key: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz' },
      { key: 'Content-Type', value: 'application/json' },
    ],
    body: { mode: 'raw', raw: '{"amount":42,"password":"hunter2"}' },
  },
  response: { code: 500, status: 'Internal Server Error', headers: [{ key: 'content-type', value: 'application/json' }, { key: 'x-request-id', value: 'req-77' }], body: '{"error":"db timeout"}', responseTime: 1234, responseSize: 24 },
  tests: [
    { name: 'status is 201', passed: false, error: 'expected 500 to equal 201' },
    { name: 'has receiptId', passed: false, error: "Cannot read properties of undefined (reading 'receiptId')" },
    { name: 'responds in time', passed: true },
  ],
  console: [{ level: 'error', message: 'receipt creation failed' }],
  postmanVersion: '11.2',
};

describe('Postman connector', () => {
  it('detects and normalises the snippet payload into a BugContext', () => {
    expect(isPostmanPayload(payload)).toBe(true);
    const ctx = normalizePostmanPayload(payload);
    expect(ctx.source.connectorId).toBe('postman');
    expect(ctx.source.tool.name).toBe('Postman');
    expect(ctx.exchanges).toHaveLength(1);
    const ex = ctx.exchanges[0]!;
    expect(ex.method).toBe('POST');
    expect(ex.response?.status).toBe(500);
    expect(ex.response?.body?.data).toContain('db timeout');
    expect(ex.timing?.totalMs).toBe(1234);
    expect(ctx.assertions.filter((a) => !a.passed)).toHaveLength(2);
    expect(ctx.assertions[0]!.exchangeId).toBe(ex.id);
    expect(ctx.trigger.initiatedBy).toBe('assertion-failure');
    expect(ctx.execution?.collection).toBe('Merchant API');
    expect(ctx.application.title).toBe('Merchant API / Receipts / Create receipt');
    expect(ctx.console[0]!.level).toBe('error');
  });

  it('flows through redaction, evidence and composer like a browser incident', () => {
    const ctx = runEvidenceEngine(redactContext(normalizePostmanPayload(payload)));
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(json).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRSTUV');
    // a 500 and a failed assertion are both valid focal events; the engine picks the higher score
    expect(['assertion', 'exchange']).toContain(ctx.evidence?.focal?.kind);
    expect(ctx.exchanges[0]!.correlationIds).toEqual([{ header: 'x-request-id', value: 'req-77' }]);
    const draft = compose(ctx);
    expect(draft.summary).toMatch(/Assertion failed|returns 500/);
    expect(draft.stepsToReproduce[0]).toContain('Open the Postman collection "Merchant API" with environment "QA"');
    expect(draft.stepsToReproduce.some((s) => s.includes('Send POST https://api.example.com/api/merchant/receipt'))).toBe(true);
    expect(draft.stepsToReproduce.some((s) => s.includes('"status is 201"'))).toBe(true);
    expect(ctx.evidence?.captureQuality.notes.join()).not.toContain('screenshot');
  });

  it('normalises a Newman run JSON into one incident with all executions', () => {
    const run: NewmanRunJson = {
      collection: { info: { name: 'Merchant API' } },
      environment: { name: 'QA', values: [{ key: 'token', value: 'secret-value' }] },
      run: {
        timings: { started: 1_750_000_000_000, completed: 1_750_000_005_000 },
        executions: [
          { item: { name: 'Login' }, request: { method: 'POST', url: { protocol: 'https', host: ['api', 'example', 'com'], path: ['auth', 'login'] }, header: [] }, response: { code: 200, status: 'OK', header: [{ key: 'content-type', value: 'application/json' }], stream: { type: 'Buffer', data: Array.from(Buffer.from('{"ok":true}')) }, responseTime: 80 }, assertions: [{ assertion: 'status 200' }] },
          { item: { name: 'Create receipt' }, request: { method: 'POST', url: 'https://api.example.com/api/merchant/receipt', header: [], body: { mode: 'raw', raw: '{"amount":1}' } }, response: { code: 500, status: 'Internal Server Error', header: [], stream: { type: 'Buffer', data: Array.from(Buffer.from('{"error":"boom"}')) }, responseTime: 900 }, assertions: [{ assertion: 'status 201', error: { message: 'expected 500 to equal 201' } }] },
        ],
      },
    };
    expect(isNewmanRun(run)).toBe(true);
    const ctx = runEvidenceEngine(normalizeNewmanRun(run));
    expect(ctx.exchanges).toHaveLength(2);
    expect(ctx.exchanges[0]!.url).toBe('https://api.example.com/auth/login');
    expect(ctx.exchanges[1]!.response?.body?.data).toBe('{"error":"boom"}');
    expect(ctx.assertions.filter((a) => !a.passed).map((a) => a.name)).toEqual(['Create receipt: status 201']);
    expect(ctx.source.tool.name).toBe('Newman');
    expect(['assertion', 'exchange']).toContain(ctx.evidence?.focal?.kind);
    expect(ctx.execution?.variables?.token).toBe('secret-value'); // redaction happens downstream
    expect(JSON.stringify(redactContext(ctx))).not.toContain('secret-value');
  });
});
