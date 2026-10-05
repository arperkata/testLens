/**
 * Background service worker: wires capture, buffers, incidents and the runtime API.
 * Everything here must tolerate being killed and restarted at any time.
 */
import { defineBackground } from 'wxt/sandbox';
import { DEFAULT_RULES, mergeRules, type RedactionRules } from '@testlens/redaction';
import { clearTab, expire, deleteIncident, getBlob, getIncident, listIncidents, putEvent, putRrweb, purgeIncidents, tabCounts } from '../src/buffer/db';
import { ingestPageExchange, installNetworkCapture } from '../src/capture/network';
import { finalizeIncident, patchIncident, redactionTotals, rememberPageInfo, rerunEngine, startIncident } from '../src/incident';
import * as tracker from '../src/tracker';
import { isRecording, markEnded, recordingSince, recordingSupported, startRecording, startSyntheticRecording, stopRecording } from '../src/recording';
import { expireVideo } from '../src/buffer/db';
import type { OffscreenEvent } from '../src/messages';
import type { CaptureMessage, ContentConfig, RuntimeRequest, RuntimeResponse, TabStatus } from '../src/messages';
import { isMonitoredUrl, loadSettings, onSettingsChanged, originsToMatchPatterns, type Settings } from '../src/settings';
import { newId } from '@testlens/schema';

export default defineBackground(() => {
  let settings: Settings | undefined;
  let rules: RedactionRules = DEFAULT_RULES;
  const monitoredTabs = new Map<number, boolean>();

  const settingsReady = loadSettings().then((s) => applySettings(s));
  onSettingsChanged((s) => void applySettings(s));

  async function applySettings(s: Settings) {
    settings = s;
    rules = mergeRules(DEFAULT_RULES, { sensitiveKeys: s.redaction.extraKeys, patterns: s.redaction.extraPatterns.map((p) => ({ ...p, flags: 'g' })), maxBodyBytes: s.maxBodyBytes });
    monitoredTabs.clear();
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id !== undefined) monitoredTabs.set(t.id, isMonitoredUrl(t.url, s));
  }

  function isMonitoredTab(tabId: number) {
    return monitoredTabs.get(tabId) ?? false;
  }

  // ---------------- content script registration ----------------
  async function registerContentScripts() {
    const s = settings ?? (await loadSettings());
    const matches = originsToMatchPatterns(s.monitoredOrigins);
    try {
      await chrome.scripting.unregisterContentScripts({ ids: ['tl-main', 'tl-isolated'] });
    } catch {
      /* not registered yet */
    }
    if (!matches.length) return;
    // only register for origins we actually have permission for
    const allowed: string[] = [];
    for (const m of Array.from(new Set(matches))) {
      if (await chrome.permissions.contains({ origins: [m] }).catch(() => false)) allowed.push(m);
    }
    if (!allowed.length) return;
    await chrome.scripting.registerContentScripts([
      { id: 'tl-main', js: ['content-scripts/main-world.js'], matches: allowed, world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
      { id: 'tl-isolated', js: ['content-scripts/content.js'], matches: allowed, runAt: 'document_start', allFrames: true, persistAcrossSessions: true },
    ]);
  }

  chrome.runtime.onInstalled.addListener(async (d) => {
    await settingsReady;
    await registerContentScripts();
    chrome.alarms.create('tl-expire', { periodInMinutes: 1 });
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    if (d.reason === 'install') void chrome.runtime.openOptionsPage();
  });
  chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create('tl-expire', { periodInMinutes: 1 });
  });

  // The popup that asked for a site permission is closed by Chrome when the prompt shows,
  // so finish the job here: register the recorder and reload tabs that are now monitored.
  chrome.permissions.onAdded.addListener(async (perm) => {
    if (!perm.origins?.length) return;
    await applySettings(await loadSettings());
    await registerContentScripts();
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id === undefined || !isMonitoredUrl(t.url, settings!)) continue;
      if (perm.origins.some((p) => matchesPattern(t.url!, p))) void chrome.tabs.reload(t.id);
    }
  });
  chrome.permissions.onRemoved.addListener(() => void registerContentScripts());

  function matchesPattern(url: string, pattern: string): boolean {
    if (pattern === '<all_urls>') return true;
    try {
      const u = new URL(url);
      const m = pattern.match(/^(\*|https?|file|ftp):\/\/(\*|\*\.[^/]+|[^/]+)\/(.*)$/);
      if (!m) return false;
      const [, scheme, host] = m;
      if (scheme !== '*' && scheme !== u.protocol.replace(':', '')) return false;
      if (host === '*') return true;
      if (host!.startsWith('*.')) {
        const d = host!.slice(2);
        return u.hostname === d || u.hostname.endsWith(`.${d}`);
      }
      return u.hostname === host;
    } catch {
      return false;
    }
  }

  // ---------------- network ----------------
  installNetworkCapture({
    isMonitoredTab,
    rules: () => rules,
    captureBodies: () => settings?.captureBodies ?? true,
    maxBodyBytes: () => settings?.maxBodyBytes ?? 262144,
    onRedaction: (stats) => {
      for (const [k, v] of Object.entries(stats.counts)) redactionTotals[k] = (redactionTotals[k] ?? 0) + v;
    },
  });

  // ---------------- tabs ----------------
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'loading') monitoredTabs.set(tabId, isMonitoredUrl(tab.url, settings ?? { monitoredOrigins: [] } as unknown as Settings));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    monitoredTabs.delete(tabId);
    void stopRecording(tabId).then(() => clearTab(tabId));
    void chrome.storage.session.remove(`tl.pageinfo.${tabId}`);
  });
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    monitoredTabs.set(d.tabId, isMonitoredUrl(d.url, settings ?? ({ monitoredOrigins: [] } as unknown as Settings)));
    if (!isMonitoredTab(d.tabId)) return;
    if (d.transitionType === 'auto_subframe') return;
    putEvent(d.tabId, 'navigation', { id: newId('n'), ts: d.timeStamp, kind: d.transitionType === 'reload' ? 'reload' : 'committed', to: d.url });
  });

  // ---------------- capture port ----------------
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'tl-capture') return;
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return;
    port.onMessage.addListener((msg: CaptureMessage) => {
      if (!isMonitoredTab(tabId)) return;
      try {
        handleCapture(tabId, msg);
      } catch (e) {
        console.warn('[TL] capture handling failed', e);
      }
    });
  });

  function handleCapture(tabId: number, msg: CaptureMessage) {
    switch (msg.type) {
      case 'console': {
        const args = msg.entry.args.map((a) => redactTextSafe(a));
        putEvent(tabId, 'console', { ...msg.entry, args });
        break;
      }
      case 'error':
        putEvent(tabId, 'error', { ...msg.entry, message: redactTextSafe(msg.entry.message), stack: msg.entry.stack ? redactTextSafe(msg.entry.stack) : undefined });
        break;
      case 'navigation':
        putEvent(tabId, 'navigation', msg.entry);
        break;
      case 'interaction':
        putEvent(tabId, 'interaction', msg.entry);
        break;
      case 'page-exchange':
        void ingestPageExchange(tabId, msg.exchange, {
          isMonitoredTab,
          rules: () => rules,
          captureBodies: () => settings?.captureBodies ?? true,
          maxBodyBytes: () => settings?.maxBodyBytes ?? 262144,
          onRedaction: (stats) => {
            for (const [k, v] of Object.entries(stats.counts)) redactionTotals[k] = (redactionTotals[k] ?? 0) + v;
          },
        });
        break;
      case 'rrweb':
        void putRrweb(tabId, msg.ts, msg.events);
        break;
      case 'page-info':
        rememberPageInfo(tabId, msg.info);
        break;
    }
  }

  function redactTextSafe(s: string) {
    // lightweight capture-time pass; full export-time pass happens at finalize
    try {
      // dynamic import avoided for SW simplicity; reuse rules via regexes
      let out = s;
      for (const p of rules.patterns) out = out.replace(new RegExp(p.regex, p.flags ?? 'g'), '«redacted»');
      return out;
    } catch {
      return s;
    }
  }

  // ---------------- alarms ----------------
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'tl-expire') {
      const s = settings;
      const pre = s?.preWindowMs ?? 300_000;
      void expire(Date.now() - pre - 90_000);
      void expireVideo(Date.now() - pre - 150_000);
      void purgeIncidents(Date.now() - (s?.retentionDays ?? 7) * 86_400_000);
    } else if (a.name.startsWith('tl-finalize:')) {
      void finalizeIncident(a.name.slice('tl-finalize:'.length));
    }
  });

  /** Make the review side panel available on one tab only. */
  async function enablePanel(tabId: number) {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
  }

  // ---------------- runtime API ----------------
  chrome.runtime.onMessage.addListener((req: RuntimeRequest | OffscreenEvent | { target?: string }, _sender, sendResponse: (r: RuntimeResponse) => void) => {
    // messages addressed to the offscreen recorder are answered there, not here
    if ((req as { target?: string }).target === 'offscreen') return false;
    if ((req as OffscreenEvent).target === 'background') {
      const ev = req as OffscreenEvent;
      if (ev.type === 'recording-ended') void markEnded(ev.tabId);
      return false;
    }
    void (async () => {
      try {
        const data = await handle(req as RuntimeRequest);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  });

  async function handle(req: RuntimeRequest): Promise<unknown> {
    await settingsReady;
    const s = settings!;
    switch (req.type) {
      case 'tl:get-config': {
        const cfg: ContentConfig = { captureBodies: s.captureBodies, maxBodyBytes: s.maxBodyBytes, domReplay: s.domReplay, maskAllInputs: s.maskAllInputs, consoleLevels: ['log', 'info', 'warn', 'error', 'debug'] };
        return cfg;
      }
      case 'tl:report-issue': {
        await enablePanel(req.tabId);
        const inc = await startIncident(req.tabId, req.note);
        await chrome.storage.session.set({ 'tl.activeIncident': inc.incidentId });
        return inc;
      }
      case 'tl:enable-panel':
        await enablePanel(req.tabId);
        return true;
      case 'tl:get-tab-status': {
        const tab = await chrome.tabs.get(req.tabId).catch(() => undefined);
        const { counts, oldest } = await tabCounts(req.tabId);
        const st: TabStatus = { tabId: req.tabId, monitored: isMonitoredUrl(tab?.url, s), url: tab?.url, counts, oldestTs: oldest, recording: await isRecording(req.tabId), recordingSince: await recordingSince(req.tabId), recordingSupported: recordingSupported() };
        return st;
      }
      case 'tl:list-incidents':
        return listIncidents();
      case 'tl:get-incident': {
        let inc = await getIncident(req.incidentId);
        if (inc?.status === 'collecting' && Date.now() >= inc.postUntil) inc = await finalizeIncident(req.incidentId);
        return inc;
      }
      case 'tl:delete-incident':
        await deleteIncident(req.incidentId);
        return true;
      case 'tl:update-incident':
        return patchIncident(req.incidentId, req.patch);
      case 'tl:rerun-engine':
        return rerunEngine(req.incidentId, req.focal);
      case 'tl:get-blob': {
        const b = await getBlob(req.blobId);
        if (!b) return undefined;
        return { type: b.type, dataUrl: await blobToDataUrl(b) };
      }
      case 'tl:apply-monitoring':
        await applySettings(await loadSettings());
        await registerContentScripts();
        return true;
      case 'tl:tracker-list':
        return tracker.listTrackers();
      case 'tl:tracker-test':
        return tracker.testConnection(req.tracker);
      case 'tl:tracker-projects':
        return tracker.projects();
      case 'tl:tracker-issue-types':
        return tracker.issueTypes(req.projectKey);
      case 'tl:tracker-fields':
        return tracker.createFields(req.projectKey, req.issueTypeId);
      case 'tl:tracker-preview':
        return tracker.preview(req.incidentId);
      case 'tl:tracker-create':
        return tracker.create(req.incidentId);
      case 'tl:tracker-similar':
        return tracker.similar(req.incidentId);
      case 'tl:set-tracker-target':
        return tracker.setTarget(req.incidentId, req.target, req.saveAsDefault);
      case 'tl:start-tab-recording':
        if (!recordingSupported()) throw new Error('Tab recording is not supported by this browser.');
        await startRecording(req.tabId, req.streamId);
        return true;
      case 'tl:stop-tab-recording':
        await stopRecording(req.tabId);
        return true;
      case 'tl:start-synthetic-recording':
        await startSyntheticRecording(req.tabId, req.options);
        return true;
      case 'tl:recording-status': {
        const st = (await chrome.storage.session.get('tl.recording'))['tl.recording'] ?? {};
        return st;
      }
    }
  }
});

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}
