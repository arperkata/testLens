/**
 * Hub client and file import. The Hub (apps/hub) ingests Postman/Newman/HAR evidence and stores
 * normalised incidents; the extension pulls them here so review, AI and tracker creation reuse
 * the browser pipeline. File import runs the connectors directly inside the extension.
 */
import type { BugContext } from '@testlens/schema';
import { isNewmanRun, isPostmanPayload, normalizeNewmanRun, normalizePostmanPayload } from '@testlens/connectors-postman';
import { isHar, normalizeHar } from '@testlens/connectors-har';
import { listIncidents as listLocal, type StoredIncident } from './buffer/db';
import { createIncidentFromContext } from './incident';
import { loadSettings } from './settings';

interface HubListItem {
  incidentId: string;
  createdAt: number;
  source: string;
  title: string;
}
interface HubIncident extends HubListItem {
  context: BugContext;
  files: Record<string, string>;
}

export interface HubStatus {
  enabled: boolean;
  url: string;
  reachable: boolean;
  error?: string;
  pending: number;
  lastSync?: number;
  imported?: number;
}

async function hubFetch<T>(url: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, init);
  if (!res.ok) throw new Error(`Hub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function ensureHubPermission(url: string) {
  const origin = `${new URL(url).origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [origin] }))) throw new Error(`TestLens needs permission to call ${new URL(url).origin}. Grant it in Settings → Hub.`);
}

export async function status(): Promise<HubStatus> {
  const { hub } = await loadSettings();
  const st = ((await chrome.storage.session.get('tl.hub.status'))['tl.hub.status'] ?? {}) as Partial<HubStatus>;
  if (!hub.enabled) return { enabled: false, url: hub.url, reachable: false, pending: 0 };
  try {
    await ensureHubPermission(hub.url);
    const list = await hubFetch<HubListItem[]>(hub.url, '/incidents');
    const known = new Set((await listLocal()).map((i) => i.hubIncidentId).filter(Boolean));
    return { enabled: true, url: hub.url, reachable: true, pending: list.filter((i) => !known.has(i.incidentId)).length, lastSync: st.lastSync, imported: st.imported };
  } catch (e) {
    return { enabled: true, url: hub.url, reachable: false, error: e instanceof Error ? e.message : String(e), pending: 0, lastSync: st.lastSync };
  }
}

/** Import every Hub incident not yet present locally. Returns the newly created local incidents. */
export async function sync(): Promise<StoredIncident[]> {
  const { hub } = await loadSettings();
  if (!hub.enabled) return [];
  await ensureHubPermission(hub.url);
  const list = await hubFetch<HubListItem[]>(hub.url, '/incidents');
  const known = new Set((await listLocal()).map((i) => i.hubIncidentId).filter(Boolean));
  const created: StoredIncident[] = [];
  for (const item of list.filter((i) => !known.has(i.incidentId)).sort((a, b) => a.createdAt - b.createdAt)) {
    const full = await hubFetch<HubIncident>(hub.url, `/incidents/${encodeURIComponent(item.incidentId)}`);
    // the raw tool payload is worth keeping as an (unselected) attachment for developers
    const extra: NonNullable<Parameters<typeof createIncidentFromContext>[1]>['extraArtifacts'] = [];
    const rawId = Object.keys(full.files).find((k) => k.endsWith(':raw-connector-payload'));
    if (rawId) {
      try {
        const res = await fetch(`${hub.url.replace(/\/+$/, '')}/incidents/${encodeURIComponent(item.incidentId)}/artifacts/${encodeURIComponent(rawId)}`);
        if (res.ok) extra.push({ kind: 'raw-connector-payload', fileName: full.files[rawId]!, mime: 'application/json', blob: await res.blob(), include: false });
      } catch {
        /* optional */
      }
    }
    // strip hub-side derived state; the local pipeline recomputes evidence and draft
    const ctx: BugContext = { ...full.context, evidence: undefined, analysis: undefined, artifacts: [] };
    created.push(await createIncidentFromContext(ctx, { origin: 'hub', hubIncidentId: item.incidentId, extraArtifacts: extra }));
  }
  const prev = ((await chrome.storage.session.get('tl.hub.status'))['tl.hub.status'] ?? {}) as Partial<HubStatus>;
  await chrome.storage.session.set({ 'tl.hub.status': { lastSync: Date.now(), imported: (prev.imported ?? 0) + created.length } });
  if (created.length) void chrome.action.setBadgeText({ text: String(created.length) }).then(() => chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' }));
  return created;
}

/** The Postman snippet with the Hub's URL baked in (served by the Hub so it always matches its port). */
export async function snippet(): Promise<string> {
  const { hub } = await loadSettings();
  await ensureHubPermission(hub.url);
  const res = await fetch(`${hub.url.replace(/\/+$/, '')}/snippet`);
  if (!res.ok) throw new Error(`Hub ${res.status}`);
  return res.text();
}

export async function testConnection(url: string) {
  await ensureHubPermission(url);
  return hubFetch<{ ok: boolean; version: string; dataDir: string }>(url, '/health');
}

/** Import a HAR / Newman run JSON / Postman payload chosen by the tester. */
export async function importFile(name: string, text: string): Promise<StoredIncident> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON. Supported: HAR 1.2 (.har), Newman run JSON, TestLens Postman payload.');
  }
  let ctx: BugContext;
  if (isPostmanPayload(payload)) ctx = normalizePostmanPayload(payload);
  else if (isNewmanRun(payload)) ctx = normalizeNewmanRun(payload);
  else if (isHar(payload)) ctx = normalizeHar(payload, { fileName: name });
  else throw new Error('Unrecognised file: expected a HAR 1.2 export, a Newman run JSON (-r json) or a TestLens Postman payload.');
  const blob = new Blob([text], { type: 'application/json' });
  return createIncidentFromContext(ctx, { origin: 'import', extraArtifacts: [{ kind: 'raw-connector-payload', fileName: name, mime: 'application/json', blob, include: false }] });
}
