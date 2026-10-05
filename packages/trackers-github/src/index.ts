/**
 * @testlens/trackers-github — GitHub Issues adapter (github.com and GitHub Enterprise Server).
 * Markdown body, labels/milestone/assignees. GitHub has no attachment API, so the evidence
 * package is linked from the description and the HTML viewer remains the developer's view.
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

export const GITHUB_DESCRIPTOR: TrackerDescriptor = {
  id: 'github',
  displayName: 'GitHub Issues',
  blurb: 'Issues in a GitHub repository. Uses a fine-grained token with Issues: Read and write. Attachments are not supported by the GitHub API; the HTML viewer and HAR stay in TestLens for download.',
  authFields: [
    { key: 'baseUrl', label: 'API URL', placeholder: 'https://api.github.com', type: 'url', help: 'GitHub Enterprise Server: https://ghe.example.com/api/v3' },
    { key: 'secret', label: 'Personal access token', type: 'password', help: 'Settings → Developer settings → Fine-grained tokens (Issues: Read and write on the repositories you file to)' },
  ],
  tokenHelpUrl: 'https://github.com/settings/tokens?type=beta',
  containerLabel: 'Repository',
  typeLabel: 'Type',
  attachments: 'none',
  authMethod: 'pat',
};

export class GitHubAdapter implements ITrackerAdapter<string> {
  readonly id = 'github';
  readonly displayName = 'GitHub Issues';
  readonly descriptor = GITHUB_DESCRIPTOR;

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = (cfg.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.secret}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const me = await this.json<{ login: string; name?: string }>({ baseUrl, headers }, 'GET', '/user');
    return { baseUrl, headers, accountId: me.login, displayName: me.name ?? me.login };
  }

  async listProjects(s: AuthSession): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    for (let page = 1; page <= 5; page++) {
      const repos = await this.json<{ full_name: string; id: number; name: string; has_issues: boolean; archived: boolean }[]>(s, 'GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      out.push(...repos.filter((r) => r.has_issues && !r.archived).map((r) => ({ id: String(r.id), key: r.full_name, name: r.full_name })));
      if (repos.length < 100) break;
    }
    return out;
  }

  async listIssueTypes(): Promise<IssueTypeRef[]> {
    return [{ id: 'issue', name: 'Issue', subtask: false }];
  }

  async getCreateFields(s: AuthSession, repo: string): Promise<FieldSchema[]> {
    const [labels, milestones] = await Promise.all([
      this.json<{ name: string }[]>(s, 'GET', `/repos/${repo}/labels?per_page=100`).catch(() => [] as { name: string }[]),
      this.json<{ number: number; title: string }[]>(s, 'GET', `/repos/${repo}/milestones?state=open&per_page=100`).catch(() => [] as { number: number; title: string }[]),
    ]);
    return [
      { key: 'labels', name: 'Labels', required: false, type: 'array', itemsType: 'string', allowedValues: labels.map((l) => ({ id: l.name, name: l.name })) },
      { key: 'milestone', name: 'Milestone', required: false, type: 'option', allowedValues: milestones.map((m) => ({ id: String(m.number), name: m.title })) },
      { key: 'assignees', name: 'Assignees (logins)', required: false, type: 'array', itemsType: 'string' },
    ];
  }

  renderDescription(draft: BugDraft): string {
    return renderMarkdown(draft, { footer: '_Created with TestLens. Evidence files (HAR, console log, replay, HTML viewer) are available from the tester’s TestLens incident; GitHub’s API does not accept attachments._' });
  }

  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const payload = this.buildPayload(draft, mapping, fields) as Record<string, unknown>;
    const v = validateRequired(draft, payload, fields, [], 256);
    return v;
  }

  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const out: Record<string, unknown> = { title: draft.summary.slice(0, 256), body: this.renderDescription(draft) };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const labels = new Set<string>();
    for (const [key, raw] of Object.entries(mapping.fields)) {
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => out.body);
      if (v === undefined) continue;
      if (key === 'labels') for (const l of (Array.isArray(v) ? v : [v]) as unknown[]) labels.add(nameOf(l));
      else if (key === 'milestone') out.milestone = Number(idOf(v)) || undefined;
      else if (key === 'assignees') out.assignees = (Array.isArray(v) ? v : [v]).map(nameOf);
      else out[key] = Array.isArray(v) ? v.map(nameOf) : nameOf(v);
    }
    if (!mapping.fields.labels) for (const l of draft.labels) labels.add(l);
    if (labels.size) out.labels = Array.from(labels);
    return out;
  }

  async createIssue(s: AuthSession, payload: unknown, mapping: TrackerMapping): Promise<CreateResult> {
    const res = await this.json<{ number: number; id: number; html_url: string }>(s, 'POST', `/repos/${mapping.projectKey}/issues`, payload);
    return { id: String(res.id), key: `#${res.number}`, url: res.html_url };
  }

  async attach(_s: AuthSession, _created: CreateResult, files: { artifact: Artifact; blob: Blob }[]): Promise<AttachmentResult[]> {
    return files.map((f) => ({ artifactId: f.artifact.id, ok: false, error: 'GitHub API does not support issue attachments; download the file from TestLens and drag it into the issue if needed' }));
  }

  async findSimilar(s: AuthSession, repo: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    try {
      const q = `repo:${repo} is:issue is:open "${needle.replace(/"/g, '')}"`;
      const res = await this.json<{ items: { number: number; title: string; html_url: string; state: string }[] }>(s, 'GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=5`);
      return res.items.map((i) => ({ key: `#${i.number}`, summary: i.title, url: i.html_url, status: i.state }));
    } catch {
      return [];
    }
  }

  async limits(): Promise<TrackerLimits> {
    return { maxAttachmentBytes: 0, maxDescriptionChars: 65_000 };
  }

  private async json<T>(s: { baseUrl: string; headers: Record<string, string> }, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${s.baseUrl}${path}`, { method, headers: { ...s.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const txt = await safeText(res);
      let msg = txt.slice(0, 300);
      try {
        msg = (JSON.parse(txt) as { message?: string }).message ?? msg;
      } catch {
        /* text */
      }
      if (res.status === 401) throw new TrackerError('GitHub 401: bad credentials — check the token', 401);
      if (res.status === 403 || res.status === 404) throw new TrackerError(`GitHub ${res.status}: ${msg || 'no access to this repository (fine-grained tokens must include it)'}`, res.status);
      throw new TrackerError(`GitHub ${res.status}: ${msg}`, res.status);
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
