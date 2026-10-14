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
  | { type: 'tl:start-tab-recording'; tabId: number; streamId: string }
  | { type: 'tl:stop-tab-recording'; tabId: number }
  | { type: 'tl:recording-status' }
  /** test hook: record a synthetic canvas stream for a tab (no tabCapture permission needed) */
  | { type: 'tl:start-synthetic-recording'; tabId: number; options?: Partial<RecordingOptions> }
  | { type: 'tl:ai-enhance'; incidentId: string }
  | { type: 'tl:ai-apply'; incidentId: string; fields: ('summary' | 'stepsToReproduce' | 'expectedResult' | 'actualResult')[] }
  | { type: 'tl:ai-projection'; incidentId: string }
  | { type: 'tl:ai-store'; incidentId: string; analysis: import('@testlens/schema').Analysis }
  /** Replace the incident screenshot with an annotated PNG (data URL); the original is kept unselected. */
  | { type: 'tl:update-screenshot'; incidentId: string; dataUrl: string }
  | { type: 'tl:open-recorder'; tabId: number }
  | { type: 'tl:recorder-started'; tabId: number; mode: 'window'; mic: boolean }
  /** Report started from the in-page alert toast (no activeTab grant → screenshot may be skipped). */
  | { type: 'tl:report-from-page'; note?: string }
  | { type: 'tl:alert-state'; tabId: number }
  | { type: 'tl:alert-mute'; tabId: number }
  | { type: 'tl:hub-status' }
  | { type: 'tl:hub-sync' }
  | { type: 'tl:hub-test'; url: string }
  | { type: 'tl:hub-snippet' }
  | { type: 'tl:import-file'; name: string; text: string }
  | { type: 'tl:ai-test'; ai: import('./settings').AiSettings };

/** Messages addressed to the offscreen recorder document (ignored by the background). */
export type OffscreenRequest =
  | { target: 'offscreen'; type: 'start'; tabId: number; streamId: string; options: RecordingOptions }
  | { target: 'offscreen'; type: 'start-synthetic'; tabId: number; options: RecordingOptions }
  | { target: 'offscreen'; type: 'stop'; tabId: number }
  | { target: 'offscreen'; type: 'flush'; tabId: number }
  | { target: 'offscreen'; type: 'status' }
  /** Stitch the segments of a tab overlapping [start,end] into one WebM stored under `blobId` (keeps the muxer out of the service worker). */
  | { target: 'offscreen'; type: 'stitch'; tabId: number; start: number; end: number; incidentId: string; blobId: string };

export interface RecordingOptions {
  segmentMs: number;
  overlapMs: number;
  retainMs: number;
  videoBitsPerSecond: number;
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  segmentMs: 60_000,
  overlapMs: 4_000,
  retainMs: 7 * 60_000,
  videoBitsPerSecond: 600_000,
  maxWidth: 1280,
  maxHeight: 720,
  frameRate: 10,
};

/** Offscreen/recorder → background notifications. */
export type OffscreenEvent = { target: 'background'; type: 'recording-ended'; tabId: number; reason: string };

/** Background → recorder window control. */
export type RecorderRequest = { target: 'recorder'; type: 'flush' | 'stop' | 'status'; tabId: number };

/** Background → content script: a failure was observed in this tab. */
export interface AlertMessage {
  type: 'tl:alert';
  count: number;
  summary: string; // e.g. "POST /api/receipt → 500"
  kind: 'request' | 'js-error';
  shortcut: string; // e.g. "Alt+Shift+R"
}

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
  recordingSince?: number;
  recordingMode?: 'tab' | 'window';
  recordingMic?: boolean;
  recordingSupported: boolean;
  alerts: { count: number; muted: boolean; last?: string; shortcut: string };
}

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function sendRuntime<T = unknown>(req: RuntimeRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as RuntimeResponse<T> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
