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
// Provider presets (what the settings UI offers)
// ---------------------------------------------------------------------------

export interface ProviderPreset {
  id: string;
  displayName: string;
  /** 'free' = free tier available with a key; 'local' = runs on the tester's machine; 'paid' */
  tier: 'free' | 'local' | 'paid';
  baseUrl: string;
  defaultModel: string;
  /** Where to get a key; undefined when no key is needed. */
  keyUrl?: string;
  needsKey: boolean;
  /** How JSON output is requested from an OpenAI-compatible endpoint. */
  jsonMode: 'json_schema' | 'json_object' | 'native-gemini';
  blurb: string;
  /** Data-handling note shown in the UI. */
  dataNote: string;
  recommended?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gemini',
    displayName: 'Google Gemini (free tier)',
    tier: 'free',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    needsKey: true,
    jsonMode: 'native-gemini',
    blurb: 'Free API key from Google AI Studio with a generous daily quota; good quality for bug writing.',
    dataNote: 'On the free tier Google may use prompts to improve its products. Fine for QA/staging data; avoid production personal data or use Ollama instead.',
  },
  {
    id: 'groq',
    displayName: 'Groq (free tier)',
    tier: 'free',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    jsonMode: 'json_object',
    blurb: 'Very fast hosted open models (Llama 3.3 70B) with a free tier that is enough for everyday bug writing.',
    dataNote: 'Prompts are processed by Groq and, per their policy, not used to train models; check the policy for your organisation.',
    recommended: true,
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter (free models)',
    tier: 'free',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    jsonMode: 'json_object',
    blurb: 'One key, many models; models ending in ":free" cost nothing.',
    dataNote: 'Free models may log prompts; see the model card on OpenRouter.',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (local, no key)',
    tier: 'local',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1:8b',
    keyUrl: 'https://ollama.com/download',
    needsKey: false,
    jsonMode: 'json_object',
    blurb: 'Runs entirely on this machine. Install Ollama, run "ollama pull llama3.1:8b", keep it running.',
    dataNote: 'Nothing leaves your computer. Best choice for sensitive data; quality depends on the local model.',
  },
  {
    id: 'openai',
    displayName: 'OpenAI (paid)',
    tier: 'paid',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    jsonMode: 'json_schema',
    blurb: 'Pay-per-use; strongest structured output support.',
    dataNote: 'API data is not used for training by default; see OpenAI’s API data policy.',
  },
];

export function getPreset(id: string): ProviderPreset {
  const p = PROVIDER_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown AI provider "${id}"`);
  return p;
}

// ---------------------------------------------------------------------------
// Shared parsing of the model's JSON into Analysis
// ---------------------------------------------------------------------------

async function toAnalysis(content: string, providerId: string, model: string, input: AnalysisInput): Promise<Analysis> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  } catch {
    throw new Error(`${providerId} returned non-JSON content`);
  }
  const str = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : '');
  const arr = (k: string) => (Array.isArray(parsed[k]) ? (parsed[k] as unknown[]).map(String).map((s) => s.trim()).filter(Boolean) : []);
  const confidence = (['low', 'medium', 'high'] as const).includes(parsed.confidence as never) ? (parsed.confidence as 'low' | 'medium' | 'high') : 'low';
  return {
    provenance: 'ai',
    provider: providerId,
    model,
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

/** Models in json_object mode sometimes wrap JSON in prose or code fences. */
function extractJson(s: string): string {
  const t = s.trim();
  if (t.startsWith('{')) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

function userPrompt(input: AnalysisInput, includeSchemaInPrompt: boolean) {
  const schemaHint = includeSchemaInPrompt ? `\n\nRespond with ONLY a JSON object matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(ANALYSIS_JSON_SCHEMA)}` : '';
  return `Evidence (JSON):\n${JSON.stringify(input)}${schemaHint}`;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (OpenAI, Groq, OpenRouter, Ollama, gateways)
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements IAnalysisProvider {
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly jsonMode: 'json_schema' | 'json_object',
    private readonly needsKey = true,
  ) {}

  private headers(cfg: AnalysisProviderConfig): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    if (this.id === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/testlens';
      h['X-Title'] = 'TestLens';
    }
    return h;
  }

  async analyze(input: AnalysisInput, cfg: AnalysisProviderConfig): Promise<Analysis> {
    if (this.needsKey && !cfg.apiKey) throw new Error(`${this.displayName}: API key is required`);
    const body: Record<string, unknown> = {
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(input, this.jsonMode === 'json_object') },
      ],
      response_format: this.jsonMode === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'testlens_analysis', strict: true, schema: ANALYSIS_JSON_SCHEMA } } : { type: 'json_object' },
    };
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: this.headers(cfg), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await describeHttpError(res, this.displayName));
    const json = (await res.json()) as { model?: string; choices?: { message?: { content?: string; refusal?: string } }[] };
    const msg = json.choices?.[0]?.message;
    if (msg?.refusal) throw new Error(`${this.displayName} refused: ${msg.refusal}`);
    if (!msg?.content) throw new Error(`${this.displayName} returned no content`);
    return toAnalysis(msg.content, this.id, json.model ?? cfg.model, input);
  }

  async test(cfg: AnalysisProviderConfig) {
    if (this.needsKey && !cfg.apiKey) throw new Error(`${this.displayName}: API key is required`);
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, { headers: this.headers(cfg) });
    if (!res.ok) throw new Error(await describeHttpError(res, this.displayName));
    const j = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    const ids = (j.data ?? []).map((m) => m.id).concat((j.models ?? []).map((m) => m.name));
    if (ids.length && !ids.some((m) => m === cfg.model || m.startsWith(`${cfg.model}:`) || cfg.model.startsWith(m))) {
      throw new Error(`${this.displayName}: model "${cfg.model}" not found. Available: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}`);
    }
    return { ok: true as const, model: cfg.model };
  }
}

/** Backwards-compatible alias. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor() {
    super('openai', 'OpenAI', 'json_schema');
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (native generateContent with a response schema)
// ---------------------------------------------------------------------------

export class GeminiProvider implements IAnalysisProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini';

  async analyze(input: AnalysisInput, cfg: AnalysisProviderConfig): Promise<Analysis> {
    if (!cfg.apiKey) throw new Error('Gemini: API key is required');
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(input, false) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: geminiSchema() },
    };
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await describeHttpError(res, 'Gemini'));
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    if (json.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error('Gemini returned no content');
    return toAnalysis(text, this.id, cfg.model, input);
  }

  async test(cfg: AnalysisProviderConfig) {
    if (!cfg.apiKey) throw new Error('Gemini: API key is required');
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model)}`, { headers: { 'x-goog-api-key': cfg.apiKey } });
    if (!res.ok) throw new Error(await describeHttpError(res, 'Gemini'));
    const j = (await res.json()) as { name?: string };
    return { ok: true as const, model: j.name?.replace(/^models\//, '') ?? cfg.model };
  }
}

/** Gemini's response schema dialect (OpenAPI subset): no additionalProperties, enums as strings. */
function geminiSchema() {
  return {
    type: 'OBJECT',
    required: [...ANALYSIS_JSON_SCHEMA.required],
    properties: {
      summary: { type: 'STRING' },
      stepsToReproduce: { type: 'ARRAY', items: { type: 'STRING' } },
      expectedResult: { type: 'STRING' },
      actualResult: { type: 'STRING' },
      technicalAnalysis: { type: 'STRING' },
      possibleComponent: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
      caveats: { type: 'ARRAY', items: { type: 'STRING' } },
    },
  };
}

async function describeHttpError(res: Response, tool: string): Promise<string> {
  let msg = '';
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string | number; status?: string } | string };
    msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.error?.status ?? '');
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) return `${tool} ${res.status}: invalid API key or no access${msg ? ` (${msg})` : ''}`;
  if (res.status === 404) return `${tool} 404: model not found${msg ? ` (${msg})` : ''}`;
  if (res.status === 429) return `${tool} 429: rate limit or free-tier quota exceeded — wait a minute or pick a smaller model${msg ? ` (${msg})` : ''}`;
  if (res.status === 0 || res.type === 'opaque') return `${tool}: network error (is the server running and the host permitted?)`;
  return `${tool} ${res.status}: ${msg || 'request failed'}`;
}

async function sha256(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return String(s.length);
  }
}

/** Build the provider implementation for a preset id (any OpenAI-compatible gateway can reuse 'openai'/'ollama' style ids). */
export function getProvider(id: string): IAnalysisProvider {
  const preset = getPreset(id);
  if (preset.jsonMode === 'native-gemini') return new GeminiProvider();
  return new OpenAICompatibleProvider(preset.id, preset.displayName, preset.jsonMode, preset.needsKey);
}

export const PROVIDERS: IAnalysisProvider[] = PROVIDER_PRESETS.map((p) => getProvider(p.id));
