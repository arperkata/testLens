import { describe, expect, it } from 'vitest';
import { runEvidenceEngine } from '@testlens/evidence-engine';
import { compose } from '@testlens/composer';
import { fixture } from '../../evidence-engine/src/index.test';
import { ANALYSIS_JSON_SCHEMA, buildAnalysisInput } from './index';

describe('AI projection', () => {
  const ctx = runEvidenceEngine(fixture());
  const draft = compose(ctx);
  const input = buildAnalysisInput(ctx, draft);
  const json = JSON.stringify(input);

  it('carries the action trail in order with relative timestamps', () => {
    const kinds = input.actions.map((a) => a.kind);
    expect(kinds[0]).toBe('navigation:load');
    expect(input.actions.some((a) => a.kind === 'click' && a.detail === 'Submit receipt')).toBe(true);
    expect(input.actions.every((a) => /^[-+]\d+\.\d+s$/.test(a.t))).toBe(true);
  });

  it('describes the focal request without headers and with a bounded body snippet', () => {
    expect(input.focal?.method).toBe('POST');
    expect(input.focal?.url).toBe('/api/merchant/receipt');
    expect(input.focal?.status).toBe(500);
    expect(input.focal?.responseSnippet).toContain('db timeout');
    // no header dumps: the only mention of a correlation id is the engine's human-readable observation
    expect((input.focal as Record<string, unknown>).headers).toBeUndefined();
    expect(json).not.toContain('content-type');
    expect(json).not.toContain('authorization');
    expect(json).not.toContain('cookie');
  });

  it('can omit bodies entirely', () => {
    const noBodies = buildAnalysisInput(ctx, draft, { includeBodies: false });
    expect(noBodies.focal?.responseSnippet).toBeUndefined();
  });

  it('includes errors, console errors, observations and the current draft', () => {
    expect(input.errors.some((e) => e.kind === 'unhandledrejection')).toBe(true);
    expect(input.consoleErrors.some((c) => c.text.includes('Failed to submit'))).toBe(true);
    expect(input.observations.some((o) => o.includes('succeeded 2 time(s)'))).toBe(true);
    expect(input.draft.summary).toBe(draft.summary);
  });

  it('bounds the number of actions', () => {
    const big = { ...ctx, interactions: Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, ts: ctx.trigger.at - 100_000 + i * 100, kind: 'click' as const, target: { selector: `#b${i}`, tag: 'button', text: `B${i}` } })) };
    expect(buildAnalysisInput(big, draft, { maxActions: 20 }).actions.length).toBe(20);
  });

  it('exposes a strict JSON schema for structured output', () => {
    expect(ANALYSIS_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(ANALYSIS_JSON_SCHEMA.required).toContain('stepsToReproduce');
  });
});
