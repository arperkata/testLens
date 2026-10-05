/**
 * @testlens/composer — deterministic BugDraft composition (no AI).
 *
 * Every section carries provenance: 'captured' (verbatim evidence), 'derived'
 * (computed by the evidence engine / composer), 'ai' (optional analysis),
 * 'user' (edited in the review UI).
 */
import type { BugContext, BugDraft, BugDraftSection, HttpExchange, InteractionEntry, NavigationEntry } from '@testlens/schema';
import { focalSignature, pathOf } from '@testlens/evidence-engine';

export const COMPOSER_VERSION = '1.0.0';

export interface ComposerOptions {
  /** URL templates for backend trace links, e.g. { 'x-request-id': 'https://logs.example.com/search?q={value}' } */
  traceLinkTemplates?: Record<string, string>;
  maxBodyPreviewChars?: number;
  maxConsoleLines?: number;
  maxSteps?: number;
}

export function compose(ctx: BugContext, opts: ComposerOptions = {}): BugDraft {
  const maxBody = opts.maxBodyPreviewChars ?? 1200;
  const maxConsole = opts.maxConsoleLines ?? 10;
  const maxSteps = opts.maxSteps ?? 12;

  const focal = ctx.evidence?.focal;
  const focalExchange = focal?.kind === 'exchange' ? ctx.exchanges.find((e) => e.id === focal.refId) : undefined;
  const focalError = focal?.kind === 'error' ? ctx.errors.find((e) => e.id === focal.refId) : undefined;
  const focalAssertion = focal?.kind === 'assertion' ? ctx.assertions.find((a) => a.id === focal.refId) : undefined;
  const focalConsole = focal?.kind === 'console' ? ctx.console.find((c) => c.id === focal.refId) : undefined;

  const page = ctx.application.title ? `"${ctx.application.title}"` : ctx.application.url ? pathOf(ctx.application.url) : 'the page';

  // ----- summary -----
  let summary: string;
  if (focalExchange) {
    const st = focalExchange.error ? `fails (${focalExchange.error.kind})` : `returns ${focalExchange.response?.status}`;
    summary = `${focalExchange.method.toUpperCase()} ${pathOf(focalExchange.url)} ${st} on ${page}`;
  } else if (focalError) {
    summary = `JavaScript ${focalError.kind === 'unhandledrejection' ? 'unhandled rejection' : 'error'}: ${firstLine(focalError.message, 90)} on ${page}`;
  } else if (focalAssertion) {
    summary = `Assertion failed: ${firstLine(focalAssertion.name, 100)}`;
  } else if (focalConsole) {
    summary = `Console error: ${firstLine(focalConsole.args.join(' '), 100)} on ${page}`;
  } else {
    summary = `Issue reported on ${page}`;
  }
  if (ctx.trigger.userNote) summary = `${firstLine(ctx.trigger.userNote, 80)} — ${summary}`;

  // ----- steps -----
  const steps = deriveSteps(ctx, maxSteps);

  // ----- expected / actual -----
  let expected = '';
  let actual = '';
  if (focalExchange) {
    const path = pathOf(focalExchange.url);
    const prior = ctx.exchanges.filter((e) => e.id !== focalExchange.id && e.method === focalExchange.method && pathOf(e.url) === path && e.response && e.response.status < 400);
    expected = prior.length
      ? `${focalExchange.method.toUpperCase()} ${path} responds successfully (observed ${prior[0]!.response!.status} on ${prior.length} earlier call(s) in the same session) and the UI completes the action.`
      : `${focalExchange.method.toUpperCase()} ${path} responds successfully and the UI completes the action.`;
    actual = focalExchange.error
      ? `The request failed at network level (${focalExchange.error.kind}${focalExchange.error.message ? `: ${focalExchange.error.message}` : ''}).`
      : `The request returned HTTP ${focalExchange.response?.status}${focalExchange.response?.statusText ? ` ${focalExchange.response.statusText}` : ''}${focalExchange.timing ? ` after ${Math.round(focalExchange.timing.totalMs)} ms` : ''}.`;
    // only errors that happened after the request started (and soon after) count as consequences
    const relatedErr = ctx.errors.find((e) => e.ts >= focalExchange.ts && e.ts - focalExchange.ts < 5000);
    if (relatedErr) actual += ` A JavaScript ${relatedErr.kind === 'unhandledrejection' ? 'unhandled rejection' : relatedErr.kind + ' error'} followed: ${firstLine(relatedErr.message, 120)}`;
  } else if (focalError) {
    expected = 'The page operates without JavaScript errors.';
    actual = `${focalError.kind}: ${firstLine(focalError.message, 200)}`;
  } else if (focalAssertion) {
    expected = focalAssertion.expected ?? `Assertion "${focalAssertion.name}" passes.`;
    actual = focalAssertion.actual ?? focalAssertion.message ?? 'Assertion failed.';
  } else {
    expected = '<describe the expected behaviour>';
    actual = ctx.trigger.userNote ?? '<describe what happened>';
  }

  // ----- sections -----
  const sections: BugDraftSection[] = [];

  if (ctx.trigger.userNote) sections.push({ id: 'tester-note', title: "Tester's note", body: ctx.trigger.userNote, provenance: 'user' });

  sections.push({ id: 'environment', title: 'Environment', body: environmentBlock(ctx), provenance: 'captured' });

  if (focalExchange) {
    sections.push({ id: 'failed-request', title: 'Failed request', body: exchangeBlock(focalExchange, maxBody), provenance: 'captured', code: true });
    const links = traceLinks(focalExchange, opts.traceLinkTemplates);
    if (links.length) sections.push({ id: 'trace-links', title: 'Backend trace links', body: links.join('\n'), provenance: 'derived' });
    sections.push({ id: 'curl', title: 'Reproduce request (cURL, secrets masked)', body: toCurl(focalExchange), provenance: 'derived', code: true });
  }
  if (focalError) sections.push({ id: 'error-details', title: 'Error details', body: `${focalError.message}\n${focalError.stack ?? ''}`.trim(), provenance: 'captured', code: true });
  if (focalAssertion) sections.push({ id: 'assertion', title: 'Assertion', body: `${focalAssertion.name}\nexpected: ${focalAssertion.expected ?? '-'}\nactual:   ${focalAssertion.actual ?? '-'}\n${focalAssertion.message ?? ''}`.trim(), provenance: 'captured', code: true });

  const consoleLines = relatedConsole(ctx, maxConsole);
  if (consoleLines) sections.push({ id: 'console', title: 'Related console output', body: consoleLines, provenance: 'captured', code: true });

  const related = relatedExchanges(ctx, focalExchange);
  if (related) sections.push({ id: 'related-requests', title: 'Related requests', body: related, provenance: 'derived', code: true });

  if (ctx.evidence?.observations.length) sections.push({ id: 'observations', title: 'Observations (derived from captured data)', body: ctx.evidence.observations.map((o) => `• ${o}`).join('\n'), provenance: 'derived' });

  if (ctx.analysis) {
    const a = ctx.analysis;
    const body = [a.technicalAnalysis, a.possibleComponent ? `Possible component: ${a.possibleComponent}` : '', `Confidence: ${a.confidence}`, ...a.caveats.map((c) => `⚠ ${c}`)].filter(Boolean).join('\n');
    sections.push({ id: 'ai-analysis', title: `AI analysis (${a.provider}/${a.model}) — not verified`, body, provenance: 'ai' });
  }

  sections.push({ id: 'evidence-index', title: 'Evidence attached', body: evidenceIndex(ctx), provenance: 'derived' });

  const labels = ['testlens'];
  if (ctx.environment.name) labels.push(slug(ctx.environment.name));
  if (focalExchange?.response && focalExchange.response.status >= 500) labels.push('server-error');
  if (focalError) labels.push('js-error');

  return {
    summary: summary.slice(0, 250),
    stepsToReproduce: steps,
    expectedResult: expected,
    actualResult: actual,
    sections,
    labels,
    environmentSummary: envOneLine(ctx),
    focalSignature: focalSignature(ctx),
  };
}

// ---------------------------------------------------------------------------

export function deriveSteps(ctx: BugContext, max: number): string[] {
  const window = ctx.evidence?.window;
  const start = window ? window.start - 60_000 : ctx.trigger.at - 120_000;
  const end = ctx.trigger.at;
  const events: { ts: number; text: string }[] = [];

  const firstNav = [...ctx.navigation].sort((a, b) => a.ts - b.ts).find((n) => n.ts <= end);
  for (const n of ctx.navigation) if (n.ts >= start && n.ts <= end) events.push({ ts: n.ts, text: navText(n) });
  for (const i of ctx.interactions) if (i.ts >= start && i.ts <= end && (i.kind === 'click' || i.kind === 'submit' || i.kind === 'change' || i.kind === 'input')) events.push({ ts: i.ts, text: interactionText(i) });

  events.sort((a, b) => a.ts - b.ts);
  // collapse consecutive inputs on the same field
  const collapsed: { ts: number; text: string }[] = [];
  for (const e of events) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.text === e.text) continue;
    collapsed.push(e);
  }
  let steps = collapsed.map((e) => e.text);
  if (steps.length > max) steps = ['…', ...steps.slice(steps.length - (max - 1))];
  const openStep = ctx.application.url ? `Open ${firstNav && firstNav.ts < start ? firstNav.to : ctx.application.url}` : undefined;
  if (openStep && !steps.some((s) => s.startsWith('Navigate') || s.startsWith('Open'))) steps.unshift(openStep);
  steps.push('Observe the failure (see Actual result).');
  return steps;
}

function navText(n: NavigationEntry) {
  switch (n.kind) {
    case 'load':
    case 'committed':
      return `Navigate to ${n.to}`;
    case 'reload':
      return `Reload ${n.to}`;
    default:
      return `Route changes to ${pathOf(n.to)}${n.title ? ` (${n.title})` : ''}`;
  }
}

function interactionText(i: InteractionEntry) {
  const label = i.target.text?.trim() || i.target.name || i.target.role || i.target.tag;
  const what = `"${firstLine(label, 50)}"${i.target.text ? '' : ` (${i.target.selector})`}`;
  switch (i.kind) {
    case 'click':
      return `Click ${what}`;
    case 'submit':
      return `Submit form ${what}`;
    case 'change':
    case 'input':
      return `Enter a value in ${what}${i.valueMasked ? ' (value masked)' : ''}`;
    default:
      return `${i.kind} on ${what}`;
  }
}

function environmentBlock(ctx: BugContext) {
  const rows: [string, string | undefined][] = [
    ['Environment', ctx.environment.name],
    ['Application', ctx.application.name],
    ['URL', ctx.application.url],
    ['Page title', ctx.application.title],
    ['App version', ctx.application.version],
    ['Browser', ctx.browser ? `${ctx.browser.name} ${ctx.browser.version}` : undefined],
    ['Viewport', ctx.browser ? `${ctx.browser.viewport.width}×${ctx.browser.viewport.height}${ctx.browser.viewport.dpr ? ` @${ctx.browser.viewport.dpr}x` : ''}` : undefined],
    ['OS', ctx.environment.os ? `${ctx.environment.os.name} ${ctx.environment.os.version ?? ''}`.trim() : undefined],
    ['Locale / TZ', [ctx.environment.locale, ctx.environment.timezone].filter(Boolean).join(' / ') || undefined],
    ['Reported at', new Date(ctx.trigger.at).toISOString()],
    ['Capture window', `-${Math.round(ctx.trigger.preWindowMs / 60000)} min / +${Math.round(ctx.trigger.postWindowMs / 1000)} s`],
    ['Source', `${ctx.source.tool.name}${ctx.source.tool.version ? ` ${ctx.source.tool.version}` : ''} via TestLens ${ctx.source.connectorId} connector ${ctx.source.connectorVersion}`],
  ];
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function envOneLine(ctx: BugContext) {
  return [ctx.browser ? `${ctx.browser.name} ${ctx.browser.version}` : ctx.source.tool.name, ctx.environment.os?.name, ctx.environment.name].filter(Boolean).join(' · ');
}

export function exchangeBlock(e: HttpExchange, maxBody: number) {
  const lines: string[] = [];
  lines.push(`${e.method.toUpperCase()} ${e.url}`);
  lines.push(`→ ${e.error ? `FAILED ${e.error.kind}${e.error.message ? `: ${e.error.message}` : ''}` : `HTTP ${e.response?.status}${e.response?.statusText ? ` ${e.response.statusText}` : ''}`}${e.timing ? `  (${Math.round(e.timing.totalMs)} ms)` : ''}`);
  lines.push(`at ${new Date(e.ts).toISOString()}${e.initiator ? `  initiator: ${e.initiator.type}` : ''}`);
  if (e.correlationIds.length) lines.push(`>>> correlation: ${e.correlationIds.map((c) => `${c.header}=${c.value}`).join(', ')}`);
  const corr = new Set(e.correlationIds.map((c) => c.header.toLowerCase()));
  const hdr = (hs: { name: string; value: string }[]) => (hs.length ? hs.map((h) => `${corr.has(h.name.toLowerCase()) ? '>>> ' : '    '}${h.name}: ${h.value}`) : ['    (none captured)']);
  lines.push('', '--- request headers', ...hdr(e.request.headers));
  lines.push('', `--- request payload (${e.bodyCapture.request}${e.request.body?.mimeType ? `, ${e.request.body.mimeType}` : ''})`, indent(e.request.body ? preview(e.request.body.data, maxBody) : `<${e.bodyCapture.request}>`));
  if (e.response) {
    lines.push('', `--- response headers (${e.response.status})`, ...hdr(e.response.headers));
    lines.push('', `--- response body (${e.bodyCapture.response}${e.response.mimeType ? `, ${e.response.mimeType}` : ''})`, indent(e.response.body ? preview(e.response.body.data, maxBody) : `<${e.bodyCapture.response}>`));
  }
  return lines.join('\n');
}

export function toCurl(e: HttpExchange): string {
  const parts = [`curl -X ${e.method.toUpperCase()} '${e.url.replace(/'/g, "'\\''")}'`];
  for (const h of e.request.headers) {
    if (/^(content-length|host|connection|accept-encoding|sec-|:)/i.test(h.name)) continue;
    parts.push(`  -H '${h.name}: ${h.value.replace(/'/g, "'\\''")}'`);
  }
  if (e.request.body && e.request.body.encoding !== 'base64') parts.push(`  --data-raw '${e.request.body.data.replace(/'/g, "'\\''")}'`);
  else if (e.request.body) parts.push(`  # request body omitted (binary, ${e.request.bodyBytes ?? '?'} bytes)`);
  return parts.join(' \\\n');
}

function traceLinks(e: HttpExchange, templates?: Record<string, string>) {
  if (!templates) return [];
  const out: string[] = [];
  for (const c of e.correlationIds) {
    const t = templates[c.header] ?? templates['*'];
    if (t) out.push(`${c.header}=${c.value}: ${t.replace('{value}', encodeURIComponent(c.value)).replace('{header}', c.header)}`);
  }
  return out;
}

function relatedConsole(ctx: BugContext, max: number) {
  const ids = new Set((ctx.evidence?.items ?? []).filter((i) => i.include && (i.kind === 'console' || i.kind === 'error')).map((i) => i.refId));
  const rows: { ts: number; line: string }[] = [];
  for (const c of ctx.console) if (ids.has(c.id)) rows.push({ ts: c.ts, line: `${hhmmss(c.ts)} console.${c.level}: ${firstLine(c.args.join(' '), 300)}` });
  for (const e of ctx.errors) if (ids.has(e.id)) rows.push({ ts: e.ts, line: `${hhmmss(e.ts)} ${e.kind}: ${firstLine(e.message, 300)}${e.stack ? `\n    ${firstLine(e.stack.split('\n').slice(1, 3).join(' | '), 300)}` : ''}` });
  rows.sort((a, b) => a.ts - b.ts);
  const sliced = rows.length > max ? rows.slice(rows.length - max) : rows;
  if (!sliced.length) return undefined;
  return (rows.length > max ? [`… ${rows.length - max} earlier line(s) in console.log attachment`] : []).concat(sliced.map((r) => r.line)).join('\n');
}

function relatedExchanges(ctx: BugContext, focal?: HttpExchange) {
  const items = (ctx.evidence?.items ?? []).filter((i) => i.include && i.kind === 'exchange' && i.refId !== focal?.id).slice(0, 8);
  if (!items.length) return undefined;
  const lines = items.map((it) => {
    const e = ctx.exchanges.find((x) => x.id === it.refId)!;
    const st = e.error ? `ERR ${e.error.kind}` : String(e.response?.status ?? '-');
    return `${hhmmss(e.ts)} ${st.padEnd(7)} ${e.method.toUpperCase().padEnd(6)} ${pathOf(e.url)}  — ${it.reasons[0] ?? ''}`;
  });
  return lines.join('\n');
}

/** Rebuild the "Evidence attached" section once the final artifact list is known. */
export function withEvidenceIndex(draft: BugDraft, ctx: BugContext): BugDraft {
  const section: BugDraftSection = { id: 'evidence-index', title: 'Evidence attached', body: evidenceIndex(ctx), provenance: 'derived' };
  const idx = draft.sections.findIndex((s) => s.id === 'evidence-index');
  const sections = idx >= 0 ? draft.sections.map((s, i) => (i === idx ? section : s)) : [...draft.sections, section];
  return { ...draft, sections };
}

function evidenceIndex(ctx: BugContext) {
  const inc = ctx.artifacts.filter((a) => a.include);
  const exc = ctx.artifacts.filter((a) => !a.include);
  const q = ctx.evidence?.captureQuality;
  const lines = inc.map((a) => `• ${a.fileName} (${a.kind}, ${kb(a.bytes)})`);
  if (exc.length) lines.push(`Not attached by tester's choice: ${exc.map((a) => a.fileName).join(', ')}`);
  if (q) lines.push(`Capture quality: ${q.score}/100${q.notes.length ? ` — ${q.notes.join(' ')}` : ''}`);
  return lines.join('\n');
}

// utils
function firstLine(s: string, n: number) {
  const l = (s.split('\n')[0] ?? '').trim();
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
}
function preview(s: string, n: number) {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n… (${s.length - n} more chars; full body in HAR)`;
}
function indent(s: string) {
  return s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}
function hhmmss(ts: number) {
  return new Date(ts).toISOString().slice(11, 23);
}
function kb(b: number) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
