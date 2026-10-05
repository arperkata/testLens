/** Tracker service used by the background script: adapter registry, sessions, preview, create. */
import type { AuthSession, FieldSchema, ITrackerAdapter, IssueTypeRef, ProjectRef, SimilarIssue, TrackerDescriptor, TrackerMapping } from '@testlens/trackers-core';
import { JiraCloudAdapter } from '@testlens/trackers-jira-cloud';
import { JiraDataCenterAdapter } from '@testlens/trackers-jira-dc';
import { AzureDevOpsAdapter } from '@testlens/trackers-azure-devops';
import { GitHubAdapter } from '@testlens/trackers-github';
import { GitLabAdapter } from '@testlens/trackers-gitlab';
import { LinearAdapter } from '@testlens/trackers-linear';
import { getIncident, putIncident, type StoredIncident, type TrackerTarget } from './buffer/db';
import { artifactBlobs } from './incident';
import { loadSettings, saveSettings, type Settings, type TrackerSettings } from './settings';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ADAPTERS: ITrackerAdapter[] = [new JiraCloudAdapter(), new JiraDataCenterAdapter(), new AzureDevOpsAdapter(), new GitHubAdapter(), new GitLabAdapter(), new LinearAdapter()];
const byId = new Map(ADAPTERS.map((a) => [a.id, a]));

export function listTrackers(): TrackerDescriptor[] {
  return ADAPTERS.map((a) => a.descriptor);
}

export function getAdapter(id: string): ITrackerAdapter {
  const a = byId.get(id);
  if (!a) throw new Error(`Unknown tracker "${id}"`);
  return a;
}

export function defaultMapping(trackerId: string, projectKey: string, issueTypeId: string): TrackerMapping {
  return { trackerId, projectKey, issueTypeId, fields: { labels: ['$labels'] }, attachKinds: ['screenshot', 'console-log', 'har-focused', 'rrweb', 'incident-viewer'], maxDescriptionChars: 30_000 };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

let sessionCache: { key: string; session: AuthSession } | undefined;

function requireTracker(s: Settings): TrackerSettings {
  const t = s.tracker;
  if (!t?.trackerId || !t.token) throw new Error('No bug tracker is connected. Open TestLens settings and connect one.');
  return t;
}

export async function ensureHostPermission(baseUrl: string) {
  const origin = `${new URL(baseUrl).origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) throw new Error(`TestLens needs permission to call ${new URL(baseUrl).origin}. Grant it in TestLens settings (Bug tracker section).`);
}

export async function session(settings?: Settings): Promise<{ adapter: ITrackerAdapter; session: AuthSession; tracker: TrackerSettings }> {
  const s = settings ?? (await loadSettings());
  const t = requireTracker(s);
  const adapter = getAdapter(t.trackerId);
  const baseUrl = t.baseUrl || defaultBaseUrl(adapter);
  await ensureHostPermission(baseUrl);
  const key = `${t.trackerId}|${baseUrl}|${t.email}|${t.token.slice(-6)}`;
  if (sessionCache?.key !== key) {
    const sess = await adapter.authenticate({ baseUrl, method: adapter.descriptor.authMethod, email: t.email || undefined, secret: t.token });
    sessionCache = { key, session: sess };
  }
  return { adapter, session: sessionCache.session, tracker: t };
}

function defaultBaseUrl(adapter: ITrackerAdapter): string {
  return adapter.descriptor.authFields.find((f) => f.key === 'baseUrl')?.placeholder ?? '';
}

export async function testConnection(t: TrackerSettings) {
  const adapter = getAdapter(t.trackerId);
  const baseUrl = t.baseUrl || defaultBaseUrl(adapter);
  await ensureHostPermission(baseUrl);
  const sess = await adapter.authenticate({ baseUrl, method: adapter.descriptor.authMethod, email: t.email || undefined, secret: t.token });
  sessionCache = undefined;
  fieldsCache.clear();
  return { displayName: sess.displayName, accountId: sess.accountId, baseUrl };
}

export async function projects(): Promise<ProjectRef[]> {
  const { adapter, session: s } = await session();
  return adapter.listProjects(s);
}

export async function issueTypes(projectKey: string): Promise<IssueTypeRef[]> {
  const { adapter, session: s } = await session();
  return adapter.listIssueTypes(s, projectKey);
}

const fieldsCache = new Map<string, FieldSchema[]>();
export async function createFields(projectKey: string, issueTypeId: string): Promise<FieldSchema[]> {
  const { adapter, session: s } = await session();
  const k = `${adapter.id}/${projectKey}/${issueTypeId}`;
  const cached = fieldsCache.get(k);
  if (cached) return cached;
  const f = await adapter.getCreateFields(s, projectKey, issueTypeId);
  fieldsCache.set(k, f);
  return f;
}

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/** Destination for an incident: its own target if the tester changed it, otherwise the settings default. */
export function resolveTarget(inc: StoredIncident, settings: Settings): TrackerTarget {
  const t = settings.tracker;
  if (inc.jiraTarget?.projectKey && inc.jiraTarget.issueTypeId && (!t || inc.jiraTarget.trackerId === t.trackerId)) return inc.jiraTarget;
  if (!t?.projectKey || !t.issueTypeId) throw new Error(`Select a ${t ? getAdapter(t.trackerId).descriptor.containerLabel.toLowerCase() : 'project'} and type (side panel → Tracker tab, or TestLens settings).`);
  return { trackerId: t.trackerId, projectKey: t.projectKey, projectName: t.projectName, issueTypeId: t.issueTypeId, issueTypeName: t.issueTypeName, fields: t.mapping?.fields ?? defaultMapping(t.trackerId, t.projectKey, t.issueTypeId).fields };
}

function mappingFor(t: TrackerTarget): TrackerMapping {
  return { ...defaultMapping(t.trackerId, t.projectKey, t.issueTypeId), fields: t.fields };
}

export async function setTarget(incidentId: string, target: TrackerTarget | undefined, saveAsDefault = false): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc) throw new Error('Incident not found');
  const updated: StoredIncident = { ...inc, jiraTarget: target };
  await putIncident(updated);
  if (saveAsDefault && target) {
    const s = await loadSettings();
    if (s.tracker) {
      s.tracker = { ...s.tracker, projectKey: target.projectKey, projectName: target.projectName, issueTypeId: target.issueTypeId, issueTypeName: target.issueTypeName, mapping: mappingFor(target) };
      await saveSettings(s);
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Preview / create / similar
// ---------------------------------------------------------------------------

export interface TrackerPreview {
  trackerId: string;
  descriptor: TrackerDescriptor;
  payload: unknown;
  validation: { ok: boolean; problems: { field: string; message: string }[] };
  fields: FieldSchema[];
  attachments: { id: string; fileName: string; bytes: number; include: boolean; tooLarge: boolean }[];
  limits: { maxAttachmentBytes: number };
  projectKey: string;
  projectName?: string;
  issueTypeId: string;
  issueTypeName?: string;
  target: TrackerTarget;
  isDefault: boolean;
  /** Plain-text rendering of the description for the preview pane. */
  descriptionText: string;
}

export async function preview(incidentId: string): Promise<TrackerPreview> {
  const inc = await getIncident(incidentId);
  if (!inc?.draft || !inc.context) throw new Error('Incident is not ready');
  const settings = await loadSettings();
  const t = resolveTarget(inc, settings);
  const { adapter, session: s } = await session(settings);
  const fields = await createFields(t.projectKey, t.issueTypeId);
  const mapping = mappingFor(t);
  const payload = adapter.buildPayload(inc.draft, mapping, fields);
  const validation = adapter.validate(inc.draft, mapping, fields);
  const limits = await adapter.limits(s);
  const attachments = inc.context.artifacts.map((a) => ({ id: a.id, fileName: a.fileName, bytes: a.bytes, include: a.include, tooLarge: adapter.descriptor.attachments === 'none' || a.bytes > limits.maxAttachmentBytes }));
  return {
    trackerId: adapter.id,
    descriptor: adapter.descriptor,
    payload,
    validation,
    fields,
    attachments,
    limits: { maxAttachmentBytes: limits.maxAttachmentBytes },
    projectKey: t.projectKey,
    projectName: t.projectName,
    issueTypeId: t.issueTypeId,
    issueTypeName: t.issueTypeName,
    target: t,
    isDefault: !inc.jiraTarget,
    descriptionText: descriptionToText(adapter.renderDescription(inc.draft)),
  };
}

export async function create(incidentId: string): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.draft || !inc.context) throw new Error('Incident is not ready');
  if (inc.created?.key || inc.jira?.key) throw new Error(`Already created as ${inc.created?.key ?? inc.jira?.key}`);
  const settings = await loadSettings();
  const t = resolveTarget(inc, settings);
  const { adapter, session: s } = await session(settings);
  const fields = await createFields(t.projectKey, t.issueTypeId);
  const mapping = mappingFor(t);
  const validation = adapter.validate(inc.draft, mapping, fields);
  if (!validation.ok) throw new Error(`Cannot create: ${validation.problems.map((p) => p.message).join('; ')}`);
  const payload = adapter.buildPayload(inc.draft, mapping, fields);
  const created = await adapter.createIssue(s, payload, mapping);
  const limits = await adapter.limits(s);
  const all = await artifactBlobs(inc, true);
  const attachments: { fileName: string; ok: boolean; error?: string }[] = [];
  if (adapter.descriptor.attachments === 'native') {
    const files = all.filter((f) => f.blob.size <= limits.maxAttachmentBytes);
    const results = await adapter.attach(s, created, files, mapping);
    for (const r of results) attachments.push({ fileName: files.find((f) => f.artifact.id === r.artifactId)?.artifact.fileName ?? r.artifactId, ok: r.ok, error: r.error });
    for (const skipped of all.filter((f) => f.blob.size > limits.maxAttachmentBytes)) attachments.push({ fileName: skipped.artifact.fileName, ok: false, error: `exceeds attachment limit (${Math.round(limits.maxAttachmentBytes / 1024 / 1024)} MB)` });
  } else {
    for (const f of all) attachments.push({ fileName: f.artifact.fileName, ok: false, error: `${adapter.displayName} does not accept attachments via API; download from TestLens` });
  }
  const updated: StoredIncident = { ...inc, status: 'created', created: { trackerId: adapter.id, key: created.key, url: created.url, attachments } };
  await putIncident(updated);
  return updated;
}

export async function similar(incidentId: string): Promise<SimilarIssue[]> {
  const inc = await getIncident(incidentId);
  if (!inc?.draft?.focalSignature) return [];
  const settings = await loadSettings();
  let projectKey: string;
  try {
    projectKey = resolveTarget(inc, settings).projectKey;
  } catch {
    return [];
  }
  const { adapter, session: s } = await session(settings);
  const res = (await adapter.findSimilar?.(s, projectKey, inc.draft.focalSignature)) ?? [];
  await putIncident({ ...inc, similar: res });
  return res;
}

// ---------------------------------------------------------------------------

/** ADF, HTML, Markdown or wiki → readable text for the preview pane. */
export function descriptionToText(doc: unknown): string {
  if (typeof doc === 'string') {
    if (/<\/?[a-z][\s\S]*>/i.test(doc)) {
      return doc
        .replace(/<\/(h\d|p|li|pre|div)>/gi, '\n')
        .replace(/<li>/gi, ' • ')
        .replace(/<h\d>/gi, '\n## ')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return doc;
  }
  const out: string[] = [];
  const walk = (n: { type: string; text?: string; content?: unknown[] }) => {
    if (n.type === 'text') out.push(n.text ?? '');
    if (n.type === 'heading') out.push('\n## ');
    if (n.type === 'listItem') out.push('\n • ');
    if (n.type === 'codeBlock') out.push('\n```\n');
    for (const k of (n.content ?? []) as typeof n[]) walk(k);
    if (n.type === 'codeBlock') out.push('\n```');
    if (n.type === 'paragraph' || n.type === 'heading') out.push('\n');
  };
  if (doc && typeof doc === 'object') walk(doc as Parameters<typeof walk>[0]);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
