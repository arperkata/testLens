/**
 * @testlens/trackers-gitlab — GitLab Issues adapter (gitlab.com and self-managed).
 * REST v4, PRIVATE-TOKEN, Markdown description, attachments via project uploads + a note.
 */
import type { Artifact, BugDraft } from '@testlens/schema';
import { TrackerError, renderMarkdown, resolveMappedValue, safeText, searchNeedle, validateRequired } from '@testlens/trackers-core';
import type {
  AttachmentResult,
  AuthSession,
  CreateResult,
  FieldSchema,
  ITrackerAdapter,
  IssueTypeRef,
  ProjectRef,
  SimilarIssue,
  TrackerAuthConfig,
  TrackerDescriptor,
  TrackerLimits,
  TrackerMapping,
  ValidationResult,
} from '@testlens/trackers-core';

export const GITLAB_DESCRIPTOR: TrackerDescriptor = {
  id: 'gitlab',
  displayName: 'GitLab Issues',
  blurb: 'Issues in a GitLab project (gitlab.com or self-managed). Uses a Personal Access Token with the "api" scope.',
  authFields: [
    { key: 'baseUrl', label: 'GitLab URL', placeholder: 'https://gitlab.com', type: 'url' },
    { key: 'secret', label: 'Personal access token', type: 'password', help: 'User settings → Access tokens → scope: api' },
  ],
  tokenHelpUrl: '{baseUrl}/-/user_settings/personal_access_tokens',
  tokenSteps: ['Enter your GitLab URL above (gitlab.com or your own server), then open the token page', '"Add new token", name it TestLens, set an expiry', 'Scope: api', 'Create and copy the token; paste it below'],
  containerLabel: 'Project',
  typeLabel: 'Issue type',
  attachments: 'native',
  authMethod: 'pat',
};

export class GitLabAdapter implements ITrackerAdapter<string> {
  readonly id = 'gitlab';
  readonly displayName = 'GitLab Issues';
  readonly descriptor = GITLAB_DESCRIPTOR;

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = (cfg.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json', 'PRIVATE-TOKEN': cfg.secret };
    const me = await this.json<{ username: string; name?: string }>({ baseUrl, headers }, 'GET', '/api/v4/user');
    return { baseUrl, headers, accountId: me.username, displayName: me.name ?? me.username };
  }

  async listProjects(s: AuthSession, query?: string): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await this.json<{ id: number; path_with_namespace: string; name_with_namespace: string; issues_enabled?: boolean; archived: boolean }[]>(s, 'GET', `/api/v4/projects?membership=true&simple=true&per_page=100&page=${page}&order_by=last_activity_at${query ? `&search=${encodeURIComponent(query)}` : ''}`);
      out.push(...res.filter((p) => p.issues_enabled !== false && !p.archived).map((p) => ({ id: String(p.id), key: p.path_with_namespace, name: p.name_with_namespace })));
      if (res.length < 100) break;
    }
    return out;
  }

  async listIssueTypes(): Promise<IssueTypeRef[]> {
    return [
      { id: 'issue', name: 'Issue', subtask: false },
      { id: 'incident', name: 'Incident', subtask: false },
    ];
  }

  async getCreateFields(s: AuthSession, projectKey: string): Promise<FieldSchema[]> {
    const pid = encodeURIComponent(projectKey);
    const [labels, milestones] = await Promise.all([
      this.json<{ name: string }[]>(s, 'GET', `/api/v4/projects/${pid}/labels?per_page=100&include_ancestor_groups=true`).catch(() => [] as { name: string }[]),
      this.json<{ id: number; title: string }[]>(s, 'GET', `/api/v4/projects/${pid}/milestones?state=active&per_page=100`).catch(() => [] as { id: number; title: string }[]),
    ]);
    return [
      { key: 'labels', name: 'Labels', required: false, type: 'array', itemsType: 'string', allowedValues: labels.map((l) => ({ id: l.name, name: l.name })) },
      { key: 'milestone_id', name: 'Milestone', required: false, type: 'option', allowedValues: milestones.map((m) => ({ id: String(m.id), name: m.title })) },
      { key: 'confidential', name: 'Confidential', required: false, type: 'option', allowedValues: [{ id: 'false', name: 'No' }, { id: 'true', name: 'Yes' }] },
      { key: 'weight', name: 'Weight', required: false, type: 'number' },
    ];
  }

  renderDescription(draft: BugDraft): string {
    return renderMarkdown(draft);
  }

  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const payload = this.buildPayload(draft, mapping, fields) as Record<string, unknown>;
    return validateRequired(draft, payload, fields, [], 255);
  }

  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const out: Record<string, unknown> = { title: draft.summary.slice(0, 255), description: this.renderDescription(draft), issue_type: mapping.issueTypeId || 'issue' };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const labels = new Set<string>();
    for (const [key, raw] of Object.entries(mapping.fields)) {
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => out.description);
      if (v === undefined) continue;
      if (key === 'labels') for (const l of (Array.isArray(v) ? v : [v]) as unknown[]) labels.add(nameOf(l));
      else if (key === 'milestone_id') out.milestone_id = Number(idOf(v)) || undefined;
      else if (key === 'confidential') out.confidential = idOf(v) === 'true' || nameOf(v).toLowerCase() === 'yes';
      else out[key] = Array.isArray(v) ? v.map(nameOf).join(',') : nameOf(v);
    }
    if (!mapping.fields.labels) for (const l of draft.labels) labels.add(l);
    if (labels.size) out.labels = Array.from(labels).join(',');
    return out;
  }

  async createIssue(s: AuthSession, payload: unknown, mapping: TrackerMapping): Promise<CreateResult> {
    const res = await this.json<{ id: number; iid: number; web_url: string }>(s, 'POST', `/api/v4/projects/${encodeURIComponent(mapping.projectKey)}/issues`, payload);
    return { id: String(res.id), key: `#${res.iid}`, url: res.web_url };
  }

  async attach(s: AuthSession, created: CreateResult, files: { artifact: Artifact; blob: Blob }[], mapping: TrackerMapping): Promise<AttachmentResult[]> {
    const pid = encodeURIComponent(mapping.projectKey);
    const results: AttachmentResult[] = [];
    const lines: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f.blob, f.artifact.fileName);
      try {
        const res = await fetch(`${s.baseUrl}/api/v4/projects/${pid}/uploads`, { method: 'POST', headers: s.headers, body: form });
        if (!res.ok) {
          results.push({ artifactId: f.artifact.id, ok: false, error: `${res.status} ${await safeText(res)}` });
          continue;
        }
        const body = (await res.json()) as { markdown: string; url: string };
        lines.push(`- ${body.markdown} (${f.artifact.kind})`);
        results.push({ artifactId: f.artifact.id, ok: true, id: body.url });
      } catch (e) {
        results.push({ artifactId: f.artifact.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (lines.length) {
      const iid = created.key.replace('#', '');
      const res = await fetch(`${s.baseUrl}/api/v4/projects/${pid}/issues/${iid}/notes`, { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `**TestLens evidence**\n\n${lines.join('\n')}` }) });
      if (!res.ok) for (const r of results) if (r.ok) r.error = `uploaded, but adding the evidence note failed: ${res.status}`;
    }
    return results;
  }

  async findSimilar(s: AuthSession, projectKey: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    try {
      const res = await this.json<{ iid: number; title: string; web_url: string; state: string }[]>(s, 'GET', `/api/v4/projects/${encodeURIComponent(projectKey)}/issues?state=opened&search=${encodeURIComponent(needle)}&in=title,description&per_page=5`);
      return res.map((i) => ({ key: `#${i.iid}`, summary: i.title, url: i.web_url, status: i.state }));
    } catch {
      return [];
    }
  }

  async limits(): Promise<TrackerLimits> {
    return { maxAttachmentBytes: 10 * 1024 * 1024, maxDescriptionChars: 1_000_000 };
  }

  private async json<T>(s: { baseUrl: string; headers: Record<string, string> }, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${s.baseUrl}${path}`, { method, headers: { ...s.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const txt = await safeText(res);
      let msg = txt.slice(0, 300);
      try {
        const j = JSON.parse(txt) as { message?: unknown; error?: string };
        msg = typeof j.message === 'string' ? j.message : j.message ? JSON.stringify(j.message) : (j.error ?? msg);
      } catch {
        /* text */
      }
      if (res.status === 401) throw new TrackerError('GitLab 401: invalid token', 401);
      throw new TrackerError(`GitLab ${res.status}: ${msg || 'request failed'}`, res.status);
    }
    return (await res.json()) as T;
  }
}

function nameOf(v: unknown): string {
  return v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : String(v);
}
function idOf(v: unknown): string {
  return v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : String(v);
}
