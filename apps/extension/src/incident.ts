/**
 * Incident pipeline: freeze → normalize → redact → evidence → compose → artifacts.
 */
import type { Artifact, BugContext, BugDraft, FocalEvent } from '@testlens/schema';
import { newId } from '@testlens/schema';
import { normalizeBrowserIncident, type RawBrowserIncident } from '@testlens/connectors-browser';
import { DEFAULT_RULES, RULES_VERSION, mergeRules, redactContext } from '@testlens/redaction';
import { buildConsoleLog, buildHar, buildNetworkLog, runEvidenceEngine, selectedExchangeIds, DEFAULT_ENGINE_OPTIONS } from '@testlens/evidence-engine';
import { compose, withEvidenceIndex } from '@testlens/composer';
import { getBlob, getIncident, putBlob, putIncident, readRrweb, readWindow, type StoredIncident } from './buffer/db';
import { loadSettings, type Settings } from './settings';
import type { IncidentPatch, PageInfo } from './messages';
import { renderViewerHtml } from './viewer-template';

const pageInfo = new Map<number, PageInfo>();
export function rememberPageInfo(tabId: number, info: PageInfo) {
  pageInfo.set(tabId, info);
  void chrome.storage.session.set({ [`tl.pageinfo.${tabId}`]: info });
}
async function getPageInfo(tabId: number): Promise<PageInfo | undefined> {
  const m = pageInfo.get(tabId);
  if (m) return m;
  const r = await chrome.storage.session.get(`tl.pageinfo.${tabId}`);
  return r[`tl.pageinfo.${tabId}`] as PageInfo | undefined;
}

export const redactionTotals: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Start: freeze immediately, finish after the post-window
// ---------------------------------------------------------------------------

export async function startIncident(tabId: number, note?: string): Promise<StoredIncident> {
  const settings = await loadSettings();
  const tab = await chrome.tabs.get(tabId);
  const now = Date.now();
  const incident: StoredIncident = {
    incidentId: newId('inc_'),
    tabId,
    createdAt: now,
    triggerAt: now,
    postUntil: now + settings.postWindowMs,
    status: 'collecting',
    note,
    tab: { url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId },
  };
  await putIncident(incident);

  // Screenshot right away (the tab is active because the tester just clicked the action).
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    await putBlob(`${incident.incidentId}:screenshot`, incident.incidentId, blob);
  } catch (e) {
    console.warn('[TL] screenshot failed', e);
    incident.warnings = [...(incident.warnings ?? []), `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`];
    await putIncident(incident);
  }

  // Schedule finalize. setTimeout works while the SW lives; the alarm is the fallback if it is killed.
  setTimeout(() => void finalizeIncident(incident.incidentId), settings.postWindowMs + 500);
  chrome.alarms.create(`tl-finalize:${incident.incidentId}`, { when: now + settings.postWindowMs + 1500 });
  return incident;
}

export async function finalizeIncident(incidentId: string): Promise<StoredIncident | undefined> {
  const inc = await getIncident(incidentId);
  if (!inc || inc.status !== 'collecting') return inc;
  if (Date.now() < inc.postUntil) return inc; // alarm fired early; the other path will finish
  try {
    const settings = await loadSettings();
    const start = inc.triggerAt - settings.preWindowMs;
    const end = inc.postUntil;
    const win = await readWindow(inc.tabId, start, end);
    const rr = settings.domReplay ? await readRrweb(inc.tabId, start, end) : [];
    const info = await getPageInfo(inc.tabId);

    const artifacts: Artifact[] = [];
    const shot = await getBlob(`${incidentId}:screenshot`);
    if (shot) artifacts.push(artifact(`${incidentId}:screenshot`, 'screenshot', 'screenshot.png', 'image/png', shot.size, 'not-applicable'));
    if (rr.length) {
      const rrBlob = new Blob([JSON.stringify(rr)], { type: 'application/json' });
      await putBlob(`${incidentId}:rrweb`, incidentId, rrBlob);
      artifacts.push(artifact(`${incidentId}:rrweb`, 'rrweb', 'replay.rrweb.json', 'application/json', rrBlob.size, settings.maskAllInputs ? 'redacted' : 'unredacted', { start, end }));
    }

    const raw: RawBrowserIncident = {
      incidentId,
      triggerAt: inc.triggerAt,
      preWindowMs: settings.preWindowMs,
      postWindowMs: settings.postWindowMs,
      userNote: inc.note,
      tab: { id: inc.tabId, url: info?.url ?? inc.tab.url, title: info?.title ?? inc.tab.title },
      page: info ? { viewport: info.viewport, locale: info.locale, timezone: info.timezone, online: info.online, appVersion: info.appVersion } : undefined,
      userAgent: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      environmentName: settings.environmentName || undefined,
      appName: appNameFor(inc.tab.url, settings),
      exchanges: win.exchanges,
      console: win.console,
      errors: win.errors,
      interactions: win.interactions,
      navigation: win.navigation,
      artifacts,
      redactionCounts: { ...redactionTotals },
      redactionRulesVersion: RULES_VERSION,
    };

    const { context, draft } = await process(normalizeBrowserIncident(raw), settings);
    const withText = await writeTextArtifacts({ ...inc, context, draft });
    await putIncident({ ...inc, status: 'ready', context: withText.context, draft: withText.draft });
    void chrome.alarms.clear(`tl-finalize:${incidentId}`);
    return getIncident(incidentId);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    console.error('[TL] finalize failed', e);
    await putIncident({ ...inc, status: 'error', error: msg });
    return getIncident(incidentId);
  }
}

async function process(ctx: BugContext, settings: Settings, focal?: { kind: FocalEvent['kind']; refId: string }, keepIncludes?: Record<string, boolean>) {
  const rules = mergeRules(DEFAULT_RULES, { sensitiveKeys: settings.redaction.extraKeys, patterns: settings.redaction.extraPatterns.map((p) => ({ ...p, flags: 'g' })), maxBodyBytes: settings.maxBodyBytes });
  const redacted = redactContext(ctx, rules);
  const engineOpts = { telemetryHosts: [...DEFAULT_ENGINE_OPTIONS.telemetryHosts, ...settings.telemetryHostsExtra] };
  const analyzed = runEvidenceEngine(redacted, engineOpts, focal);
  if (keepIncludes && analyzed.evidence) {
    for (const it of analyzed.evidence.items) {
      const k = `${it.kind}:${it.refId}`;
      if (k in keepIncludes) it.include = keepIncludes[k]!;
    }
  }
  const draft = compose(analyzed, { traceLinkTemplates: settings.traceLinkTemplates });
  return { context: analyzed, draft };
}

/** Re-run engine (e.g. tester picked a different focal event). Preserves artifact include flags. */
export async function rerunEngine(incidentId: string, focal?: { kind: FocalEvent['kind']; refId: string }): Promise<StoredIncident | undefined> {
  const inc = await getIncident(incidentId);
  if (!inc?.context) return inc;
  const settings = await loadSettings();
  const includes = Object.fromEntries(inc.context.artifacts.map((a) => [a.id, a.include]));
  const base: BugContext = { ...inc.context, evidence: undefined, redaction: { ...inc.context.redaction, appliedAt: ['capture'] } };
  const { context, draft } = await process(base, settings, focal);
  context.artifacts = context.artifacts.map((a) => ({ ...a, include: includes[a.id] ?? a.include }));
  const withText = await writeTextArtifacts({ ...inc, context, draft });
  await putIncident({ ...inc, context: withText.context, draft: withText.draft });
  return getIncident(incidentId);
}

export async function patchIncident(incidentId: string, patch: IncidentPatch): Promise<StoredIncident | undefined> {
  const inc = await getIncident(incidentId);
  if (!inc) return undefined;
  let changedEvidence = false;
  if (inc.context && patch.artifactIncludes) {
    inc.context.artifacts = inc.context.artifacts.map((a) => (a.id in patch.artifactIncludes! ? { ...a, include: patch.artifactIncludes![a.id]! } : a));
  }
  if (inc.context?.evidence && patch.itemIncludes) {
    for (const it of inc.context.evidence.items) {
      const k = `${it.kind}:${it.refId}`;
      if (k in patch.itemIncludes) {
        it.include = patch.itemIncludes[k]!;
        changedEvidence = true;
      }
    }
  }
  if (patch.note !== undefined) inc.note = patch.note;
  if (changedEvidence && inc.context) {
    // Recompose derived sections but keep user-edited summary/steps/expected/actual if they were edited.
    const settings = await loadSettings();
    const fresh = compose(inc.context, { traceLinkTemplates: settings.traceLinkTemplates });
    inc.draft = { ...fresh, ...(inc.draft ? pickUserEdited(inc.draft, fresh) : {}) };
  }
  if (patch.draft && inc.draft) inc.draft = { ...inc.draft, ...patch.draft };
  if (inc.context && inc.draft) {
    const withText = await writeTextArtifacts(inc as StoredIncident & { context: BugContext; draft: BugDraft });
    inc.context = withText.context;
    inc.draft = withText.draft;
  }
  await putIncident(inc);
  return inc;
}

function pickUserEdited(current: BugDraft, fresh: BugDraft): Partial<BugDraft> {
  const out: Partial<BugDraft> = {};
  if (current.summary !== fresh.summary) out.summary = current.summary;
  if (current.expectedResult !== fresh.expectedResult) out.expectedResult = current.expectedResult;
  if (current.actualResult !== fresh.actualResult) out.actualResult = current.actualResult;
  if (JSON.stringify(current.stepsToReproduce) !== JSON.stringify(fresh.stepsToReproduce)) out.stepsToReproduce = current.stepsToReproduce;
  if (JSON.stringify(current.labels) !== JSON.stringify(fresh.labels)) out.labels = current.labels;
  return out;
}

// ---------------------------------------------------------------------------
// Text artifacts (regenerated whenever the context changes)
// ---------------------------------------------------------------------------

async function writeTextArtifacts(inc: StoredIncident & { context: BugContext; draft: BugDraft }): Promise<{ context: BugContext; draft: BugDraft }> {
  const ctx = inc.context;
  const id = inc.incidentId;
  const includes = Object.fromEntries(ctx.artifacts.map((a) => [a.kind, a.include]));
  const keep = ctx.artifacts.filter((a) => a.kind === 'screenshot' || a.kind === 'rrweb' || a.kind === 'video');
  const text: Artifact[] = [];
  const add = async (kind: Artifact['kind'], fileName: string, mime: string, content: string, defaultInclude = true) => {
    const blob = new Blob([content], { type: mime });
    const aid = `${id}:${kind}`;
    await putBlob(aid, id, blob);
    text.push({ ...artifact(aid, kind, fileName, mime, blob.size, 'redacted'), include: includes[kind] ?? defaultInclude });
  };
  await add('console-log', 'console.log', 'text/plain', buildConsoleLog(ctx));
  await add('network-log', 'network.log', 'text/plain', buildNetworkLog(ctx));
  await add('har-focused', 'network-focused.har', 'application/json', buildHar(ctx, selectedExchangeIds(ctx)));
  await add('har', 'network-full.har', 'application/json', buildHar(ctx), false);

  // viewer: embed screenshot + rrweb
  const shot = await getBlob(`${id}:screenshot`);
  const rr = await getBlob(`${id}:rrweb`);
  const screenshotDataUrl = shot ? await blobToDataUrl(shot) : undefined;
  const rrwebEvents = rr ? (JSON.parse(await rr.text()) as unknown[]) : undefined;
  const ctxForViewer: BugContext = { ...ctx, artifacts: [...keep, ...text] };
  const draftForViewer = withEvidenceIndex(inc.draft, ctxForViewer);
  await add('incident-viewer', 'testlens-incident.html', 'text/html', renderViewerHtml(ctxForViewer, draftForViewer, { screenshotDataUrl, rrwebEvents }));

  const finalCtx: BugContext = { ...ctx, artifacts: [...keep, ...text] };
  return { context: finalCtx, draft: withEvidenceIndex(inc.draft, finalCtx) };
}

export async function artifactBlobs(inc: StoredIncident, onlyIncluded = true): Promise<{ artifact: Artifact; blob: Blob }[]> {
  const out: { artifact: Artifact; blob: Blob }[] = [];
  for (const a of inc.context?.artifacts ?? []) {
    if (onlyIncluded && !a.include) continue;
    const blob = await getBlob(a.storage.ref);
    if (blob) out.push({ artifact: a, blob });
  }
  return out;
}

function artifact(id: string, kind: Artifact['kind'], fileName: string, mime: string, bytes: number, status: Artifact['redaction']['status'], timeRange?: { start: number; end: number }): Artifact {
  return { id, kind, fileName, mime, bytes, storage: { type: 'indexeddb', ref: id }, redaction: { status, rulesApplied: status === 'redacted' ? ['default'] : [] }, include: true, timeRange };
}

function appNameFor(url: string, s: Settings) {
  try {
    return s.appNames[new URL(url).origin];
  } catch {
    return undefined;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}
