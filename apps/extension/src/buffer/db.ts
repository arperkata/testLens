/**
 * IndexedDB-backed rolling buffer. The MV3 service worker can be killed at any
 * moment, so every captured event is written through here; memory is a cache only.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BugContext, BugDraft, ConsoleEntry, ErrorEntry, HttpExchange, InteractionEntry, NavigationEntry } from '@testlens/schema';

export type EventKind = 'exchange' | 'console' | 'error' | 'interaction' | 'navigation';

export interface StoredEvent {
  key: string; // `${tabId}:${kind}:${id}`
  tabId: number;
  ts: number;
  kind: EventKind;
  data: HttpExchange | ConsoleEntry | ErrorEntry | InteractionEntry | NavigationEntry;
}

export interface RrwebChunk {
  key: string; // `${tabId}:${ts}`
  tabId: number;
  ts: number;
  events: unknown[];
}

export type IncidentStatus = 'collecting' | 'ready' | 'created' | 'error';

export interface TrackerTarget {
  trackerId: string;
  projectKey: string;
  projectName?: string;
  issueTypeId: string;
  issueTypeName?: string;
  /** Mapping fields for this incident (same shape as settings.tracker.mapping.fields). */
  fields: Record<string, unknown>;
}
/** @deprecated use TrackerTarget */
export type JiraTarget = TrackerTarget;

export interface CreatedIssue {
  trackerId: string;
  key: string;
  url: string;
  attachments: { fileName: string; ok: boolean; error?: string }[];
}

export interface StoredIncident {
  incidentId: string;
  tabId: number;
  createdAt: number;
  triggerAt: number;
  postUntil: number;
  status: IncidentStatus;
  error?: string;
  warnings?: string[];
  note?: string;
  tab: { url: string; title: string; windowId: number };
  context?: BugContext;
  draft?: BugDraft;
  /** Result of a successful create (any tracker). */
  created?: CreatedIssue;
  /** @deprecated legacy field from Jira-only builds; read as fallback for `created`. */
  jira?: { key: string; url: string; attachments: { fileName: string; ok: boolean; error?: string }[] };
  /** Per-incident destination chosen in the side panel; falls back to settings when absent. */
  jiraTarget?: TrackerTarget;
  /** Where the incident came from: browser capture (default), the local Hub, or a file import. */
  origin?: 'browser' | 'hub' | 'import';
  /** Id of the incident on the Hub, used to avoid importing it twice. */
  hubIncidentId?: string;
  similar?: { key: string; summary: string; url: string; status: string }[];
}

export interface StoredBlob {
  id: string;
  incidentId: string;
  blob: Blob;
}

/** One sealed video segment of the rolling tab recording. */
export interface VideoSegment {
  key: string; // `${tabId}:${start}`
  tabId: number;
  start: number;
  end: number;
  mime: string;
  blob: Blob;
}

interface TLSchema extends DBSchema {
  events: { key: string; value: StoredEvent; indexes: { 'by-tab-ts': [number, number]; 'by-ts': number } };
  rrweb: { key: string; value: RrwebChunk; indexes: { 'by-tab-ts': [number, number]; 'by-ts': number } };
  incidents: { key: string; value: StoredIncident; indexes: { 'by-created': number } };
  blobs: { key: string; value: StoredBlob; indexes: { 'by-incident': string } };
  video: { key: string; value: VideoSegment; indexes: { 'by-tab-start': [number, number]; 'by-end': number } };
}

let dbPromise: Promise<IDBPDatabase<TLSchema>> | undefined;

export function db(): Promise<IDBPDatabase<TLSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<TLSchema>('testlens', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const ev = d.createObjectStore('events', { keyPath: 'key' });
          ev.createIndex('by-tab-ts', ['tabId', 'ts']);
          ev.createIndex('by-ts', 'ts');
          const rr = d.createObjectStore('rrweb', { keyPath: 'key' });
          rr.createIndex('by-tab-ts', ['tabId', 'ts']);
          rr.createIndex('by-ts', 'ts');
          const inc = d.createObjectStore('incidents', { keyPath: 'incidentId' });
          inc.createIndex('by-created', 'createdAt');
          const bl = d.createObjectStore('blobs', { keyPath: 'id' });
          bl.createIndex('by-incident', 'incidentId');
        }
        if (oldVersion < 2) {
          const v = d.createObjectStore('video', { keyPath: 'key' });
          v.createIndex('by-tab-start', ['tabId', 'start']);
          v.createIndex('by-end', 'end');
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Video segments (written by the offscreen recorder, read at incident time)
// ---------------------------------------------------------------------------

export async function putVideoSegment(seg: VideoSegment) {
  const d = await db();
  await d.put('video', seg);
}

/** Segments overlapping [start, end], oldest first. */
export async function readVideoSegments(tabId: number, start: number, end: number): Promise<VideoSegment[]> {
  const d = await db();
  const rows = await d.getAllFromIndex('video', 'by-tab-start', IDBKeyRange.bound([tabId, 0], [tabId, end]));
  return rows.filter((r) => r.end >= start).sort((a, b) => a.start - b.start);
}

export async function expireVideo(olderThanEnd: number) {
  const d = await db();
  const tx = d.transaction('video', 'readwrite');
  let cursor = await tx.store.index('by-end').openCursor(IDBKeyRange.upperBound(olderThanEnd));
  while (cursor) {
    void cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearTabVideo(tabId: number) {
  const d = await db();
  const tx = d.transaction('video', 'readwrite');
  let cursor = await tx.store.index('by-tab-start').openCursor(IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]));
  while (cursor) {
    void cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ---------------------------------------------------------------------------
// Batched write-through
// ---------------------------------------------------------------------------

const pending: StoredEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function putEvent(tabId: number, kind: EventKind, data: StoredEvent['data']) {
  pending.push({ key: `${tabId}:${kind}:${data.id}`, tabId, ts: data.ts, kind, data });
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), 200);
  if (pending.length > 200) void flush();
}

export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!pending.length) return;
  const batch = pending.splice(0, pending.length);
  const d = await db();
  const tx = d.transaction('events', 'readwrite');
  for (const e of batch) void tx.store.put(e);
  await tx.done;
}

/** Update an exchange already written (used to merge page-world bodies into a webRequest record). */
export async function updateExchange(tabId: number, id: string, patch: (e: HttpExchange) => HttpExchange): Promise<boolean> {
  await flush();
  const d = await db();
  const key = `${tabId}:exchange:${id}`;
  const existing = await d.get('events', key);
  if (!existing) return false;
  await d.put('events', { ...existing, data: patch(existing.data as HttpExchange) });
  return true;
}

export async function findRecentExchanges(tabId: number, sinceTs: number): Promise<HttpExchange[]> {
  await flush();
  const d = await db();
  const rows = await d.getAllFromIndex('events', 'by-tab-ts', IDBKeyRange.bound([tabId, sinceTs], [tabId, Number.MAX_SAFE_INTEGER]));
  return rows.filter((r) => r.kind === 'exchange').map((r) => r.data as HttpExchange);
}

export async function putRrweb(tabId: number, ts: number, events: unknown[]) {
  const d = await db();
  await d.put('rrweb', { key: `${tabId}:${ts}:${Math.random().toString(36).slice(2, 6)}`, tabId, ts, events });
}

export async function readWindow(tabId: number, start: number, end: number) {
  await flush();
  const d = await db();
  const rows = await d.getAllFromIndex('events', 'by-tab-ts', IDBKeyRange.bound([tabId, start], [tabId, end]));
  const out = { exchanges: [] as HttpExchange[], console: [] as ConsoleEntry[], errors: [] as ErrorEntry[], interactions: [] as InteractionEntry[], navigation: [] as NavigationEntry[] };
  for (const r of rows) {
    switch (r.kind) {
      case 'exchange':
        out.exchanges.push(r.data as HttpExchange);
        break;
      case 'console':
        out.console.push(r.data as ConsoleEntry);
        break;
      case 'error':
        out.errors.push(r.data as ErrorEntry);
        break;
      case 'interaction':
        out.interactions.push(r.data as InteractionEntry);
        break;
      case 'navigation':
        out.navigation.push(r.data as NavigationEntry);
        break;
    }
  }
  return out;
}

/** rrweb events for [start,end], starting from the last full snapshot at or before `start`. */
export async function readRrweb(tabId: number, start: number, end: number): Promise<unknown[]> {
  const d = await db();
  const rows = await d.getAllFromIndex('rrweb', 'by-tab-ts', IDBKeyRange.bound([tabId, start - 120_000], [tabId, end]));
  const events = rows.flatMap((r) => r.events) as { type: number; timestamp: number }[];
  events.sort((a, b) => a.timestamp - b.timestamp);
  // find last Meta(4) followed by FullSnapshot(2) at or before start
  let cut = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 4 && e.timestamp <= start + 1000) cut = i;
  }
  if (cut < 0) {
    // no snapshot before window — fall back to the first Meta in range
    cut = events.findIndex((e) => e.type === 4);
    if (cut < 0) return [];
  }
  return events.slice(cut).filter((e) => e.timestamp <= end);
}

export async function tabCounts(tabId: number) {
  await flush();
  const d = await db();
  const rows = await d.getAllFromIndex('events', 'by-tab-ts', IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]));
  const rr = await d.countFromIndex('rrweb', 'by-tab-ts', IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]));
  const counts = { exchanges: 0, console: 0, errors: 0, interactions: 0, navigation: 0, rrwebChunks: rr };
  let oldest: number | undefined;
  for (const r of rows) {
    if (oldest === undefined || r.ts < oldest) oldest = r.ts;
    if (r.kind === 'exchange') counts.exchanges++;
    else if (r.kind === 'console') counts.console++;
    else if (r.kind === 'error') counts.errors++;
    else if (r.kind === 'interaction') counts.interactions++;
    else counts.navigation++;
  }
  return { counts, oldest };
}

/** Delete everything older than `olderThan` (ms epoch) across tabs; plus optional per-tab count cap. */
export async function expire(olderThan: number, maxPerTab = 6000) {
  await flush();
  const d = await db();
  {
    const tx = d.transaction('events', 'readwrite');
    let cursor = await tx.store.index('by-ts').openCursor(IDBKeyRange.upperBound(olderThan));
    while (cursor) {
      void cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  {
    const tx = d.transaction('rrweb', 'readwrite');
    let cursor = await tx.store.index('by-ts').openCursor(IDBKeyRange.upperBound(olderThan - 120_000));
    while (cursor) {
      void cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  // count cap (oldest first) — cheap approximation of a byte cap
  const all = await d.getAllKeysFromIndex('events', 'by-tab-ts');
  const perTab = new Map<number, string[]>();
  for (const k of all) {
    const tabId = Number(String(k).split(':')[0]);
    const arr = perTab.get(tabId) ?? [];
    arr.push(String(k));
    perTab.set(tabId, arr);
  }
  const tx = d.transaction('events', 'readwrite');
  for (const [, keys] of perTab) {
    if (keys.length <= maxPerTab) continue;
    for (const k of keys.slice(0, keys.length - maxPerTab)) void tx.store.delete(k);
  }
  await tx.done;
}

export async function clearTab(tabId: number) {
  await flush();
  await clearTabVideo(tabId);
  const d = await db();
  for (const store of ['events', 'rrweb'] as const) {
    const tx = d.transaction(store, 'readwrite');
    let cursor = await tx.store.index('by-tab-ts').openCursor(IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]));
    while (cursor) {
      void cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}

// ---------------------------------------------------------------------------
// Incidents & blobs
// ---------------------------------------------------------------------------

export async function putIncident(i: StoredIncident) {
  const d = await db();
  await d.put('incidents', i);
}
export async function getIncident(id: string) {
  const d = await db();
  return d.get('incidents', id);
}
export async function listIncidents(): Promise<StoredIncident[]> {
  const d = await db();
  const all = await d.getAllFromIndex('incidents', 'by-created');
  return all.reverse().map((i) => ({ ...i, context: undefined })); // list view omits heavy context
}
export async function deleteIncident(id: string) {
  const d = await db();
  const keys = await d.getAllKeysFromIndex('blobs', 'by-incident', id);
  const tx = d.transaction(['incidents', 'blobs'], 'readwrite');
  void tx.objectStore('incidents').delete(id);
  for (const k of keys) void tx.objectStore('blobs').delete(k);
  await tx.done;
}
export async function putBlob(id: string, incidentId: string, blob: Blob) {
  const d = await db();
  await d.put('blobs', { id, incidentId, blob });
}
export async function getBlob(id: string): Promise<Blob | undefined> {
  const d = await db();
  return (await d.get('blobs', id))?.blob;
}
export async function purgeIncidents(olderThan: number) {
  const d = await db();
  const old = await d.getAllFromIndex('incidents', 'by-created', IDBKeyRange.upperBound(olderThan));
  for (const i of old) await deleteIncident(i.incidentId);
}
