/**
 * @testlens/trackers-jira-dc — Jira Server / Data Center adapter (REST v2, wiki markup, PAT).
 * Reuses the Cloud adapter for everything that is identical.
 */
import type { BugDraft } from '@testlens/schema';
import { TrackerError, renderWikiMarkup, resolveMappedValue, sanitizeLabels, searchNeedle, validateRequired } from '@testlens/trackers-core';
import type { AuthSession, CreateResult, FieldSchema, ITrackerAdapter, IssueTypeRef, ProjectRef, SimilarIssue, TrackerAuthConfig, TrackerDescriptor, TrackerMapping, ValidationResult } from '@testlens/trackers-core';
import { JiraCloudAdapter, escapeJql, toJiraValue } from '@testlens/trackers-jira-cloud';

export const JIRA_DC_DESCRIPTOR: TrackerDescriptor = {
  id: 'jira-dc',
  displayName: 'Jira Server / Data Center',
  blurb: 'Self-hosted Jira. Uses a Personal Access Token (Jira 8.14+); older servers can use username + password in the token field.',
  authFields: [
    { key: 'baseUrl', label: 'Jira base URL', placeholder: 'https://jira.yourcompany.com', type: 'url' },
    { key: 'email', label: 'Username (only for password auth)', placeholder: 'leave empty when using a PAT' },
    { key: 'secret', label: 'Personal access token (or password)', type: 'password', help: 'Profile → Personal Access Tokens → Create token' },
  ],
  containerLabel: 'Project',
  typeLabel: 'Issue type',
  attachments: 'native',
  authMethod: 'pat',
};

export class JiraDataCenterAdapter extends JiraCloudAdapter implements ITrackerAdapter {
  override readonly id: string = 'jira-dc';
  override readonly displayName: string = 'Jira Server / Data Center';
  override readonly descriptor: TrackerDescriptor = JIRA_DC_DESCRIPTOR;

  override async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Username present → basic auth with password; otherwise bearer PAT.
    if (cfg.email) headers.Authorization = `Basic ${btoa(`${cfg.email}:${cfg.secret}`)}`;
    else headers.Authorization = `Bearer ${cfg.secret}`;
    const me = await this.json<{ name: string; displayName: string; key?: string }>({ baseUrl, headers }, 'GET', '/rest/api/2/myself');
    return { baseUrl, headers, accountId: me.key ?? me.name, displayName: me.displayName };
  }

  override async listProjects(s: AuthSession): Promise<ProjectRef[]> {
    const all = await this.json<{ id: string; key: string; name: string }[]>(s, 'GET', '/rest/api/2/project');
    return all.map((p) => ({ id: p.id, key: p.key, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  override async listIssueTypes(s: AuthSession, projectKey: string): Promise<IssueTypeRef[]> {
    const p = await this.json<{ issueTypes: { id: string; name: string; subtask: boolean }[] }>(s, 'GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}`);
    return p.issueTypes.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
  }

  override async getCreateFields(s: AuthSession, projectKey: string, issueTypeId: string): Promise<FieldSchema[]> {
    const meta = await this.json<{
      projects: { issuetypes: { id: string; fields: Record<string, { name: string; required: boolean; hasDefaultValue?: boolean; schema: { type: string; items?: string }; allowedValues?: { id: string; name?: string; value?: string }[] }> }[] }[];
    }>(s, 'GET', `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&issuetypeIds=${encodeURIComponent(issueTypeId)}&expand=projects.issuetypes.fields`);
    const it = meta.projects[0]?.issuetypes.find((t) => t.id === issueTypeId) ?? meta.projects[0]?.issuetypes[0];
    if (!it) throw new TrackerError('Jira returned no create metadata for that project / issue type');
    return Object.entries(it.fields).map(([key, f]) => ({
      key,
      name: f.name,
      required: f.required,
      type: f.schema.type,
      itemsType: f.schema.items,
      hasDefault: f.hasDefaultValue,
      allowedValues: f.allowedValues?.map((v) => ({ id: v.id, name: v.name ?? v.value ?? v.id })),
    }));
  }

  // Description is wiki markup text on Server/DC.
  override renderDescription(draft: BugDraft): string {
    return renderWikiMarkup(draft);
  }
  renderWiki(draft: BugDraft): string {
    return this.renderDescription(draft);
  }

  override validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const payload = this.buildPayload(draft, mapping, fields) as { fields: Record<string, unknown> };
    return validateRequired(draft, payload.fields, fields, ['project', 'issuetype', 'reporter']);
  }

  override buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const out: Record<string, unknown> = {
      project: { key: mapping.projectKey },
      issuetype: { id: mapping.issueTypeId },
      summary: draft.summary,
      description: this.renderWiki(draft),
    };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const [key, raw] of Object.entries(mapping.fields)) {
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => this.renderWiki(draft));
      if (v !== undefined) out[key] = toJiraValue(v, { ...(byKey.get(key) ?? { key, name: key, required: false, type: 'string' }), type: byKey.get(key)?.type === 'doc' ? 'string' : (byKey.get(key)?.type ?? 'string') });
    }
    if (out.labels) out.labels = sanitizeLabels(out.labels);
    return { fields: out };
  }

  override async createIssue(s: AuthSession, payload: unknown): Promise<CreateResult> {
    const res = await this.json<{ id: string; key: string }>(s, 'POST', '/rest/api/2/issue', payload);
    return { id: res.id, key: res.key, url: `${s.baseUrl}/browse/${res.key}` };
  }

  override async findSimilar(s: AuthSession, projectKey: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    const jql = `project = "${projectKey}" AND statusCategory != Done AND (summary ~ "${escapeJql(needle)}" OR text ~ "${escapeJql(needle)}") ORDER BY created DESC`;
    try {
      const res = await this.json<{ issues: { key: string; fields: { summary: string; status: { name: string } } }[] }>(s, 'GET', `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,status`);
      return res.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, url: `${s.baseUrl}/browse/${i.key}` }));
    } catch {
      return [];
    }
  }

  protected override apiBase() {
    return '/rest/api/2';
  }
}
