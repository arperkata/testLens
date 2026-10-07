/**
 * Rolling segment recorder shared by the offscreen tab recorder and the window recorder page.
 * Two MediaRecorders alternate with a small overlap; each sealed segment is stored in IndexedDB.
 */
import { expireVideo, putVideoSegment } from '../buffer/db';
import type { RecordingOptions } from '../messages';

interface Segment {
  recorder: MediaRecorder;
  start: number;
  chunks: Blob[];
  done: Promise<void>;
  finish: () => void;
}

export interface SegmentRecording {
  tabId: number;
  stream: MediaStream;
  options: RecordingOptions;
  active?: Segment;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  /** 'tab' = silent tabCapture; 'window' = getDisplayMedia, possibly with microphone */
  mode: 'tab' | 'window';
}

export function pickMime(withAudio: boolean): string {
  const candidates = withAudio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function createSegmentRecording(tabId: number, stream: MediaStream, options: RecordingOptions, mode: 'tab' | 'window'): SegmentRecording {
  const rec: SegmentRecording = { tabId, stream, options, stopped: false, mode };
  beginSegment(rec);
  return rec;
}

function beginSegment(rec: SegmentRecording) {
  if (rec.stopped) return;
  const mime = pickMime(rec.stream.getAudioTracks().length > 0);
  const recorder = new MediaRecorder(rec.stream, { mimeType: mime || undefined, videoBitsPerSecond: rec.options.videoBitsPerSecond, audioBitsPerSecond: 64_000 });
  const chunks: Blob[] = [];
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const seg: Segment = { recorder, start: Date.now(), chunks, done, finish };
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const end = Date.now();
    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    if (blob.size > 0) void putVideoSegment({ key: `${rec.tabId}:${seg.start}`, tabId: rec.tabId, start: seg.start, end, mime: blob.type, blob }).then(() => expireVideo(Date.now() - rec.options.retainMs));
    finish();
  };
  recorder.start(1000);
  const previous = rec.active;
  rec.active = seg;
  if (previous && previous.recorder.state !== 'inactive') setTimeout(() => previous.recorder.state !== 'inactive' && previous.recorder.stop(), rec.options.overlapMs);
  rec.timer = setTimeout(() => beginSegment(rec), rec.options.segmentMs);
}

/** Seal the current segment now (so an incident can read up to this moment) and keep recording. */
export async function flushSegmentRecording(rec: SegmentRecording) {
  if (rec.stopped) return;
  if (rec.timer) clearTimeout(rec.timer);
  const current = rec.active;
  beginSegment(rec);
  if (current) {
    setTimeout(() => current.recorder.state !== 'inactive' && current.recorder.stop(), 50);
    await current.done;
  }
}

export async function stopSegmentRecording(rec: SegmentRecording) {
  rec.stopped = true;
  if (rec.timer) clearTimeout(rec.timer);
  const seg = rec.active;
  if (seg && seg.recorder.state !== 'inactive') {
    seg.recorder.stop();
    await seg.done;
  }
  for (const t of rec.stream.getTracks()) t.stop();
}
