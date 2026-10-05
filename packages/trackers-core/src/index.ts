/**
 * @testlens/trackers-core — tracker-neutral adapter contract, descriptors for the UI,
 * mapping config and shared description renderers (Markdown, HTML).
 */
import type { Artifact, BugDraft } from '@testlens/schema';

// ---------------------------------------------------------------------------
// Descriptor: everything the UI needs to render a connection form for a tracker
// ---------------------------------------------------------------------------

export interface AuthFieldSpec {
  key: 'baseUrl' | 'email' | 'secret';
  label: string;
  placeholder?: string;
  help?: string;
  type?: 'text' | 'password' | 'url';
}

export interface TrackerDescriptor {
  id: string;
  displayName: string;
  /** Shown under the tracker name in settings. */
  blurb: string;
  authFields: AuthFieldSpec[];
  /** Where the user creates the token/key. */
  tokenHelpUrl?: string;
  /** What this tracker calls the container issues live in. */
  containerLabel: string; // 'Project' | 'Repository' | 'Team'
  /** What this tracker calls the kind of item. */
  typeLabel: string; // 'Issue type' | 'Work item type' | 'Type'
  /** Whether files can be attached to the created item. */
  attachments: 'native' | 'none';
  /** Default secret method used by authenticate(). */
  authMethod: 'basic' | 'pat' | 'oauth';
}

// ---------------------------------------------------------------------------
// Auth and metadata
// ---------------------------------------------------------------------------

export interface TrackerAuthConfig {
  baseUrl: string;
  /** 'basic' (email + token), 'pat' (bearer / header token), 'oauth'. */
  method: 'basic' | 'pat' | 'oauth';
  email?: string;
  secret: string;
}

export interface AuthSession {
  baseUrl: string;
  accountId?: string;
  displayName?: string;
  headers: Record<string, string>;
  /** Adapter-private data (e.g. resolved ids). */
  extra?: Record<string, unknown>;
}

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
}
export interface IssueTypeRef {
  id: string;
  name: string;
  subtask: boolean;
}
export interface FieldOption {
  id: string;
  name: string;
}
export interface FieldSchema {
  key: string;
  name: string;
  required: boolean;
  type: string; // 'string' | 'array' | 'option' | 'priority' | 'user' | 'number' | 'date' | 'doc' | 'html' ...
  itemsType?: string;
  allowedValues?: FieldOption[];
  hasDefault?: boolean;
}

/**
 * Mapping config: how a BugDraft becomes tracker fields. Values support
 * `{{...}}` templates resolved against { draft }.
 *
 * Special values: "$description", "$summary", "$labels".
 */
export interface TrackerMapping {
  trackerId: string;
  projectKey: string;
  issueTypeId: string;
  fields: Record<string, unknown>;
  attachKinds: string[];
  maxDescriptionChars?: number;
}

export interface ValidationResult {
  ok: boolean;
  problems: { field: string; message: string }[];
}

export interface CreateResult {
  key: string;
  id: string;
  url: string;
}

export interface AttachmentResult {
  artifactId: string;
  ok: boolean;
  id?: string;
  error?: string;
}

export interface TrackerLimits {
  maxAttachmentBytes: number;
  maxDescriptionChars: number;
}

export interface SimilarIssue {
  key: string;
  summary: string;
  url: string;
  status: string;
}

export interface ITrackerAdapter<TDoc = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly descriptor: TrackerDescriptor;
  authenticate(cfg: TrackerAuthConfig): Promise<AuthSession>;
  listProjects(s: AuthSession, query?: string): Promise<ProjectRef[]>;
  listIssueTypes(s: AuthSession, projectKey: string): Promise<IssueTypeRef[]>;
  getCreateFields(s: AuthSession, projectKey: string, issueTypeId: string): Promise<FieldSchema[]>;
  renderDescription(draft: BugDraft): TDoc;
  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult;
  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown;
  createIssue(s: AuthSession, payload: unknown, mapping: TrackerMapping): Promise<CreateResult>;
  attach(s: AuthSession, created: CreateResult, files: { artifact: Artifact; blob: Blob }[], mapping: TrackerMapping): Promise<AttachmentResult[]>;
  findSimilar?(s: AuthSession, projectKey: string, signature: string): Promise<SimilarIssue[]>;
  limits(s?: AuthSession): Promise<TrackerLimits>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal mustache-style template: {{draft.summary}} */
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), scope);
    return v === undefined || v === null ? '' : String(v);
  });
}

export class TrackerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

/** Generic required-field validation shared by adapters. */
export function validateRequired(draft: BugDraft, payloadFields: Record<string, unknown>, fields: FieldSchema[], skip: string[], summaryMax = 255): ValidationResult {
  const problems: { field: string; message: string }[] = [];
  if (!draft.summary.trim()) problems.push({ field: 'summary', message: 'Summary is empty' });
  if (draft.summary.length > summaryMax) problems.push({ field: 'summary', message: `Summary exceeds ${summaryMax} characters` });
  for (const f of fields) {
    if (!f.required || f.hasDefault || skip.includes(f.key)) continue;
    const v = payloadFields[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) problems.push({ field: f.key, message: `Required field "${f.name}" has no value — set it in the tracker mapping` });
  }
  return { ok: problems.length === 0, problems };
}

/** Resolve one mapped value against the draft and a field schema (shared by adapters). */
export function resolveMappedValue(raw: unknown, draft: BugDraft, schema: FieldSchema | undefined, renderDescription: () => unknown): unknown {
  if (raw === '$summary') return draft.summary;
  if (raw === '$description') return renderDescription();
  if (raw === '$labels') return draft.labels;
  if (typeof raw === 'string') {
    const v = renderTemplate(raw, { draft });
    if (!v) return undefined;
    if (schema?.type === 'array' && (schema.itemsType === 'string' || !schema.itemsType)) return v.split(',').map((x) => x.trim()).filter(Boolean);
    if (schema?.type === 'array') return v.split(',').map((x) => matchAllowed(x.trim(), schema)).filter(Boolean);
    if (schema?.allowedValues?.length) return matchAllowed(v, schema);
    if (schema?.type === 'number') return Number(v);
    return v;
  }
  if (Array.isArray(raw)) {
    const items = raw.map((r) => resolveMappedValue(r, draft, schema ? { ...schema, type: schema.itemsType ?? 'string', itemsType: undefined } : undefined, renderDescription)).filter((x) => x !== undefined);
    if (raw.includes('$labels')) return Array.from(new Set([...draft.labels, ...(items.flat() as string[])]));
    return items.flat();
  }
  return raw;
}

export function matchAllowed(v: string, schema: FieldSchema): { id: string; name: string } | { name: string } {
  const hit = schema.allowedValues?.find((a) => a.id === v || a.name.toLowerCase() === v.toLowerCase());
  return hit ? { id: hit.id, name: hit.name } : { name: v };
}

/** Jira-style label sanitising (no spaces). */
export function sanitizeLabels(labels: unknown): string[] {
  return Array.isArray(labels) ? (labels as unknown[]).map((l) => String(typeof l === 'object' && l ? (l as { name?: string }).name ?? '' : l).replace(/\s+/g, '-')).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Description renderers
// ---------------------------------------------------------------------------

/** GitHub/GitLab/Linear-flavoured Markdown. */
export function renderMarkdown(draft: BugDraft, opts: { maxChars?: number; footer?: string } = {}): string {
  const max = opts.maxChars ?? 60_000;
  const parts: string[] = [];
  parts.push('### Steps to reproduce', (draft.stepsToReproduce.length ? draft.stepsToReproduce : ['<add steps>']).map((s, i) => `${i + 1}. ${s}`).join('\n'), '');
  parts.push('### Expected result', draft.expectedResult, '');
  parts.push('### Actual result', draft.actualResult, '');
  let used = parts.join('\n').length;
  const deferred: string[] = [];
  for (const s of draft.sections) {
    const block = s.code ? `### ${s.title}\n\n\`\`\`${s.id === 'curl' ? 'bash' : ''}\n${s.body}\n\`\`\`\n` : `### ${s.title}\n\n${s.body.split('\n').map((l) => (l.startsWith('• ') ? `- ${l.slice(2)}` : l)).join('\n')}\n`;
    const wrapped = s.provenance === 'ai' ? `> **AI-generated analysis — review before relying on it.**\n\n${block}` : block;
    if (used + wrapped.length > max && s.id !== 'evidence-index' && s.id !== 'environment') {
      deferred.push(s.title);
      continue;
    }
    used += wrapped.length;
    parts.push(wrapped);
  }
  if (deferred.length) parts.push(`> Sections moved to attachments to respect the description size limit: ${deferred.join(', ')}.`, '');
  parts.push(opts.footer ?? '_Created with TestLens_');
  return parts.join('\n');
}

/** Simple HTML (Azure DevOps rich-text fields). */
export function renderHtml(draft: BugDraft, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 120_000;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const link = (s: string) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const parts: string[] = [];
  parts.push(`<h3>Steps to reproduce</h3><ol>${(draft.stepsToReproduce.length ? draft.stepsToReproduce : ['<add steps>']).map((s) => `<li>${link(s)}</li>`).join('')}</ol>`);
  parts.push(`<h3>Expected result</h3><p>${link(draft.expectedResult)}</p>`);
  parts.push(`<h3>Actual result</h3><p>${link(draft.actualResult)}</p>`);
  let used = parts.join('').length;
  const deferred: string[] = [];
  for (const s of draft.sections) {
    let block: string;
    if (s.code) block = `<h3>${esc(s.title)}</h3><pre style="white-space:pre-wrap">${esc(s.body)}</pre>`;
    else {
      const lines = s.body.split('\n').filter((l) => l.trim());
      block = lines.every((l) => l.startsWith('• ')) && lines.length ? `<h3>${esc(s.title)}</h3><ul>${lines.map((l) => `<li>${link(l.slice(2))}</li>`).join('')}</ul>` : `<h3>${esc(s.title)}</h3>${lines.map((l) => `<p>${link(l)}</p>`).join('')}`;
    }
    if (s.provenance === 'ai') block = `<div style="border-left:3px solid #e8a317;padding-left:8px"><p><b>AI-generated analysis — review before relying on it.</b></p>${block}</div>`;
    if (used + block.length > max && s.id !== 'evidence-index' && s.id !== 'environment') {
      deferred.push(s.title);
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  if (deferred.length) parts.push(`<p><i>Sections moved to attachments to respect the description size limit: ${esc(deferred.join(', '))}.</i></p>`);
  parts.push('<p><i>Created with TestLens</i></p>');
  return parts.join('');
}

/** Jira Server / Data Center wiki markup. */
export function renderWikiMarkup(draft: BugDraft, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 30_000;
  const parts: string[] = [];
  parts.push('h3. Steps to reproduce', (draft.stepsToReproduce.length ? draft.stepsToReproduce : ['<add steps>']).map((s) => `# ${s}`).join('\n'), '');
  parts.push('h3. Expected result', draft.expectedResult, '');
  parts.push('h3. Actual result', draft.actualResult, '');
  let used = parts.join('\n').length;
  const deferred: string[] = [];
  for (const s of draft.sections) {
    const body = s.code ? `{code}\n${s.body}\n{code}` : s.body.split('\n').map((l) => (l.startsWith('• ') ? `* ${l.slice(2)}` : l)).join('\n');
    let block = `h3. ${s.title}\n${body}\n`;
    if (s.provenance === 'ai') block = `{panel:title=AI-generated analysis — review before relying on it|borderColor=#e8a317}\n${block}{panel}\n`;
    if (used + block.length > max && s.id !== 'evidence-index' && s.id !== 'environment') {
      deferred.push(s.title);
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  if (deferred.length) parts.push(`{quote}Sections moved to attachments to respect the description size limit: ${deferred.join(', ')}.{quote}`, '');
  parts.push('_Created with TestLens_');
  return parts.join('\n');
}

/** Token for duplicate search: the most specific part of a focal signature. */
export function searchNeedle(signature: string): string | undefined {
  const tokens = signature.split(/\s+/).filter((t) => t.length > 3 && !/^\d+$/.test(t));
  if (!tokens.length) return undefined;
  return tokens.find((t) => t.startsWith('/')) ?? tokens[0];
}

export async function safeText(res: Response) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
