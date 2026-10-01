import { describe, expect, it } from 'vitest';
import type { BugDraft } from '@testlens/schema';
import type { FieldSchema, TrackerMapping } from '@testlens/trackers-core';
import { JiraCloudAdapter, renderAdf } from './index';

const draft: BugDraft = {
  summary: 'POST /api/x returns 500',
  stepsToReproduce: ['Open https://app', 'Click "Submit"'],
  expectedResult: 'Works',
  actualResult: 'HTTP 500',
  sections: [
    { id: 'environment', title: 'Environment', body: 'Browser: Chrome 130\nURL: https://app', provenance: 'captured' },
    { id: 'curl', title: 'cURL', body: "curl -X POST 'https://app'", provenance: 'derived', code: true },
    { id: 'ai-analysis', title: 'AI analysis', body: 'Maybe the DB', provenance: 'ai' },
  ],
  labels: ['testlens', 'qa env'],
  environmentSummary: 'Chrome 130 · Windows · QA',
  focalSignature: 'POST /api/x 500',
};

const fields: FieldSchema[] = [
  { key: 'summary', name: 'Summary', required: true, type: 'string' },
  { key: 'description', name: 'Description', required: false, type: 'doc' },
  { key: 'priority', name: 'Priority', required: false, type: 'priority', allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }] },
  { key: 'components', name: 'Components', required: false, type: 'array', itemsType: 'component', allowedValues: [{ id: '10', name: 'Checkout' }] },
  { key: 'customfield_10042', name: 'Environment', required: true, type: 'string' },
  { key: 'labels', name: 'Labels', required: false, type: 'array', itemsType: 'string' },
];

describe('Jira Cloud adapter', () => {
  const jira = new JiraCloudAdapter();

  it('renders ADF with steps, expected/actual, code blocks and an AI panel', () => {
    const doc = renderAdf(draft);
    expect(doc.type).toBe('doc');
    const types = doc.content.map((n) => n.type);
    expect(types).toContain('orderedList');
    expect(types).toContain('codeBlock');
    expect(types).toContain('panel');
    const panel = doc.content.find((n) => n.type === 'panel')!;
    expect(JSON.stringify(panel)).toContain('AI-generated analysis');
    expect(JSON.stringify(doc)).toContain('"href":"https://app"');
  });

  it('builds a payload from the mapping and resolves option fields by name', () => {
    const mapping: TrackerMapping = { trackerId: 'jira-cloud', projectKey: 'SHOP', issueTypeId: '10004', fields: { labels: ['$labels', 'regression'], priority: 'High', components: 'Checkout', customfield_10042: '{{draft.environmentSummary}}' }, attachKinds: [] };
    const p = jira.buildPayload(draft, mapping, fields) as { fields: Record<string, unknown> };
    expect(p.fields.project).toEqual({ key: 'SHOP' });
    expect(p.fields.issuetype).toEqual({ id: '10004' });
    expect(p.fields.summary).toBe(draft.summary);
    expect(p.fields.labels).toEqual(['testlens', 'qa-env', 'regression']);
    expect(p.fields.priority).toEqual({ id: '2' });
    expect(p.fields.components).toEqual([{ id: '10' }]);
    expect(p.fields.customfield_10042).toBe('Chrome 130 · Windows · QA');
    expect((p.fields.description as { type: string }).type).toBe('doc');
  });

  it('flags unmapped required fields', () => {
    const mapping: TrackerMapping = { trackerId: 'jira-cloud', projectKey: 'SHOP', issueTypeId: '1', fields: {}, attachKinds: [] };
    const v = jira.validate(draft, mapping, fields);
    expect(v.ok).toBe(false);
    expect(v.problems[0]!.field).toBe('customfield_10042');
  });
});
