import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/base.css';
import { resolveTokenHelpUrl, type FieldSchema, type IssueTypeRef, type ProjectRef, type TrackerDescriptor } from '@testlens/trackers-core';
import { sendRuntime } from '../../src/messages';
import { ARTIFACT_KIND_LABELS, DEFAULT_SETTINGS, describeEntry, exportSettings, importSettings, loadSettings, normalizeOriginInput, originsToMatchPatterns, saveSettings, type Settings, type TrackerSettings } from '../../src/settings';
import { buildMappingFields, optionalFieldsWithValues, requiredFields, stringValues, withDefaults } from '../../src/jira-mapping';
import { FieldControl } from '../../src/ui/FieldControl';
import { ChromeBuiltinProvider, PROVIDER_PRESETS, type BuiltinAvailability } from '@testlens/ai';

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
        TestLens is a flight recorder for testing. It keeps a rolling buffer of console, errors, network and interactions for the sites you choose, and turns the last 5 minutes into a reviewed Jira issue when you click â€œReport Issueâ€. Nothing leaves this machine until you click Create.
      </p>

      <MonitoringSection s={s} update={update} persist={persist} setMsg={setMsg} />
      <CaptureSection s={s} update={update} persist={persist} />
      <TrackerSection s={s} update={update} persist={persist} setMsg={setMsg} />
      <AiSection s={s} update={update} persist={persist} setMsg={setMsg} />
      <HubSection s={s} update={update} persist={persist} setMsg={setMsg} />
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
  const [incognitoAllowed, setIncognitoAllowed] = useState<boolean>();
  const [editing, setEditing] = useState<{ from: string; value: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  /** Replace an entry in place, carrying its app name over, then ask for the new permission on Apply. */
  const commitEdit = () => {
    if (!editing) return;
    const next = normalizeOriginInput(editing.value);
    if (!next) return setMsg?.({ kind: 'err', text: 'Enter a site like app.example.com, https://host:port or *.example.com' });
    const origins = s.monitoredOrigins.map((x) => (x === editing.from ? next : x)).filter((x, i, arr) => arr.indexOf(x) === i);
    const appNames = { ...s.appNames };
    if (appNames[editing.from] !== undefined && next !== editing.from) {
      appNames[next] = appNames[editing.from]!;
      delete appNames[editing.from];
    }
    update({ monitoredOrigins: origins, appNames });
    setEditing(undefined);
    if (next !== editing.from) setMsg?.({ kind: 'ok', text: `Changed to ${describeEntry(next)}. Click Apply monitoring to grant the permission.` });
  };
  useEffect(() => {
    void chrome.permissions.getAll().then((p) => setGranted(p.origins ?? []));
    chrome.extension.isAllowedIncognitoAccess((ok) => setIncognitoAllowed(ok));
  }, [s.monitoredOrigins]);

  const add = () => {
    const o = normalizeOriginInput(input);
    if (!o) return setMsg?.({ kind: 'err', text: 'Enter a site like app.example.com, https://app.example.com or *.example.com' });
    if (!s.monitoredOrigins.includes(o)) update({ monitoredOrigins: [...s.monitoredOrigins, o] });
    setInput('');
  };
  const apply = async () => {
    const patterns = originsToMatchPatterns(s.monitoredOrigins);
    if (patterns.length) {
      const ok = await chrome.permissions.request({ origins: patterns });
      if (!ok) return setMsg?.({ kind: 'err', text: 'Permission not granted; monitoring not enabled for those sites' });
    }
    await persist({ ...s, onboarded: true });
    await sendRuntime({ type: 'tl:apply-monitoring' });
    setMsg?.({ kind: 'ok', text: 'Monitoring applied to every window of this browser. Reload open tabs of these sites to start capturing.' });
  };
  const isGranted = (o: string) => granted.includes('<all_urls>') || originsToMatchPatterns([o]).every((p) => granted.includes(p));

  const exportFile = () => {
    const blob = new Blob([exportSettings(s)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'testlens-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const next = importSettings(s, await f.text());
      await persist(next);
      await sendRuntime({ type: 'tl:apply-monitoring' });
      setMsg?.({ kind: 'ok', text: 'Settings imported. Click Apply monitoring to grant site permissions, and enter the Jira token if needed.' });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>1. Monitored sites</h2>
      <p className="muted">
        Add the application under test. Monitoring is <b>domain-wide</b>: entering app.example.com covers example.com and every subdomain (api.example.com, auth.example.comâ€¦), http and https, any port. localhost and IP addresses are kept exact. Configure once; the same configuration applies to all normal windows and, once allowed, Incognito windows of this browser, and syncs with your signed-in Chrome profile.
      </p>
      <div className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="app.example.com" style={{ flex: 1 }} />
        <button onClick={add}>Add</button>
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {s.monitoredOrigins.map((o) =>
          editing?.from === o ? (
            <div key={o} className="item">
              <div className="body">
                <input
                  autoFocus
                  value={editing.value}
                  onChange={(e) => setEditing({ from: o, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditing(undefined);
                  }}
                  placeholder="app.example.com, https://host:port or *.example.com"
                />
                <div className="reasons">Will become: {normalizeOriginInput(editing.value) ? describeEntry(normalizeOriginInput(editing.value)!) : 'invalid entry'}</div>
              </div>
              <button className="small primary" onClick={commitEdit} disabled={!normalizeOriginInput(editing.value)}>Save</button>
              <button className="small" onClick={() => setEditing(undefined)}>Cancel</button>
            </div>
          ) : (
            <div key={o} className="item">
              <div className="body">
                <div className="mono">
                  {o.replace(/^\*\./, '')} {isGranted(o) ? <span className="badge ok">permission granted</span> : <span className="badge err">permission pending â€” click Apply</span>}
                </div>
                <div className="reasons">{describeEntry(o)}</div>
              </div>
              <input placeholder="app name (optional)" style={{ width: 180 }} value={s.appNames[o] ?? ''} onChange={(e) => update({ appNames: { ...s.appNames, [o]: e.target.value } })} />
              <button className="small" title="Change this entry, e.g. widen it to the whole domain" onClick={() => setEditing({ from: o, value: o })}>edit</button>
              <button className="small danger" onClick={() => update({ monitoredOrigins: s.monitoredOrigins.filter((x) => x !== o) })}>remove</button>
            </div>
          ),
        )}
        {!s.monitoredOrigins.length && <p className="muted">No sites yet.</p>}
      </div>
      <label>Environment name (added to every bug, e.g. QA, Staging)</label>
      <input value={s.environmentName} onChange={(e) => update({ environmentName: e.target.value })} style={{ maxWidth: 240 }} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={apply}>Apply monitoring</button>
        <button onClick={exportFile}>Export settings</button>
        <button onClick={() => fileRef.current?.click()}>Import settings</button>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>

      <div className="card" style={{ marginTop: 12, background: 'var(--panel2)' }}>
        <div className="row between">
          <span>
            <b>Incognito windows</b>{' '}
            {incognitoAllowed === undefined ? null : incognitoAllowed ? <span className="badge ok">allowed â€” same configuration applies</span> : <span className="badge err">not allowed yet</span>}
          </span>
          {incognitoAllowed === false && (
            <button className="small" onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
              Open extension details
            </button>
          )}
        </div>
        {incognitoAllowed === false && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Chrome does not let extensions enable this themselves. On the extension details page turn on <b>Allow in Incognito</b> once. TestLens then uses the same sites, Jira connection and recorder in Incognito; no reconfiguration.
          </p>
        )}
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
      <p className="muted">
        <b>Tab video</b>: Chrome only allows video capture after TestLens has been opened on the tab. With the option below, opening the popup on a monitored tab starts the rolling recording automatically (60-second segments, kept for ~7 minutes, until the tab closes). DOM replay and the screenshot are always captured regardless.
      </p>
      <label className="inline"><input type="checkbox" checked={s.autoRecordOnOpen} onChange={(e) => update({ autoRecordOnOpen: e.target.checked })} /> Start tab video automatically when I open TestLens on a monitored tab</label>
      <label className="inline" title="By default the recorder keeps rolling after Report Issue (only the last ~7 minutes are kept) so a second issue can be reported without re-arming. Tick to stop it once the incident has its footage.">
        <input type="checkbox" checked={s.stopVideoAfterReport} onChange={(e) => update({ stopVideoAfterReport: e.target.checked })} /> Stop tab video after Report Issue
      </label>
      <p className="muted" style={{ marginTop: 4 }}>Footage inside the incident window is stitched into a single <code>recording.webm</code>. The rolling recorder itself keeps only the last ~7 minutes and never attaches anything outside the incident window.</p>

      <h3>Default attachments</h3>
      <p className="muted" style={{ marginTop: 0 }}>Everything is always captured. These are only the files pre-ticked for the bug; you can change each one on the Evidence and Tracker tabs before Create.</p>
      <div className="row" style={{ gap: 4 }}>
        {Object.entries(ARTIFACT_KIND_LABELS).map(([kind, label]) => (
          <label key={kind} className="inline">
            <input type="checkbox" checked={s.attachDefaults[kind] ?? true} onChange={(e) => update({ attachDefaults: { ...s.attachDefaults, [kind]: e.target.checked } })} /> {label}
          </label>
        ))}
      </div>
      <button onClick={() => persist()} style={{ marginTop: 8 }}>Save</button>
    </div>
  );
}

function TrackerSection({ s, update, persist, setMsg }: SectionProps) {
  const [descriptors, setDescriptors] = useState<TrackerDescriptor[]>([]);
  const t: TrackerSettings = s.tracker ?? { trackerId: 'jira-cloud', baseUrl: '', email: '', token: '', projectKey: '', issueTypeId: '', mapping: { trackerId: 'jira-cloud', projectKey: '', issueTypeId: '', fields: { labels: ['$labels'] }, attachKinds: [] } };
  const d = descriptors.find((x) => x.id === t.trackerId);
  const setT = (p: Partial<TrackerSettings>) => update({ tracker: { ...t, ...p } });
  const [projects, setProjects] = useState<ProjectRef[]>();
  const [types, setTypes] = useState<IssueTypeRef[]>();
  const [fields, setFields] = useState<FieldSchema[]>();
  const [testing, setTesting] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [who, setWho] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>(() => stringValues(t.mapping.fields));
  const [advanced, setAdvanced] = useState(false);
  const [mappingText, setMappingText] = useState(JSON.stringify(t.mapping.fields, null, 2));

  useEffect(() => {
    void sendRuntime<TrackerDescriptor[]>({ type: 'tl:tracker-list' }).then(setDescriptors);
  }, []);

  // With saved credentials, load containers, types and fields on open so the selects stay editable.
  useEffect(() => {
    if (!t.token) return;
    setLoadingFields(true);
    (async () => {
      try {
        const [p, ty] = await Promise.all([sendRuntime<ProjectRef[]>({ type: 'tl:tracker-projects' }), t.projectKey ? sendRuntime<IssueTypeRef[]>({ type: 'tl:tracker-issue-types', projectKey: t.projectKey }) : Promise.resolve(undefined)]);
        setProjects(p);
        if (ty) setTypes(ty);
        if (t.projectKey && t.issueTypeId) setFields(await sendRuntime<FieldSchema[]>({ type: 'tl:tracker-fields', projectKey: t.projectKey, issueTypeId: t.issueTypeId }));
      } catch (e) {
        setMsg?.({ kind: 'err', text: `${d?.displayName ?? 'Tracker'}: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setLoadingFields(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTracker = (trackerId: string) => {
    const nd = descriptors.find((x) => x.id === trackerId);
    const baseUrl = nd?.authFields.find((f) => f.key === 'baseUrl')?.placeholder ?? '';
    update({ tracker: { trackerId, baseUrl: nd?.authFields.some((f) => f.key === 'baseUrl') && !/yourcompany|yourorg|example/.test(baseUrl) ? baseUrl : '', email: '', token: '', projectKey: '', issueTypeId: '', mapping: { trackerId, projectKey: '', issueTypeId: '', fields: { labels: ['$labels'] }, attachKinds: [] } } });
    setProjects(undefined);
    setTypes(undefined);
    setFields(undefined);
    setWho(undefined);
    setValues({});
    setMappingText(JSON.stringify({ labels: ['$labels'] }, null, 2));
  };

  const connect = async () => {
    try {
      setTesting(true);
      const base = t.baseUrl || d?.authFields.find((f) => f.key === 'baseUrl')?.placeholder || '';
      const origin = `${new URL(base).origin}/*`;
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) throw new Error(`Permission to call ${new URL(base).origin} was not granted`);
      const next = { ...t, baseUrl: base };
      await persist({ ...s, tracker: next });
      const me = await sendRuntime<{ displayName?: string }>({ type: 'tl:tracker-test', tracker: next });
      setWho(me.displayName);
      setProjects(await sendRuntime<ProjectRef[]>({ type: 'tl:tracker-projects' }));
      if (t.projectKey) setTypes(await sendRuntime<IssueTypeRef[]>({ type: 'tl:tracker-issue-types', projectKey: t.projectKey }));
      setMsg?.({ kind: 'ok', text: `Connected to ${d?.displayName ?? 'tracker'} as ${me.displayName}` });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const loadTypes = async (projectKey: string) => {
    const p = projects?.find((x) => x.key === projectKey);
    setT({ projectKey, projectName: p?.name, issueTypeId: '', issueTypeName: undefined });
    setFields(undefined);
    setTypes(undefined);
    if (!projectKey) return;
    const ty = await sendRuntime<IssueTypeRef[]>({ type: 'tl:tracker-issue-types', projectKey });
    setTypes(ty);
    const bug = ty.find((x) => !x.subtask && /^bug$/i.test(x.name)) ?? ty.find((x) => !x.subtask);
    if (bug) await loadFields(bug.id, projectKey, ty, p?.name);
  };

  const loadFields = async (issueTypeId: string, projectKey = t.projectKey, typeList = types, projectName = t.projectName) => {
    const ty = typeList?.find((x) => x.id === issueTypeId);
    setLoadingFields(true);
    try {
      const f = await sendRuntime<FieldSchema[]>({ type: 'tl:tracker-fields', projectKey, issueTypeId });
      setFields(f);
      const next = withDefaults(values, f);
      setValues(next);
      const mappingFields = buildMappingFields(next, f);
      setMappingText(JSON.stringify(mappingFields, null, 2));
      const nextTracker: TrackerSettings = { ...t, projectKey, projectName, issueTypeId, issueTypeName: ty?.name, mapping: { ...t.mapping, trackerId: t.trackerId, projectKey, issueTypeId, fields: mappingFields } };
      await persist({ ...s, tracker: nextTracker });
      setMsg?.({ kind: 'ok', text: `Default destination set: ${projectKey} / ${ty?.name ?? issueTypeId}${requiredFields(f).length ? ' â€” review the required fields below' : ''}` });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingFields(false);
    }
  };

  const setValue = (key: string, v: string) => {
    const next = { ...values, [key]: v };
    setValues(next);
    if (fields) setMappingText(JSON.stringify(buildMappingFields(next, fields), null, 2));
  };

  const save = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = advanced ? (JSON.parse(mappingText) as Record<string, unknown>) : buildMappingFields(values, fields ?? []);
    } catch {
      return setMsg?.({ kind: 'err', text: 'Field mapping is not valid JSON' });
    }
    await persist({ ...s, tracker: { ...t, mapping: { ...t.mapping, trackerId: t.trackerId, projectKey: t.projectKey, issueTypeId: t.issueTypeId, fields: parsed } } });
  };

  const required = fields ? requiredFields(fields) : [];
  const optional = fields ? optionalFieldsWithValues(fields) : [];
  const missing = required.filter((f) => !values[f.key]);
  const authReady = Boolean(t.token) && (d?.authFields ?? []).filter((f) => f.key !== 'secret').every((f) => f.key === 'email' ? (d?.authMethod === 'basic' ? Boolean(t.email) : true) : Boolean(t.baseUrl) || Boolean(f.placeholder));

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>3. Bug tracker</h2>
      <label>Tracker</label>
      <select value={t.trackerId} onChange={(e) => switchTracker(e.target.value)} style={{ maxWidth: 360 }}>
        {descriptors.map((x) => (
          <option key={x.id} value={x.id}>
            {x.displayName}
          </option>
        ))}
        {!descriptors.length && <option value={t.trackerId}>{t.trackerId}</option>}
      </select>
      {d && <p className="muted">{d.blurb} Credentials are stored only in this browser profile; the token never syncs.</p>}

      {d && (
        <div className="card" style={{ background: 'var(--panel2)', marginTop: 8 }}>
          <div className="row between">
            <b>Step 1 â€” get your {d.authFields.find((f) => f.key === 'secret')?.label.replace(/\s*\(.*\)$/, '') ?? 'token'}</b>
            {(() => {
              const url = resolveTokenHelpUrl(d, t.baseUrl);
              const needsUrl = Boolean(d.tokenHelpUrl?.includes('{baseUrl}')) && !url;
              return (
                <button className="primary small" disabled={!url} title={needsUrl ? `Enter the ${d.authFields.find((f) => f.key === 'baseUrl')?.label ?? 'URL'} first` : url} onClick={() => url && chrome.tabs.create({ url })}>
                  {needsUrl ? 'Enter the URL first' : `Open ${d.displayName} token page â†—`}
                </button>
              );
            })()}
          </div>
          {d.tokenSteps && (
            <ol style={{ margin: '6px 0 0 18px', padding: 0 }} className="muted">
              {d.tokenSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      <h3 style={{ marginBottom: 0 }}>Step 2 â€” enter the connection details</h3>
      <div className="row" style={{ gap: 12 }}>
        {(d?.authFields ?? []).map((f) => (
          <div key={f.key} style={{ flex: f.key === 'secret' ? 3 : 2, minWidth: 220 }}>
            <label>{f.label}</label>
            <input
              type={f.type === 'password' ? 'password' : 'text'}
              value={f.key === 'baseUrl' ? t.baseUrl : f.key === 'email' ? t.email : t.token}
              placeholder={f.placeholder}
              title={f.help}
              onChange={(e) => setT(f.key === 'baseUrl' ? { baseUrl: e.target.value.trim() } : f.key === 'email' ? { email: e.target.value.trim() } : { token: e.target.value.trim() })}
            />
            {f.help && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{f.help}</div>}
          </div>
        ))}
      </div>
      <h3 style={{ marginBottom: 0 }}>Step 3 â€” connect</h3>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={connect} disabled={testing || !authReady}>{testing ? 'Connectingâ€¦' : `Connect & load ${d?.containerLabel.toLowerCase() ?? 'project'}s`}</button>
        {who && <span className="ok">Connected as {who}</span>}
        {!authReady && !who && <span className="muted">Fill the fields above to enable</span>}
      </div>

      {(projects || t.projectKey) && (
        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>{d?.containerLabel ?? 'Project'}</label>
            {projects ? (
              <select value={t.projectKey} onChange={(e) => void loadTypes(e.target.value)}>
                <option value="">â€” select â€”</option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key === p.name ? p.name : `${p.key} â€” ${p.name}`}
                  </option>
                ))}
              </select>
            ) : (
              <input value={t.projectName ?? t.projectKey} readOnly />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label>{d?.typeLabel ?? 'Issue type'}</label>
            {types ? (
              <select value={t.issueTypeId} onChange={(e) => void loadFields(e.target.value)}>
                <option value="">â€” select â€”</option>
                {types.filter((x) => !x.subtask).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            ) : (
              <input value={t.issueTypeName ?? t.issueTypeId} readOnly />
            )}
          </div>
        </div>
      )}

      {loadingFields && <p className="muted"><span className="spinner" /> Loading fieldsâ€¦</p>}

      {fields && (
        <div style={{ marginTop: 10 }}>
          {required.length ? (
            <>
              <h3 style={{ marginBottom: 2 }}>Required by this {d?.containerLabel.toLowerCase() ?? 'project'}</h3>
              <p className="muted" style={{ marginTop: 0 }}>Defaults were chosen for you. Change any of them; they are used for every bug unless you change them per bug in the side panel.</p>
              <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
                {required.map((f) => (
                  <FieldControl key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} />
                ))}
              </div>
            </>
          ) : (
            <p className="ok">No extra required fields. Summary and description are enough.</p>
          )}
          {optional.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted">Optional defaults ({optional.slice(0, 3).map((f) => f.name).join(', ')}{optional.length > 3 ? 'â€¦' : ''})</summary>
              <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
                {optional.map((f) => (
                  <FieldControl key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} allowEmpty />
                ))}
              </div>
            </details>
          )}
          <details style={{ marginTop: 8 }} open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
            <summary className="muted">Advanced: raw field mapping (JSON)</summary>
            <p className="muted">Values: "$labels", "$summary", "$description", or templates like {'{{draft.environmentSummary}}'}. Editing here overrides the form above when you save.</p>
            <textarea className="mono" value={mappingText} onChange={(e) => setMappingText(e.target.value)} style={{ minHeight: 120 }} />
          </details>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={save} disabled={!t.projectKey || !t.issueTypeId || missing.length > 0}>Save tracker settings</button>
            {missing.length > 0 && <span className="warn">Choose a value for: {missing.map((f) => f.name).join(', ')}</span>}
            {d?.attachments === 'none' && <span className="muted">{d.displayName} cannot receive file attachments via its API; evidence stays downloadable from TestLens.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function AiSection({ s, update, persist, setMsg }: SectionProps) {
  const ai = s.ai;
  const preset = PROVIDER_PRESETS.find((p) => p.id === ai.provider) ?? PROVIDER_PRESETS[0]!;
  const setAi = (p: Partial<typeof ai>) => update({ ai: { ...ai, ...p } });
  const [testing, setTesting] = useState(false);
  const [ok, setOk] = useState<string>();

  const switchProvider = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setOk(undefined);
    update({ ai: { ...ai, provider: p.id, baseUrl: p.baseUrl, model: p.defaultModel, apiKey: '' } });
  };

  const connect = async () => {
    setTesting(true);
    try {
      const origin = `${new URL(ai.baseUrl).origin}/*`;
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`Permission to call ${new URL(ai.baseUrl).origin} was not granted`);
      const next = { ...ai, enabled: true };
      await persist({ ...s, ai: next });
      const r = await sendRuntime<{ model: string }>({ type: 'tl:ai-test', ai: next });
      setOk(r.model);
      setMsg?.({ kind: 'ok', text: `${preset.displayName} connected (${r.model}). AI analysis is now enabled.` });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const tierBadge = (t: typeof preset.tier) => (t === 'free' ? <span className="badge ok">free tier</span> : t === 'local' ? <span className="badge ok">local, free</span> : <span className="badge warn">paid</span>);
  const isBuiltin = preset.id === 'chrome-builtin';
  const ready = isBuiltin || (Boolean(ai.baseUrl) && (!preset.needsKey || Boolean(ai.apiKey)));

  // Chrome's on-device model: availability is checked in this page (the API lives in page contexts).
  const [builtin, setBuiltin] = useState<BuiltinAvailability>();
  const [progress, setProgress] = useState<number>();
  useEffect(() => {
    if (isBuiltin) void ChromeBuiltinProvider.availability().then(setBuiltin);
  }, [isBuiltin]);
  const downloadBuiltin = async () => {
    setTesting(true);
    try {
      setProgress(0);
      await ChromeBuiltinProvider.download((f) => setProgress(f));
      setBuiltin(await ChromeBuiltinProvider.availability());
      await persist({ ...s, ai: { ...ai, enabled: true } });
      setMsg?.({ kind: 'ok', text: 'Built-in model ready. AI suggestions now run on this machine.' });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setProgress(undefined);
      setTesting(false);
    }
  };
  const testBuiltin = async () => {
    setTesting(true);
    try {
      const r = await new ChromeBuiltinProvider().test({ apiKey: '', model: ai.model, baseUrl: '' });
      await persist({ ...s, ai: { ...ai, enabled: true } });
      setOk(r.model);
      setMsg?.({ kind: 'ok', text: 'Chrome built-in AI is ready; nothing leaves this machine.' });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>4. AI analysis (optional)</h2>
      <p className="muted">
        An AI model rewrites the <b>steps to reproduce</b> from the actions recorded in the rolling window and drafts the <b>bug summary</b>, expected/actual and a short technical analysis. Suggestions appear on the Bug tab and replace nothing until you click Apply; applied text is marked as AI. Off until you connect a provider.
      </p>

      <div className="card" style={{ background: 'var(--panel2)' }}>
        <div className="row between">
          <b>Step 1 â€” choose a provider and get a key</b>
          {preset.keyUrl && (
            <button className="primary small" onClick={() => chrome.tabs.create({ url: preset.keyUrl! })}>
              {preset.needsKey ? `Open ${preset.displayName.replace(/\s*\(.*\)$/, '')} API keys page â†—` : `Install ${preset.displayName.replace(/\s*\(.*\)$/, '')} â†—`}
            </button>
          )}
        </div>
        <label>Provider</label>
        <select value={preset.id} onChange={(e) => switchProvider(e.target.value)} style={{ maxWidth: 420 }}>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
              {p.recommended ? ' â€” recommended' : ''}
            </option>
          ))}
        </select>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          {tierBadge(preset.tier)} {preset.blurb}
        </p>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          <b>Data:</b> {preset.dataNote}
        </p>
      </div>

      <div className="card" style={{ background: 'var(--panel2)', marginTop: 8 }}>
        <b>What is sent to the provider</b>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          Redacted only: the click/input/navigation trail with timestamps, the focal request's method, URL path, status, duration and a short body snippet (optional below), console errors, JavaScript errors, the engine's observations and your current draft. Never sent: headers, cookies, tokens, full bodies, screenshots, replay, video. The exact payload is viewable per bug via "What is sent?".
        </p>
      </div>

      {isBuiltin && (
        <div className="card" style={{ background: 'var(--panel2)', marginTop: 8 }}>
          <div className="row between">
            <b>
              Model status:{' '}
              {builtin === undefined ? 'â€¦' : builtin === 'available' ? <span className="ok">ready on this machine</span> : builtin === 'downloadable' ? <span className="warn">not downloaded yet</span> : builtin === 'downloading' ? <span className="warn">downloading</span> : builtin === 'unsupported' ? <span className="err">not available in this browser (Chrome 138+ needed)</span> : <span className="err">unavailable on this device</span>}
            </b>
            {(builtin === 'downloadable' || builtin === 'downloading') && (
              <button className="primary small" disabled={testing} onClick={downloadBuiltin}>
                {testing ? `Downloadingâ€¦ ${progress !== undefined ? `${Math.round(progress * 100)}%` : ''}` : 'Download model (one time, â‰ˆ2 GB)'}
              </button>
            )}
          </div>
          {(builtin === 'unsupported' || builtin === 'unavailable') && <p className="muted" style={{ marginBottom: 0 }}>Pick <b>Groq (free tier)</b> above instead: one free API key, no payment details.</p>}
        </div>
      )}

      <h3 style={{ marginBottom: 0 }}>Step 2 â€” connection</h3>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label>Model</label>
          <input value={ai.model} onChange={(e) => setAi({ model: e.target.value.trim() })} placeholder={preset.defaultModel} disabled={isBuiltin} />
        </div>
        {!isBuiltin && (
          <div style={{ flex: 2, minWidth: 240 }}>
            <label>API base URL</label>
            <input value={ai.baseUrl} onChange={(e) => setAi({ baseUrl: e.target.value.trim() })} placeholder={preset.baseUrl} title="Any OpenAI-compatible gateway works here" />
          </div>
        )}
        {preset.needsKey && (
          <div style={{ flex: 3, minWidth: 240 }}>
            <label>API key</label>
            <input type="password" value={ai.apiKey} onChange={(e) => setAi({ apiKey: e.target.value.trim() })} />
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Stored only in this browser profile; never synced or exported.</div>
          </div>
        )}
      </div>
      <div style={{ marginTop: 6 }}>
        <label className="inline"><input type="checkbox" checked={ai.autoRun} onChange={(e) => setAi({ autoRun: e.target.checked })} /> Run automatically when I click Report Issue</label>
        <label className="inline"><input type="checkbox" checked={ai.includeBodies} onChange={(e) => setAi({ includeBodies: e.target.checked })} /> Include short redacted body snippets of the failed request</label>
        <label className="inline"><input type="checkbox" checked={ai.enabled} onChange={(e) => setAi({ enabled: e.target.checked })} /> AI analysis enabled</label>
      </div>

      <h3 style={{ marginBottom: 0 }}>Step 3 â€” connect</h3>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={isBuiltin ? testBuiltin : connect} disabled={testing || !ready}>{testing ? 'Testingâ€¦' : isBuiltin ? 'Check & enable' : 'Connect & test'}</button>
        <button onClick={() => persist()}>Save</button>
        {ok && <span className="ok">Model reachable: {ok}</span>}
        {!ready && <span className="muted">{preset.needsKey ? 'Enter the API key to enable' : 'Enter the base URL to enable'}</span>}
      </div>
    </div>
  );
}

function HubSection({ s, update, persist, setMsg }: SectionProps) {
  const hub = s.hub;
  const setHub = (p: Partial<typeof hub>) => update({ hub: { ...hub, ...p } });
  const [testing, setTesting] = useState(false);
  const [info, setInfo] = useState<string>();
  const connect = async () => {
    setTesting(true);
    try {
      const origin = `${new URL(hub.url).origin}/*`;
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) throw new Error(`Permission to call ${new URL(hub.url).origin} was not granted`);
      await persist({ ...s, hub: { ...hub, enabled: true } });
      const h = await sendRuntime<{ version: string; dataDir: string }>({ type: 'tl:hub-test', url: hub.url });
      setInfo(`Hub ${h.version} Â· data in ${h.dataDir}`);
      setMsg?.({ kind: 'ok', text: 'Hub connected. Incidents from Postman/Newman now appear under Incidents â†’ Sync from Hub.' });
    } catch (e) {
      setMsg?.({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>5. API testing tools (Postman, Newman, HAR)</h2>
      <p className="muted">
        API-testing tools have no browser to record, so they push evidence to a small <b>local Hub</b> on your machine. The Hub normalises it; this extension pulls the incidents and handles review, AI and tracker creation exactly like browser bugs. No tracker credentials live in the Hub. HAR and Newman files can also be imported directly from the Incidents list without a Hub.
      </p>
      <div className="card" style={{ background: 'var(--panel2)' }}>
        <b>Step 1 â€” start the Hub</b>
        <pre style={{ margin: '6px 0 0' }}>npx testlens-hub</pre>
        <p className="muted" style={{ margin: '4px 0 0' }}>From the TestLens repository: <code>npm run hub</code>. It listens on <code>http://localhost:7331</code> and shows the Postman snippet to paste into your collection.</p>
      </div>
      <div className="row" style={{ gap: 12, marginTop: 8 }}>
        <div style={{ flex: 2, minWidth: 240 }}>
          <label>Hub URL</label>
          <input value={hub.url} onChange={(e) => setHub({ url: e.target.value.trim() })} placeholder="http://localhost:7331" />
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        <label className="inline"><input type="checkbox" checked={hub.enabled} onChange={(e) => setHub({ enabled: e.target.checked })} /> Hub enabled</label>
        <label className="inline"><input type="checkbox" checked={hub.autoSync} onChange={(e) => setHub({ autoSync: e.target.checked })} /> Pull new incidents automatically (every minute)</label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={connect} disabled={testing || !hub.url}>{testing ? 'Connectingâ€¦' : 'Step 2 â€” Connect & test'}</button>
        <button onClick={() => persist()}>Save</button>
        {info && <span className="ok">{info}</span>}
      </div>
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
      <h2 style={{ marginTop: 0 }}>6. Redaction</h2>
      <p className="muted">
        Built-in rules always mask: authorization, cookie, set-cookie, x-api-key, password, token, access_token, refresh_token, client_secret, api_key, secret, session ids, OTP/PIN/SSN/CVV/card fields, plus JWTs, bearer tokens, AWS/GitHub/OpenAI/Slack key formats and card-number-like digit runs. Masked values keep a short hash so equal values stay correlatable.
      </p>
      <label>Extra sensitive header / field names (comma separated)</label>
      <input value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="x-tenant-secret, internalToken" />
      <label>Extra regex patterns (one per line, â€œid = regexâ€)</label>
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
      <h2 style={{ marginTop: 0 }}>7. Backend trace links & noise</h2>
      <p className="muted">When a failed response carries a correlation header, TestLens adds a deep link into your logging/tracing tool. One per line: â€œheader = URL template with {'{value}'}â€. Use â€œ*â€ as the header to apply to any correlation id.</p>
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
      <h2 style={{ marginTop: 0 }}>8. Data</h2>
      <p className="muted">Buffers expire continuously (older than the rolling window). Frozen incidents are kept locally and purged automatically.</p>
      <label>Keep incidents for (days)</label>
      <input type="number" min={1} max={90} value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} style={{ width: 100 }} />
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => persist()}>Save</button>
        <button className="danger" onClick={clearAll}>Clear all local data</button>
        <button onClick={() => persist({ ...DEFAULT_SETTINGS, tracker: s.tracker, monitoredOrigins: s.monitoredOrigins, onboarded: true })}>Reset other settings to defaults</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Options />);
