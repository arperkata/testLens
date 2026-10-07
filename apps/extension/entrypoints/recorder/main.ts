/**
 * Recorder window: "Entire window / screen" (getDisplayMedia) with optional microphone, or a
 * silent current-tab capture. Chrome only grants display capture to a visible extension page,
 * so this small window owns the stream and must stay open while recording.
 * Segments are written to the same store as the offscreen recorder, keyed by the tab id.
 */
import { DEFAULT_RECORDING_OPTIONS, type RecorderRequest } from '../../src/messages';
import { createSegmentRecording, flushSegmentRecording, stopSegmentRecording, type SegmentRecording } from '../../src/video/segmenter';

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const tabTitle = params.get('title') ?? '';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: 'window' | 'tab' = 'window';
let rec: SegmentRecording | undefined;

$('target').textContent = `for tab: ${tabTitle || `#${tabId}`}`;
$('modeWindow').onclick = () => setMode('window');
$('modeTab').onclick = () => setMode('tab');
function setMode(m: 'window' | 'tab') {
  mode = m;
  $('modeWindow').classList.toggle('active', m === 'window');
  $('modeTab').classList.toggle('active', m === 'tab');
  ($('mic') as HTMLInputElement).disabled = false;
}

$('start').onclick = async () => {
  try {
    $('status').textContent = 'requesting capture…';
    let video: MediaStream;
    if (mode === 'window') {
      video = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: DEFAULT_RECORDING_OPTIONS.frameRate, width: { max: 1920 }, height: { max: 1080 } }, audio: false, preferCurrentTab: false } as DisplayMediaStreamOptions);
    } else {
      const streamId = await new Promise<string>((resolve, reject) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => (chrome.runtime.lastError || !id ? reject(new Error(chrome.runtime.lastError?.message ?? 'No stream id')) : resolve(id))));
      video = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: DEFAULT_RECORDING_OPTIONS.maxWidth, maxHeight: DEFAULT_RECORDING_OPTIONS.maxHeight, maxFrameRate: DEFAULT_RECORDING_OPTIONS.frameRate } } as MediaTrackConstraints });
    }
    const tracks: MediaStreamTrack[] = [...video.getVideoTracks()];
    if (($('mic') as HTMLInputElement).checked) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        tracks.push(...mic.getAudioTracks());
      } catch (e) {
        $('status').textContent = `microphone unavailable (${e instanceof Error ? e.message : String(e)}); recording video only`;
      }
    }
    const stream = new MediaStream(tracks);
    ($('preview') as HTMLVideoElement).srcObject = new MediaStream(video.getVideoTracks());
    rec = createSegmentRecording(tabId, stream, { ...DEFAULT_RECORDING_OPTIONS, videoBitsPerSecond: mode === 'window' ? 1_000_000 : DEFAULT_RECORDING_OPTIONS.videoBitsPerSecond }, mode);
    video.getVideoTracks()[0]?.addEventListener('ended', () => void stop('capture ended by the browser'));
    await chrome.runtime.sendMessage({ type: 'tl:recorder-started', tabId, mode: 'window', mic: tracks.length > 1 });
    $('status').innerHTML = `<span class="dot"></span>recording ${mode === 'window' ? 'window' : 'tab'}${tracks.length > 1 ? ' + microphone' : ''}`;
    ($('start') as HTMLButtonElement).disabled = true;
    ($('stop') as HTMLButtonElement).disabled = false;
  } catch (e) {
    $('status').textContent = `could not start: ${e instanceof Error ? e.message : String(e)}`;
    $('status').className = 'err';
  }
};

$('stop').onclick = () => void stop('stopped by user');

async function stop(reason: string) {
  if (!rec) return;
  const r = rec;
  rec = undefined;
  await stopSegmentRecording(r);
  ($('preview') as HTMLVideoElement).srcObject = null;
  $('status').textContent = `stopped (${reason})`;
  $('status').className = 'muted';
  ($('start') as HTMLButtonElement).disabled = false;
  ($('stop') as HTMLButtonElement).disabled = true;
  void chrome.runtime.sendMessage({ target: 'background', type: 'recording-ended', tabId, reason }).catch(() => undefined);
}

// background → recorder control (flush before an incident reads segments; stop when the tab closes)
chrome.runtime.onMessage.addListener((msg: RecorderRequest, _s, sendResponse) => {
  if (!msg || msg.target !== 'recorder' || msg.tabId !== tabId) return;
  void (async () => {
    if (msg.type === 'flush' && rec) await flushSegmentRecording(rec);
    if (msg.type === 'stop') await stop('tab closed');
    sendResponse({ ok: true, data: Boolean(rec) });
  })();
  return true;
});

window.addEventListener('beforeunload', () => {
  if (rec) void stop('recorder window closed');
});
