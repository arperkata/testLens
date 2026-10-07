/**
 * Incident pipeline: freeze → normalize → redact → evidence → compose → artifacts.
 */
import type { Artifact, BugContext, BugDraft, FocalEvent } from '@testlens/schema';
import { newId } from '@testlens/schema';
import { normalizeBrowserIncident, type RawBrowserIncident } from '@testlens/connectors-browser';
import { DEFAULT_RULES, RULES_VERSION, mergeRules, redactContext } from '@testlens/redaction';
import { buildConsoleLog, buildHar, buildNetworkLog, runEvidenceEngine, selectedExchangeIds, DEFAULT_ENGINE_OPTIONS } from '@testlens/evidence-engine';
import { compose, withEvidenceIndex } from '@testlens/composer';
import { getBlob, getIncident, putBlob, putIncident, readRrweb, readVideoSegments, readWindow, type StoredIncident } from './buffer/db';
import { loadSettings, type Settings } from './settings';
import type { IncidentPatch, PageInfo } from './messages';
import { renderViewerHtml } from './viewer-template';
import { flushRecording, stopRecording } from './recording';
import { stitchWebm } from './video/stitch';

function hhmmss(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

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
    // seal the running video segment first so footage up to the end of the post-window is on disk
    await flushRecording(inc.tabId);
    const win = await readWindow(inc.tabId, start, end);
    const rr = settings.domReplay ? await readRrweb(inc.tabId, start, end) : [];
    const info = await getPageInfo(inc.tabId);

    const artifacts: Artifact[] = [];
    const shot = await getBlob(`${incidentId}:screenshot`);
    const def = (kind: string) => settings.attachDefaults[kind] ?? true;
    if (shot) artifacts.push(artifact(`${incidentId}:screenshot`, 'screenshot', 'screenshot.png', 'image/png', shot.size, 'not-applicable', undefined, def('screenshot')));

    // Video: stitch the segments overlapping the window into ONE playable file (no re-encoding).
    // If stitching fails for any reason, fall back to attaching the segments individually.
    const segments = await readVideoSegments(inc.tabId, start, end);
    if (segments.length) {
      try {
        const stitched = await stitchWebm(segments.map((s) => ({ blob: s.blob, start: s.start, end: s.end })));
        const id = `${incidentId}:video`;
        await putBlob(id, incidentId, stitched.blob);
        const name = `recording_${hhmmss(stitched.start)}-${hhmmss(stitched.end)}.webm`;
        artifacts.push(artifact(id, 'video', name, 'video/webm', stitched.blob.size, 'unredacted', { start: stitched.start, end: stitched.end }, def('video')));
      } catch (e) {
        inc.warnings = [...(inc.warnings ?? []), `Video stitching failed (${e instanceof Error ? e.message : String(e)}); attaching ${segments.length} segment(s) instead`];
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;
          const id = `${incidentId}:video:${i + 1}`;
          await putBlob(id, incidentId, seg.blob);
          const name = `recording-${String(i + 1).padStart(2, '0')}_${hhmmss(seg.start)}-${hhmmss(seg.end)}.webm`;
          artifacts.push(artifact(id, 'video', name, seg.mime || 'video/webm', seg.blob.size, 'unredacted', { start: seg.start, end: seg.end }, def('video')));
        }
      }
    }
    // Optionally stop the tab recording once the incident has its footage (default: keep rolling for the next issue).
    if (settings.stopVideoAfterReport) void stopRecording(inc.tabId);
    if (rr.length) {
      const rrBlob = new Blob([JSON.stringify(rr)], { type: 'application/json' });
      await putBlob(`${incidentId}:rrweb`, incidentId, rrBlob);
      artifacts.push(artifact(`${incidentId}:rrweb`, 'rrweb', 'replay.rrweb.json', 'application/json', rrBlob.size, settings.maskAllInputs ? 'redacted' : 'unredacted', { start, end }, def('rrweb')));
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
    // Optional AI pass runs after the incident is usable, so a slow or failing provider never blocks review.
    if (settings.ai.enabled && settings.ai.autoRun) {
      void import('./ai')
        .then((m) => m.enhance(incidentId))
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          // Chrome's on-device model may only be reachable from extension pages; the side panel runs it then.
          if (msg === 'RUN_IN_PAGE' || /not downloaded yet/.test(msg)) return;
          const cur = await getIncident(incidentId);
          if (cur) await putIncident({ ...cur, warnings: [...(cur.warnings ?? []), `AI analysis failed: ${msg}`] });
        });
    }
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

/**
 * Create an incident from an already-normalised BugContext (Hub sync, HAR/Newman import).
 * Runs the same redaction → evidence → compose → artifacts pipeline as a browser incident.
 */
export async function createIncidentFromContext(
  ctx: BugContext,
  opts: { origin: 'hub' | 'import'; hubIncidentId?: string; extraArtifacts?: { kind: Artifact['kind']; fileName: string; mime: string; blob: Blob; include?: boolean }[] } = { origin: 'import' },
): Promise<StoredIncident> {
  const settings = await loadSettings();
  const incidentId = ctx.incidentId || newId('inc_');
  const base: StoredIncident = {
    incidentId,
    tabId: -1,
    createdAt: Date.now(),
    triggerAt: ctx.trigger.at,
    postUntil: ctx.trigger.at,
    status: 'collecting',
    tab: { url: ctx.application.url ?? '', title: ctx.application.title ?? ctx.source.tool.name, windowId: -1 },
    note: ctx.trigger.userNote,
    origin: opts.origin,
    hubIncidentId: opts.hubIncidentId,
  };
  await putIncident(base);
  try {
    const artifacts: Artifact[] = [];
    for (const a of opts.extraArtifacts ?? []) {
      const id = `${incidentId}:${a.kind}:${artifacts.length}`;
      await putBlob(id, incidentId, a.blob);
      artifacts.push(artifact(id, a.kind, a.fileName, a.mime, a.blob.size, a.kind === 'raw-connector-payload' ? 'unredacted' : 'redacted', undefined, a.include ?? false));
    }
    const prepared: BugContext = { ...ctx, incidentId, artifacts: [...ctx.artifacts.filter((x) => x.storage.type !== 'hub'), ...artifacts] };
    const { context, draft } = await process(prepared, settings);
    const withText = await writeTextArtifacts({ ...base, context, draft });
    await putIncident({ ...base, status: 'ready', context: withText.context, draft: withText.draft });
    if (settings.ai.enabled && settings.ai.autoRun) {
      void import('./ai')
        .then((m) => m.enhance(incidentId))
        .catch(() => undefined);
    }
  } catch (e) {
    await putIncident({ ...base, status: 'error', error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
  return (await getIncident(incidentId))!;
}

/**
 * Replace the screenshot with an annotated version. The untouched original is kept as an
 * unselected attachment so nothing is lost; the HTML viewer is regenerated with the markup.
 */
export async function replaceScreenshot(incidentId: string, dataUrl: string): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.context || !inc.draft) throw new Error('Incident is not ready');
  if (!/^data:image\/png;base64,/.test(dataUrl)) throw new Error('Expected a PNG data URL');
  const shotId = `${incidentId}:screenshot`;
  const origId = `${incidentId}:screenshot-original`;
  const existing = await getBlob(shotId);
  const artifacts = [...inc.context.artifacts];
  if (existing && !artifacts.some((a) => a.id === origId)) {
    await putBlob(origId, incidentId, existing);
    artifacts.push(artifact(origId, 'file', 'screenshot-original.png', 'image/png', existing.size, 'not-applicable', undefined, false));
  }
  const blob = await (await fetch(dataUrl)).blob();
  await putBlob(shotId, incidentId, blob);
  const idx = artifacts.findIndex((a) => a.id === shotId);
  const annotated = { ...artifact(shotId, 'screenshot', 'screenshot.png', 'image/png', blob.size, 'not-applicable'), include: idx >= 0 ? artifacts[idx]!.include : true };
  if (idx >= 0) artifacts[idx] = annotated;
  else artifacts.unshift(annotated);
  return recomposeIncident({ ...inc, context: { ...inc.context, artifacts } });
}

/**
 * Recompose derived sections (e.g. after an AI analysis arrives) while keeping the tester's
 * summary/steps/expected/actual/labels and the AI-applied markers, then refresh text artifacts.
 */
export async function recomposeIncident(inc: StoredIncident): Promise<StoredIncident> {
  if (!inc.context || !inc.draft) return inc;
  const settings = await loadSettings();
  const fresh = compose(inc.context, { traceLinkTemplates: settings.traceLinkTemplates });
  const draft: BugDraft = {
    ...fresh,
    summary: inc.draft.summary,
    stepsToReproduce: inc.draft.stepsToReproduce,
    expectedResult: inc.draft.expectedResult,
    actualResult: inc.draft.actualResult,
    labels: inc.draft.labels,
    aiApplied: inc.draft.aiApplied,
  };
  const withText = await writeTextArtifacts({ ...inc, context: inc.context, draft });
  const updated: StoredIncident = { ...inc, context: withText.context, draft: withText.draft };
  await putIncident(updated);
  return updated;
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
  const defaults = (await loadSettings()).attachDefaults;
  // keep every artifact that is not regenerated here (screenshot, replay, video, originals, raw payloads…)
  const REGENERATED = new Set(['console-log', 'network-log', 'har-focused', 'har', 'incident-viewer']);
  const keep = ctx.artifacts.filter((a) => !REGENERATED.has(a.kind));
  const text: Artifact[] = [];
  const add = async (kind: Artifact['kind'], fileName: string, mime: string, content: string) => {
    const blob = new Blob([content], { type: mime });
    const aid = `${id}:${kind}`;
    await putBlob(aid, id, blob);
    // keep the tester's earlier choice if the artifact already existed; otherwise apply the configured default
    text.push({ ...artifact(aid, kind, fileName, mime, blob.size, 'redacted'), include: includes[kind] ?? defaults[kind] ?? true });
  };
  await add('console-log', 'console.log', 'text/plain', buildConsoleLog(ctx));
  await add('network-log', 'network.log', 'text/plain', buildNetworkLog(ctx));
  await add('har-focused', 'network-focused.har', 'application/json', buildHar(ctx, selectedExchangeIds(ctx)));
  await add('har', 'network-full.har', 'application/json', buildHar(ctx));

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

function artifact(id: string, kind: Artifact['kind'], fileName: string, mime: string, bytes: number, status: Artifact['redaction']['status'], timeRange?: { start: number; end: number }, include = true): Artifact {
  return { id, kind, fileName, mime, bytes, storage: { type: 'indexeddb', ref: id }, redaction: { status, rulesApplied: status === 'redacted' ? ['default'] : [] }, include, timeRange };
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
