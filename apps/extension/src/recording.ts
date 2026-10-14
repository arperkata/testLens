/** Background-side control of the offscreen tab recorder. */
import { DEFAULT_RECORDING_OPTIONS, type OffscreenRequest, type RecordingOptions } from './messages';

const OFFSCREEN_URL = 'offscreen.html';
const STATE_KEY = 'tl.recording';

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: 'Rolling tab video recording for TestLens incidents' });
  } catch (e) {
    // "Only a single offscreen document may be created" → already there
    if (!String(e).includes('single offscreen')) throw e;
  }
}

async function send<T = unknown>(req: OffscreenRequest): Promise<T> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!res) throw new Error('Recorder did not respond');
  if (!res.ok) throw new Error(res.error ?? 'Recorder error');
  return res.data as T;
}

export interface RecordingState {
  since: number;
  /** 'tab' = offscreen tabCapture (silent); 'window' = recorder window (getDisplayMedia, optional mic) */
  mode: 'tab' | 'window';
  mic?: boolean;
}

async function readState(): Promise<Record<number, RecordingState>> {
  return ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? {}) as Record<number, RecordingState>;
}
async function writeState(s: Record<number, RecordingState>) {
  await chrome.storage.session.set({ [STATE_KEY]: s });
}

export async function startRecording(tabId: number, streamId: string) {
  await send({ target: 'offscreen', type: 'start', tabId, streamId, options: DEFAULT_RECORDING_OPTIONS });
  const s = await readState();
  s[tabId] = { since: Date.now(), mode: 'tab' };
  await writeState(s);
}

/** The recorder window registers itself once its stream is live. */
export async function markWindowRecording(tabId: number, mic: boolean) {
  const s = await readState();
  s[tabId] = { since: Date.now(), mode: 'window', mic };
  await writeState(s);
}

/** Open the recorder window for "Entire window + microphone" capture of a tab. */
export async function openRecorderWindow(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = chrome.runtime.getURL(`recorder.html?tabId=${tabId}&title=${encodeURIComponent(tab?.title ?? '')}`);
  const existing = (await chrome.tabs.query({ url: `${chrome.runtime.getURL('recorder.html')}*` })).find((t) => t.url?.includes(`tabId=${tabId}`));
  if (existing?.windowId !== undefined) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: 'popup', width: 460, height: 420, focused: true });
}

async function sendToRecorder(tabId: number, type: 'flush' | 'stop' | 'status'): Promise<boolean> {
  try {
    const res = (await chrome.runtime.sendMessage({ target: 'recorder', type, tabId })) as { ok: boolean; data?: boolean } | undefined;
    return Boolean(res?.ok && res.data !== false);
  } catch {
    return false;
  }
}

/** Test hook: same pipeline fed by a drawn canvas, so automation can verify segments and attachments. */
export async function startSyntheticRecording(tabId: number, options: Partial<RecordingOptions> = {}) {
  await send({ target: 'offscreen', type: 'start-synthetic', tabId, options: { ...DEFAULT_RECORDING_OPTIONS, ...options } });
  const s = await readState();
  s[tabId] = { since: Date.now(), mode: 'tab' };
  await writeState(s);
}

export async function stopRecording(tabId: number) {
  const st = (await readState())[tabId];
  if (st?.mode === 'window') await sendToRecorder(tabId, 'stop');
  else {
    try {
      await send({ target: 'offscreen', type: 'stop', tabId });
    } catch {
      /* recorder may already be gone */
    }
  }
  await markEnded(tabId);
}

export async function markEnded(tabId: number) {
  const s = await readState();
  if (tabId in s) {
    delete s[tabId];
    await writeState(s);
  }
}

/** Seal the running segment so the incident can include video up to now. */
export async function flushRecording(tabId: number) {
  if (!(await isRecording(tabId))) return;
  const st = (await readState())[tabId];
  if (st?.mode === 'window') {
    await sendToRecorder(tabId, 'flush');
    return;
  }
  try {
    await send({ target: 'offscreen', type: 'flush', tabId });
  } catch {
    /* ignore */
  }
}

export async function isRecording(tabId: number): Promise<boolean> {
  const s = await readState();
  const st = s[tabId];
  if (!st) return false;
  // confirm with the live recorder; session state can outlive it after a restart or a closed window
  if (st.mode === 'window') {
    const alive = await sendToRecorder(tabId, 'status');
    if (!alive) await markEnded(tabId);
    return alive;
  }
  try {
    const live = await send<number[]>({ target: 'offscreen', type: 'status' });
    if (!live.includes(tabId)) {
      await markEnded(tabId);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function recordingSince(tabId: number): Promise<number | undefined> {
  return (await readState())[tabId]?.since;
}

export async function recordingState(tabId: number): Promise<RecordingState | undefined> {
  return (await readState())[tabId];
}

/**
 * Stitch a tab's segments for [start,end] into one WebM blob stored under `blobId`, in the offscreen
 * document. Returns null when there are no segments. Throws when the offscreen document is unavailable.
 */
export async function stitchInOffscreen(tabId: number, start: number, end: number, incidentId: string, blobId: string): Promise<{ start: number; end: number; bytes: number; packets: number } | null> {
  return send<{ start: number; end: number; bytes: number; packets: number } | null>({ target: 'offscreen', type: 'stitch', tabId, start, end, incidentId, blobId });
}

export function recordingSupported(): boolean {
  return typeof chrome.tabCapture?.getMediaStreamId === 'function' && typeof chrome.offscreen?.createDocument === 'function';
}
