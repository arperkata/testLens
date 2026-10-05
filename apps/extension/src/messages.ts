/** Message protocol between worlds. */
import type { ConsoleEntry, ErrorEntry, InteractionEntry, NavigationEntry } from '@testlens/schema';

/** Name of the DOM CustomEvent used by the MAIN-world script to reach the isolated content script. */
export const PAGE_EVENT = '__testlens_capture__';

/** HTTP exchange observed in the page world (fetch / XHR), carrying bodies. */
export interface PageExchange {
  id: string;
  ts: number;
  endTs: number;
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  requestHeaders: { name: string; value: string }[];
  requestBody?: { data: string; truncated: boolean; originalBytes: number; mimeType?: string; omitted?: 'binary' | 'too-large' | 'stream' };
  status?: number;
  statusText?: string;
  responseHeaders?: { name: string; value: string }[];
  responseBody?: { data: string; truncated: boolean; originalBytes: number; mimeType?: string; omitted?: 'binary' | 'too-large' | 'opaque' | 'stream' | 'unreadable' };
  error?: string;
  stack?: string;
}

export interface PageInfo {
  viewport: { width: number; height: number; dpr: number };
  locale: string;
  timezone: string;
  online: boolean;
  appVersion?: string;
  title: string;
  url: string;
}

export type PageToContentMessage =
  | { type: 'console'; entry: ConsoleEntry }
  | { type: 'error'; entry: ErrorEntry }
  | { type: 'navigation'; entry: NavigationEntry }
  | { type: 'page-exchange'; exchange: PageExchange };

export type CaptureMessage =
  | PageToContentMessage
  | { type: 'interaction'; entry: InteractionEntry }
  | { type: 'rrweb'; events: unknown[]; ts: number }
  | { type: 'page-info'; info: PageInfo };

export type ContentConfig = {
  captureBodies: boolean;
  maxBodyBytes: number;
  domReplay: boolean;
  maskAllInputs: boolean;
  consoleLevels: ('log' | 'info' | 'warn' | 'error' | 'debug')[];
};

/** Runtime messages (popup / sidepanel / options ↔ background). */
export type RuntimeRequest =
  | { type: 'tl:get-config' }
  | { type: 'tl:report-issue'; tabId: number; note?: string }
  | { type: 'tl:get-tab-status'; tabId: number }
  | { type: 'tl:list-incidents' }
  | { type: 'tl:get-incident'; incidentId: string }
  | { type: 'tl:delete-incident'; incidentId: string }
  | { type: 'tl:update-incident'; incidentId: string; patch: IncidentPatch }
  | { type: 'tl:rerun-engine'; incidentId: string; focal?: { kind: 'exchange' | 'error' | 'assertion' | 'console'; refId: string } }
  | { type: 'tl:get-blob'; blobId: string }
  | { type: 'tl:apply-monitoring' }
  | { type: 'tl:enable-panel'; tabId: number }
  | { type: 'tl:tracker-list' }
  | { type: 'tl:tracker-test'; tracker: import('./settings').TrackerSettings }
  | { type: 'tl:tracker-projects' }
  | { type: 'tl:tracker-issue-types'; projectKey: string }
  | { type: 'tl:tracker-fields'; projectKey: string; issueTypeId: string }
  | { type: 'tl:tracker-preview'; incidentId: string }
  | { type: 'tl:tracker-create'; incidentId: string }
  | { type: 'tl:set-tracker-target'; incidentId: string; target: import('./buffer/db').TrackerTarget | undefined; saveAsDefault?: boolean }
  | { type: 'tl:tracker-similar'; incidentId: string }
  | { type: 'tl:start-tab-recording'; tabId: number }
  | { type: 'tl:stop-tab-recording'; tabId: number };

export interface IncidentPatch {
  draft?: Partial<import('@testlens/schema').BugDraft>;
  artifactIncludes?: Record<string, boolean>;
  itemIncludes?: Record<string, boolean>; // key `${kind}:${refId}`
  note?: string;
}

export interface TabStatus {
  tabId: number;
  monitored: boolean;
  url?: string;
  counts: { exchanges: number; console: number; errors: number; interactions: number; navigation: number; rrwebChunks: number };
  oldestTs?: number;
  recording: boolean;
  recordingSupported: boolean;
}

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function sendRuntime<T = unknown>(req: RuntimeRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as RuntimeResponse<T> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
