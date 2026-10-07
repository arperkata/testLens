import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/base.css';
import { sendRuntime, type TabStatus } from '../../src/messages';
import { describeEntry, loadSettings, normalizeOriginInput, originsToMatchPatterns, saveSettings } from '../../src/settings';

function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [status, setStatus] = useState<TabStatus>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [jiraReady, setJiraReady] = useState(false);

  const [autoStarted, setAutoStarted] = useState(false);

  useEffect(() => {
    void (async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTab(t);
      const s = await loadSettings();
      setJiraReady(Boolean(s.tracker?.token && s.tracker.projectKey));
      if (t?.id === undefined) return;
      let st = await sendRuntime<TabStatus>({ type: 'tl:get-tab-status', tabId: t.id });
      // Opening the popup is the user invocation Chrome requires for tab capture: start video
      // automatically on monitored tabs so the tester never has to think about it.
      if (s.autoRecordOnOpen && st.monitored && st.recordingSupported && !st.recording) {
        try {
          const streamId = await new Promise<string>((resolve, reject) =>
            chrome.tabCapture.getMediaStreamId({ targetTabId: t.id! }, (id) => (chrome.runtime.lastError || !id ? reject(new Error(chrome.runtime.lastError?.message ?? 'No stream id')) : resolve(id))),
          );
          await sendRuntime({ type: 'tl:start-tab-recording', tabId: t.id, streamId });
          st = await sendRuntime<TabStatus>({ type: 'tl:get-tab-status', tabId: t.id });
          setAutoStarted(true);
        } catch (e) {
          console.warn('[TL] auto video start failed', e);
        }
      }
      setStatus(st);
    })().catch((e) => setError(String(e)));
  }, []);

  const report = async () => {
    if (!tab?.id) return;
    setBusy(true);
    setError(undefined);
    try {
      await sendRuntime({ type: 'tl:report-issue', tabId: tab.id, note: note.trim() || undefined });
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const monitorThisSite = async () => {
    if (!tab?.url) return;
    const origin = normalizeOriginInput(tab.url);
    if (!origin) return;
    setBusy(true);
    try {
      // Save first: Chrome closes this popup as soon as the native permission prompt appears,
      // so nothing after `permissions.request` is guaranteed to run. The background worker
      // listens for permissions.onAdded, registers the recorder and reloads the tab.
      const s = await loadSettings();
      if (!s.monitoredOrigins.includes(origin)) s.monitoredOrigins.push(origin);
      s.onboarded = true;
      await saveSettings(s);
      const granted = await chrome.permissions.request({ origins: originsToMatchPatterns([origin]) });
      if (!granted) {
        // user declined: roll the entry back
        s.monitoredOrigins = s.monitoredOrigins.filter((o) => o !== origin);
        await saveSettings(s);
        throw new Error('Permission was not granted');
      }
      await sendRuntime({ type: 'tl:apply-monitoring' });
      if (tab.id !== undefined) await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /** One click per tab: Chrome only hands out a tab-capture stream in response to a toolbar click. */
  const toggleRecording = async () => {
    if (!tab?.id || !status) return;
    setBusy(true);
    setError(undefined);
    try {
      if (status.recording) {
        await sendRuntime({ type: 'tl:stop-tab-recording', tabId: tab.id });
      } else {
        const streamId = await new Promise<string>((resolve, reject) =>
          chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => (chrome.runtime.lastError || !id ? reject(new Error(chrome.runtime.lastError?.message ?? 'No stream id')) : resolve(id))),
        );
        await sendRuntime({ type: 'tl:start-tab-recording', tabId: tab.id, streamId });
      }
      setStatus(await sendRuntime<TabStatus>({ type: 'tl:get-tab-status', tabId: tab.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Entire window + microphone: Chrome only grants display capture to a visible extension page, so open the recorder window. */
  const openRecorder = async () => {
    if (!tab?.id) return;
    try {
      await sendRuntime({ type: 'tl:open-recorder', tabId: tab.id });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openPanel = async () => {
    if (tab?.id !== undefined) {
      await sendRuntime({ type: 'tl:enable-panel', tabId: tab.id });
      await chrome.sidePanel.open({ tabId: tab.id });
    }
    window.close();
  };

  const unsupported = !tab?.url || !/^https?:/.test(tab.url);

  return (
    <div style={{ padding: 12 }}>
      <div className="row between">
        <h1 style={{ margin: 0 }}>TestLens</h1>
        <button className="small" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
      <p className="muted mono" style={{ wordBreak: 'break-all' }}>
        {tab?.url ?? ''}
      </p>

      {unsupported && <div className="card">TestLens cannot monitor this page type.</div>}

      {!unsupported && status && !status.monitored && (
        <div className="card">
          <p>This site is not monitored yet.</p>
          <p className="muted">
            TestLens only records sites you choose. Monitoring is domain-wide, so {tab?.url ? describeEntry(normalizeOriginInput(tab.url) ?? '') : 'the whole domain'} will be covered, including its API subdomains. Configure once; it applies to every window of this browser.
          </p>
          <button className="primary" onClick={monitorThisSite} disabled={busy}>
            Monitor {tab?.url ? (normalizeOriginInput(tab.url) ?? '').replace(/^\*\./, '') : 'this site'}
          </button>
        </div>
      )}

      {!unsupported && status?.monitored && (
        <>
          <div className="card">
            <div className="row between">
              <span>
                <span className="ok">●</span> Recording buffer active
              </span>
              <span className="muted">{status.oldestTs ? `since ${new Date(status.oldestTs).toLocaleTimeString()}` : 'no events yet'}</span>
            </div>
            <div className="row muted" style={{ marginTop: 6, gap: 12 }}>
              <span>{status.counts.exchanges} requests</span>
              <span>{status.counts.console} console</span>
              <span className={status.counts.errors ? 'err' : ''}>{status.counts.errors} errors</span>
              <span>{status.counts.interactions} actions</span>
              <span>{status.counts.rrwebChunks ? 'replay ✓' : 'replay –'}</span>
            </div>
            {status.recordingSupported && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                <div className="row between">
                  <span className={status.recording ? 'err' : 'muted'}>
                    {status.recording
                      ? `● Recording ${status.recordingMode === 'window' ? 'window' : 'this tab'}${status.recordingMic ? ' + mic' : ''}${autoStarted ? ' (started now)' : status.recordingSince ? ` since ${new Date(status.recordingSince).toLocaleTimeString()}` : ''}`
                      : 'Video: off (DOM replay + screenshot still captured)'}
                  </span>
                  {status.recording && (
                    <button className="small" onClick={toggleRecording} disabled={busy}>
                      Stop video
                    </button>
                  )}
                </div>
                {!status.recording && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button className="small" onClick={toggleRecording} disabled={busy} title="Silent capture of this tab in the background. Stays on until the tab closes.">
                      ▣ Current tab
                    </button>
                    <button className="small" onClick={openRecorder} disabled={busy} title="Opens a small recorder window: capture the entire window or screen and narrate with your microphone. Keep the window open while recording.">
                      🖥 Entire window + mic
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {status.alerts.count > 0 && !status.alerts.muted && (
            <div className="card alert-card">
              <div className="row between">
                <b>
                  <span className="dot" /> {status.alerts.count === 1 ? '1 failure' : `${status.alerts.count} failures`} noticed in this tab
                </b>
                <button className="small" onClick={() => void sendRuntime({ type: 'tl:alert-mute', tabId: tab!.id! }).then(() => setStatus({ ...status, alerts: { ...status.alerts, muted: true } }))}>
                  mute
                </button>
              </div>
              {status.alerts.last && <div className="muted mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>{status.alerts.last}</div>}
              <div className="muted" style={{ marginTop: 4 }}>Report Issue below preserves the last 5 minutes around {status.alerts.count === 1 ? 'it' : 'them'}. Shortcut: {status.alerts.shortcut}.</div>
            </div>
          )}
          <label>What went wrong? (optional)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Submitting the receipt form shows a spinner forever" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className={`primary ${status.alerts.count > 0 && !status.alerts.muted ? 'pulse' : ''}`} onClick={report} disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Preserving evidence…' : status.alerts.count > 0 && !status.alerts.muted ? `Report Issue (${status.alerts.count} failure${status.alerts.count > 1 ? 's' : ''} noticed)` : 'Report Issue'}
            </button>
            <button onClick={openPanel}>Incidents</button>
          </div>
          {!jiraReady && (
            <p className="muted" style={{ marginTop: 8 }}>
              No bug tracker is connected yet. You can still report and review; connect one in Settings to create issues.
            </p>
          )}
        </>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
