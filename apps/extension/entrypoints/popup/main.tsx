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

  useEffect(() => {
    void (async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTab(t);
      if (t?.id !== undefined) setStatus(await sendRuntime<TabStatus>({ type: 'tl:get-tab-status', tabId: t.id }));
      const s = await loadSettings();
      setJiraReady(Boolean(s.jira?.baseUrl && s.jira.projectKey));
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
          </div>
          <label>What went wrong? (optional)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Submitting the receipt form shows a spinner forever" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={report} disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Preserving evidence…' : 'Report Issue'}
            </button>
            <button onClick={openPanel}>Incidents</button>
          </div>
          {!jiraReady && (
            <p className="muted" style={{ marginTop: 8 }}>
              Jira is not connected yet. You can still report and review; connect Jira in Settings to create issues.
            </p>
          )}
        </>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
