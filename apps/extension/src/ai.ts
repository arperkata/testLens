/** AI analysis service used by the background: builds the redacted projection, calls the provider, stores the result. */
import { buildAnalysisInput, getPreset, getProvider, type AnalysisInput } from '@testlens/ai';
import type { BugDraft } from '@testlens/schema';
import { getIncident, type StoredIncident } from './buffer/db';
import { recomposeIncident } from './incident';
import { loadSettings, type AiSettings } from './settings';

export type AiField = 'summary' | 'stepsToReproduce' | 'expectedResult' | 'actualResult';

export async function ensureAiPermission(baseUrl: string) {
  if (!baseUrl) return; // on-device provider: no network host involved
  const origin = `${new URL(baseUrl).origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) throw new Error(`TestLens needs permission to call ${new URL(baseUrl).origin}. Grant it in TestLens settings (AI section).`);
}

function requireAi(ai: AiSettings): AiSettings {
  if (!ai.enabled) throw new Error('AI analysis is turned off in TestLens settings.');
  if (getPreset(ai.provider).needsKey && !ai.apiKey) throw new Error(`No API key configured for ${getPreset(ai.provider).displayName}.`);
  return ai;
}

/** What would be sent, for the "show what is sent" preview in the UI. Never includes headers, cookies or screenshots. */
export async function projection(incidentId: string): Promise<AnalysisInput> {
  const inc = await getIncident(incidentId);
  if (!inc?.context || !inc.draft) throw new Error('Incident is not ready');
  const { ai } = await loadSettings();
  return buildAnalysisInput(inc.context, inc.draft, { includeBodies: ai.includeBodies });
}

export async function enhance(incidentId: string): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.context || !inc.draft) throw new Error('Incident is not ready');
  const { ai } = await loadSettings();
  requireAi(ai);
  await ensureAiPermission(ai.baseUrl);
  const provider = getProvider(ai.provider);
  const input = buildAnalysisInput(inc.context, inc.draft, { includeBodies: ai.includeBodies });
  const analysis = await provider.analyze(input, { apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl });
  // recompose so the description gains the marked "AI analysis" section; tester fields are untouched
  return recomposeIncident({ ...inc, context: { ...inc.context, analysis } });
}

/**
 * Store an analysis computed in an extension page (Chrome's built-in model only exists in page
 * contexts on some Chrome versions). The page sends the result here so the pipeline stays in one place.
 */
export async function store(incidentId: string, analysis: import('@testlens/schema').Analysis): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.context || !inc.draft) throw new Error('Incident is not ready');
  if (analysis.provenance !== 'ai') throw new Error('Invalid analysis');
  return recomposeIncident({ ...inc, context: { ...inc.context, analysis } });
}

/** Copy chosen AI suggestions into the draft. Explicit tester action; recorded in draft.aiApplied. */
export async function apply(incidentId: string, fields: AiField[]): Promise<StoredIncident> {
  const inc = await getIncident(incidentId);
  if (!inc?.context?.analysis || !inc.draft) throw new Error('No AI analysis to apply');
  const a = inc.context.analysis;
  const draft: BugDraft = { ...inc.draft };
  const applied = new Set(draft.aiApplied ?? []);
  for (const f of fields) {
    if (f === 'summary' && a.summary) {
      draft.summary = a.summary.slice(0, 250);
      applied.add(f);
    }
    if (f === 'stepsToReproduce' && a.stepsToReproduce?.length) {
      draft.stepsToReproduce = a.stepsToReproduce;
      applied.add(f);
    }
    if (f === 'expectedResult' && a.expectedResult) {
      draft.expectedResult = a.expectedResult;
      applied.add(f);
    }
    if (f === 'actualResult' && a.actualResult) {
      draft.actualResult = a.actualResult;
      applied.add(f);
    }
  }
  draft.aiApplied = Array.from(applied);
  // refresh the viewer and description-dependent artifacts with the applied text
  return recomposeIncident({ ...inc, draft });
}

export async function testConnection(ai: AiSettings) {
  if (getPreset(ai.provider).needsKey && !ai.apiKey) throw new Error('Enter an API key first');
  await ensureAiPermission(ai.baseUrl);
  return getProvider(ai.provider).test({ apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl });
}
