import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/base.css';
import type { FieldSchema, IssueTypeRef, ProjectRef } from '@testlens/trackers-core';
import { sendRuntime } from '../../src/messages';
import { DEFAULT_SETTINGS, loadSettings, normalizeOriginInput, originsToMatchPatterns, saveSettings, type Settings } from '../../src/settings';
import { defaultMapping } from '../../src/jira';

function Options() {
  const [s, setS] = useState<Settings>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  useEffect(() => {
    void loadSettings().then(setS);
  }, []);
  if (!s) return null;

  const update = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const persist = async (next: Settings = s) => {
    await saveSettings(next);
    setS(next);
    setMsg({ kind: 'ok', text: 'Saved' });
    setTimeout(() => setMsg(undefined), 1500);
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
      <div className="row between">
        <h1>TestLens settings</h1>
        <span className="muted">v{chrome.runtime.getManifest().version}</span>
      </div>
      <p className="muted">
        TestLens is a flight recorder for testing. It keeps a rolling buffer of console, errors, network and interactions for the sites you choose, and turns the last 5 minutes into a reviewed Jira issue when you click “Report Issue”. Nothing leaves this machine until you click Create.
      </p>

      <MonitoringSection s={s} update={update} persist={persist} setMsg={setMsg} />
      <CaptureSection s={s} update={update} persist={persist} />
      <JiraSection s={s} update={update} persist={persist} setMsg={setMsg} />
      <PrivacySection s={s} update={update} persist={persist} />
      <TraceSection s={s} update={update} persist={persist} />
      <DataSection s={s} update={update} persist={persist} setMsg={setMsg} />

      {msg && <div className={`toast ${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}

type SectionProps = { s: Settings; update: (p: Partial<Settings>) => void; persist: (n?: Settings) => Promise<void>; setMsg?: (m: { kind: 'ok' | 'err'; text: string } | undefined) => void };

function MonitoringSection({ s, update, persist, setMsg }: SectionProps) {
  const [input, setInput] = useState('');
  const [granted, setGranted] = useState<string[]>([]);
  useEffect(() => {
    void chrome.permissions.getAll().then((p) => setGranted(p.origins ?? []));
  }, [s.monitoredOrigins]);

  const add = () => {
    const o = normalizeOriginInput(input);
    if (!o) return setMsg?.({ kind: 'err', text: 'Enter an origin like https://app.example.com or *.example.com' });
    if (!s.monitoredOrigins.includes(o)) update({ monitoredOrigins: [...s.monitoredOrigins, o] });
    setInput('');
  };
  const apply = async () => {
    const patterns = originsToMatchPatterns(s.monitoredOrigins);
    if (patterns.length) {
      const ok = await chrome.permissions.request({ origins: patterns });
      if (!ok) return setMsg?.({ kind: 'err', text: 'Permission not granted; monitoring not enabled for those origins' });
    }
    await persist({ ...s, onboarded: true });
    await sendRuntime({ type: 'tl:apply-monitoring' });
    setMsg?.({ kind: 'ok', text: 'Monitoring applied. Reload open tabs of these sites to start capturing.' });
  };
  const isGranted = (o: string) => granted.includes('<all_urls>') || originsToMatchPatterns([o]).every((p) => granted.includes(p));

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>1. Monitored sites</h2>
      <p className="muted">Add the application under test. If it calls APIs on a different origin (for example api.example.com), add that too so request bodies and headers are captured for it. Use “*.example.com” for all subdomains, or “*” to monitor everything (not recommended).</p>
      <div className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="https://app.example.com" style={{ flex: 1 }} />
        <button onClick={add}>Add</button>
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {s.monitoredOrigins.map((o) => (
          <div key={o} className="item">
            <div className="body mono">
              {o} {isGranted(o) ? <span className="badge ok">permission granted</span> : <span className="badge err">permission pending — click Apply</span>}
            </div>
            <input placeholder="app name (optional)" style={{ width: 180 }} value={s.appNames[o] ?? ''} onChange={(e) => update({ appNames: { ...s.appNames, [o]: e.target.value } })} />
            <button className="small danger" onClick={() => update({ monitoredOrigins: s.monitoredOrigins.filter((x) => x !== o) })}>remove</button>
          </div>
        ))}
        {!s.monitoredOrigins.length && <p className="muted">No sites yet.</p>}
      </div>
      <label>Environment name (added to every bug, e.g. QA, Staging)</label>
      <input value={s.environmentName} onChange={(e) => update({ environmentName: e.target.value })} style={{ maxWidth: 240 }} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={apply}>Apply monitoring</button>
      </div>
    </div>
  );
}

function CaptureSection({ s, update, persist }: SectionProps) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>2. Capture</h2>
      <div className="row" style={{ gap: 24 }}>
        <div>
          <label>Rolling window (minutes)</label>
          <input type="number" min={1} max={15} value={s.preWindowMs / 60000} onChange={(e) => update({ preWindowMs: Number(e.target.value) * 60000 })} style={{ width: 100 }} />
        </div>
        <div>
          <label>Post-click window (seconds)</label>
          <input type="number" min={0} max={60} value={s.postWindowMs / 1000} onChange={(e) => update({ postWindowMs: Number(e.target.value) * 1000 })} style={{ width: 100 }} />
        </div>
        <div>
          <label>Max body size (KB)</label>
          <input type="number" min={1} max={2048} value={Math.round(s.maxBodyBytes / 1024)} onChange={(e) => update({ maxBodyBytes: Number(e.target.value) * 1024 })} style={{ width: 100 }} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label className="inline"><input type="checkbox" checked={s.captureBodies} onChange={(e) => update({ captureBodies: e.target.checked })} /> Capture request/response bodies (fetch/XHR)</label>
        <label className="inline"><input type="checkbox" checked={s.domReplay} onChange={(e) => update({ domReplay: e.target.checked })} /> DOM replay recording (rrweb)</label>
        <label className="inline"><input type="checkbox" checked={s.maskAllInputs} onChange={(e) => update({ maskAllInputs: e.target.checked })} /> Mask all input values in replay</label>
      </div>
      <p className="muted">Video recording of the tab is planned for a later build; the DOM replay plus the screenshot at Report Issue cover the visual evidence in this version.</p>
      <button onClick={() => persist()}>Save</button>
    </div>
  );
}

function JiraSection({ s, update, persist, setMsg }: SectionProps) {
  const j = s.jira ?? { baseUrl: '', email: '', token: '', projectKey: '', issueTypeId: '', mapping: defaultMapping('', '') };
  const setJ = (p: Partial<typeof j>) => update({ jira: { ...j, ...p } });
  const [projects, setProjects] = useState<ProjectRef[]>();
  const [types, setTypes] = useState<IssueTypeRef[]>();
  const [fields, setFields] = useState<FieldSchema[]>();
  const [testing, setTesting] = useState(false);
  const [mappingText, setMappingText] = useState(JSON.stringify(j.mapping.fields, null, 2));
  const [who, setWho] = useState<string>();

  const connect = async () => {
    try {
      setTesting(true);
      const origin = `${new URL(j.baseUrl).origin}/*`;
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) throw new Error('Permission to call Jira was not granted');
      await persist({ ...s, jira: j });
      const me = await sendRuntime<{ displayName?: string }>({ type: 'tl:jira-test' });
      setWho(me.displayName);
      setProjects(await sendRuntime<ProjectRef[]>({ type: 'tl:jira-projects' }));
      setMsg?.({ kind: 'ok', text: `Connected as ${me.displayName}` });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };
  const loadTypes = async (projectKey: string) => {
    setJ({ projectKey, issueTypeId: '', issueTypeName: undefined });
    setTypes(await sendRuntime<IssueTypeRef[]>({ type: 'tl:jira-issue-types', projectKey }));
  };
  const loadFields = async (issueTypeId: string) => {
    const t = types?.find((x) => x.id === issueTypeId);
    const next = { ...j, issueTypeId, issueTypeName: t?.name, mapping: { ...j.mapping, projectKey: j.projectKey, issueTypeId } };
    update({ jira: next });
    setFields(await sendRuntime<FieldSchema[]>({ type: 'tl:jira-fields', projectKey: j.projectKey, issueTypeId }));
  };
  const saveJira = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(mappingText) as Record<string, unknown>;
    } catch {
      return setMsg?.({ kind: 'err', text: 'Field mapping is not valid JSON' });
    }
    await persist({ ...s, jira: { ...j, mapping: { ...j.mapping, projectKey: j.projectKey, issueTypeId: j.issueTypeId, fields: parsed } } });
  };
  const required = fields?.filter((f) => f.required && !f.hasDefault && !['project', 'issuetype', 'summary', 'description', 'reporter'].includes(f.key)) ?? [];

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>3. Jira Cloud</h2>
      <p className="muted">
        Uses your own Jira account via an API token, so issues are created as you. Create a token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">id.atlassian.com → API tokens</a>. The token is stored only in this browser profile.
      </p>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 2 }}>
          <label>Jira site URL</label>
          <input value={j.baseUrl} onChange={(e) => setJ({ baseUrl: e.target.value.trim() })} placeholder="https://yourcompany.atlassian.net" />
        </div>
        <div style={{ flex: 2 }}>
          <label>Email</label>
          <input value={j.email} onChange={(e) => setJ({ email: e.target.value.trim() })} placeholder="you@company.com" />
        </div>
        <div style={{ flex: 3 }}>
          <label>API token</label>
          <input type="password" value={j.token} onChange={(e) => setJ({ token: e.target.value.trim() })} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={connect} disabled={testing || !j.baseUrl || !j.email || !j.token}>{testing ? 'Connecting…' : 'Connect & load projects'}</button>
        {who && <span className="ok">Connected as {who}</span>}
      </div>

      {(projects || j.projectKey) && (
        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Project</label>
            {projects ? (
              <select value={j.projectKey} onChange={(e) => void loadTypes(e.target.value)}>
                <option value="">— select —</option>
                {projects.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
              </select>
            ) : (
              <input value={j.projectKey} readOnly />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label>Issue type</label>
            {types ? (
              <select value={j.issueTypeId} onChange={(e) => void loadFields(e.target.value)}>
                <option value="">— select —</option>
                {types.filter((t) => !t.subtask).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <input value={j.issueTypeName ?? j.issueTypeId} readOnly />
            )}
          </div>
        </div>
      )}

      {fields && (
        <div style={{ marginTop: 8 }}>
          {required.length > 0 ? (
            <p className="warn">This issue type has required fields without defaults: {required.map((f) => `${f.name} (${f.key})`).join(', ')}. Map them below or issue creation will fail.</p>
          ) : (
            <p className="ok">No extra required fields. Summary and description are enough.</p>
          )}
          <details>
            <summary className="muted">All create-screen fields ({fields.length})</summary>
            <table>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.key}>
                    <td className="mono">{f.key}</td>
                    <td>{f.name}{f.required ? ' *' : ''}</td>
                    <td className="muted">{f.type}{f.itemsType ? `<${f.itemsType}>` : ''}</td>
                    <td className="muted">{f.allowedValues?.slice(0, 6).map((v) => v.name).join(', ')}{(f.allowedValues?.length ?? 0) > 6 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      <label>Field mapping (JSON). Values: "$labels", "$summary", "$description", or templates like "{'{{'}draft.environmentSummary{'}}'}". Option fields accept a name or id.</label>
      <textarea className="mono" value={mappingText} onChange={(e) => setMappingText(e.target.value)} style={{ minHeight: 120 }} />
      <p className="muted">Example: {'{ "labels": ["$labels", "regression"], "priority": "High", "components": "Checkout", "customfield_10042": "{{draft.environmentSummary}}" }'}</p>
      <button className="primary" onClick={saveJira} disabled={!j.projectKey || !j.issueTypeId}>Save Jira settings</button>
    </div>
  );
}

function PrivacySection({ s, update, persist }: SectionProps) {
  const [keys, setKeys] = useState(s.redaction.extraKeys.join(', '));
  const [patterns, setPatterns] = useState(s.redaction.extraPatterns.map((p) => `${p.id} = ${p.regex}`).join('\n'));
  const save = () => {
    const extraKeys = keys.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    const extraPatterns = patterns.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? { id: l.slice(0, i).trim(), regex: l.slice(i + 1).trim() } : { id: l.slice(0, 12), regex: l };
    });
    for (const p of extraPatterns) new RegExp(p.regex); // throws on invalid
    void persist({ ...s, redaction: { extraKeys, extraPatterns } });
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>4. Redaction</h2>
      <p className="muted">
        Built-in rules always mask: authorization, cookie, set-cookie, x-api-key, password, token, access_token, refresh_token, client_secret, api_key, secret, session ids, OTP/PIN/SSN/CVV/card fields, plus JWTs, bearer tokens, AWS/GitHub/OpenAI/Slack key formats and card-number-like digit runs. Masked values keep a short hash so equal values stay correlatable.
      </p>
      <label>Extra sensitive header / field names (comma separated)</label>
      <input value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="x-tenant-secret, internalToken" />
      <label>Extra regex patterns (one per line, “id = regex”)</label>
      <textarea className="mono" value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder={'employee-id = \\bEMP-\\d{6}\\b'} />
      <button onClick={save}>Save redaction rules</button>
    </div>
  );
}

function TraceSection({ s, update, persist }: SectionProps) {
  const [text, setText] = useState(Object.entries(s.traceLinkTemplates).map(([k, v]) => `${k} = ${v}`).join('\n'));
  const [tele, setTele] = useState(s.telemetryHostsExtra.join(', '));
  const save = () => {
    const traceLinkTemplates: Record<string, string> = {};
    for (const l of text.split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) traceLinkTemplates[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    void persist({ ...s, traceLinkTemplates, telemetryHostsExtra: tele.split(',').map((x) => x.trim()).filter(Boolean) });
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>5. Backend trace links & noise</h2>
      <p className="muted">When a failed response carries a correlation header, TestLens adds a deep link into your logging/tracing tool. One per line: “header = URL template with {'{value}'}”. Use “*” as the header to apply to any correlation id.</p>
      <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={'x-request-id = https://logs.example.com/app/discover#/?_a=(query:(query:\'{value}\'))\ntraceparent = https://tempo.example.com/trace/{value}'} />
      <label>Extra telemetry hosts to ignore (comma separated)</label>
      <input value={tele} onChange={(e) => setTele(e.target.value)} placeholder="metrics.internal.example.com" />
      <button onClick={save}>Save</button>
    </div>
  );
}

function DataSection({ s, update, persist, setMsg }: SectionProps) {
  const clearAll = async () => {
    if (!confirm('Delete all buffered events and incidents stored by TestLens in this browser?')) return;
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name === 'testlens') indexedDB.deleteDatabase('testlens');
    await chrome.storage.session.clear();
    setMsg?.({ kind: 'ok', text: 'Local TestLens data cleared. Reload monitored tabs.' });
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>6. Data</h2>
      <p className="muted">Buffers expire continuously (older than the rolling window). Frozen incidents are kept locally and purged automatically.</p>
      <label>Keep incidents for (days)</label>
      <input type="number" min={1} max={90} value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} style={{ width: 100 }} />
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => persist()}>Save</button>
        <button className="danger" onClick={clearAll}>Clear all local data</button>
        <button onClick={() => persist({ ...DEFAULT_SETTINGS, jira: s.jira, monitoredOrigins: s.monitoredOrigins, onboarded: true })}>Reset other settings to defaults</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Options />);
