/**
 * Offscreen recorder: consumes a tabCapture stream and keeps a rolling set of sealed WebM
 * segments in IndexedDB. Two MediaRecorders alternate with a small overlap so a segment is
 * always closing while the next one is already recording, leaving no gaps.
 */
import { expireVideo, putVideoSegment } from '../../src/buffer/db';
import type { OffscreenEvent, OffscreenRequest, RecordingOptions } from '../../src/messages';

interface TabRecording {
  tabId: number;
  stream: MediaStream;
  options: RecordingOptions;
  active?: Segment;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}
interface Segment {
  recorder: MediaRecorder;
  start: number;
  chunks: Blob[];
  done: Promise<void>;
  finish: () => void;
}

const recordings = new Map<number, TabRecording>();

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  void (async () => {
    try {
      switch (msg.type) {
        case 'start':
          await start(msg.tabId, msg.streamId, msg.options);
          sendResponse({ ok: true });
          break;
        case 'start-synthetic':
          // test hook: a drawn canvas instead of a tab, so automation can exercise the pipeline
          await startWithStream(msg.tabId, syntheticStream(), msg.options);
          sendResponse({ ok: true });
          break;
        case 'stop':
          await stop(msg.tabId, 'stopped by user');
          sendResponse({ ok: true });
          break;
        case 'flush':
          await flush(msg.tabId);
          sendResponse({ ok: true });
          break;
        case 'status':
          sendResponse({ ok: true, data: Array.from(recordings.keys()) });
          break;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true;
});

async function start(tabId: number, streamId: string, options: RecordingOptions) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // Chrome-specific constraints for tab capture streams
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: options.maxWidth, maxHeight: options.maxHeight, maxFrameRate: options.frameRate },
    } as MediaTrackConstraints,
  });
  await startWithStream(tabId, stream, options);
}

function syntheticStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  let n = 0;
  setInterval(() => {
    ctx.fillStyle = `hsl(${(n * 7) % 360} 60% 30%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = '20px monospace';
    ctx.fillText(new Date().toISOString().slice(11, 23), 20, 100);
    n++;
  }, 100);
  return canvas.captureStream(10);
}

async function startWithStream(tabId: number, stream: MediaStream, options: RecordingOptions) {
  if (recordings.has(tabId)) await stop(tabId, 'restarted');
  const rec: TabRecording = { tabId, stream, options, stopped: false };
  recordings.set(tabId, rec);
  const track = stream.getVideoTracks()[0];
  track?.addEventListener('ended', () => void stop(tabId, 'tab closed or capture ended'));
  beginSegment(rec);
}

function pickMime(): string {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function beginSegment(rec: TabRecording) {
  if (rec.stopped) return;
  const mime = pickMime();
  const recorder = new MediaRecorder(rec.stream, { mimeType: mime || undefined, videoBitsPerSecond: rec.options.videoBitsPerSecond });
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
  // overlap: stop the previous segment a little after the new one started
  if (previous && previous.recorder.state !== 'inactive') setTimeout(() => previous.recorder.state !== 'inactive' && previous.recorder.stop(), rec.options.overlapMs);
  rec.timer = setTimeout(() => beginSegment(rec), rec.options.segmentMs);
}

/** Seal the current segment now (so an incident can read up to this moment) and keep recording. */
async function flush(tabId: number) {
  const rec = recordings.get(tabId);
  if (!rec || rec.stopped) return;
  if (rec.timer) clearTimeout(rec.timer);
  const current = rec.active;
  beginSegment(rec); // starts the next segment; previous stops after the overlap
  if (current) {
    setTimeout(() => current.recorder.state !== 'inactive' && current.recorder.stop(), 50);
    await current.done;
  }
}

async function stop(tabId: number, reason: string) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  rec.stopped = true;
  if (rec.timer) clearTimeout(rec.timer);
  const seg = rec.active;
  if (seg && seg.recorder.state !== 'inactive') {
    seg.recorder.stop();
    await seg.done;
  }
  for (const t of rec.stream.getTracks()) t.stop();
  recordings.delete(tabId);
  const ev: OffscreenEvent = { target: 'background', type: 'recording-ended', tabId, reason };
  void chrome.runtime.sendMessage(ev).catch(() => undefined);
}
