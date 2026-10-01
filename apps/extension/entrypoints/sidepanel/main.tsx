import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/base.css';
import type { BugContext, BugDraft, EvidenceItem, FocalEvent } from '@testlens/schema';
import type { StoredIncident } from '../../src/buffer/db';
import type { JiraPreview } from '../../src/jira';
import { sendRuntime } from '../../src/messages';
import { loadSettings } from '../../src/settings';

type Incident = StoredIncident;

function App() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [incident, setIncident] = useState<Incident>();
  const [error, setError] = useState<string>();

  const refreshList = useCallback(async () => {
    setIncidents(await sendRuntime<Incident[]>({ type: 'tl:list-incidents' }));
  }, []);

  const load = useCallback(async (id: string) => {
    const inc = await sendRuntime<Incident | undefined>({ type: 'tl:get-incident', incidentId: id });
    setIncident(inc);
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshList();
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
      <div style={{ padding: 12 }}>
        <div className="row between">
          <h1>Incidents</h1>
          <button className="small" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
        </div>
        {!incidents.length && <p className="muted">No incidents yet. Click the TestLens icon on a monitored tab and choose “Report Issue”.</p>}
        <div className="list">
          {incidents.map((i) => (
            <div key={i.incidentId} className="item" style={{ cursor: 'pointer' }} onClick={() => setActiveId(i.incidentId)}>
              <div className="body">
                <div className="title">{i.draft?.summary ?? i.tab.title ?? i.tab.url}</div>
                <div className="reasons">
                  {new Date(i.triggerAt).toLocaleString()} · {i.status}
                  {i.jira?.key ? ` · ${i.jira.key}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
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
        <span className="muted mono">{incident.incidentId}</span>
      </div>
      <div className="row between" style={{ marginTop: 8 }}>
        <span className="muted">{new Date(incident.triggerAt).toLocaleString()}</span>
        {q && (
          <span className={`quality ${q.score >= 80 ? 'ok' : q.score >= 50 ? 'warn' : 'err'}`} title={q.notes.join('\n')}>
            capture {q.score}/100
          </span>
        )}
      </div>
      {incident.jira?.key && (
        <div className="card ok">
          Created <a href={incident.jira.url} target="_blank" rel="noreferrer">{incident.jira.key}</a>
          {incident.jira.attachments.some((a) => !a.ok) && (
            <div className="warn" style={{ marginTop: 4 }}>
              Some attachments failed: {incident.jira.attachments.filter((a) => !a.ok).map((a) => `${a.fileName} (${a.error})`).join('; ')}
            </div>
          )}
        </div>
      )}

      <div className="tabs" style={{ marginTop: 10 }}>
        <button className={tab === 'bug' ? 'active' : ''} onClick={() => setTab('bug')}>Bug</button>
        <button className={tab === 'evidence' ? 'active' : ''} onClick={() => setTab('evidence')}>Evidence</button>
        <button className={tab === 'jira' ? 'active' : ''} onClick={() => setTab('jira')}>Jira</button>
      </div>

      {tab === 'bug' && <BugTab ctx={ctx} draft={draft} incident={incident} onPatch={patch} onRerun={(f) => run('rerun', async () => setIncident(await sendRuntime<Incident>({ type: 'tl:rerun-engine', incidentId: incident.incidentId, focal: f })))} />}
      {tab === 'evidence' && <EvidenceTab ctx={ctx} incident={incident} onPatch={patch} />}
      {tab === 'jira' && <JiraTab incident={incident} setIncident={setIncident} />}

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

function BugTab({ ctx, draft, incident, onPatch, onRerun }: { ctx: BugContext; draft: BugDraft; incident: Incident; onPatch: (p: import('../../src/messages').IncidentPatch) => void; onRerun: (f?: { kind: FocalEvent['kind']; refId: string }) => void }) {
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

      <label>Summary</label>
      <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
      <label>Steps to reproduce (one per line) <span className="badge derived">derived from your clicks and navigation</span></label>
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

function EvidenceTab({ ctx, incident, onPatch }: { ctx: BugContext; incident: Incident; onPatch: (p: import('../../src/messages').IncidentPatch) => void }) {
  const [shot, setShot] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const a = ctx.artifacts.find((x) => x.kind === 'screenshot');
    if (!a) return;
    void sendRuntime<{ dataUrl: string } | undefined>({ type: 'tl:get-blob', blobId: a.storage.ref }).then((b) => setShot(b?.dataUrl));
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
      {shot && <img className="shot" src={shot} alt="screenshot" style={{ marginTop: 8 }} />}
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
        {visible.map((it) => (
          <div key={`${it.kind}:${it.refId}`} className={`item ${it.include ? '' : 'off'} ${ctx.evidence?.focal?.refId === it.refId ? 'focal' : ''}`}>
            <input type="checkbox" checked={it.include} onChange={(e) => onPatch({ itemIncludes: { [`${it.kind}:${it.refId}`]: e.target.checked } })} />
            <div className="body">
              <div className="title mono">
                <span className="muted">{tsFor(it) ? rel(tsFor(it)!, ctx.trigger.at) : ''}</span> {labelFor(it)}
              </div>
              <div className="reasons">[{it.score}] {it.reasons.join(' · ')}</div>
            </div>
          </div>
        ))}
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

function JiraTab({ incident, setIncident }: { incident: Incident; setIncident: (i: Incident) => void }) {
  const [configured, setConfigured] = useState<boolean>();
  const [preview, setPreview] = useState<JiraPreview>();
  const [similar, setSimilar] = useState<{ key: string; summary: string; url: string; status: string }[]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showPayload, setShowPayload] = useState(false);

  const refresh = useCallback(async () => {
    setErr(undefined);
    const s = await loadSettings();
    const ok = Boolean(s.jira?.baseUrl && s.jira.email && s.jira.token && s.jira.projectKey && s.jira.issueTypeId);
    setConfigured(ok);
    if (!ok) return;
    try {
      setPreview(await sendRuntime<JiraPreview>({ type: 'tl:jira-preview', incidentId: incident.incidentId }));
      void sendRuntime<typeof similar>({ type: 'tl:jira-similar', incidentId: incident.incidentId }).then(setSimilar).catch(() => undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [incident.incidentId]);

  useEffect(() => {
    void refresh();
  }, [refresh, incident.draft, incident.context?.artifacts]);

  const create = async () => {
    if (!confirm('Create this issue in Jira now? Review the preview first; this cannot be undone from TestLens.')) return;
    setBusy(true);
    setErr(undefined);
    try {
      const inc = await sendRuntime<Incident>({ type: 'tl:jira-create', incidentId: incident.incidentId });
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
        <p>Jira is not connected.</p>
        <button className="primary" onClick={() => chrome.runtime.openOptionsPage()}>Connect Jira in Settings</button>
      </div>
    );
  if (!preview && !err) return <p><span className="spinner" /> Preparing Jira preview…</p>;

  const fields = preview ? (preview.payload as { fields: Record<string, unknown> }).fields : {};
  const descText = preview ? adfToText(fields.description) : '';

  return (
    <>
      {err && <div className="card err">{err}</div>}
      {preview && (
        <>
          <div className="card">
            <div className="row between">
              <b>{preview.projectKey} · {preview.issueTypeName ?? 'issue'}</b>
              {preview.validation.ok ? <span className="badge ok">ready</span> : <span className="badge err">{preview.validation.problems.length} problem(s)</span>}
            </div>
            {!preview.validation.ok && (
              <ul className="err" style={{ margin: '6px 0 0 16px', padding: 0 }}>
                {preview.validation.problems.map((p, i) => <li key={i}>{p.message}</li>)}
              </ul>
            )}
          </div>

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
            <b>{String(fields.summary ?? '')}</b>
            <pre style={{ maxHeight: 400 }}>{descText}</pre>
            <div className="muted">
              Fields: {Object.keys(fields).filter((k) => !['summary', 'description', 'project', 'issuetype'].includes(k)).map((k) => `${k}=${JSON.stringify(fields[k])}`).join(', ') || 'none beyond summary/description'}
            </div>
          </div>

          <h2>Attachments</h2>
          <table>
            <tbody>
              {preview.attachments.map((a) => (
                <tr key={a.id} className={a.include ? '' : 'muted'}>
                  <td>{a.include ? '✓' : '–'}</td>
                  <td>{a.fileName}</td>
                  <td>{fmtBytes(a.bytes)}</td>
                  <td className="err">{a.include && a.tooLarge ? `exceeds ${fmtBytes(preview.limits.maxAttachmentBytes)} limit — will be skipped` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="inline" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={showPayload} onChange={(e) => setShowPayload(e.target.checked)} /> show raw API payload
          </label>
          {showPayload && <pre>{JSON.stringify(preview.payload, null, 2)}</pre>}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || !preview.validation.ok || Boolean(incident.jira?.key)} onClick={create} style={{ flex: 1 }}>
              {incident.jira?.key ? `Created ${incident.jira.key}` : busy ? 'Creating…' : 'Create Jira issue'}
            </button>
            <button onClick={refresh} disabled={busy}>Refresh</button>
          </div>
          <p className="muted">Nothing is sent to Jira until you click Create.</p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function adfToText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: { type: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> }, depth = 0) => {
    if (n.type === 'text') out.push(n.text ?? '');
    const kids = (n.content ?? []) as typeof n[];
    if (n.type === 'heading') out.push('\n## ');
    if (n.type === 'listItem') out.push('\n • ');
    if (n.type === 'codeBlock') out.push('\n```\n');
    for (const k of kids) walk(k, depth + 1);
    if (n.type === 'codeBlock') out.push('\n```');
    if (n.type === 'paragraph' || n.type === 'heading') out.push('\n');
  };
  if (doc && typeof doc === 'object') walk(doc as Parameters<typeof walk>[0]);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
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
