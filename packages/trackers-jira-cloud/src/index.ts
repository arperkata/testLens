/**
 * @testlens/trackers-jira-cloud — Jira Cloud (REST v3, ADF) adapter.
 */
import type { Artifact, BugDraft, BugDraftSection } from '@testlens/schema';
import { TrackerError, resolveMappedValue, safeText, sanitizeLabels, searchNeedle, validateRequired } from '@testlens/trackers-core';
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

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) builders
// ---------------------------------------------------------------------------

export type AdfNode = { type: string; attrs?: Record<string, unknown>; content?: AdfNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
export type AdfDoc = { type: 'doc'; version: 1; content: AdfNode[] };

const text = (t: string, marks?: AdfNode['marks']): AdfNode => ({ type: 'text', text: t || ' ', ...(marks ? { marks } : {}) });
const paragraph = (...nodes: AdfNode[]): AdfNode => ({ type: 'paragraph', content: nodes.length ? nodes : [text(' ')] });
const heading = (level: number, t: string): AdfNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const codeBlock = (code: string, language = 'text'): AdfNode => ({ type: 'codeBlock', attrs: { language }, content: [text(code || ' ')] });
const bulletList = (items: string[]): AdfNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [paragraphWithLinks(i)] })) });
const orderedList = (items: string[]): AdfNode => ({ type: 'orderedList', content: items.map((i) => ({ type: 'listItem', content: [paragraphWithLinks(i)] })) });
const panel = (type: 'info' | 'note' | 'warning' | 'success' | 'error', nodes: AdfNode[]): AdfNode => ({ type: 'panel', attrs: { panelType: type }, content: nodes });

function paragraphWithLinks(line: string): AdfNode {
  const parts = line.split(/(https?:\/\/[^\s)]+)/g).filter(Boolean);
  return paragraph(...parts.map((p) => (/^https?:\/\//.test(p) ? text(p, [{ type: 'link', attrs: { href: p } }]) : text(p))));
}

function sectionToAdf(s: BugDraftSection): AdfNode[] {
  const nodes: AdfNode[] = [heading(3, s.title)];
  if (s.code) nodes.push(codeBlock(s.body, s.id === 'curl' ? 'bash' : 'text'));
  else {
    const lines = s.body.split('\n').filter((l) => l.trim().length);
    const bullets = lines.filter((l) => l.startsWith('• '));
    if (bullets.length === lines.length && lines.length) nodes.push(bulletList(bullets.map((b) => b.slice(2))));
    else for (const l of lines) nodes.push(paragraphWithLinks(l));
  }
  if (s.provenance === 'ai') return [panel('note', [paragraph(text('AI-generated analysis — review before relying on it.', [{ type: 'strong' }])), ...nodes])];
  return nodes;
}

export function renderAdf(draft: BugDraft, maxChars = 30_000): AdfDoc {
  const content: AdfNode[] = [];
  content.push(heading(3, 'Steps to reproduce'));
  content.push(orderedList(draft.stepsToReproduce.length ? draft.stepsToReproduce : ['<add steps>']));
  content.push(heading(3, 'Expected result'));
  content.push(paragraphWithLinks(draft.expectedResult));
  content.push(heading(3, 'Actual result'));
  content.push(paragraphWithLinks(draft.actualResult));
  let used = JSON.stringify(content).length;
  const deferred: string[] = [];
  for (const s of draft.sections) {
    const nodes = sectionToAdf(s);
    const size = JSON.stringify(nodes).length;
    if (used + size > maxChars && s.id !== 'evidence-index' && s.id !== 'environment') {
      deferred.push(s.title);
      continue;
    }
    used += size;
    content.push(...nodes);
  }
  if (deferred.length) content.push(panel('info', [paragraph(text(`Sections moved to attachments to respect the description size limit: ${deferred.join(', ')}.`))]));
  content.push(paragraph(text('Created with TestLens', [{ type: 'em' }])));
  return { type: 'doc', version: 1, content };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const JIRA_CLOUD_DESCRIPTOR: TrackerDescriptor = {
  id: 'jira-cloud',
  displayName: 'Jira Cloud',
  blurb: 'Atlassian-hosted Jira (yourcompany.atlassian.net). Uses your own API token; issues are created as you.',
  authFields: [
    { key: 'baseUrl', label: 'Jira site URL', placeholder: 'https://yourcompany.atlassian.net', type: 'url' },
    { key: 'email', label: 'Email', placeholder: 'you@company.com' },
    { key: 'secret', label: 'API token', type: 'password', help: 'Create one at id.atlassian.com → Security → API tokens' },
  ],
  tokenHelpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  tokenSteps: ['Sign in with the Atlassian account you use for Jira', 'Click "Create API token", name it TestLens', 'Copy the token now; Atlassian shows it only once', 'Paste it below with the same email address'],
  containerLabel: 'Project',
  typeLabel: 'Issue type',
  attachments: 'native',
  authMethod: 'basic',
};

export class JiraCloudAdapter implements ITrackerAdapter {
  readonly id: string = 'jira-cloud';
  readonly displayName: string = 'Jira Cloud';
  readonly descriptor: TrackerDescriptor = JIRA_CLOUD_DESCRIPTOR;

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.method === 'basic') {
      if (!cfg.email) throw new TrackerError('Email is required for Jira Cloud API token authentication');
      headers.Authorization = `Basic ${btoa(`${cfg.email}:${cfg.secret}`)}`;
    } else headers.Authorization = `Bearer ${cfg.secret}`;
    const me = await this.json<{ accountId: string; displayName: string }>({ baseUrl, headers }, 'GET', '/rest/api/3/myself');
    return { baseUrl, headers, accountId: me.accountId, displayName: me.displayName };
  }

  async listProjects(s: AuthSession, query?: string): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.json<{ values: { id: string; key: string; name: string }[]; isLast: boolean }>(s, 'GET', `/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=name${query ? `&query=${encodeURIComponent(query)}` : ''}`);
      out.push(...page.values.map((p) => ({ id: p.id, key: p.key, name: p.name })));
      if (page.isLast || page.values.length === 0 || out.length >= 500) break;
      startAt += page.values.length;
    }
    return out;
  }

  async listIssueTypes(s: AuthSession, projectKey: string): Promise<IssueTypeRef[]> {
    const page = await this.json<{ issueTypes: { id: string; name: string; subtask: boolean }[] }>(s, 'GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=50`);
    return page.issueTypes.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
  }

  async getCreateFields(s: AuthSession, projectKey: string, issueTypeId: string): Promise<FieldSchema[]> {
    const page = await this.json<{
      fields: { fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema: { type: string; items?: string; custom?: string }; allowedValues?: { id: string; name?: string; value?: string }[] }[];
    }>(s, 'GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`);
    return page.fields.map((f) => ({
      key: f.fieldId,
      name: f.name,
      required: f.required,
      type: f.schema.type,
      itemsType: f.schema.items,
      hasDefault: f.hasDefaultValue,
      allowedValues: f.allowedValues?.map((v) => ({ id: v.id, name: v.name ?? v.value ?? v.id })),
    }));
  }

  /** ADF on Cloud; subclasses may return another document type (wiki markup on Server/DC). */
  renderDescription(draft: BugDraft): unknown {
    return renderAdf(draft);
  }

  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const payload = this.buildPayload(draft, mapping, fields) as { fields: Record<string, unknown> };
    return validateRequired(draft, payload.fields, fields, ['project', 'issuetype', 'reporter']);
  }

  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const out: Record<string, unknown> = {
      project: { key: mapping.projectKey },
      issuetype: { id: mapping.issueTypeId },
      summary: draft.summary,
      description: this.renderDescription(draft),
    };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const [key, raw] of Object.entries(mapping.fields)) {
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => this.renderDescription(draft));
      if (v !== undefined) out[key] = toJiraValue(v, byKey.get(key));
    }
    if (out.labels) out.labels = sanitizeLabels(out.labels);
    return { fields: out };
  }

  async createIssue(s: AuthSession, payload: unknown): Promise<CreateResult> {
    const res = await this.json<{ id: string; key: string }>(s, 'POST', '/rest/api/3/issue', payload);
    return { id: res.id, key: res.key, url: `${s.baseUrl}/browse/${res.key}` };
  }

  async attach(s: AuthSession, created: CreateResult, files: { artifact: Artifact; blob: Blob }[]): Promise<AttachmentResult[]> {
    const results: AttachmentResult[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f.blob, f.artifact.fileName);
      try {
        const res = await fetch(`${s.baseUrl}${this.apiBase()}/issue/${encodeURIComponent(created.key)}/attachments`, { method: 'POST', headers: { ...s.headers, 'X-Atlassian-Token': 'no-check' }, body: form });
        if (!res.ok) {
          results.push({ artifactId: f.artifact.id, ok: false, error: `${res.status} ${await safeText(res)}` });
          continue;
        }
        const body = (await res.json()) as { id: string }[];
        results.push({ artifactId: f.artifact.id, ok: true, id: body[0]?.id });
      } catch (e) {
        results.push({ artifactId: f.artifact.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  async findSimilar(s: AuthSession, projectKey: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    const jql = `project = "${projectKey}" AND statusCategory != Done AND (summary ~ "${escapeJql(needle)}" OR labels = testlens AND text ~ "${escapeJql(needle)}") ORDER BY created DESC`;
    const map = (res: { issues: { key: string; fields: { summary: string; status: { name: string } } }[] }) => res.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, url: `${s.baseUrl}/browse/${i.key}` }));
    try {
      return map(await this.json(s, 'POST', '/rest/api/3/search/jql', { jql, maxResults: 5, fields: ['summary', 'status'] }));
    } catch {
      try {
        return map(await this.json(s, 'GET', `${this.apiBase()}/search?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,status`));
      } catch {
        return [];
      }
    }
  }

  async limits(s?: AuthSession): Promise<TrackerLimits> {
    let maxAttachmentBytes = 10 * 1024 * 1024;
    if (s) {
      try {
        const cfg = await this.json<{ uploadLimit?: number }>(s, 'GET', `${this.apiBase()}/attachment/meta`);
        if (cfg.uploadLimit) maxAttachmentBytes = cfg.uploadLimit;
      } catch {
        /* keep default */
      }
    }
    return { maxAttachmentBytes, maxDescriptionChars: 32_000 };
  }

  protected apiBase() {
    return '/rest/api/3';
  }

  protected async json<T>(s: { baseUrl: string; headers: Record<string, string> }, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${s.baseUrl}${path}`, {
      method,
      headers: { ...s.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await safeText(res);
      let details: unknown = txt;
      try {
        details = JSON.parse(txt);
      } catch {
        /* text */
      }
      throw new TrackerError(describeJiraError(res.status, details), res.status, details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Jira wants { id } for options/priorities/components/versions, plain strings for text. */
export function toJiraValue(v: unknown, schema?: FieldSchema): unknown {
  const strip = (x: unknown) => (x && typeof x === 'object' && 'id' in x ? { id: (x as { id: string }).id } : x && typeof x === 'object' && 'name' in x ? { name: (x as { name: string }).name } : x);
  if (Array.isArray(v)) return v.map(strip);
  if (schema?.type === 'doc' && typeof v === 'string') return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: v }] }] };
  return strip(v);
}

export function escapeJql(s: string) {
  return s.replace(/(["\\])/g, '\\$1');
}

export function describeJiraError(status: number, details: unknown): string {
  const d = details as { errorMessages?: string[]; errors?: Record<string, string>; message?: string } | string;
  if (typeof d === 'object' && d) {
    const parts = [...(d.errorMessages ?? []), ...Object.entries(d.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
    if (parts.length) return `Jira ${status}: ${parts.join('; ')}`;
    if (d.message) return `Jira ${status}: ${d.message}`;
  }
  if (status === 401) return 'Jira 401: authentication failed — check site URL, email and API token';
  if (status === 403) return 'Jira 403: this account lacks permission for that project or action';
  if (status === 404) return 'Jira 404: resource not found — check the site URL and project key';
  return `Jira ${status}: ${typeof d === 'string' ? d.slice(0, 200) : 'request failed'}`;
}
