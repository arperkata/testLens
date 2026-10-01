/**
 * @testlens/trackers-jira-cloud — Jira Cloud (REST v3, ADF) adapter.
 *
 * Runs inside the extension (host permission for the Jira origin bypasses CORS)
 * or inside a Hub. Uses only `fetch`.
 */
import type { Artifact, BugDraft, BugDraftSection } from '@testlens/schema';
import { TrackerError, renderTemplate } from '@testlens/trackers-core';
import type {
  AttachmentResult,
  AuthSession,
  CreateResult,
  FieldSchema,
  ITrackerAdapter,
  IssueTypeRef,
  ProjectRef,
  TrackerAuthConfig,
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

/** Turns bare URLs in a line into link marks. */
function paragraphWithLinks(line: string): AdfNode {
  const parts = line.split(/(https?:\/\/[^\s)]+)/g).filter(Boolean);
  return paragraph(...parts.map((p) => (/^https?:\/\//.test(p) ? text(p, [{ type: 'link', attrs: { href: p } }]) : text(p))));
}

function sectionToAdf(s: BugDraftSection): AdfNode[] {
  const nodes: AdfNode[] = [heading(3, s.title)];
  if (s.code) {
    nodes.push(codeBlock(s.body, s.id === 'curl' ? 'bash' : 'text'));
  } else {
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

export class JiraCloudAdapter implements ITrackerAdapter<AdfDoc> {
  readonly id = 'jira-cloud';
  readonly displayName = 'Jira Cloud';

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.method === 'basic') {
      if (!cfg.email) throw new TrackerError('Email is required for Jira Cloud API token authentication');
      headers.Authorization = `Basic ${btoa(`${cfg.email}:${cfg.secret}`)}`;
    } else if (cfg.method === 'pat' || cfg.method === 'oauth') {
      headers.Authorization = `Bearer ${cfg.secret}`;
    }
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

  renderDescription(draft: BugDraft): AdfDoc {
    return renderAdf(draft);
  }

  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const problems: { field: string; message: string }[] = [];
    if (!draft.summary.trim()) problems.push({ field: 'summary', message: 'Summary is empty' });
    if (draft.summary.length > 255) problems.push({ field: 'summary', message: 'Summary exceeds 255 characters' });
    const payload = this.buildPayload(draft, mapping, fields) as { fields: Record<string, unknown> };
    for (const f of fields) {
      if (!f.required || f.hasDefault) continue;
      if (['project', 'issuetype', 'reporter'].includes(f.key)) continue;
      const v = payload.fields[f.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) problems.push({ field: f.key, message: `Required field "${f.name}" has no value — set it in the Jira mapping` });
    }
    return { ok: problems.length === 0, problems };
  }

  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const scope = { draft };
    const out: Record<string, unknown> = {
      project: { key: mapping.projectKey },
      issuetype: { id: mapping.issueTypeId },
      summary: draft.summary,
      description: this.renderDescription(draft),
    };
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const [key, raw] of Object.entries(mapping.fields)) {
      const schema = byKey.get(key);
      const v = resolveMappedValue(raw, draft, scope, schema);
      if (v !== undefined) out[key] = v;
    }
    // labels: Jira forbids spaces
    if (Array.isArray(out.labels)) out.labels = (out.labels as string[]).map((l) => l.replace(/\s+/g, '-'));
    return { fields: out };
  }

  async createIssue(s: AuthSession, payload: unknown): Promise<CreateResult> {
    const res = await this.json<{ id: string; key: string; self: string }>(s, 'POST', '/rest/api/3/issue', payload);
    return { id: res.id, key: res.key, url: `${s.baseUrl}/browse/${res.key}` };
  }

  async attach(s: AuthSession, issueKey: string, files: { artifact: Artifact; blob: Blob }[]): Promise<AttachmentResult[]> {
    const results: AttachmentResult[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f.blob, f.artifact.fileName);
      try {
        const res = await fetch(`${s.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
          method: 'POST',
          headers: { ...s.headers, 'X-Atlassian-Token': 'no-check' },
          body: form,
        });
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

  async findSimilar(s: AuthSession, projectKey: string, signature: string) {
    // Use the most specific token (path) for text search; status codes are too generic.
    const tokens = signature.split(/\s+/).filter((t) => t.length > 3 && !/^\d+$/.test(t));
    if (!tokens.length) return [];
    const needle = tokens.find((t) => t.startsWith('/')) ?? tokens[0]!;
    const jql = `project = "${projectKey}" AND statusCategory != Done AND (summary ~ "${escapeJql(needle)}" OR labels = testlens AND text ~ "${escapeJql(needle)}") ORDER BY created DESC`;
    try {
      const res = await this.json<{ issues: { key: string; fields: { summary: string; status: { name: string } } }[] }>(s, 'POST', '/rest/api/3/search/jql', { jql, maxResults: 5, fields: ['summary', 'status'] });
      return res.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, url: `${s.baseUrl}/browse/${i.key}` }));
    } catch {
      // fall back to legacy search endpoint
      try {
        const res = await this.json<{ issues: { key: string; fields: { summary: string; status: { name: string } } }[] }>(s, 'GET', `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,status`);
        return res.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name, url: `${s.baseUrl}/browse/${i.key}` }));
      } catch {
        return [];
      }
    }
  }

  async limits(s?: AuthSession): Promise<TrackerLimits> {
    let maxAttachmentBytes = 10 * 1024 * 1024;
    if (s) {
      try {
        const cfg = await this.json<{ attachmentsEnabled: boolean; uploadLimit?: number }>(s, 'GET', '/rest/api/3/attachment/meta');
        if (cfg.uploadLimit) maxAttachmentBytes = cfg.uploadLimit;
      } catch {
        /* keep default */
      }
    }
    return { maxAttachmentBytes, maxDescriptionChars: 32_000 };
  }

  private async json<T>(s: { baseUrl: string; headers: Record<string, string> }, method: string, path: string, body?: unknown): Promise<T> {
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

function resolveMappedValue(raw: unknown, draft: BugDraft, scope: Record<string, unknown>, schema?: FieldSchema): unknown {
  if (raw === '$summary') return draft.summary;
  if (raw === '$description') return renderAdf(draft);
  if (raw === '$labels') return draft.labels;
  if (typeof raw === 'string') {
    const v = renderTemplate(raw, scope);
    if (!v) return undefined;
    if (schema?.type === 'array' && schema.itemsType === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
    if (schema?.type === 'option' || schema?.type === 'priority' || schema?.type === 'component') return matchAllowed(v, schema);
    if (schema?.type === 'array' && (schema.itemsType === 'component' || schema.itemsType === 'option' || schema.itemsType === 'version')) return v.split(',').map((x) => matchAllowed(x.trim(), schema)).filter(Boolean);
    if (schema?.type === 'number') return Number(v);
    if (schema?.type === 'doc') return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: v }] }] };
    return v;
  }
  if (Array.isArray(raw)) {
    const items = raw.map((r) => resolveMappedValue(r, draft, scope, schema ? { ...schema, type: schema.itemsType ?? 'string' } : undefined)).filter((x) => x !== undefined);
    if (raw.includes('$labels')) return Array.from(new Set([...draft.labels, ...(items.flat() as string[])]));
    return items.flat();
  }
  return raw; // already a Jira-shaped object, e.g. { id: "3" }
}

function matchAllowed(v: string, schema: FieldSchema) {
  const hit = schema.allowedValues?.find((a) => a.id === v || a.name.toLowerCase() === v.toLowerCase());
  return hit ? { id: hit.id } : { name: v };
}

function escapeJql(s: string) {
  return s.replace(/(["\\])/g, '\\$1');
}

async function safeText(res: Response) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function describeJiraError(status: number, details: unknown): string {
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
