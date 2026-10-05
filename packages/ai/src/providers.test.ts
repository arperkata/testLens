import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvidenceEngine } from '@testlens/evidence-engine';
import { compose } from '@testlens/composer';
import { fixture } from '../../evidence-engine/src/index.test';
import { ChromeBuiltinProvider, GeminiProvider, OpenAICompatibleProvider, PROVIDER_PRESETS, buildAnalysisInput, getPreset, getProvider } from './index';

const ctx = runEvidenceEngine(fixture());
const draft = compose(ctx);
const input = buildAnalysisInput(ctx, draft);

const answer = {
  summary: 'Receipt submit fails with 500',
  stepsToReproduce: ['Open https://app.example.com/checkout', 'Click "Submit receipt"', 'Observe the 500'],
  expectedResult: 'Receipt created',
  actualResult: 'HTTP 500',
  technicalAnalysis: 'Server-side failure after earlier successes.',
  possibleComponent: 'receipt service',
  confidence: 'medium',
  caveats: ['No server logs'],
};

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = handler(u, init ?? {});
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('provider presets', () => {
  it('lists on-device and free-tier providers and recommends the built-in model', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['chrome-builtin', 'gemini', 'groq', 'openrouter', 'ollama', 'openai']));
    expect(PROVIDER_PRESETS.filter((p) => p.tier === 'free').length).toBeGreaterThanOrEqual(3);
    expect(PROVIDER_PRESETS.find((p) => p.recommended)?.id).toBe('chrome-builtin');
    expect(getPreset('ollama').needsKey).toBe(false);
    expect(getPreset('chrome-builtin').needsKey).toBe(false);
  });
  it('builds a provider for every preset', () => {
    for (const p of PROVIDER_PRESETS) expect(getProvider(p.id).id).toBe(p.id);
  });
});

describe('OpenAI-compatible provider (Groq style, json_object mode)', () => {
  it('asks for json_object, embeds the schema in the prompt, and parses fenced JSON', async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(String(init.body)) as { response_format: { type: string }; messages: { role: string; content: string }[]; model: string };
      expect(body.response_format.type).toBe('json_object');
      expect(body.messages[1]!.content).toContain('matching this JSON Schema');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
      return { model: body.model, choices: [{ message: { content: '```json\n' + JSON.stringify(answer) + '\n```' } }] };
    });
    const p = new OpenAICompatibleProvider('groq', 'Groq', 'json_object');
    const a = await p.analyze(input, { apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(a.provenance).toBe('ai');
    expect(a.provider).toBe('groq');
    expect(a.stepsToReproduce).toEqual(answer.stepsToReproduce);
    expect(a.confidence).toBe('medium');
    expect(a.caveats).toEqual(['No server logs']);
  });

  it('uses strict json_schema for OpenAI', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { response_format: { type: string; json_schema?: { strict: boolean } } };
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema?.strict).toBe(true);
      return { model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify(answer) } }] };
    });
    const a = await getProvider('openai').analyze(input, { apiKey: 'sk', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' });
    expect(a.summary).toBe(answer.summary);
  });

  it('works without a key for Ollama', async () => {
    mockFetch((_url, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return { model: 'llama3.1:8b', choices: [{ message: { content: JSON.stringify(answer) } }] };
    });
    const a = await getProvider('ollama').analyze(input, { apiKey: '', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434/v1' });
    expect(a.model).toBe('llama3.1:8b');
  });

  it('surfaces rate-limit errors readably', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 })));
    await expect(getProvider('groq').analyze(input, { apiKey: 'k', model: 'm', baseUrl: 'https://api.groq.com/openai/v1' })).rejects.toThrow(/429.*quota/);
  });
});

describe('Chrome built-in provider (on-device Prompt API)', () => {
  it('reports unsupported when the API is absent and tells callers to run in a page', async () => {
    vi.stubGlobal('LanguageModel', undefined);
    expect(await ChromeBuiltinProvider.availability()).toBe('unsupported');
    await expect(new ChromeBuiltinProvider().analyze(input, { apiKey: '', model: 'gemini-nano', baseUrl: '' })).rejects.toThrow('RUN_IN_PAGE');
  });

  it('uses a response constraint, compacts the prompt, and destroys the session', async () => {
    const destroy = vi.fn();
    const prompt = vi.fn(async (_text: string, opts?: { responseConstraint?: unknown }) => {
      expect(opts?.responseConstraint).toBeDefined();
      return JSON.stringify(answer);
    });
    const create = vi.fn(async (opts: { initialPrompts?: { role: string; content: string }[] }) => {
      expect(opts.initialPrompts?.[0]?.role).toBe('system');
      return { prompt, destroy };
    });
    vi.stubGlobal('LanguageModel', { availability: async () => 'available', create });
    const a = await new ChromeBuiltinProvider().analyze(input, { apiKey: '', model: 'gemini-nano', baseUrl: '' });
    expect(a.provider).toBe('chrome-builtin');
    expect(a.model).toBe('gemini-nano');
    expect(a.stepsToReproduce).toEqual(answer.stepsToReproduce);
    expect(destroy).toHaveBeenCalledOnce();
    const sentText = prompt.mock.calls[0]![0];
    expect(sentText).toContain('Evidence (JSON)');
    expect(sentText).not.toContain('matching this JSON Schema'); // constraint used, no schema-in-prompt
  });

  it('falls back to schema-in-prompt when responseConstraint is rejected', async () => {
    let calls = 0;
    const prompt = vi.fn(async (_text: string, opts?: { responseConstraint?: unknown }) => {
      calls++;
      if (opts?.responseConstraint) throw new TypeError('responseConstraint not supported');
      return JSON.stringify(answer);
    });
    vi.stubGlobal('LanguageModel', { availability: async () => 'available', create: async () => ({ prompt, destroy: vi.fn() }) });
    const a = await new ChromeBuiltinProvider().analyze(input, { apiKey: '', model: 'gemini-nano', baseUrl: '' });
    expect(calls).toBe(2);
    expect(prompt.mock.calls[1]![0]).toContain('matching this JSON Schema');
    expect(a.summary).toBe(answer.summary);
  });

  it('refuses to run before the model is downloaded', async () => {
    vi.stubGlobal('LanguageModel', { availability: async () => 'downloadable', create: vi.fn() });
    await expect(new ChromeBuiltinProvider().analyze(input, { apiKey: '', model: 'gemini-nano', baseUrl: '' })).rejects.toThrow(/not downloaded yet/);
    expect(getPreset('chrome-builtin').recommended).toBe(true);
    expect(PROVIDER_PRESETS.filter((p) => p.recommended).length).toBe(1);
  });
});

describe('Gemini provider', () => {
  it('calls generateContent with a response schema and parses the candidate text', async () => {
    mockFetch((url, init) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza');
      const body = JSON.parse(String(init.body)) as { generationConfig: { responseMimeType: string; responseSchema: { type: string } } };
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
      return { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] };
    });
    const a = await new GeminiProvider().analyze(input, { apiKey: 'AIza', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
    expect(a.provider).toBe('gemini');
    expect(a.stepsToReproduce?.length).toBe(3);
  });
});
