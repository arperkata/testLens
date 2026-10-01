/** Jira service used by the background script. */
import { JiraCloudAdapter } from '@testlens/trackers-jira-cloud';
import type { AuthSession, FieldSchema, TrackerMapping } from '@testlens/trackers-core';
import { getIncident, putIncident, type StoredIncident } from './buffer/db';
import { artifactBlobs } from './incident';
import { loadSettings, type JiraSettings, type Settings } from './settings';

export const jira = new JiraCloudAdapter();

let sessionCache: { key: string; session: AuthSession } | undefined;

export function defaultMapping(projectKey: string, issueTypeId: string): TrackerMapping {
  return {
    trackerId: 'jira-cloud',
    projectKey,
    issueTypeId,
    fields: { labels: ['$labels'] },
    attachKinds: ['screenshot', 'console-log', 'har-focused', 'rrweb', 'incident-viewer'],
    maxDescriptionChars: 30_000,
  };
}

export async function jiraSession(settings?: Settings): Promise<AuthSession> {
  const s = settings ?? (await loadSettings());
  const j = s.jira;
  if (!j?.baseUrl || !j.email || !j.token) throw new Error('Jira is not configured. Open TestLens settings and connect Jira.');
  await ensureHostPermission(j.baseUrl);
  const key = `${j.baseUrl}|${j.email}|${j.token.slice(-6)}`;
  if (sessionCache?.key === key) return sessionCache.session;
  const session = await jira.authenticate({ baseUrl: j.baseUrl, method: 'basic', email: j.email, secret: j.token });
  sessionCache = { key, session };
  return session;
}

export async function ensureHostPermission(baseUrl: string) {
  const origin = `${new URL(baseUrl).origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) throw new Error(`TestLens needs permission to call ${new URL(baseUrl).origin}. Grant it in TestLens settings (Jira section).`);
}

export async function testConnection(j: JiraSettings) {
  await ensureHostPermission(j.baseUrl);
  const session = await jira.authenticate({ baseUrl: j.baseUrl, method: 'basic', email: j.email, secret: j.token });
  sessionCache = undefined;
  return { displayName: session.displayName, accountId: session.accountId };
}

const fieldsCache = new Map<string, FieldSchema[]>();
export async function createFields(projectKey: string, issueTypeId: string): Promise<FieldSchema[]> {
  const k = `${projectKey}/${issueTypeId}`;
  const cached = fieldsCache.get(k);
  if (cached) return cached;
  const s = await jiraSession();
  const f = await jira.getCreateFields(s, projectKey, issueTypeId);
  fieldsCache.set(k, f);
  return f;
}

export interface JiraPreview {
  payload: unknown;
  validation: { ok: boolean; problems: { field: string; message: string }[] };
  fields: FieldSchema[];
  attachments: { id: string; fileName: string; bytes: number; include: boolean; tooLarge: boolean }[];
  limits: { maxAttachmentBytes: number };
  projectKey: string;
  issueTypeName?: string;
}

export async function preview(incidentId: string): Promise<JiraPreview> {
  const inc = await getIncident(incidentId);
  if (!inc?.draft || !inc.context) throw new Error('Incident is not ready');
  const settings = await loadSettings();
  const j = settings.jira;
  if (!j?.projectKey || !j.issueTypeId) throw new Error('Select a Jira project and issue type in TestLens settings.');
  const fields = await createFields(j.projectKey, j.issueTypeId);
  const mapping = j.mapping ?? defaultMapping(j.projectKey, j.issueTypeId);
  const payload = jira.buildPayload(inc.draft, mapping, fields);
  const validation = jira.validate(inc.draft, mapping, fields);
  const limits = await jira.limits(await jiraSession(settings));
  const attachments = inc.context.artifacts.map((a) => ({ id: a.id, fileName: a.fileName, bytes: a.bytes, include: a.include, tooLarge: a.bytes > limits.maxAttachmentBytes }));
  return { payload, validation, fields, attachments, limits: { maxAttachmentBytes: limits.maxAttachmentBytes }, projectKey: j.projectKey, issueTypeName: j.issueTypeName };
}

export async function create(incidentId: string): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.draft || !inc.context) throw new Error('Incident is not ready');
  if (inc.jira?.key) throw new Error(`Already created as ${inc.jira.key}`);
  const settings = await loadSettings();
  const j = settings.jira!;
  const session = await jiraSession(settings);
  const fields = await createFields(j.projectKey, j.issueTypeId);
  const mapping = j.mapping ?? defaultMapping(j.projectKey, j.issueTypeId);
  const validation = jira.validate(inc.draft, mapping, fields);
  if (!validation.ok) throw new Error(`Cannot create: ${validation.problems.map((p) => p.message).join('; ')}`);
  const payload = jira.buildPayload(inc.draft, mapping, fields);
  const created = await jira.createIssue(session, payload);
  const limits = await jira.limits(session);
  const files = (await artifactBlobs(inc, true)).filter((f) => f.blob.size <= limits.maxAttachmentBytes);
  const results = await jira.attach(session, created.key, files);
  const attachments = results.map((r) => ({ fileName: files.find((f) => f.artifact.id === r.artifactId)?.artifact.fileName ?? r.artifactId, ok: r.ok, error: r.error }));
  for (const skipped of (await artifactBlobs(inc, true)).filter((f) => f.blob.size > limits.maxAttachmentBytes)) {
    attachments.push({ fileName: skipped.artifact.fileName, ok: false, error: `exceeds Jira attachment limit (${Math.round(limits.maxAttachmentBytes / 1024 / 1024)} MB)` });
  }
  const updated: StoredIncident = { ...inc, status: 'created', jira: { key: created.key, url: created.url, attachments } };
  await putIncident(updated);
  return updated;
}

export async function similar(incidentId: string) {
  const inc = await getIncident(incidentId);
  if (!inc?.draft?.focalSignature) return [];
  const settings = await loadSettings();
  if (!settings.jira?.projectKey) return [];
  const s = await jiraSession(settings);
  const res = (await jira.findSimilar?.(s, settings.jira.projectKey, inc.draft.focalSignature)) ?? [];
  await putIncident({ ...inc, similar: res });
  return res;
}
