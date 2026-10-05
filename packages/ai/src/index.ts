/**
 * @testlens/ai — optional AI analysis layer.
 *
 * Principles: the provider only ever sees a redacted *projection* of the BugContext
 * (`buildAnalysisInput`), the output is structured (`Analysis`) and labelled with
 * provenance 'ai', and nothing is applied to the bug without the tester's click.
 */
import type { Analysis, BugContext, BugDraft } from '@testlens/schema';

// ---------------------------------------------------------------------------
// Projection: what the model is allowed to see
// ---------------------------------------------------------------------------

export interface AnalysisInput {
  application: { name?: string; url?: string; title?: string; version?: string };
  environment: { browser?: string; os?: string; name?: string };
  trigger: { at: string; userNote?: string; preWindowSeconds: number };
  /** Chronological trail of what the tester did, relative to the Report Issue click. */
  actions: { t: string; kind: string; detail: string }[];
  focal?: { kind: string; detail: string; status?: number; method?: string; url?: string; durationMs?: number; responseSnippet?: string; requestSnippet?: string };
  relatedRequests: { t: string; method: string; url: string; status: string; durationMs?: number }[];
  errors: { t: string; kind: string; message: string; stackTop?: string }[];
  consoleErrors: { t: string; level: string; text: string }[];
  observations: string[];
  /** Current deterministic draft, so the model improves rather than restarts. */
  draft: { summary: string; stepsToReproduce: string[]; expectedResult: string; actualResult: string };
}

export interface ProjectionOptions {
  maxActions?: number;
  maxBodySnippetChars?: number;
  maxErrors?: number;
  includeBodies?: boolean;
}

export function buildAnalysisInput(ctx: BugContext, draft: BugDraft, opts: ProjectionOptions = {}): AnalysisInput {
  const maxActions = opts.maxActions ?? 60;
  const snip = opts.maxBodySnippetChars ?? 600;
  const maxErrors = opts.maxErrors ?? 15;
  const t0 = ctx.trigger.at;
  const rel = (ts: number) => {
    const d = (ts - t0) / 1000;
    return `${d <= 0 ? '-' : '+'}${Math.abs(d).toFixed(1)}s`;
  };
  const shortUrl = (u: string) => {
    try {
      const x = new URL(u);
      return x.pathname + (x.search ? x.search.slice(0, 60) : '');
    } catch {
      return u.slice(0, 120);
    }
  };

  const actions: AnalysisInput['actions'] = [];
  for (const n of ctx.navigation) actions.push({ t: rel(n.ts), kind: `navigation:${n.kind}`, detail: `${n.to}${n.title ? ` (${n.title})` : ''}` });
  for (const i of ctx.interactions) {
    const label = i.target.text?.trim() || i.target.name || i.target.role || i.target.tag;
    actions.push({ t: rel(i.ts), kind: i.kind, detail: `${label}${i.target.text ? '' : ` [${i.target.selector}]`}${i.valueMasked ? ' (value masked)' : ''}` });
  }
  actions.sort((a, b) => parseFloat(a.t) - parseFloat(b.t));
  const trimmedActions = actions.length > maxActions ? actions.slice(actions.length - maxActions) : actions;

  const focalRef = ctx.evidence?.focal;
  let focal: AnalysisInput['focal'];
  if (focalRef?.kind === 'exchange') {
    const e = ctx.exchanges.find((x) => x.id === focalRef.refId);
    if (e)
      focal = {
        kind: 'request',
        detail: focalRef.reasons.join('; '),
        method: e.method,
        url: shortUrl(e.url),
        status: e.response?.status,
        durationMs: e.timing ? Math.round(e.timing.totalMs) : undefined,
        responseSnippet: opts.includeBodies === false ? undefined : e.response?.body?.encoding !== 'base64' ? e.response?.body?.data.slice(0, snip) : undefined,
        requestSnippet: opts.includeBodies === false ? undefined : e.request.body?.encoding !== 'base64' ? e.request.body?.data.slice(0, snip) : undefined,
      };
  } else if (focalRef?.kind === 'error') {
    const er = ctx.errors.find((x) => x.id === focalRef.refId);
    if (er) focal = { kind: 'js-error', detail: `${er.kind}: ${er.message.slice(0, 300)}` };
  } else if (focalRef?.kind === 'console') {
    const c = ctx.console.find((x) => x.id === focalRef.refId);
    if (c) focal = { kind: 'console-error', detail: c.args.join(' ').slice(0, 300) };
  }

  const selected = new Set((ctx.evidence?.items ?? []).filter((i) => i.include && i.kind === 'exchange').map((i) => i.refId));
  const relatedRequests = ctx.exchanges
    .filter((e) => selected.has(e.id) && e.id !== focalRef?.refId)
    .slice(0, 12)
    .map((e) => ({ t: rel(e.ts), method: e.method, url: shortUrl(e.url), status: e.error ? `ERR ${e.error.kind}` : String(e.response?.status ?? '-'), durationMs: e.timing ? Math.round(e.timing.totalMs) : undefined }));

  const errors = ctx.errors.slice(-maxErrors).map((e) => ({ t: rel(e.ts), kind: e.kind, message: e.message.slice(0, 300), stackTop: e.stack?.split('\n').slice(1, 3).join(' | ').slice(0, 200) }));
  const consoleErrors = ctx.console.filter((c) => c.level === 'error' || c.level === 'warn').slice(-maxErrors).map((c) => ({ t: rel(c.ts), level: c.level, text: c.args.join(' ').slice(0, 300) }));

  return {
    application: { name: ctx.application.name, url: ctx.application.url, title: ctx.application.title, version: ctx.application.version },
    environment: { browser: ctx.browser ? `${ctx.browser.name} ${ctx.browser.version}` : undefined, os: ctx.environment.os ? `${ctx.environment.os.name} ${ctx.environment.os.version ?? ''}`.trim() : undefined, name: ctx.environment.name },
    trigger: { at: new Date(t0).toISOString(), userNote: ctx.trigger.userNote, preWindowSeconds: Math.round(ctx.trigger.preWindowMs / 1000) },
    actions: trimmedActions,
    focal,
    relatedRequests,
    errors,
    consoleErrors,
    observations: ctx.evidence?.observations ?? [],
    draft: { summary: draft.summary, stepsToReproduce: draft.stepsToReproduce, expectedResult: draft.expectedResult, actualResult: draft.actualResult },
  };
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface AnalysisProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface IAnalysisProvider {
  readonly id: string;
  readonly displayName: string;
  analyze(input: AnalysisInput, cfg: AnalysisProviderConfig): Promise<Analysis>;
  test(cfg: AnalysisProviderConfig): Promise<{ ok: true; model: string } | never>;
}

/** JSON schema the model must return (OpenAI structured outputs, strict). */
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'stepsToReproduce', 'expectedResult', 'actualResult', 'technicalAnalysis', 'possibleComponent', 'confidence', 'caveats'],
  properties: {
    summary: { type: 'string', description: 'One line, ≤ 120 chars, states the failing action and symptom. No speculation.' },
    stepsToReproduce: { type: 'array', items: { type: 'string' }, description: 'Numbered-style steps a developer can follow, derived ONLY from the recorded actions. Merge noise (repeated inputs), name buttons/links by their visible text, include the URL to open first and end with the observed failure.' },
    expectedResult: { type: 'string' },
    actualResult: { type: 'string', description: 'What actually happened, grounded in the focal request/error.' },
    technicalAnalysis: { type: 'string', description: '2–5 sentences for the developer: what failed, where, correlation between actions/requests/errors. Mark hypotheses explicitly as hypotheses.' },
    possibleComponent: { type: 'string', description: 'Likely affected component/endpoint, or empty string.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    caveats: { type: 'array', items: { type: 'string' }, description: 'What is uncertain or could not be determined from the evidence.' },
  },
} as const;

export const SYSTEM_PROMPT = `You are TestLens, an assistant that turns captured browser-testing evidence into a precise bug report.
Rules:
- Use ONLY the evidence provided. Never invent actions, data, or causes. If something is unknown, say so in caveats.
- Steps to reproduce must follow the recorded action trail in order. Drop irrelevant noise (hover, repeated keystrokes, unrelated navigation long before the failure) but keep every action that plausibly leads to the failure.
- Refer to UI elements by their visible text when available.
- Distinguish facts (captured) from hypotheses (your inference). Put hypotheses in technicalAnalysis and label them as such.
- Keep the tester's note in mind: it describes what they saw.
- Output must match the JSON schema exactly.`;

// ---------------------------------------------------------------------------
// OpenAI provider (Chat Completions with structured outputs)
// ---------------------------------------------------------------------------

export class OpenAIProvider implements IAnalysisProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';

  async analyze(input: AnalysisInput, cfg: AnalysisProviderConfig): Promise<Analysis> {
    const body = {
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Evidence (JSON):\n${JSON.stringify(input)}` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'testlens_analysis', strict: true, schema: ANALYSIS_JSON_SCHEMA } },
    };
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await describeOpenAIError(res));
    const json = (await res.json()) as { model?: string; choices?: { message?: { content?: string; refusal?: string } }[] };
    const msg = json.choices?.[0]?.message;
    if (msg?.refusal) throw new Error(`OpenAI refused: ${msg.refusal}`);
    const content = msg?.content;
    if (!content) throw new Error('OpenAI returned no content');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error('OpenAI returned non-JSON content');
    }
    const str = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : '');
    const arr = (k: string) => (Array.isArray(parsed[k]) ? (parsed[k] as unknown[]).map(String).map((s) => s.trim()).filter(Boolean) : []);
    const confidence = (['low', 'medium', 'high'] as const).includes(parsed.confidence as never) ? (parsed.confidence as 'low' | 'medium' | 'high') : 'low';
    return {
      provenance: 'ai',
      provider: this.id,
      model: json.model ?? cfg.model,
      generatedAt: Date.now(),
      inputHash: await sha256(JSON.stringify(input)),
      summary: str('summary') || undefined,
      stepsToReproduce: arr('stepsToReproduce').length ? arr('stepsToReproduce') : undefined,
      expectedResult: str('expectedResult') || undefined,
      actualResult: str('actualResult') || undefined,
      technicalAnalysis: str('technicalAnalysis') || undefined,
      possibleComponent: str('possibleComponent') || undefined,
      confidence,
      caveats: arr('caveats'),
    };
  }

  async test(cfg: AnalysisProviderConfig) {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model)}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (!res.ok) throw new Error(await describeOpenAIError(res));
    const j = (await res.json()) as { id?: string };
    return { ok: true as const, model: j.id ?? cfg.model };
  }
}

async function describeOpenAIError(res: Response): Promise<string> {
  let msg = '';
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string } };
    msg = j.error?.message ?? j.error?.code ?? '';
  } catch {
    /* ignore */
  }
  if (res.status === 401) return 'OpenAI 401: invalid API key';
  if (res.status === 404) return `OpenAI 404: model not found or no access${msg ? ` (${msg})` : ''}`;
  if (res.status === 429) return `OpenAI 429: rate limit or quota exceeded${msg ? ` (${msg})` : ''}`;
  return `OpenAI ${res.status}: ${msg || 'request failed'}`;
}

async function sha256(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return String(s.length);
  }
}

export const PROVIDERS: IAnalysisProvider[] = [new OpenAIProvider()];
export function getProvider(id: string): IAnalysisProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown AI provider "${id}"`);
  return p;
}
