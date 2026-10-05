/**
 * @testlens/schema — BugContext v1.0
 *
 * The single, versioned, connector-neutral model that every TestLens source
 * normalizes into and every downstream layer (redaction, evidence, composer,
 * trackers) consumes. Connector-specific leftovers go into `extensions`.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0' as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Header = z.object({ name: z.string(), value: z.string() });
export type Header = z.infer<typeof Header>;

export const Body = z.object({
  encoding: z.enum(['utf8', 'base64', 'json']),
  data: z.string(),
  truncated: z.boolean(),
  originalBytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});
export type Body = z.infer<typeof Body>;

export const BodyCaptureStatus = z.enum(['full', 'truncated', 'omitted', 'unavailable']);
export type BodyCaptureStatus = z.infer<typeof BodyCaptureStatus>;

// ---------------------------------------------------------------------------
// HTTP exchange — unified for browser network and API-tool requests
// ---------------------------------------------------------------------------

export const HttpExchange = z.object({
  id: z.string(),
  ts: z.number(), // epoch ms, request start
  method: z.string(),
  url: z.string(),
  initiator: z
    .object({
      type: z.enum(['fetch', 'xhr', 'navigation', 'script', 'img', 'css', 'font', 'media', 'other', 'tool']),
      stack: z.string().optional(),
      interactionId: z.string().optional(),
      frameUrl: z.string().optional(),
    })
    .optional(),
  request: z.object({
    headers: z.array(Header),
    body: Body.optional(),
    bodyBytes: z.number().int().nonnegative().optional(),
  }),
  response: z
    .object({
      status: z.number().int(),
      statusText: z.string().optional(),
      headers: z.array(Header),
      body: Body.optional(),
      bodyBytes: z.number().int().nonnegative().optional(),
      fromCache: z.boolean().optional(),
      mimeType: z.string().optional(),
    })
    .optional(),
  error: z
    .object({
      kind: z.enum(['network', 'aborted', 'timeout', 'blocked', 'cors', 'tls', 'unknown']),
      message: z.string().optional(),
    })
    .optional(),
  timing: z
    .object({
      totalMs: z.number().nonnegative(),
      ttfbMs: z.number().nonnegative().optional(),
    })
    .optional(),
  correlationIds: z.array(z.object({ header: z.string(), value: z.string() })),
  classification: z.object({
    isApi: z.boolean(),
    isStatic: z.boolean(),
    isTelemetry: z.boolean(),
    isPolling: z.boolean().optional(),
  }),
  bodyCapture: z.object({ request: BodyCaptureStatus, response: BodyCaptureStatus }),
});
export type HttpExchange = z.infer<typeof HttpExchange>;

// ---------------------------------------------------------------------------
// Event lists
// ---------------------------------------------------------------------------

export const ConsoleEntry = z.object({
  id: z.string(),
  ts: z.number(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  args: z.array(z.string()), // serialized, bounded, redacted
  stack: z.string().optional(),
  frameUrl: z.string().optional(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

export const ErrorEntry = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.enum(['uncaught', 'unhandledrejection', 'resource', 'csp']),
  message: z.string(),
  stack: z.string().optional(),
  source: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  frameUrl: z.string().optional(),
});
export type ErrorEntry = z.infer<typeof ErrorEntry>;

export const InteractionEntry = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.enum(['click', 'input', 'change', 'submit', 'keydown', 'scroll', 'focus']),
  target: z.object({
    selector: z.string(),
    tag: z.string(),
    text: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
  }),
  valueMasked: z.boolean().optional(),
  frameUrl: z.string().optional(),
});
export type InteractionEntry = z.infer<typeof InteractionEntry>;

export const NavigationEntry = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.enum(['load', 'pushState', 'replaceState', 'popstate', 'hashchange', 'reload', 'committed']),
  from: z.string().optional(),
  to: z.string(),
  title: z.string().optional(),
});
export type NavigationEntry = z.infer<typeof NavigationEntry>;

export const AssertionEntry = z.object({
  id: z.string(),
  ts: z.number(),
  name: z.string(),
  passed: z.boolean(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
  exchangeId: z.string().optional(),
});
export type AssertionEntry = z.infer<typeof AssertionEntry>;

// ---------------------------------------------------------------------------
// Artifacts & evidence
// ---------------------------------------------------------------------------

export const ArtifactKind = z.enum([
  'screenshot',
  'video',
  'rrweb',
  'har',
  'har-focused',
  'console-log',
  'network-log',
  'incident-viewer',
  'raw-connector-payload',
  'file',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  id: z.string(),
  kind: ArtifactKind,
  fileName: z.string(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  storage: z.object({
    type: z.enum(['indexeddb', 'inline', 'hub']),
    ref: z.string(), // idb key, data URL, or hub URL
  }),
  timeRange: z.object({ start: z.number(), end: z.number() }).optional(),
  redaction: z.object({
    status: z.enum(['redacted', 'not-applicable', 'unredacted']),
    rulesApplied: z.array(z.string()),
  }),
  /** User decision in the review UI. Default: engine recommendation. */
  include: z.boolean().default(true),
});
export type Artifact = z.infer<typeof Artifact>;

export const TimelineRef = z.object({
  ts: z.number(),
  kind: z.enum(['exchange', 'console', 'error', 'interaction', 'navigation', 'assertion', 'trigger']),
  refId: z.string(),
});
export type TimelineRef = z.infer<typeof TimelineRef>;

export const FocalEvent = z.object({
  kind: z.enum(['exchange', 'error', 'assertion', 'console']),
  refId: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
});
export type FocalEvent = z.infer<typeof FocalEvent>;

export const EvidenceItem = z.object({
  kind: TimelineRef.shape.kind,
  refId: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  include: z.boolean(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const EvidenceSelection = z.object({
  engineVersion: z.string(),
  focal: FocalEvent.optional(),
  candidates: z.array(FocalEvent),
  items: z.array(EvidenceItem),
  window: z.object({ start: z.number(), end: z.number() }),
  /** Deterministic observations the composer can state as facts. */
  observations: z.array(z.string()),
  captureQuality: z.object({
    score: z.number().min(0).max(100),
    notes: z.array(z.string()),
  }),
});
export type EvidenceSelection = z.infer<typeof EvidenceSelection>;

export const Analysis = z.object({
  provenance: z.literal('ai'),
  provider: z.string(),
  model: z.string(),
  generatedAt: z.number(),
  inputHash: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  stepsToReproduce: z.array(z.string()).optional(),
  expectedResult: z.string().optional(),
  actualResult: z.string().optional(),
  technicalAnalysis: z.string().optional(),
  suspectedExchangeIds: z.array(z.string()).optional(),
  relatedErrorIds: z.array(z.string()).optional(),
  possibleComponent: z.string().optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  caveats: z.array(z.string()),
});
export type Analysis = z.infer<typeof Analysis>;

// ---------------------------------------------------------------------------
// BugContext
// ---------------------------------------------------------------------------

export const BugContext = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  incidentId: z.string(),
  createdAt: z.number(),

  source: z.object({
    connectorId: z.string(),
    connectorVersion: z.string(),
    tool: z.object({ name: z.string(), version: z.string().optional() }),
    captureMode: z.enum(['rolling', 'on-demand', 'import']),
  }),

  trigger: z.object({
    at: z.number(),
    preWindowMs: z.number(),
    postWindowMs: z.number(),
    initiatedBy: z.enum(['user', 'assertion-failure', 'import']),
    userNote: z.string().optional(),
  }),

  environment: z.object({
    name: z.string().optional(),
    os: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
    online: z.boolean().optional(),
  }),

  application: z.object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
  }),

  browser: z
    .object({
      name: z.string(),
      version: z.string(),
      userAgent: z.string(),
      viewport: z.object({ width: z.number(), height: z.number(), dpr: z.number().optional() }),
      tabId: z.number().optional(),
      extensionVersion: z.string(),
    })
    .optional(),

  exchanges: z.array(HttpExchange),
  console: z.array(ConsoleEntry),
  errors: z.array(ErrorEntry),
  interactions: z.array(InteractionEntry),
  navigation: z.array(NavigationEntry),
  assertions: z.array(AssertionEntry),

  execution: z
    .object({
      suite: z.string().optional(),
      collection: z.string().optional(),
      testName: z.string().optional(),
      iteration: z.number().optional(),
      runId: z.string().optional(),
      durationMs: z.number().optional(),
      variables: z.record(z.string()).optional(),
    })
    .optional(),

  artifacts: z.array(Artifact),
  timeline: z.array(TimelineRef),

  redaction: z.object({
    appliedAt: z.array(z.enum(['capture', 'export'])),
    rulesVersion: z.string(),
    counts: z.record(z.number()),
  }),

  evidence: EvidenceSelection.optional(),
  analysis: Analysis.optional(),
  extensions: z.record(z.unknown()).optional(),
});
export type BugContext = z.infer<typeof BugContext>;

// ---------------------------------------------------------------------------
// Bug draft — tracker-neutral output of the composer
// ---------------------------------------------------------------------------

export const BugDraftSection = z.object({
  id: z.string(),
  title: z.string(),
  /** Markdown-ish plain text. Trackers render to their native format. */
  body: z.string(),
  provenance: z.enum(['captured', 'derived', 'ai', 'user']),
  code: z.boolean().optional(),
});
export type BugDraftSection = z.infer<typeof BugDraftSection>;

export const BugDraft = z.object({
  summary: z.string(),
  stepsToReproduce: z.array(z.string()),
  expectedResult: z.string(),
  actualResult: z.string(),
  sections: z.array(BugDraftSection),
  labels: z.array(z.string()),
  environmentSummary: z.string(),
  focalSignature: z.string().optional(),
  /** Draft fields the tester replaced with AI suggestions (kept so the description can mark them). */
  aiApplied: z.array(z.enum(['summary', 'stepsToReproduce', 'expectedResult', 'actualResult'])).optional(),
});
export type BugDraft = z.infer<typeof BugDraft>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildTimeline(ctx: Pick<BugContext, 'exchanges' | 'console' | 'errors' | 'interactions' | 'navigation' | 'assertions' | 'trigger'>): TimelineRef[] {
  const refs: TimelineRef[] = [];
  for (const e of ctx.exchanges) refs.push({ ts: e.ts, kind: 'exchange', refId: e.id });
  for (const e of ctx.console) refs.push({ ts: e.ts, kind: 'console', refId: e.id });
  for (const e of ctx.errors) refs.push({ ts: e.ts, kind: 'error', refId: e.id });
  for (const e of ctx.interactions) refs.push({ ts: e.ts, kind: 'interaction', refId: e.id });
  for (const e of ctx.navigation) refs.push({ ts: e.ts, kind: 'navigation', refId: e.id });
  for (const e of ctx.assertions) refs.push({ ts: e.ts, kind: 'assertion', refId: e.id });
  refs.push({ ts: ctx.trigger.at, kind: 'trigger', refId: 'trigger' });
  refs.sort((a, b) => a.ts - b.ts);
  return refs;
}

let counter = 0;
/** Compact, sortable, collision-resistant id (no crypto dependency so it runs in every world). */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0');
  return `${prefix}${t}${counter.toString(36).padStart(3, '0')}${r}`;
}

export function parseBugContext(input: unknown): BugContext {
  return BugContext.parse(input);
}
