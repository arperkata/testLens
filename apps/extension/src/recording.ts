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

async function readState(): Promise<Record<number, { since: number }>> {
  return ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? {}) as Record<number, { since: number }>;
}
async function writeState(s: Record<number, { since: number }>) {
  await chrome.storage.session.set({ [STATE_KEY]: s });
}

export async function startRecording(tabId: number, streamId: string) {
  await send({ target: 'offscreen', type: 'start', tabId, streamId, options: DEFAULT_RECORDING_OPTIONS });
  const s = await readState();
  s[tabId] = { since: Date.now() };
  await writeState(s);
}

/** Test hook: same pipeline fed by a drawn canvas, so automation can verify segments and attachments. */
export async function startSyntheticRecording(tabId: number, options: Partial<RecordingOptions> = {}) {
  await send({ target: 'offscreen', type: 'start-synthetic', tabId, options: { ...DEFAULT_RECORDING_OPTIONS, ...options } });
  const s = await readState();
  s[tabId] = { since: Date.now() };
  await writeState(s);
}

export async function stopRecording(tabId: number) {
  try {
    await send({ target: 'offscreen', type: 'stop', tabId });
  } catch {
    /* recorder may already be gone */
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
  try {
    await send({ target: 'offscreen', type: 'flush', tabId });
  } catch {
    /* ignore */
  }
}

export async function isRecording(tabId: number): Promise<boolean> {
  const s = await readState();
  if (!(tabId in s)) return false;
  // confirm with the recorder; session state can outlive it after a browser restart
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

export function recordingSupported(): boolean {
  return typeof chrome.tabCapture?.getMediaStreamId === 'function' && typeof chrome.offscreen?.createDocument === 'function';
}
