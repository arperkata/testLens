/**
 * Cross-adapter contract tests: every adapter must render a description, build a payload
 * from the same mapping and validate required fields consistently.
 */
import { describe, expect, it } from 'vitest';
import type { BugDraft } from '@testlens/schema';
import { JiraCloudAdapter } from '@testlens/trackers-jira-cloud';
import { JiraDataCenterAdapter } from '@testlens/trackers-jira-dc';
import { AzureDevOpsAdapter } from '@testlens/trackers-azure-devops';
import { GitHubAdapter } from '@testlens/trackers-github';
import { GitLabAdapter } from '@testlens/trackers-gitlab';
import { LinearAdapter } from '@testlens/trackers-linear';
import { renderHtml, renderMarkdown, renderWikiMarkup, searchNeedle, type FieldSchema, type ITrackerAdapter, type TrackerMapping } from './index';

const draft: BugDraft = {
  summary: 'POST /api/x returns 500 on "Checkout"',
  stepsToReproduce: ['Open https://app.example.com', 'Click "Submit"'],
  expectedResult: 'Request succeeds',
  actualResult: 'HTTP 500 after 300 ms',
  sections: [
    { id: 'environment', title: 'Environment', body: 'Browser: Chrome 130\nURL: https://app.example.com', provenance: 'captured' },
    { id: 'failed-request', title: 'Failed request', body: 'POST https://app.example.com/api/x\n→ HTTP 500', provenance: 'captured', code: true },
    { id: 'observations', title: 'Observations', body: '• succeeded 2 times then failed\n• correlation id available', provenance: 'derived' },
    { id: 'ai-analysis', title: 'AI analysis', body: 'Maybe the DB', provenance: 'ai' },
  ],
  labels: ['testlens', 'qa env', 'server-error'],
  environmentSummary: 'Chrome 130 · Windows · QA',
  focalSignature: 'POST /api/x 500',
};

const adapters: ITrackerAdapter[] = [new JiraCloudAdapter(), new JiraDataCenterAdapter(), new AzureDevOpsAdapter(), new GitHubAdapter(), new GitLabAdapter(), new LinearAdapter()];

describe('description renderers', () => {
  it('markdown has steps, sections, AI caveat and code fences', () => {
    const md = renderMarkdown(draft);
    expect(md).toContain('### Steps to reproduce');
    expect(md).toContain('1. Open https://app.example.com');
    expect(md).toContain('```\nPOST https://app.example.com/api/x');
    expect(md).toContain('- succeeded 2 times then failed');
    expect(md).toContain('AI-generated analysis');
  });
  it('html escapes and links', () => {
    const html = renderHtml(draft);
    expect(html).toContain('<h3>Steps to reproduce</h3><ol><li>Open <a href="https://app.example.com">');
    expect(html).toContain('&gt; HTTP 500'.replace('&gt;', '→')); // arrow is not escaped
    expect(html).toContain('<pre style="white-space:pre-wrap">POST https://app.example.com/api/x');
    expect(html).toContain('AI-generated analysis');
  });
  it('wiki markup uses h3/code/panel', () => {
    const wiki = renderWikiMarkup(draft);
    expect(wiki).toContain('h3. Steps to reproduce');
    expect(wiki).toContain('# Open https://app.example.com');
    expect(wiki).toContain('{code}\nPOST https://app.example.com/api/x');
    expect(wiki).toContain('{panel:title=AI-generated analysis');
    expect(wiki).toContain('* succeeded 2 times then failed');
  });
  it('search needle prefers the path', () => {
    expect(searchNeedle('POST /api/x 500')).toBe('/api/x');
    expect(searchNeedle('JS uncaught Cannot read')).toBe('uncaught');
  });
});

describe('every adapter', () => {
  for (const a of adapters) {
    it(`${a.id} exposes a descriptor consistent with its id`, () => {
      expect(a.descriptor.id).toBe(a.id);
      expect(a.descriptor.authFields.some((f) => f.key === 'secret')).toBe(true);
      expect(['native', 'none']).toContain(a.descriptor.attachments);
    });
    it(`${a.id} validates an empty summary and builds a payload with the title`, () => {
      const mapping: TrackerMapping = { trackerId: a.id, projectKey: 'P', issueTypeId: 'Bug', fields: { labels: ['$labels'] }, attachKinds: [] };
      const v = a.validate({ ...draft, summary: '' }, mapping, []);
      expect(v.ok).toBe(false);
      const payload = JSON.stringify(a.buildPayload(draft, mapping, []));
      expect(payload).toContain('POST /api/x returns 500');
    });
  }
});

describe('Jira Data Center', () => {
  it('posts wiki markup and v2 field shapes', () => {
    const a = new JiraDataCenterAdapter();
    const fields: FieldSchema[] = [{ key: 'priority', name: 'Priority', required: false, type: 'priority', allowedValues: [{ id: '2', name: 'High' }] }];
    const p = a.buildPayload(draft, { trackerId: 'jira-dc', projectKey: 'SHOP', issueTypeId: '1', fields: { priority: 'High', labels: ['$labels'] }, attachKinds: [] }, fields) as { fields: Record<string, unknown> };
    expect(typeof p.fields.description).toBe('string');
    expect(p.fields.description as string).toContain('h3. Steps to reproduce');
    expect(p.fields.priority).toEqual({ id: '2' });
    expect(p.fields.labels).toEqual(['testlens', 'qa-env', 'server-error']);
  });
});

describe('Azure DevOps', () => {
  it('puts repro steps on Bugs, tags from labels, and flags required fields', () => {
    const a = new AzureDevOpsAdapter();
    const fields: FieldSchema[] = [
      { key: 'Microsoft.VSTS.Common.Severity', name: 'Severity', required: true, type: 'option', allowedValues: [{ id: '2 - High', name: '2 - High' }, { id: '3 - Medium', name: '3 - Medium' }] },
      { key: 'System.AreaPath', name: 'Area path', required: false, type: 'string' },
    ];
    const bad = a.validate(draft, { trackerId: 'azure-devops', projectKey: 'Shop', issueTypeId: 'Bug', fields: {}, attachKinds: [] }, fields);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]!.field).toBe('Microsoft.VSTS.Common.Severity');
    const p = a.buildPayload(draft, { trackerId: 'azure-devops', projectKey: 'Shop', issueTypeId: 'Bug', fields: { 'Microsoft.VSTS.Common.Severity': '2 - High', 'System.AreaPath': 'Shop\\Checkout', labels: ['$labels', 'e2e'] }, attachKinds: [] }, fields) as { fields: Record<string, unknown> };
    expect(p.fields['System.Title']).toBe(draft.summary);
    expect(p.fields['Microsoft.VSTS.TCM.ReproSteps'] as string).toContain('<h3>Steps to reproduce</h3>');
    expect(p.fields['Microsoft.VSTS.Common.Severity']).toBe('2 - High');
    expect(p.fields['System.AreaPath']).toBe('Shop\\Checkout');
    expect(p.fields['System.Tags']).toBe('testlens; qa env; server-error; e2e');
  });
  it('uses Description for non-bug types', () => {
    const a = new AzureDevOpsAdapter();
    const p = a.buildPayload(draft, { trackerId: 'azure-devops', projectKey: 'Shop', issueTypeId: 'Task', fields: {}, attachKinds: [] }, []) as { fields: Record<string, unknown> };
    expect(p.fields['System.Description'] as string).toContain('<h3>Steps to reproduce</h3>');
    expect(p.fields['Microsoft.VSTS.TCM.ReproSteps']).toBeUndefined();
  });
});

describe('GitHub', () => {
  it('builds title/body/labels/milestone and declines attachments', async () => {
    const a = new GitHubAdapter();
    const fields: FieldSchema[] = [
      { key: 'labels', name: 'Labels', required: false, type: 'array', itemsType: 'string', allowedValues: [{ id: 'bug', name: 'bug' }] },
      { key: 'milestone', name: 'Milestone', required: false, type: 'option', allowedValues: [{ id: '7', name: 'Sprint 12' }] },
    ];
    const p = a.buildPayload(draft, { trackerId: 'github', projectKey: 'acme/shop', issueTypeId: 'issue', fields: { labels: ['$labels', 'bug'], milestone: 'Sprint 12' }, attachKinds: [] }, fields) as Record<string, unknown>;
    expect(p.title).toBe(draft.summary);
    expect(p.body as string).toContain('### Steps to reproduce');
    expect(p.labels).toEqual(['testlens', 'qa env', 'server-error', 'bug']);
    expect(p.milestone).toBe(7);
    const att = await a.attach({ baseUrl: '', headers: {} }, { id: '1', key: '#1', url: '' }, [{ artifact: { id: 'a', kind: 'screenshot', fileName: 's.png', mime: 'image/png', bytes: 1, storage: { type: 'inline', ref: '' }, redaction: { status: 'not-applicable', rulesApplied: [] }, include: true }, blob: new Blob(['x']) }]);
    expect(att[0]!.ok).toBe(false);
    expect(a.descriptor.attachments).toBe('none');
  });
});

describe('GitLab', () => {
  it('builds issue payload with comma labels and issue_type', () => {
    const a = new GitLabAdapter();
    const fields: FieldSchema[] = [
      { key: 'labels', name: 'Labels', required: false, type: 'array', itemsType: 'string' },
      { key: 'milestone_id', name: 'Milestone', required: false, type: 'option', allowedValues: [{ id: '42', name: 'M1' }] },
      { key: 'confidential', name: 'Confidential', required: false, type: 'option', allowedValues: [{ id: 'false', name: 'No' }, { id: 'true', name: 'Yes' }] },
    ];
    const p = a.buildPayload(draft, { trackerId: 'gitlab', projectKey: 'acme/shop', issueTypeId: 'incident', fields: { labels: ['$labels'], milestone_id: 'M1', confidential: 'Yes' }, attachKinds: [] }, fields) as Record<string, unknown>;
    expect(p.issue_type).toBe('incident');
    expect(p.labels).toBe('testlens,qa env,server-error');
    expect(p.milestone_id).toBe(42);
    expect(p.confidential).toBe(true);
    expect(p.description as string).toContain('### Actual result');
  });
});

describe('Linear', () => {
  it('maps priority/labels/state ids and appends TestLens labels to the description', () => {
    const a = new LinearAdapter();
    const fields: FieldSchema[] = [
      { key: 'priority', name: 'Priority', required: false, type: 'option', allowedValues: [{ id: '2', name: 'High' }] },
      { key: 'labelIds', name: 'Labels', required: false, type: 'array', itemsType: 'option', allowedValues: [{ id: '6f1c2a9e-1111-4a2b-9c3d-123456789abc', name: 'Bug' }] },
      { key: 'stateId', name: 'Status', required: false, type: 'option', allowedValues: [{ id: 'st-1', name: 'Todo' }] },
    ];
    const p = a.buildPayload(draft, { trackerId: 'linear', projectKey: 'team-uuid', issueTypeId: 'issue', fields: { priority: 'High', labelIds: 'Bug', stateId: 'Todo', labels: ['$labels'] }, attachKinds: [] }, fields) as Record<string, unknown>;
    expect(p.teamId).toBe('team-uuid');
    expect(p.priority).toBe(2);
    expect(p.labelIds).toEqual(['6f1c2a9e-1111-4a2b-9c3d-123456789abc']);
    expect(p.stateId).toBe('st-1');
    expect(p.description as string).toContain('TestLens labels: testlens, qa env, server-error');
  });
});
