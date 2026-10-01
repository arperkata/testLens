import { describe, expect, it } from 'vitest';
import { runEvidenceEngine } from '@testlens/evidence-engine';
import { fixture } from '../../evidence-engine/src/index.test';
import { compose, toCurl } from './index';

describe('composer', () => {
  const ctx = runEvidenceEngine(fixture());
  const draft = compose(ctx, { traceLinkTemplates: { 'x-request-id': 'https://logs.example.com/?q={value}' } });

  it('writes a factual summary from the focal exchange', () => {
    expect(draft.summary).toBe('POST /api/merchant/receipt returns 500 on "Checkout"');
  });

  it('derives steps from navigation and interactions, ending with the observation', () => {
    // the page load happened before the step window, so the composer prepends an "Open" step
    expect(draft.stepsToReproduce[0]).toBe('Open https://app.example.com/checkout');
    expect(draft.stepsToReproduce.some((s) => s.includes('Click "Submit receipt"'))).toBe(true);
    expect(draft.stepsToReproduce.at(-1)).toContain('Observe the failure');
  });

  it('states expected result from the earlier successful calls', () => {
    expect(draft.expectedResult).toContain('observed 200 on 2 earlier call(s)');
    expect(draft.actualResult).toContain('HTTP 500');
    expect(draft.actualResult).toContain('unhandled rejection followed');
  });

  it('includes provenance-tagged sections, trace link and cURL', () => {
    const ids = draft.sections.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['environment', 'failed-request', 'trace-links', 'curl', 'console', 'related-requests', 'observations', 'evidence-index']));
    expect(draft.sections.find((s) => s.id === 'trace-links')?.body).toContain('https://logs.example.com/?q=r-3');
    expect(draft.sections.every((s) => ['captured', 'derived', 'ai', 'user'].includes(s.provenance))).toBe(true);
    expect(draft.sections.find((s) => s.id === 'ai-analysis')).toBeUndefined();
  });

  it('labels the bug', () => {
    expect(draft.labels).toEqual(expect.arrayContaining(['testlens', 'qa', 'server-error']));
    expect(draft.focalSignature).toBe('POST /api/merchant/receipt 500');
  });

  it('renders cURL with masked headers and body', () => {
    const e = ctx.exchanges.find((x) => x.id === 'fail')!;
    const curl = toCurl({ ...e, request: { headers: [{ name: 'Authorization', value: '«redacted:abcd1234»' }], body: { encoding: 'json', data: '{"a":1}', truncated: false } } });
    expect(curl).toContain("curl -X POST 'https://api.example.com/api/merchant/receipt'");
    expect(curl).toContain("-H 'Authorization: «redacted:abcd1234»'");
    expect(curl).toContain(`--data-raw '{"a":1}'`);
  });
});
