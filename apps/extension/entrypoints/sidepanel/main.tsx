import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChromeBuiltinProvider, getPreset, type BuiltinAvailability } from '@testlens/ai';
import { createRoot } from 'react-dom/client';
import '../../src/ui/base.css';
import type { BugContext, BugDraft, EvidenceItem, FocalEvent } from '@testlens/schema';
import { getBlob, type StoredIncident } from '../../src/buffer/db';
import type { TrackerPreview } from '../../src/tracker';
import { sendRuntime } from '../../src/messages';
import { loadSettings, saveSettings } from '../../src/settings';
import type { FieldSchema, IssueTypeRef, ProjectRef } from '@testlens/trackers-core';
import { buildMappingFields, optionalFieldsWithValues, requiredFields, stringValues, withDefaults } from '../../src/jira-mapping';
import { FieldControl } from '../../src/ui/FieldControl';
import { MarkupEditor } from '../../src/ui/MarkupEditor';

type Incident = StoredIncident;

type IncidentRow = import('../../src/buffer/db').IncidentSummary;

function App() {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [incident, setIncident] = useState<Incident>();
  const [error, setError] = useState<string>();

  const refreshList = useCallback(async () => {
    setIncidents(await sendRuntime<IncidentRow[]>({ type: 'tl:list-incidents' }));
  }, []);

  const load = useCallback(async (id: string) => {
    const inc = await sendRuntime<Incident | undefined>({ type: 'tl:get-incident', incidentId: id });
    setIncident(inc);
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshList();
      // popped-out window: ?incident=<id>; side panel: last reported incident
      const fromUrl = new URLSearchParams(location.search).get('incident');
      if (fromUrl) return setActiveId(fromUrl);
      const r = await chrome.storage.session.get('tl.activeIncident');
      const id = r['tl.activeIncident'] as string | undefined;
      if (id) setActiveId(id);
    })().catch((e) => setError(String(e)));
    const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes['tl.activeIncident']?.newValue) setActiveId(changes['tl.activeIncident'].newValue as string);
    };
    chrome.storage.onChanged.addListener(l);
    return () => chrome.storage.onChanged.removeListener(l);
  }, [refreshList]);

  useEffect(() => {
    if (!activeId) return;
    void load(activeId).catch((e) => setError(String(e)));
  }, [activeId, load]);

  // poll while collecting
  useEffect(() => {
    if (incident?.status !== 'collecting' || !activeId) return;
    const t = setInterval(() => void load(activeId), 1000);
    return () => clearInterval(t);
  }, [incident?.status, activeId, load]);

  if (error) return <div style={{ padding: 12 }} className="err">{error}</div>;

  if (!activeId || !incident) {
    return (
      <IncidentList
        incidents={incidents}
        onOpen={setActiveId}
        onRefresh={refreshList}
      />
    );
  }

  return (
    <IncidentView
      incident={incident}
      onBack={() => {
        setActiveId(undefined);
        setIncident(undefined);
        void chrome.storage.session.remove('tl.activeIncident');
        void refreshList();
      }}
      reload={() => load(incident.incidentId)}
      setIncident={setIncident}
    />
  );
}

// ---------------------------------------------------------------------------

/** Incident list with the two API-testing entry points: pull from the local Hub, or import a file. */
function IncidentList({ incidents, onOpen, onRefresh }: { incidents: IncidentRow[]; onOpen: (id: string) => void; onRefresh: () => Promise<void> }) {
  const [hub, setHub] = useState<import('../../src/hub').HubStatus>();
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const refreshHub = useCallback(() => sendRuntime<import('../../src/hub').HubStatus>({ type: 'tl:hub-status' }).then(setHub).catch(() => undefined), []);
  useEffect(() => {
    void refreshHub();
  }, [refreshHub]);

  const syncHub = async () => {
    setBusy('sync');
    setMsg(undefined);
    try {
      const created = await sendRuntime<Incident[]>({ type: 'tl:hub-sync' });
      await onRefresh();
      await refreshHub();
      setMsg({ kind: 'ok', text: created.length ? `${created.length} incident(s) pulled from the Hub` : 'Nothing new on the Hub' });
      if (created.length === 1) onOpen(created[0]!.incidentId);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy('import');
    setMsg(undefined);
    try {
      const inc = await sendRuntime<Incident>({ type: 'tl:import-file', name: f.name, text: await f.text() });
      await onRefresh();
      if (inc.status === 'error') setMsg({ kind: 'err', text: inc.error ?? 'import failed' });
      else onOpen(inc.incidentId);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const originBadge = (i: IncidentRow) => (i.origin === 'hub' ? <span className="badge">{i.toolName ?? 'Hub'}</span> : i.origin === 'import' ? <span className="badge">{i.toolName ?? 'import'}</span> : null);

  // UI (browser) vs API (Hub, Postman, Newman, HAR) — remembered for the session; the popup can preselect API
  const [mode, setMode] = useState<'ui' | 'api'>('ui');
  useEffect(() => {
    void chrome.storage.session.get('tl.panelMode').then((r) => {
      if (r['tl.panelMode'] === 'api') setMode('api');
    });
  }, []);
  const switchMode = (m: 'ui' | 'api') => {
    setMode(m);
    void chrome.storage.session.set({ 'tl.panelMode': m });
  };
  // while the API tab is open, watch for the Hub coming online every 3 s
  useEffect(() => {
    if (mode !== 'api') return;
    const t = setInterval(() => void refreshHub(), 3000);
    return () => clearInterval(t);
  }, [mode, refreshHub]);

  const uiIncidents = incidents.filter((i) => !i.origin || i.origin === 'browser');
  const apiIncidents = incidents.filter((i) => i.origin === 'hub' || i.origin === 'import');

  const rows = (list: IncidentRow[]) => (
    <div className="list">
      {list.map((i) => (
        <div key={i.incidentId} className="item" style={{ cursor: 'pointer' }} onClick={() => onOpen(i.incidentId)}>
          <div className="body">
            <div className="title">
              {i.summary ?? i.tab.title ?? i.tab.url} {originBadge(i)}
            </div>
            <div className="reasons">
              {new Date(i.triggerAt).toLocaleString()} · {i.status}
              {createdOf(i)?.key ? ` · ${createdOf(i)!.key}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ padding: 12 }}>
      <div className="row between">
        <h1>Incidents</h1>
        <button className="small" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
      </div>
      <div className="tabs" style={{ marginTop: 4 }}>
        <button className={mode === 'ui' ? 'active' : ''} onClick={() => switchMode('ui')}>UI testing{uiIncidents.length ? ` (${uiIncidents.length})` : ''}</button>
        <button className={mode === 'api' ? 'active' : ''} onClick={() => switchMode('api')}>
          API testing{apiIncidents.length ? ` (${apiIncidents.length})` : ''} {hub?.enabled && <span className={hub.reachable ? 'ok' : 'err'}>●</span>}
        </button>
      </div>
      {msg && <p className={msg.kind === 'err' ? 'err' : 'ok'}>{msg.text}</p>}

      {mode === 'ui' && (
        <>
          {!uiIncidents.length && <p className="muted">No browser incidents yet. Open a monitored tab, click the TestLens icon and choose “Report Issue”, or press Alt+Shift+R when something breaks.</p>}
          {rows(uiIncidents)}
        </>
      )}

      {mode === 'api' && (
        <ApiPanel
          hub={hub}
          busy={busy}
          onConnect={async () => {
            const s = await loadSettings();
            try {
              const origin = `${new URL(s.hub.url).origin}/*`;
              const ok = await chrome.permissions.request({ origins: [origin] });
              if (!ok) throw new Error('Permission to call the Hub was not granted');
              await saveSettings({ ...s, hub: { ...s.hub, enabled: true } });
              await refreshHub();
            } catch (e) {
              setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
            }
          }}
          onSync={syncHub}
          onImport={() => fileRef.current?.click()}
          incidents={rows(apiIncidents)}
          hasIncidents={apiIncidents.length > 0}
        />
      )}
      <input ref={fileRef} type="file" accept=".har,.json,application/json" style={{ display: 'none' }} onChange={(e) => void importFile(e.target.files?.[0])} />
    </div>
  );
}

/**
 * API testing tab. The extension cannot start a process, so starting the Hub is a copy-paste
 * (or a downloaded start script); the tab detects when it comes online and then provides the
 * Postman snippet, the Newman command, file import and the API incidents.
 */
function ApiPanel({ hub, busy, onConnect, onSync, onImport, incidents, hasIncidents }: { hub?: import('../../src/hub').HubStatus; busy?: string; onConnect: () => Promise<void>; onSync: () => Promise<void>; onImport: () => void; incidents: React.ReactNode; hasIncidents: boolean }) {
  const [copied, setCopied] = useState<string>();
  const [snippet, setSnippet] = useState<string>();
  const [showSnippet, setShowSnippet] = useState(false);
  const url = hub?.url ?? 'http://localhost:7331';
  const port = (() => {
    try {
      return new URL(url).port || '7331';
    } catch {
      return '7331';
    }
  })();
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(undefined), 1600);
    } catch {
      setCopied(`could not copy ${label}`);
    }
  };
  const download = (name: string, text: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const loadSnippet = async () => {
    if (!snippet) {
      try {
        setSnippet(await sendRuntime<string>({ type: 'tl:hub-snippet' }));
      } catch (e) {
        setSnippet(`// could not load from the Hub: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setShowSnippet((v) => !v);
  };
  const online = Boolean(hub?.enabled && hub.reachable);
  const startCmd = `npx testlens-hub`;
  const startCmdPort = port === '7331' ? startCmd : `TL_HUB_PORT=${port} npx testlens-hub`;
  const cmdFile = `@echo off\r\ntitle TestLens Hub\r\necho Starting TestLens Hub on ${url} ...\r\n${port === '7331' ? '' : `set TL_HUB_PORT=${port}\r\n`}npx testlens-hub\r\npause\r\n`;
  const shFile = `#!/bin/sh\n# TestLens Hub — API-testing ingestion server\n${port === '7331' ? '' : `export TL_HUB_PORT=${port}\n`}exec npx testlens-hub\n`;
  const newmanCmd = `newman run collection.json -e env.json -r cli,testlens --reporter-testlens-hub ${url}`;

  return (
    <>
      {/* 1. Hub status + start */}
      <div className="card">
        <div className="row between">
          <b>
            <span className="badge" style={{ marginLeft: 0 }}>1</span> Local Hub{' '}
            {hub?.enabled === false ? <span className="badge">not connected</span> : online ? <span className="badge ok">● online at {url}</span> : <span className="badge err">● offline</span>}
          </b>
          {hub?.enabled === false ? (
            <button className="small primary" onClick={onConnect}>Connect</button>
          ) : (
            <button className="small" onClick={() => void onSync()} disabled={busy !== undefined || !online}>
              {busy === 'sync' ? 'Syncing…' : `Sync from Hub${hub?.pending ? ` (${hub.pending} new)` : ''}`}
            </button>
          )}
        </div>
        {!online && (
          <div style={{ marginTop: 8 }}>
            <p className="muted" style={{ margin: '0 0 6px' }}>
              The Hub is a small server on this machine that receives evidence from API tools. A browser extension cannot start it, so run this once in a terminal (needs Node.js). This tab detects it as soon as it is up.
            </p>
            <div className="row" style={{ gap: 6 }}>
              <code className="mono" style={{ padding: '6px 10px', background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 6 }}>{startCmdPort}</code>
              <button className="small primary" onClick={() => copy('command', startCmdPort)}>{copied === 'command' ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 11 }}>Or save a double-click starter:</span>
              <button className="small" onClick={() => download('start-testlens-hub.cmd', cmdFile)}>Windows .cmd</button>
              <button className="small" onClick={() => download('start-testlens-hub.sh', shFile)}>macOS / Linux .sh</button>
              <span className="muted" style={{ fontSize: 11 }}>Needs Node 18+. No npm access? Run the single file from the TestLens release: <code>node testlens-hub.mjs</code></span>
            </div>
            {hub?.enabled && hub.error && <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>{hub.error}</p>}
          </div>
        )}
        {online && (
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
            Hub data stays on this machine. Incidents are pulled here automatically every minute, or now with Sync. Open <a href={url} target="_blank" rel="noreferrer">{url}</a> for the Hub page.
          </p>
        )}
      </div>

      {/* 2. Use it from API tools */}
      <div className="card">
        <b><span className="badge" style={{ marginLeft: 0 }}>2</span> Use it in your API tool</b>
        <div style={{ marginTop: 8 }}>
          <div className="row between">
            <span><b>Postman</b> <span className="muted">collection → Scripts → Post-response</span></span>
            <span className="row" style={{ gap: 6 }}>
              <button className="small" onClick={loadSnippet} disabled={!online}>{showSnippet ? 'Hide snippet' : 'Show snippet'}</button>
              <button className="small primary" disabled={!online} onClick={async () => { if (!snippet) { try { setSnippet(await sendRuntime<string>({ type: 'tl:hub-snippet' })); } catch { /* shown below */ } } const s = snippet ?? (await sendRuntime<string>({ type: 'tl:hub-snippet' }).catch(() => '')); if (s) void copy('snippet', s); }}>
                {copied === 'snippet' ? 'Copied' : 'Copy snippet'}
              </button>
            </span>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>Reports only on 4xx/5xx, request errors or failed <code>pm.test</code>s. Force one with <code>pm.variables.set("TL_REPORT","why")</code>.</p>
          {showSnippet && snippet && <pre style={{ maxHeight: 220, marginTop: 6 }}>{snippet}</pre>}
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="row between">
            <span><b>Newman / CI</b> <span className="muted">reporter in integrations/postman</span></span>
            <button className="small" onClick={() => copy('newman', newmanCmd)}>{copied === 'newman' ? 'Copied' : 'Copy command'}</button>
          </div>
          <pre style={{ marginTop: 6, maxHeight: 80 }}>{newmanCmd}</pre>
        </div>
        <div style={{ marginTop: 10 }} className="row between">
          <span><b>HAR / Newman JSON file</b> <span className="muted">DevTools, Charles, Fiddler, Proxyman, Insomnia</span></span>
          <button className="small" onClick={onImport} disabled={busy !== undefined}>{busy === 'import' ? 'Importing…' : 'Import file'}</button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>File import needs no Hub.</p>
        {copied && copied.startsWith('could not') && <p className="err">{copied}</p>}
      </div>

      {/* 3. Incidents from API tools */}
      <h2>API incidents</h2>
      {!hasIncidents && <p className="muted">None yet. Run a failing request in Postman or Newman with the Hub online, or import a file.</p>}
      {incidents}
    </>
  );
}

// ---------------------------------------------------------------------------

function IncidentView({ incident, onBack, reload, setIncident }: { incident: Incident; onBack: () => void; reload: () => Promise<void>; setIncident: (i: Incident) => void }) {
  const [tab, setTab] = useState<'bug' | 'evidence' | 'jira'>('bug');
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();

  const ctx = incident.context;
  const draft = incident.draft;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const patch = (p: Parameters<typeof sendRuntime>[0] extends infer _ ? import('../../src/messages').IncidentPatch : never) =>
    run('saving', async () => {
      const inc = await sendRuntime<Incident>({ type: 'tl:update-incident', incidentId: incident.incidentId, patch: p });
      setIncident(inc);
    });

  if (incident.status === 'collecting') {
    const left = Math.max(0, Math.ceil((incident.postUntil - Date.now()) / 1000));
    return (
      <div style={{ padding: 12 }}>
        <button className="small" onClick={onBack}>← Incidents</button>
        <div className="card" style={{ marginTop: 10 }}>
          <h1>
            <span className="spinner" /> Evidence preserved
          </h1>
          <p>The previous 5 minutes are frozen. Capturing a short post-click window for errors that are still completing… {left}s</p>
          <p className="muted">Screenshot taken at the moment you clicked Report Issue.</p>
        </div>
      </div>
    );
  }
  if (incident.status === 'error' || !ctx || !draft) {
    return (
      <div style={{ padding: 12 }}>
        <button className="small" onClick={onBack}>← Incidents</button>
        <div className="card err">
          <h1>Could not assemble this incident</h1>
          <pre>{incident.error ?? 'Unknown error'}</pre>
          <button className="danger small" onClick={() => run('delete', async () => { await sendRuntime({ type: 'tl:delete-incident', incidentId: incident.incidentId }); onBack(); })}>Delete</button>
        </div>
      </div>
    );
  }

  const q = ctx.evidence?.captureQuality;

  return (
    <div style={{ padding: 12, paddingBottom: 60 }}>
      <div className="row between">
        <button className="small" onClick={onBack}>← Incidents</button>
        <span className="row" style={{ gap: 6 }}>
          <span className="muted mono">{incident.incidentId}</span>
          {!new URLSearchParams(location.search).get('incident') && (
            <button className="small" title="Open this review in its own window" onClick={() => void chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?incident=${incident.incidentId}`), type: 'popup', width: 560, height: 900 })}>
              ⧉ Pop out
            </button>
          )}
        </span>
      </div>
      <div className="row between" style={{ marginTop: 8 }}>
        <span className="muted">{new Date(incident.triggerAt).toLocaleString()}</span>
        {q && (
          <span className={`quality ${q.score >= 80 ? 'ok' : q.score >= 50 ? 'warn' : 'err'}`} title={q.notes.join('\n')}>
            capture {q.score}/100
          </span>
        )}
      </div>
      {createdOf(incident)?.key && (
        <div className="card ok">
          Created <a href={createdOf(incident)!.url} target="_blank" rel="noreferrer">{createdOf(incident)!.key}</a>
          {createdOf(incident)!.attachments.some((a) => !a.ok) && (
            <div className="warn" style={{ marginTop: 4 }}>
              Some attachments failed: {createdOf(incident)!.attachments.filter((a) => !a.ok).map((a) => `${a.fileName} (${a.error})`).join('; ')}
            </div>
          )}
        </div>
      )}

      <div className="tabs" style={{ marginTop: 10 }}>
        <button className={tab === 'bug' ? 'active' : ''} onClick={() => setTab('bug')}>Bug</button>
        <button className={tab === 'evidence' ? 'active' : ''} onClick={() => setTab('evidence')}>Evidence</button>
        <button className={tab === 'jira' ? 'active' : ''} onClick={() => setTab('jira')}>Tracker</button>
      </div>

      {tab === 'bug' && <BugTab ctx={ctx} draft={draft} incident={incident} onPatch={patch} onAiApplied={setIncident} onRerun={(f) => run('rerun', async () => setIncident(await sendRuntime<Incident>({ type: 'tl:rerun-engine', incidentId: incident.incidentId, focal: f })))} />}
      {tab === 'evidence' && <EvidenceTab ctx={ctx} incident={incident} onPatch={patch} onIncident={setIncident} />}
      {tab === 'jira' && <TrackerTab incident={incident} setIncident={setIncident} onPatch={patch} />}

      {(busy || msg) && (
        <div className="toast">
          {busy && <span><span className="spinner" /> {busy}…</span>}
          {msg && <span className="err">{msg}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BugTab({ ctx, draft, incident, onPatch, onRerun, onAiApplied }: { ctx: BugContext; draft: BugDraft; incident: Incident; onPatch: (p: import('../../src/messages').IncidentPatch) => void; onRerun: (f?: { kind: FocalEvent['kind']; refId: string }) => void; onAiApplied: (i: Incident) => void }) {
  const [summary, setSummary] = useState(draft.summary);
  const [steps, setSteps] = useState(draft.stepsToReproduce.join('\n'));
  const [expected, setExpected] = useState(draft.expectedResult);
  const [actual, setActual] = useState(draft.actualResult);
  const [labels, setLabels] = useState(draft.labels.join(', '));
  useEffect(() => {
    setSummary(draft.summary);
    setSteps(draft.stepsToReproduce.join('\n'));
    setExpected(draft.expectedResult);
    setActual(draft.actualResult);
    setLabels(draft.labels.join(', '));
  }, [draft]);

  const dirty = summary !== draft.summary || steps !== draft.stepsToReproduce.join('\n') || expected !== draft.expectedResult || actual !== draft.actualResult || labels !== draft.labels.join(', ');
  const save = () => onPatch({ draft: { summary, stepsToReproduce: steps.split('\n').map((s) => s.trim()).filter(Boolean), expectedResult: expected, actualResult: actual, labels: labels.split(',').map((s) => s.trim()).filter(Boolean) } });

  const focal = ctx.evidence?.focal;
  const candidates = ctx.evidence?.candidates ?? [];
  const describe = (c: FocalEvent) => {
    if (c.kind === 'exchange') {
      const e = ctx.exchanges.find((x) => x.id === c.refId);
      return e ? `${e.error ? `ERR ${e.error.kind}` : e.response?.status} ${e.method} ${shortUrl(e.url)}` : c.refId;
    }
    if (c.kind === 'error') return `JS error: ${ctx.errors.find((x) => x.id === c.refId)?.message.slice(0, 80) ?? ''}`;
    if (c.kind === 'console') return `console.error: ${ctx.console.find((x) => x.id === c.refId)?.args.join(' ').slice(0, 80) ?? ''}`;
    return c.refId;
  };

  return (
    <>
      <div className="card">
        <div className="row between">
          <b>Focal event</b>
          <span className="badge derived">derived</span>
        </div>
        {focal ? (
          <>
            <div className="mono" style={{ marginTop: 4 }}>{describe(focal)}</div>
            <div className="muted" style={{ fontSize: 11 }}>{focal.reasons.join(' · ')}</div>
          </>
        ) : (
          <p className="muted">No failure detected automatically. Describe the problem in the fields below.</p>
        )}
        {candidates.length > 1 && (
          <>
            <label>Not the right one? Pick another candidate</label>
            <select value={focal ? `${focal.kind}:${focal.refId}` : ''} onChange={(e) => { const [kind, ...rest] = e.target.value.split(':'); onRerun({ kind: kind as FocalEvent['kind'], refId: rest.join(':') }); }}>
              {candidates.map((c) => (
                <option key={`${c.kind}:${c.refId}`} value={`${c.kind}:${c.refId}`}>
                  [{c.score}] {describe(c)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <AiPanel ctx={ctx} draft={draft} incident={incident} onApplied={onAiApplied} />

      <label>Summary{draft.aiApplied?.includes('summary') && <span className="badge ai">AI</span>}</label>
      <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
      <label>
        Steps to reproduce (one per line) {draft.aiApplied?.includes('stepsToReproduce') ? <span className="badge ai">AI, from your recorded actions</span> : <span className="badge derived">derived from your clicks and navigation</span>}
      </label>
      <textarea value={steps} onChange={(e) => setSteps(e.target.value)} style={{ minHeight: 110 }} />
      <label>Expected result</label>
      <textarea value={expected} onChange={(e) => setExpected(e.target.value)} />
      <label>Actual result</label>
      <textarea value={actual} onChange={(e) => setActual(e.target.value)} />
      <label>Labels (comma separated)</label>
      <input value={labels} onChange={(e) => setLabels(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!dirty} onClick={save}>Save edits</button>
        {dirty && <span className="muted">unsaved changes</span>}
      </div>

      <h2>Sections that will go into the description</h2>
      {draft.sections.map((s) => (
        <div className="card" key={s.id}>
          <div className="row between">
            <b>{s.title}</b>
            <span className={`badge ${s.provenance}`}>{s.provenance}</span>
          </div>
          {s.code ? <pre>{s.body}</pre> : <p style={{ whiteSpace: 'pre-wrap' }}>{s.body}</p>}
        </div>
      ))}
      <p className="muted">Sections are generated from captured data. Edit the fields above; toggle evidence items on the Evidence tab to change what appears here.</p>
      {incident.note && <p className="muted">Your note: “{incident.note}”</p>}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Optional AI suggestions. Facts stay facts: the suggestion is shown beside the deterministic
 * draft and only replaces a field when the tester clicks Apply.
 */
function AiPanel({ ctx, draft, incident, onApplied }: { ctx: BugContext; draft: BugDraft; incident: Incident; onApplied: (i: Incident) => void }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [provider, setProvider] = useState<string>();
  const [builtin, setBuiltin] = useState<BuiltinAvailability>();
  const [progress, setProgress] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [showSent, setShowSent] = useState(false);
  const [sent, setSent] = useState<unknown>();
  const autoRan = useRef(false);
  useEffect(() => {
    void loadSettings().then(async (s) => {
      setProvider(s.ai.provider);
      const preset = getPreset(s.ai.provider);
      setEnabled(s.ai.enabled && (!preset.needsKey || Boolean(s.ai.apiKey)));
      if (s.ai.provider === 'chrome-builtin') setBuiltin(await ChromeBuiltinProvider.availability());
    });
  }, []);
  const a = ctx.analysis;

  /** Run in this page when the provider is the on-device model (the background may not have the API). */
  const runInPage = async () => {
    const s = await loadSettings();
    const input = await sendRuntime<import('@testlens/ai').AnalysisInput>({ type: 'tl:ai-projection', incidentId: incident.incidentId });
    const analysis = await new ChromeBuiltinProvider().analyze(input, { apiKey: '', model: s.ai.model, baseUrl: '' });
    return sendRuntime<Incident>({ type: 'tl:ai-store', incidentId: incident.incidentId, analysis });
  };

  const run = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onApplied(provider === 'chrome-builtin' ? await runInPage() : await sendRuntime<Incident>({ type: 'tl:ai-enhance', incidentId: incident.incidentId }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // On-device model present and nothing analysed yet → do it now, no click needed.
  useEffect(() => {
    if (autoRan.current || !enabled || provider !== 'chrome-builtin' || builtin !== 'available' || a || incident.status !== 'ready') return;
    autoRan.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, provider, builtin, a, incident.status]);

  const download = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      setProgress(0);
      await ChromeBuiltinProvider.download((f) => setProgress(f));
      setBuiltin(await ChromeBuiltinProvider.availability());
      setProgress(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const applyFields = async (fields: ('summary' | 'stepsToReproduce' | 'expectedResult' | 'actualResult')[]) => {
    setBusy(true);
    try {
      onApplied(await sendRuntime<Incident>({ type: 'tl:ai-apply', incidentId: incident.incidentId, fields }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const showSentPayload = async () => {
    if (!sent) setSent(await sendRuntime({ type: 'tl:ai-projection', incidentId: incident.incidentId }));
    setShowSent((v) => !v);
  };

  if (enabled === undefined) return null;
  if (!enabled)
    return (
      <div className="card" style={{ borderStyle: 'dashed' }}>
        <div className="row between">
          <span className="muted">
            <span className="badge ai" style={{ marginLeft: 0 }}>AI</span> Optional: let an AI model rewrite the steps to reproduce from your recorded actions and draft the analysis.
          </span>
          <button className="small" onClick={() => chrome.runtime.openOptionsPage()}>Set up in Settings</button>
        </div>
      </div>
    );

  // On-device model states that need the tester's attention (no key, no login involved)
  if (provider === 'chrome-builtin' && builtin && builtin !== 'available' && !a) {
    const canDownload = builtin === 'downloadable' || builtin === 'downloading';
    return (
      <div className="card" style={{ borderColor: 'var(--ai)' }}>
        <div className="row between">
          <b>
            <span className="badge ai" style={{ marginLeft: 0 }}>AI</span> Chrome built-in model
          </b>
          {canDownload ? (
            <button className="small primary" disabled={busy} onClick={download}>
              {busy ? `Downloading… ${progress !== undefined ? `${Math.round(progress * 100)}%` : ''}` : 'Download model (one time, ≈2 GB)'}
            </button>
          ) : (
            <button className="small" onClick={() => chrome.runtime.openOptionsPage()}>Choose another provider</button>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {builtin === 'unsupported' && 'This browser does not expose Chrome’s built-in AI (needs Chrome 138 or newer). Switch to Groq’s free tier in Settings; it takes one API key.'}
          {builtin === 'unavailable' && 'This device cannot run the built-in model (disk or hardware requirements). Switch to Groq’s free tier in Settings; it takes one API key.'}
          {canDownload && 'Chrome downloads Gemini Nano once; afterwards suggestions are generated on this machine with no account and nothing sent anywhere.'}
        </p>
        {err && <p className="err">{err}</p>}
      </div>
    );
  }

  const applied = new Set(draft.aiApplied ?? []);
  const field = (key: 'summary' | 'stepsToReproduce' | 'expectedResult' | 'actualResult', title: string, body: string | undefined) =>
    body ? (
      <div style={{ marginTop: 8 }}>
        <div className="row between">
          <b>{title}</b>
          <button className="small" disabled={busy || applied.has(key)} onClick={() => applyFields([key])}>
            {applied.has(key) ? 'Applied' : 'Apply'}
          </button>
        </div>
        <pre style={{ maxHeight: 160, marginTop: 4 }}>{body}</pre>
      </div>
    ) : null;

  return (
    <div className="card" style={{ borderColor: 'var(--ai)' }}>
      <div className="row between">
        <b>
          <span className="badge ai" style={{ marginLeft: 0 }}>AI</span> {a ? `Suggestions from ${a.provider}/${a.model}` : 'AI suggestions'}
          {a && <span className="badge">{a.confidence} confidence</span>}
        </b>
        <span className="row" style={{ gap: 6 }}>
          <button className="small" onClick={showSentPayload} title="Exactly what is sent to the AI provider (redacted, no headers, no cookies, no screenshots)">
            {showSent ? 'Hide what is sent' : 'What is sent?'}
          </button>
          <button className="small primary" disabled={busy} onClick={run}>
            {busy ? 'Analysing…' : a ? 'Re-run' : 'Enhance with AI'}
          </button>
        </span>
      </div>
      {err && <p className="err">{err}</p>}
      {showSent && <pre style={{ maxHeight: 240 }}>{JSON.stringify(sent, null, 2)}</pre>}
      {a && (
        <>
          <p className="muted" style={{ marginTop: 6 }}>AI output is a suggestion. Captured facts above are unchanged until you click Apply; applied fields are marked in the bug and in the description.</p>
          {field('stepsToReproduce', 'Steps to reproduce (from your recorded actions)', a.stepsToReproduce?.map((s, i) => `${i + 1}. ${s}`).join('\n'))}
          {field('summary', 'Summary', a.summary)}
          {field('expectedResult', 'Expected result', a.expectedResult)}
          {field('actualResult', 'Actual result', a.actualResult)}
          {a.technicalAnalysis && (
            <div style={{ marginTop: 8 }}>
              <b>Technical analysis</b> <span className="muted">(goes into the description as an "AI analysis" section)</span>
              <pre style={{ maxHeight: 160, marginTop: 4 }}>{a.technicalAnalysis}{a.possibleComponent ? `\n\nPossible component: ${a.possibleComponent}` : ''}</pre>
            </div>
          )}
          {a.caveats.length > 0 && (
            <ul className="muted" style={{ margin: '6px 0 0 16px', padding: 0 }}>
              {a.caveats.map((c, i) => (
                <li key={i}>⚠ {c}</li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="small" disabled={busy || applied.size >= 4} onClick={() => applyFields(['stepsToReproduce', 'summary', 'expectedResult', 'actualResult'])}>
              Apply all
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EvidenceTab({ ctx, incident, onPatch, onIncident }: { ctx: BugContext; incident: Incident; onPatch: (p: import('../../src/messages').IncidentPatch) => void; onIncident: (i: Incident) => void }) {
  const [shot, setShot] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [videos, setVideos] = useState<{ id: string; name: string; url: string; range?: { start: number; end: number } }[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  useEffect(() => {
    const a = ctx.artifacts.find((x) => x.kind === 'screenshot');
    if (a) void sendRuntime<{ dataUrl: string } | undefined>({ type: 'tl:get-blob', blobId: a.storage.ref }).then((b) => setShot(b?.dataUrl));
    // video segments are read straight from IndexedDB (same extension origin) to avoid base64 round-trips of large blobs
    const vids = ctx.artifacts.filter((x) => x.kind === 'video');
    let urls: string[] = [];
    void Promise.all(vids.map(async (v) => ({ v, blob: await getBlob(v.storage.ref) }))).then((rows) => {
      const out = rows.filter((r) => r.blob).map((r) => ({ id: r.v.id, name: r.v.fileName, url: URL.createObjectURL(r.blob!), range: r.v.timeRange }));
      urls = out.map((o) => o.url);
      setVideos(out);
    });
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [ctx.artifacts]);

  const items = ctx.evidence?.items ?? [];
  const visible = showAll ? items : items.filter((i) => i.include || i.score >= 15);
  const labelFor = (it: EvidenceItem) => {
    switch (it.kind) {
      case 'exchange': {
        const e = ctx.exchanges.find((x) => x.id === it.refId);
        return e ? `${e.error ? `ERR ${e.error.kind}` : e.response?.status ?? '-'} ${e.method} ${shortUrl(e.url)}${e.timing ? ` · ${Math.round(e.timing.totalMs)}ms` : ''} · body:${e.bodyCapture.response}` : it.refId;
      }
      case 'console': {
        const c = ctx.console.find((x) => x.id === it.refId);
        return c ? `console.${c.level} ${c.args.join(' ').slice(0, 120)}` : it.refId;
      }
      case 'error': {
        const e = ctx.errors.find((x) => x.id === it.refId);
        return e ? `${e.kind} ${e.message.slice(0, 120)}` : it.refId;
      }
      case 'interaction': {
        const i = ctx.interactions.find((x) => x.id === it.refId);
        return i ? `${i.kind} ${i.target.text ?? i.target.selector}` : it.refId;
      }
      case 'navigation': {
        const n = ctx.navigation.find((x) => x.id === it.refId);
        return n ? `${n.kind} → ${shortUrl(n.to)}` : it.refId;
      }
      default:
        return it.refId;
    }
  };
  const tsFor = (it: EvidenceItem) => ctx.timeline.find((t) => t.kind === it.kind && t.refId === it.refId)?.ts;

  const download = async (artifactId: string, fileName: string) => {
    const b = await sendRuntime<{ dataUrl: string } | undefined>({ type: 'tl:get-blob', blobId: artifactId });
    if (!b) return;
    const a = document.createElement('a');
    a.href = b.dataUrl;
    a.download = fileName;
    a.click();
  };

  const totalIncluded = ctx.artifacts.filter((a) => a.include).reduce((s, a) => s + a.bytes, 0);

  return (
    <>
      {ctx.evidence?.captureQuality.notes.length ? (
        <div className="card">
          <b>Capture quality {ctx.evidence.captureQuality.score}/100</b>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }} className="muted">
            {ctx.evidence.captureQuality.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      ) : null}

      <h2>Attachments ({fmtBytes(totalIncluded)} selected)</h2>
      <div className="list">
        {ctx.artifacts.map((a) => (
          <div key={a.id} className={`item ${a.include ? '' : 'off'}`}>
            <input type="checkbox" checked={a.include} onChange={(e) => onPatch({ artifactIncludes: { [a.id]: e.target.checked } })} />
            <div className="body">
              <div className="title">
                {a.fileName} <span className="badge">{a.kind}</span> <span className="badge">{fmtBytes(a.bytes)}</span>
                <span className={`badge ${a.redaction.status === 'redacted' ? 'ok' : a.redaction.status === 'unredacted' ? 'err' : ''}`}>{a.redaction.status}</span>
              </div>
            </div>
            <button className="small" onClick={() => download(a.storage.ref, a.fileName)}>↓</button>
          </div>
        ))}
      </div>
      {shot && !editing && (
        <div style={{ marginTop: 8 }}>
          <div className="row between" style={{ marginBottom: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>Screenshot at Report Issue</span>
            <button className="small" onClick={() => setEditing(true)} disabled={Boolean(createdOf(incident))} title="Draw boxes, arrows and notes; pixelate sensitive data">
              ✎ Annotate
            </button>
          </div>
          <img className="shot" src={shot} alt="screenshot" />
        </div>
      )}
      {shot && editing && (
        <div style={{ marginTop: 8 }}>
          <MarkupEditor
            src={shot}
            onCancel={() => setEditing(false)}
            onSave={async (dataUrl) => {
              try {
                const inc = await sendRuntime<Incident>({ type: 'tl:update-screenshot', incidentId: incident.incidentId, dataUrl });
                onIncident(inc);
              } finally {
                setEditing(false);
              }
            }}
          />
        </div>
      )}
      {videos.length > 0 && (
        <>
          <h2>Tab recording ({videos.length} segment{videos.length > 1 ? 's' : ''})</h2>
          {videos.map((v) => (
            <RewindPlayer key={v.id} video={v} ctx={ctx} />
          ))}
        </>
      )}
      {incident.context?.redaction.counts && Object.keys(incident.context.redaction.counts).length > 0 && (
        <p className="muted">
          Redacted {Object.values(incident.context.redaction.counts).reduce((a, b) => a + b, 0)} value(s): {Object.entries(incident.context.redaction.counts).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ')}
        </p>
      )}

      <h2>Evidence items ({items.filter((i) => i.include).length} of {items.length} selected)</h2>
      <label className="inline">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show low-relevance items
      </label>
      <div className="list">
        {visible.map((it) => {
          const key = `${it.kind}:${it.refId}`;
          const ex = it.kind === 'exchange' ? ctx.exchanges.find((x) => x.id === it.refId) : undefined;
          const open = expanded === key;
          return (
            <div key={key} className={`item ${it.include ? '' : 'off'} ${ctx.evidence?.focal?.refId === it.refId ? 'focal' : ''}`} style={{ flexWrap: 'wrap' }}>
              <input type="checkbox" checked={it.include} onChange={(e) => onPatch({ itemIncludes: { [key]: e.target.checked } })} />
              <div className="body" style={{ cursor: ex ? 'pointer' : 'default' }} onClick={() => ex && setExpanded(open ? undefined : key)}>
                <div className="title mono">
                  <span className="muted">{tsFor(it) ? rel(tsFor(it)!, ctx.trigger.at) : ''}</span> {labelFor(it)}
                  {ex && <span className="badge">{open ? '▾ hide' : '▸ details'}</span>}
                </div>
                <div className="reasons">[{it.score}] {it.reasons.join(' · ')}</div>
              </div>
              {ex && open && <ExchangeDetail ex={ex} />}
            </div>
          );
        })}
      </div>
      {ctx.evidence?.observations.length ? (
        <>
          <h2>Observations</h2>
          <ul style={{ margin: '0 0 0 16px', padding: 0 }}>{ctx.evidence.observations.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Full request/response view for one exchange; correlation ids are highlighted wherever they appear. */
function ExchangeDetail({ ex }: { ex: import('@testlens/schema').HttpExchange }) {
  const corrHeaders = new Set(ex.correlationIds.map((c) => c.header.toLowerCase()));
  const corrValues = ex.correlationIds.map((c) => c.value).filter(Boolean);
  const hl = (text: string) => {
    if (!corrValues.length) return text;
    const parts = text.split(new RegExp(`(${corrValues.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g'));
    return parts.map((p, i) => (corrValues.includes(p) ? <mark key={i}>{p}</mark> : p));
  };
  const headers = (hs: { name: string; value: string }[]) =>
    hs.length ? (
      <table className="mono" style={{ fontSize: 11 }}>
        <tbody>
          {hs.map((h, i) => (
            <tr key={i} className={corrHeaders.has(h.name.toLowerCase()) ? 'corr' : ''}>
              <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{h.name}</td>
              <td style={{ wordBreak: 'break-all' }}>{hl(h.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <span className="muted">none captured</span>
    );
  const body = (b: import('@testlens/schema').Body | undefined, status: string) =>
    b && b.encoding !== 'base64' ? <pre style={{ maxHeight: 220 }}>{hl(pretty(b.data))}{b.truncated ? '\n… truncated' : ''}</pre> : <span className="muted">&lt;{status}&gt;</span>;
  return (
    <div style={{ flexBasis: '100%', marginTop: 6, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
      <div className="mono" style={{ wordBreak: 'break-all' }}>
        {ex.method} {hl(ex.url)}
        {ex.timing && <span className="badge">{Math.round(ex.timing.totalMs)} ms</span>}
        {ex.error && <span className="badge err">{ex.error.kind}{ex.error.message ? `: ${ex.error.message}` : ''}</span>}
      </div>
      {ex.correlationIds.length > 0 && (
        <div style={{ margin: '4px 0' }}>
          correlation: {ex.correlationIds.map((c) => <span key={c.header + c.value} className="mono"><mark>{c.header}={c.value}</mark>{' '}</span>)}
        </div>
      )}
      <h3>Request headers</h3>
      {headers(ex.request.headers)}
      <h3>Request payload <span className="badge">{ex.bodyCapture.request}</span></h3>
      {body(ex.request.body, ex.bodyCapture.request)}
      <h3>Response headers {ex.response && <span className="badge">{ex.response.status}</span>}</h3>
      {headers(ex.response?.headers ?? [])}
      <h3>Response body <span className="badge">{ex.bodyCapture.response}</span></h3>
      {body(ex.response?.body, ex.bodyCapture.response)}
      {ex.initiator?.stack && (
        <>
          <h3>Initiator</h3>
          <pre style={{ maxHeight: 120 }}>{ex.initiator.stack}</pre>
        </>
      )}
    </div>
  );
}

function pretty(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------

/**
 * Video player with "rewind to failure" markers: every failed request, JavaScript error and the
 * Report Issue moment that fall inside the recording are marked on a bar under the player and
 * listed as chips. Clicking one seeks straight to that moment.
 */
function RewindPlayer({ video, ctx }: { video: { id: string; name: string; url: string; range?: { start: number; end: number } }; ctx: BugContext }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState<number>();
  const range = video.range;
  const spanMs = range ? range.end - range.start : 0;

  type Marker = { ts: number; kind: 'fail' | 'error' | 'trigger'; label: string };
  const markers: Marker[] = useMemo(() => {
    if (!range) return [];
    const inRange = (ts: number) => ts >= range.start && ts <= range.end;
    const out: Marker[] = [];
    for (const e of ctx.exchanges) {
      if (e.classification.isTelemetry) continue;
      const failed = e.error || (e.response && e.response.status >= 400);
      if (failed && inRange(e.ts)) out.push({ ts: e.ts, kind: 'fail', label: `${e.error ? `ERR ${e.error.kind}` : e.response!.status} ${e.method} ${shortUrl(e.url)}` });
    }
    for (const er of ctx.errors) if ((er.kind === 'uncaught' || er.kind === 'unhandledrejection') && inRange(er.ts)) out.push({ ts: er.ts, kind: 'error', label: `${er.kind === 'uncaught' ? 'JS error' : 'Rejection'}: ${er.message.slice(0, 60)}` });
    if (inRange(ctx.trigger.at)) out.push({ ts: ctx.trigger.at, kind: 'trigger', label: 'Report Issue clicked' });
    return out.sort((a, b) => a.ts - b.ts);
  }, [ctx, range]);

  /** Map a wall-clock moment to a position in the file; the file may be shorter than the range, so scale. */
  const toSec = (ts: number) => {
    if (!range) return 0;
    const fileDur = dur && Number.isFinite(dur) ? dur : spanMs / 1000;
    return Math.max(0, Math.min(fileDur - 0.05, ((ts - range.start) / spanMs) * fileDur));
  };
  const seek = (ts: number) => {
    const el = ref.current;
    if (!el) return;
    // land ~1.5 s before the failure so the viewer sees what led to it
    el.currentTime = Math.max(0, toSec(ts) - 1.5);
    void el.play().catch(() => undefined);
  };
  const focalTs = (() => {
    const f = ctx.evidence?.focal;
    if (!f) return undefined;
    return ctx.timeline.find((t) => t.kind === f.kind && t.refId === f.refId)?.ts;
  })();

  return (
    <div style={{ marginBottom: 10 }} className="vwrap">
      <div className="row between">
        <div className="muted mono" style={{ fontSize: 11 }}>
          {video.name}
          {range ? ` · ${rel(range.start, ctx.trigger.at)} → ${rel(range.end, ctx.trigger.at)}` : ''}
        </div>
        {focalTs !== undefined && range && focalTs >= range.start && focalTs <= range.end && (
          <button className="small primary" onClick={() => seek(focalTs)} title="Jump to the moment of the focal failure">
            ⏪ Rewind to failure
          </button>
        )}
      </div>
      <video
        ref={ref}
        controls
        preload="metadata"
        src={video.url}
        style={{ width: '100%', borderRadius: 6, border: '1px solid var(--line)', background: '#000' }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
      />
      {range && markers.length > 0 && (
        <>
          <div className="vbar" title="Failures in this recording — click to jump">
            {markers.map((m, i) => (
              <span key={i} className={`mk ${m.kind}`} style={{ left: `${((m.ts - range.start) / spanMs) * 100}%` }} title={`${rel(m.ts, ctx.trigger.at)} ${m.label}`} onClick={() => seek(m.ts)} />
            ))}
            {dur ? <span className="pos" style={{ left: `${Math.min(100, (pos / dur) * 100)}%` }} /> : null}
          </div>
          <div className="chips">
            {markers
              .filter((m) => m.kind !== 'trigger')
              .slice(0, 12)
              .map((m, i) => (
                <button key={i} className={`small ${m.kind}`} onClick={() => seek(m.ts)} title={m.label}>
                  {rel(m.ts, ctx.trigger.at)} {m.label.length > 38 ? `${m.label.slice(0, 37)}…` : m.label}
                </button>
              ))}
          </div>
        </>
      )}
      {range && markers.length === 0 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>No failed requests or errors fall inside this recording.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TrackerTab({ incident, setIncident, onPatch }: { incident: Incident; setIncident: (i: Incident) => void; onPatch: (p: import('../../src/messages').IncidentPatch) => void }) {
  const [configured, setConfigured] = useState<boolean>();
  const [preview, setPreview] = useState<TrackerPreview>();
  const [similar, setSimilar] = useState<{ key: string; summary: string; url: string; status: string }[]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [projects, setProjects] = useState<ProjectRef[]>();
  const [types, setTypes] = useState<IssueTypeRef[]>();
  const [fields, setFields] = useState<FieldSchema[]>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [loadingDest, setLoadingDest] = useState(false);
  const [trackerId, setTrackerId] = useState<string>();

  const refresh = useCallback(async () => {
    setErr(undefined);
    const s = await loadSettings();
    const ok = Boolean(s.tracker?.trackerId && s.tracker.token);
    setConfigured(ok);
    setTrackerId(s.tracker?.trackerId);
    if (!ok) return;
    try {
      const p = await sendRuntime<TrackerPreview>({ type: 'tl:tracker-preview', incidentId: incident.incidentId });
      setPreview(p);
      setFields(p.fields);
      setValues(stringValues(p.target.fields));
      void sendRuntime<typeof similar>({ type: 'tl:tracker-similar', incidentId: incident.incidentId }).then(setSimilar).catch(() => undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEditing(true);
      void loadProjects();
    }
  }, [incident.incidentId]);

  useEffect(() => {
    void refresh();
  }, [refresh, incident.draft, incident.context?.artifacts, incident.jiraTarget]);

  const loadProjects = async () => {
    if (projects) return;
    setLoadingDest(true);
    try {
      setProjects(await sendRuntime<ProjectRef[]>({ type: 'tl:tracker-projects' }));
      if (preview) setTypes(await sendRuntime<IssueTypeRef[]>({ type: 'tl:tracker-issue-types', projectKey: preview.projectKey }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDest(false);
    }
  };

  const startEditing = async () => {
    setEditing(true);
    await loadProjects();
  };

  const applyTarget = async (projectKey: string, projectName: string | undefined, issueTypeId: string, issueTypeName: string | undefined, nextValues: Record<string, string>, f: FieldSchema[], saveAsDefault = false) => {
    setBusy(true);
    try {
      const target = { trackerId: trackerId!, projectKey, projectName, issueTypeId, issueTypeName, fields: buildMappingFields(nextValues, f) };
      const inc = await sendRuntime<Incident>({ type: 'tl:set-tracker-target', incidentId: incident.incidentId, target, saveAsDefault });
      setIncident(inc);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeProject = async (projectKey: string) => {
    if (!projectKey) return;
    setLoadingDest(true);
    try {
      const t = await sendRuntime<IssueTypeRef[]>({ type: 'tl:tracker-issue-types', projectKey });
      setTypes(t);
      const bug = t.find((x) => !x.subtask && /^bug$/i.test(x.name)) ?? t.find((x) => !x.subtask);
      if (bug) await changeType(projectKey, bug.id, t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDest(false);
    }
  };

  const changeType = async (projectKey: string, issueTypeId: string, typeList = types) => {
    if (!issueTypeId) return;
    setLoadingDest(true);
    try {
      const f = await sendRuntime<FieldSchema[]>({ type: 'tl:tracker-fields', projectKey, issueTypeId });
      setFields(f);
      const s = await loadSettings();
      const base = s.tracker && s.tracker.projectKey === projectKey && s.tracker.issueTypeId === issueTypeId ? stringValues(s.tracker.mapping.fields) : {};
      const next = withDefaults(base, f);
      setValues(next);
      await applyTarget(projectKey, projects?.find((p) => p.key === projectKey)?.name, issueTypeId, typeList?.find((x) => x.id === issueTypeId)?.name, next, f);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDest(false);
    }
  };

  const changeValue = (key: string, v: string) => {
    const next = { ...values, [key]: v };
    setValues(next);
    if (preview && fields) void applyTarget(preview.projectKey, preview.projectName, preview.issueTypeId, preview.issueTypeName, next, fields);
  };

  const resetToDefault = async () => {
    setBusy(true);
    try {
      setIncident(await sendRuntime<Incident>({ type: 'tl:set-tracker-target', incidentId: incident.incidentId, target: undefined }));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const saveAsDefault = async () => {
    if (!preview || !fields) return;
    await applyTarget(preview.projectKey, preview.projectName, preview.issueTypeId, preview.issueTypeName, values, fields, true);
  };

  const create = async () => {
    if (!confirm(`Create this issue in ${preview?.descriptor.displayName ?? 'the tracker'} now? Review the preview first; this cannot be undone from TestLens.`)) return;
    setBusy(true);
    setErr(undefined);
    try {
      const inc = await sendRuntime<Incident>({ type: 'tl:tracker-create', incidentId: incident.incidentId });
      setIncident(inc);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (configured === false)
    return (
      <div className="card">
        <p>No bug tracker is connected.</p>
        <button className="primary" onClick={() => chrome.runtime.openOptionsPage()}>Connect a tracker in Settings</button>
      </div>
    );
  if (!preview && !err) return <p><span className="spinner" /> Preparing preview…</p>;

  const d = preview?.descriptor;
  const payloadFields = preview ? ((preview.payload as { fields?: Record<string, unknown> }).fields ?? (preview.payload as Record<string, unknown>)) : {};
  const required = fields ? requiredFields(fields) : [];
  const optional = fields ? optionalFieldsWithValues(fields) : [];
  const createdIssue = createdOf(incident);
  const created = Boolean(createdIssue);
  const containerLabel = d?.containerLabel ?? 'Project';
  const destLabel = preview ? `${preview.projectName && preview.projectName !== preview.projectKey ? preview.projectName : preview.projectKey} · ${preview.issueTypeName ?? 'issue'}` : `Choose a ${containerLabel.toLowerCase()}`;

  return (
    <>
      {err && <div className="card err">{err}</div>}

      <div className="card">
        <div className="row between">
          <b>
            {d && <span className="badge" style={{ marginLeft: 0, marginRight: 6 }}>{d.displayName}</span>}
            {destLabel}
            {preview && <span className="badge">{preview.isDefault ? 'default from settings' : 'changed for this bug'}</span>}
          </b>
          <span className="row" style={{ gap: 6 }}>
            {preview && (preview.validation.ok ? <span className="badge ok">ready</span> : <span className="badge err">{preview.validation.problems.length} problem(s)</span>)}
            {!created && !editing && <button className="small" onClick={startEditing}>Change</button>}
          </span>
        </div>

        {editing && !created && (
          <div style={{ marginTop: 8 }}>
            {loadingDest && <p className="muted"><span className="spinner" /> Loading from {d?.displayName ?? 'tracker'}…</p>}
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label>{containerLabel}</label>
                <select value={preview?.projectKey ?? ''} disabled={!projects || busy} onChange={(e) => void changeProject(e.target.value)}>
                  {!projects && <option value={preview?.projectKey ?? ''}>{preview?.projectName ?? preview?.projectKey ?? '…'}</option>}
                  {projects && <option value="">— select —</option>}
                  {projects?.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key === p.name ? p.name : `${p.key} — ${p.name}`}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label>{d?.typeLabel ?? 'Issue type'}</label>
                <select value={preview?.issueTypeId ?? ''} disabled={!types || busy} onChange={(e) => preview && void changeType(preview.projectKey, e.target.value)}>
                  {!types && <option value={preview?.issueTypeId ?? ''}>{preview?.issueTypeName ?? '…'}</option>}
                  {types?.filter((x) => !x.subtask).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {required.length > 0 && (
              <>
                <h3 style={{ marginBottom: 0 }}>Required fields</h3>
                <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                  {required.map((f) => (
                    <FieldControl key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => changeValue(f.key, v)} compact />
                  ))}
                </div>
              </>
            )}
            {optional.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary className="muted">Optional fields ({optional.map((f) => f.name).slice(0, 3).join(', ')}{optional.length > 3 ? '…' : ''})</summary>
                <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                  {optional.map((f) => (
                    <FieldControl key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => changeValue(f.key, v)} allowEmpty compact />
                  ))}
                </div>
              </details>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="small" onClick={() => setEditing(false)}>Done</button>
              <button className="small" onClick={saveAsDefault} disabled={busy || !preview} title="Use this destination and field values for future bugs too">Save as default</button>
              {preview && !preview.isDefault && <button className="small" onClick={resetToDefault} disabled={busy}>Back to default</button>}
            </div>
          </div>
        )}

        {preview && !preview.validation.ok && (
          <ul className="err" style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {preview.validation.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        )}
      </div>

      {preview && (
        <>
          {similar && similar.length > 0 && (
            <div className="card warn">
              <b>Possibly related open issues</b>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {similar.map((s) => (
                  <li key={s.key}>
                    <a href={s.url} target="_blank" rel="noreferrer">{s.key}</a> {s.summary} <span className="badge">{s.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2>Preview</h2>
          <div className="card">
            <b>{String(payloadFields.summary ?? payloadFields.title ?? payloadFields['System.Title'] ?? '')}</b>
            <pre style={{ maxHeight: 400 }}>{preview.descriptionText}</pre>
            <div className="muted">
              Fields:{' '}
              {Object.keys(payloadFields)
                .filter((k) => !['summary', 'title', 'description', 'body', 'project', 'issuetype', 'teamId', 'System.Title', 'System.Description', 'Microsoft.VSTS.TCM.ReproSteps'].includes(k))
                .map((k) => `${fields?.find((f) => f.key === k)?.name ?? k}=${JSON.stringify(payloadFields[k])}`)
                .join(', ') || 'none beyond title/description'}
            </div>
          </div>

          <h2>Attachments — tick what goes into the bug</h2>
          {d?.attachments === 'none' && <p className="warn">{d.displayName} does not accept attachments through its API. Files stay downloadable on the Evidence tab; the description notes this.</p>}
          <table>
            <tbody>
              {preview.attachments.map((a) => (
                <tr key={a.id} className={a.include ? '' : 'muted'}>
                  <td style={{ width: 28 }}>
                    <input type="checkbox" checked={a.include} disabled={created} onChange={(e) => onPatch({ artifactIncludes: { [a.id]: e.target.checked } })} />
                  </td>
                  <td>{a.fileName}</td>
                  <td>{fmtBytes(a.bytes)}</td>
                  <td className="err">{a.include && a.tooLarge && d?.attachments !== 'none' ? `exceeds ${fmtBytes(preview.limits.maxAttachmentBytes)} limit — will be skipped` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 4 }}>
            Selected: {preview.attachments.filter((a) => a.include).length} of {preview.attachments.length} ({fmtBytes(preview.attachments.filter((a) => a.include).reduce((n, a) => n + a.bytes, 0))}). Defaults come from Settings → Capture → Default attachments.
          </p>

          <label className="inline" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={showPayload} onChange={(e) => setShowPayload(e.target.checked)} /> show raw API payload
          </label>
          {showPayload && <pre>{JSON.stringify(preview.payload, null, 2)}</pre>}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || !preview.validation.ok || created} onClick={create} style={{ flex: 1 }}>
              {created ? `Created ${createdIssue!.key}` : busy ? 'Working…' : `Create in ${preview.projectName && preview.projectName !== preview.projectKey ? preview.projectName : preview.projectKey}`}
            </button>
            <button onClick={refresh} disabled={busy}>Refresh</button>
          </div>
          <p className="muted">Nothing is sent to {d?.displayName ?? 'the tracker'} until you click Create.</p>
        </>
      )}
    </>
  );
}

/** Created-issue record, tolerating incidents stored by Jira-only builds. */
function createdOf(i: Pick<Incident, 'created' | 'jira'>): { key: string; url: string; attachments: { fileName: string; ok: boolean; error?: string }[] } | undefined {
  return i.created ?? i.jira;
}

// ---------------------------------------------------------------------------

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.pathname + (x.search.length > 40 ? x.search.slice(0, 40) + '…' : x.search);
  } catch {
    return u;
  }
}
function fmtBytes(b: number) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
function rel(ts: number, t0: number) {
  const d = (ts - t0) / 1000;
  return `${d <= 0 ? '-' : '+'}${Math.abs(d).toFixed(1)}s`;
}

createRoot(document.getElementById('root')!).render(<App />);
