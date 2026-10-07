/**
 * Offscreen recorder: consumes a tabCapture stream and keeps a rolling set of sealed WebM
 * segments in IndexedDB via the shared segmenter.
 */
import type { OffscreenEvent, OffscreenRequest, RecordingOptions } from '../../src/messages';
import { createSegmentRecording, flushSegmentRecording, stopSegmentRecording, type SegmentRecording } from '../../src/video/segmenter';

const recordings = new Map<number, SegmentRecording>();

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
        case 'flush': {
          const rec = recordings.get(msg.tabId);
          if (rec) await flushSegmentRecording(rec);
          sendResponse({ ok: true });
          break;
        }
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
  const rec = createSegmentRecording(tabId, stream, options, 'tab');
  recordings.set(tabId, rec);
  stream.getVideoTracks()[0]?.addEventListener('ended', () => void stop(tabId, 'tab closed or capture ended'));
}

async function stop(tabId: number, reason: string) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  await stopSegmentRecording(rec);
  recordings.delete(tabId);
  const ev: OffscreenEvent = { target: 'background', type: 'recording-ended', tabId, reason };
  void chrome.runtime.sendMessage(ev).catch(() => undefined);
}
