/**
 * @testlens/trackers-linear — Linear adapter (GraphQL API, personal API key).
 * Markdown description, priority/labels/state, native file attachments.
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

export const LINEAR_DESCRIPTOR: TrackerDescriptor = {
  id: 'linear',
  displayName: 'Linear',
  blurb: 'Issues in a Linear team. Uses a personal API key.',
  authFields: [
    { key: 'baseUrl', label: 'API URL', placeholder: 'https://api.linear.app/graphql', type: 'url' },
    { key: 'secret', label: 'Personal API key', type: 'password', help: 'Settings → Security & access → Personal API keys' },
  ],
  tokenHelpUrl: 'https://linear.app/settings/account/security',
  tokenSteps: ['Settings → Security & access → Personal API keys', '"Create key", label it TestLens', 'Copy the key; paste it below'],
  containerLabel: 'Team',
  typeLabel: 'Type',
  attachments: 'native',
  authMethod: 'pat',
};

const PRIORITIES = [
  { id: '0', name: 'No priority' },
  { id: '1', name: 'Urgent' },
  { id: '2', name: 'High' },
  { id: '3', name: 'Medium' },
  { id: '4', name: 'Low' },
];

export class LinearAdapter implements ITrackerAdapter<string> {
  readonly id = 'linear';
  readonly displayName = 'Linear';
  readonly descriptor = LINEAR_DESCRIPTOR;

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = (cfg.baseUrl || 'https://api.linear.app/graphql').replace(/\/+$/, '');
    const headers: Record<string, string> = { Authorization: cfg.secret, 'Content-Type': 'application/json' };
    const me = await this.gql<{ viewer: { id: string; name: string } }>({ baseUrl, headers }, 'query { viewer { id name } }');
    return { baseUrl, headers, accountId: me.viewer.id, displayName: me.viewer.name };
  }

  async listProjects(s: AuthSession): Promise<ProjectRef[]> {
    const res = await this.gql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(s, 'query { teams(first: 100) { nodes { id key name } } }');
    return res.teams.nodes.map((t) => ({ id: t.id, key: t.id, name: `${t.key} — ${t.name}` })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listIssueTypes(): Promise<IssueTypeRef[]> {
    return [{ id: 'issue', name: 'Issue', subtask: false }];
  }

  async getCreateFields(s: AuthSession, teamId: string): Promise<FieldSchema[]> {
    const res = await this.gql<{ team: { labels: { nodes: { id: string; name: string }[] }; states: { nodes: { id: string; name: string; type: string }[] }; projects: { nodes: { id: string; name: string }[] } } }>(
      s,
      'query($id: String!) { team(id: $id) { labels(first: 100) { nodes { id name } } states(first: 50) { nodes { id name type } } projects(first: 100) { nodes { id name } } } }',
      { id: teamId },
    );
    return [
      { key: 'priority', name: 'Priority', required: false, type: 'option', allowedValues: PRIORITIES },
      { key: 'labelIds', name: 'Labels', required: false, type: 'array', itemsType: 'option', allowedValues: res.team.labels.nodes.map((l) => ({ id: l.id, name: l.name })) },
      { key: 'stateId', name: 'Status', required: false, type: 'option', allowedValues: res.team.states.nodes.filter((st) => st.type !== 'completed' && st.type !== 'canceled').map((st) => ({ id: st.id, name: st.name })) },
      { key: 'projectId', name: 'Project', required: false, type: 'option', allowedValues: res.team.projects.nodes.map((p) => ({ id: p.id, name: p.name })) },
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
    const out: Record<string, unknown> = { teamId: mapping.projectKey, title: draft.summary.slice(0, 255), description: this.renderDescription(draft) };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const [key, raw] of Object.entries(mapping.fields)) {
      if (key === 'labels') continue; // Linear labels are ids; TestLens text labels go into the description footer below
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => out.description);
      if (v === undefined) continue;
      if (key === 'priority') out.priority = Number(idOf(v));
      else if (key === 'labelIds') out.labelIds = (Array.isArray(v) ? v : [v]).map(idOf).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      else if (key === 'stateId' || key === 'projectId') out[key] = idOf(v);
      else out[key] = Array.isArray(v) ? v.map(idOf) : idOf(v);
    }
    if (draft.labels.length) out.description = `${out.description}\n\n_TestLens labels: ${draft.labels.join(', ')}_`;
    return out;
  }

  async createIssue(s: AuthSession, payload: unknown): Promise<CreateResult> {
    const res = await this.gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(s, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input: payload });
    if (!res.issueCreate.success) throw new TrackerError('Linear did not create the issue');
    return { id: res.issueCreate.issue.id, key: res.issueCreate.issue.identifier, url: res.issueCreate.issue.url };
  }

  async attach(s: AuthSession, created: CreateResult, files: { artifact: Artifact; blob: Blob }[]): Promise<AttachmentResult[]> {
    const results: AttachmentResult[] = [];
    for (const f of files) {
      try {
        const up = await this.gql<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } } }>(
          s,
          'mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }',
          { contentType: f.blob.type || 'application/octet-stream', filename: f.artifact.fileName, size: f.blob.size },
        );
        const u = up.fileUpload.uploadFile;
        const hdrs: Record<string, string> = { 'Content-Type': f.blob.type || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' };
        for (const h of u.headers) hdrs[h.key] = h.value;
        const put = await fetch(u.uploadUrl, { method: 'PUT', headers: hdrs, body: f.blob });
        if (!put.ok) {
          results.push({ artifactId: f.artifact.id, ok: false, error: `upload ${put.status} ${await safeText(put)}` });
          continue;
        }
        await this.gql(s, 'mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }', { input: { issueId: created.id, url: u.assetUrl, title: f.artifact.fileName, subtitle: `TestLens ${f.artifact.kind}` } });
        results.push({ artifactId: f.artifact.id, ok: true, id: u.assetUrl });
      } catch (e) {
        results.push({ artifactId: f.artifact.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  async findSimilar(s: AuthSession, teamId: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    try {
      const res = await this.gql<{ issues: { nodes: { identifier: string; title: string; url: string; state: { name: string } }[] } }>(
        s,
        'query($teamId: ID!, $needle: String!) { issues(first: 5, filter: { team: { id: { eq: $teamId } }, title: { containsIgnoreCase: $needle }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title url state { name } } } }',
        { teamId, needle },
      );
      return res.issues.nodes.map((i) => ({ key: i.identifier, summary: i.title, url: i.url, status: i.state.name }));
    } catch {
      return [];
    }
  }

  async limits(): Promise<TrackerLimits> {
    return { maxAttachmentBytes: 50 * 1024 * 1024, maxDescriptionChars: 100_000 };
  }

  private async gql<T>(s: { baseUrl: string; headers: Record<string, string> }, query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(s.baseUrl, { method: 'POST', headers: s.headers, body: JSON.stringify({ query, variables }) });
    if (!res.ok) {
      if (res.status === 401) throw new TrackerError('Linear 401: invalid API key', 401);
      throw new TrackerError(`Linear ${res.status}: ${(await safeText(res)).slice(0, 300)}`, res.status);
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new TrackerError(`Linear: ${body.errors.map((e) => e.message).join('; ')}`, 400, body.errors);
    return body.data as T;
  }
}

function idOf(v: unknown): string {
  return v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : String(v);
}
