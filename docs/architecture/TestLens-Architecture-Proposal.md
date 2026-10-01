# TestLens (TL) — Architecture Proposal v0.1

Status: DRAFT for review. Nothing here is implemented.
Date: 2026-10-01

---

## 0. Executive summary

TestLens is feasible and the core philosophy ("TL already has the evidence when the tester realizes something went wrong") holds for **console, errors, network, interactions, navigation and a visual timeline**. Those can be captured continuously in the background with a one-time permission grant.

One requirement needs to change: **"grant once, record real video forever" is not achievable in any current browser.** Browsers tie screen/tab capture to an explicit user gesture and (for tab capture) to a specific tab. The closest honest approximation is "one click per tab you are testing", plus a permission-free DOM-replay recording (rrweb-style) that works exactly as the requirement describes. Details in §H.

Everything else in the brief maps cleanly onto the proposed architecture:

```
Connectors  →  BugContext (versioned)  →  Evidence Engine  →  [AI]  →  Composer  →  Review  →  Tracker Adapter (Jira)
```

Key recommendations:

1. **TypeScript monorepo** (pnpm + Turborepo). Extension built with WXT (MV3, Chrome/Edge first, Firefox later).
2. **A thin, optional "TL Hub" backend** that can run on the tester's machine (`localhost`) or be hosted. Needed for API-tool ingestion, Jira OAuth, AI key custody and policy. The browser flow works without it for MVP (API-token Jira auth, no AI).
3. **One unified `HttpExchange` model** used by both the browser connector and API-tool connectors, so the Evidence Engine, Composer and Jira layer never know which tool produced the data.
4. **Deterministic Evidence Engine** with explainable selection ("included because…"). AI is a strictly optional, clearly labelled layer that only ever sees redacted, user-approved input.
5. **Redaction at capture time** for known secrets (irreversible), **configurable rules at export time**, and **per-item include/exclude** in the review UI.

Decisions I need from you are listed in §M.

---

## A. Architecture proposal

### A.1 Principles

| Principle | Consequence |
|---|---|
| Flight recorder, not a recorder you start | Rolling ring buffers everywhere; no "Start" button in the main flow |
| Sources are plugins | Core never imports anything tool-specific; connectors produce `BugContext` |
| Trackers are plugins | Core produces a tracker-neutral `BugDraft`; Jira adapter renders it |
| Facts vs analysis | Everything in `BugContext.analysis` is labelled by provenance; UI badges it |
| Human in the loop | No tracker write without an explicit "Create" click on a preview |
| Privacy by default | Redact on capture, scope capture to configured origins, nothing leaves the machine without the user seeing what leaves |
| Local-first | Full MVP works with zero cloud dependency (extension + optional local Hub) |

### A.2 Layers

```
┌────────────────────────────────────────────────────────────────────────────┐
│ SOURCES                                                                    │
│  Browser (extension)   Postman   Insomnia   Bruno   JMeter   SoapUI  HAR  │
└───────┬───────────────────┬─────────┬─────────┬────────┬────────┬──────┬───┘
        │                   │         │         │        │        │      │
┌───────▼───────────────────▼─────────▼─────────▼────────▼────────▼──────▼───┐
│ CONNECTOR LAYER  (ITestConnector implementations; tool-specific code ONLY) │
│  BrowserConnector  PostmanConnector  InsomniaConnector ... HarConnector    │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │  BugContext v1 (validated, versioned)
┌───────────────────────────────────▼────────────────────────────────────────┐
│ CORE                                                                       │
│  Redaction Engine → Evidence Engine → [AI Analysis Provider] → Composer    │
│                       (focal event, correlation, selection, artifacts)     │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │  BugDraft + EvidencePackage
┌───────────────────────────────────▼────────────────────────────────────────┐
│ REVIEW UI  (shared React app: extension side panel  |  Hub web page)       │
│  edit fields · toggle evidence items · pick focal event · see AI badges    │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │  user clicks "Create"
┌───────────────────────────────────▼────────────────────────────────────────┐
│ TRACKER LAYER  (ITrackerAdapter)                                           │
│  JiraCloudAdapter (v3/ADF)  JiraDataCenterAdapter (v2/wiki)  [ADO, GitHub…]│
└────────────────────────────────────────────────────────────────────────────┘
```

### A.3 Deployment topologies

| Topology | Components | When |
|---|---|---|
| **T0 — Extension only** | Extension talks directly to Jira Cloud with an API token. No AI. | MVP default, zero infrastructure |
| **T1 — Extension + local Hub** | `npx testlens hub` on the tester's laptop. Receives API-tool payloads, hosts review UI, holds Jira creds and AI key. | API testing use case, AI on, single tester |
| **T2 — Hosted Hub** | Same Hub, deployed by the team. Shared Jira mapping config, shared redaction policy, OAuth, audit log. | Teams, enterprise |

The Hub is the **same codebase** in T1 and T2. The extension detects a Hub and routes through it when present.

---

## B. Technology stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) end-to-end | One schema package shared by extension, Hub, connectors, UI |
| Monorepo | pnpm workspaces + Turborepo + Changesets | Fast, standard, independent package versioning |
| Schema | Zod → JSON Schema export | Runtime validation at every connector boundary; JSON Schema published for non-TS connectors (JMeter/Java) |
| Extension framework | **WXT** (Vite-based, MV3, multi-browser manifests) | Best current DX for MV3; Firefox/Chrome manifest divergence handled in config |
| Extension storage | IndexedDB via `idb` (ring buffers, blobs) + `chrome.storage.session/local` (small state) | Survives MV3 service-worker termination; blobs for video/screenshots |
| DOM replay | **rrweb** | Permission-free "visual recording", built-in input masking, tiny footprint |
| Video | MediaRecorder in an offscreen document (Chrome) with segmented rolling buffer | Only option for real pixels; see §H |
| UI | React 19 + Vite + Tailwind + Radix primitives | Shared between side panel and Hub |
| Hub runtime | Node 22, **Fastify**, Drizzle ORM, SQLite (local) / Postgres (hosted) | Small, fast, trivially packaged as `npx` and as a container |
| Artifact store | Local filesystem (T1) / S3-compatible (T2) behind `IArtifactStore` | Large blobs never live in the DB |
| Jira | Own thin REST client (Cloud v3 + ADF builder; DC v2 + wiki markup) | Official SDKs are heavy and Cloud/DC diverge; we need both eventually |
| AI | `IAnalysisProvider` interface; first impl Anthropic Claude via Hub; structured JSON output | Provider swap without touching core; key never in extension |
| HAR | Own HAR 1.2 writer from `HttpExchange[]` | HAR is the lingua franca for network evidence |
| Testing | Vitest (unit), Playwright (extension e2e with real Chromium), fixture-based connector golden tests | Connector normalizers are pure functions → great for golden tests |
| Lint/format | Biome | Fast, single tool |
| JMeter listener | Kotlin/Java, Gradle (separate `integrations/jmeter`) | JMeter is JVM only |

---

## C. Component diagram

### C.1 Browser extension internals (MV3)

```
┌─────────────────────────────── Page (per tab, per frame) ────────────────────────────────┐
│  MAIN-world script (document_start)            Isolated-world content script             │
│   • wraps console.*                             • receives MAIN-world events (postMessage)│
│   • window.onerror / unhandledrejection         • interaction capture (click/input/nav)   │
│   • wraps fetch / XMLHttpRequest (bodies)       • rrweb recorder                          │
│   • perf/resource timing                        • forwards to SW via chrome.runtime.Port  │
└──────────────────────────────────────────────┬───────────────────────────────────────────┘
                                               │
┌──────────────────────────────────────────────▼───────────────────────────────────────────┐
│  Background Service Worker (ephemeral!)                                                  │
│   • chrome.webRequest observers (all requests: method, url, status, headers, timing)     │
│   • joins webRequest metadata ↔ page-world bodies by (url, method, ts, requestId)        │
│   • RingBufferStore (write-through: memory → IndexedDB), per-tab, time + byte bounded    │
│   • Redaction-at-capture                                                                 │
│   • Trigger handler: freeze(tabId, t0, preWindow, postWindow)                            │
│   • Jira client / Hub client                                                             │
└───────┬───────────────────────────────────────────────┬──────────────────────────────────┘
        │                                               │
┌───────▼─────────────────────┐             ┌───────────▼─────────────────────────────────┐
│ Offscreen document (Chrome) │             │ Side Panel (React Review UI)                │
│  • MediaRecorder            │             │  • "Report Issue" → incident timeline        │
│  • segmented video ring     │             │  • evidence toggles, focal event picker      │
│  • rrweb → mp4/webm render? │             │  • Jira preview, field editor, Create        │
└─────────────────────────────┘             └─────────────────────────────────────────────┘
        Popup: minimal — "Report Issue", capture status, settings link (popup closes on blur,
        so the real workflow lives in the Side Panel).
```

### C.2 Hub internals

```
┌──────────────────────────── TL Hub (Fastify) ────────────────────────────┐
│  /ingest/:connectorId      ← Postman/Bruno/JMeter/SoapUI HTTP payloads    │
│  /import                   ← HAR, Newman JSON, JTL, Insomnia export       │
│  /incidents, /artifacts    ← CRUD + storage (IArtifactStore)              │
│  /trackers/jira/*          ← OAuth 3LO callback, metadata, create, attach │
│  /ai/analyze               ← policy check → redaction check → provider   │
│  /config                   ← Jira mapping, redaction rules, AI policy     │
│  /ui                       ← serves Review UI (same React app)            │
│  Core packages: schema · connectors · redaction · evidence · composer     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## D. Data flow

### D.1 Browser: Report Issue

```
 t-5m ─────────────────────────────────── t0 ──── t0+Δ(post window, default 15s)
 ░░░░░░░░░ rolling buffers (console, errors, network, interactions, nav, rrweb, [video]) ░░░░░░
                                           │
                                   tester clicks TL → "Report Issue"
                                           │
 1. SW: freeze(tabId, t0)  → copies buffer window [t0-5m, t0] to an Incident record (immutable)
 2. SW: continue appending post-window events until t0+Δ, then seal
 3. SW: chrome.tabs.captureVisibleTab → screenshot artifact
 4. Offscreen: finalize video segments overlapping [t0-5m, t0+Δ] → single webm artifact
 5. BrowserConnector.normalize(rawIncident) → BugContext v1
 6. RedactionEngine.apply(context, rules)            (export-time rules; capture-time already done)
 7. EvidenceEngine.run(context) → focalEvent, EvidenceSelection, HAR, timeline
 8. [if enabled & policy allows] AIProvider.analyze(projection(context, selection)) → Analysis
 9. Composer.compose(context, selection, analysis?) → BugDraft
10. Side Panel renders preview; user edits / toggles evidence / changes focal event (re-runs 7–9)
11. User clicks Create → JiraAdapter.createIssue(draft, mapping) → attach selected artifacts
12. Show issue key + link; store incident ↔ issue linkage locally / in Hub
```

### D.2 API tool: Postman example

```
Postman test script fails
   │  (TL snippet in Collection-level Tests: on failure → pm.sendRequest(HUB/ingest/postman, payload))
   ▼
Hub /ingest/postman  → PostmanConnector.validate/normalize → BugContext
   → Redaction → Evidence → [AI] → Composer → incident stored
   → Hub returns {incidentId, reviewUrl}; snippet logs URL in Postman console
   → Tester opens review URL (or Hub notifies extension / desktop toast)
   → Review → Create → Jira
```

Same pipeline from step "BugContext" onwards. The Evidence Engine sees one `HttpExchange` with `assertions[]` instead of 400 exchanges, and selects accordingly.

---

## E. BugContext model (v1 proposal)

Changes versus the conceptual schema in the brief, and why:

| Brief | Proposal | Reason |
|---|---|---|
| `request`, `response` (singular) + `network` | One `exchanges: HttpExchange[]` | Browser has hundreds; Postman has one. One list, one model, Evidence Engine marks the focal one. |
| `console`, `errors`, `interactions` as separate flat lists | Kept as typed lists **plus** a unified `timeline: TimelineRef[]` | Correlation needs a single ordered sequence; typed lists keep querying simple |
| no trigger info | `trigger` block | "When did the human say *now*" is the anchor for everything |
| `evidence` | `artifacts[]` with storage refs + `evidence` (selection result) | Separate *what exists* from *what we chose to send* |
| `metadata` | `extensions: Record<'x-<connector>', unknown>` | Namespaced escape hatch so connectors don't pollute the core |
| AI mixed in | `analysis` with mandatory `provenance` | Hard separation of fact vs inference |

```ts
// packages/schema/src/bug-context.ts  (Zod; abbreviated to the shape)

type BugContext = {
  schemaVersion: '1.0';
  incidentId: string;                 // ulid
  createdAt: string;                  // ISO 8601, when context was assembled

  source: {
    connectorId: string;              // 'browser' | 'postman' | 'insomnia' | 'bruno' | 'jmeter' | 'har' | ...
    connectorVersion: string;
    tool: { name: string; version?: string };     // 'Chrome 130', 'Postman 11.x', 'Newman 6'
    captureMode: 'rolling' | 'on-demand' | 'import';
  };

  trigger: {
    at: string;                        // the user's "Report Issue" moment (or test failure time)
    preWindowMs: number;               // e.g. 300000
    postWindowMs: number;              // e.g. 15000
    initiatedBy: 'user' | 'assertion-failure' | 'import';
    userNote?: string;                 // optional free text typed at report time
  };

  environment: {
    name?: string;                     // 'QA', 'staging' — from config or Postman environment name
    os?: { name: string; version?: string };
    device?: { type: 'desktop' | 'mobile' | 'tablet'; dpr?: number };
    locale?: string; timezone?: string;
    network?: { online: boolean; effectiveType?: string };
  };

  application: {
    name?: string;                     // from TL config (origin → app name)
    baseUrl?: string;
    url?: string;                      // at trigger
    title?: string;
    version?: string;                  // from <meta name="version">, build headers, config
  };

  browser?: {                          // present only for browser-sourced contexts
    name: string; version: string; userAgent: string; engine?: string;
    viewport: { width: number; height: number };
    tabId?: number; frameCount?: number;
    extensionVersion: string;
  };

  exchanges: HttpExchange[];           // unified HTTP model, see below
  console: ConsoleEntry[];             // {id, ts, level, args(redacted, truncated), stack?, frameUrl?}
  errors: ErrorEntry[];                // {id, ts, kind: 'uncaught'|'unhandledrejection'|'resource'|'csp', message, stack?, source?}
  interactions: InteractionEntry[];    // {id, ts, kind: 'click'|'input'|'submit'|'keydown'|'scroll', target: {selector, text?, role?, name?}, valueMasked?: boolean}
  navigation: NavigationEntry[];       // {id, ts, from?, to, kind: 'load'|'pushState'|'replaceState'|'popstate'|'hashchange'|'reload'}
  assertions: AssertionEntry[];        // {id, ts, name, passed, expected?, actual?, message?, exchangeId?}
  execution?: {                        // API tools / test runners
    suite?: string; collection?: string; folder?: string; testName?: string;
    iteration?: number; runId?: string; durationMs?: number;
    scripts?: { preRequest?: string; test?: string };      // included only if user opts in
    variables?: Record<string, string>;                     // redacted
  };

  artifacts: Artifact[];               // {id, kind: 'screenshot'|'video'|'rrweb'|'har'|'console-log'|'network-log'|'raw-connector-payload'|'file',
                                       //  mime, bytes, sha256, storage: {type: 'indexeddb'|'hub'|'inline', ref}, timeRange?, redaction: {status, rulesApplied}}

  timeline: TimelineRef[];             // ordered {ts, kind, refId} across all typed lists — the correlation backbone

  redaction: {
    appliedAt: ('capture' | 'export')[];
    rulesVersion: string;
    counts: Record<string, number>;    // e.g. {'header.authorization': 42, 'body.jsonpath.$.token': 3}
  };

  evidence?: EvidenceSelection;        // output of the Evidence Engine (see §F/§A)
  analysis?: Analysis;                 // output of AI provider; provenance: 'ai' — never required

  extensions?: Record<`x-${string}`, unknown>;   // connector-specific leftovers, namespaced
};

type HttpExchange = {
  id: string;
  ts: string;                          // request start
  method: string;
  url: string;                         // redacted query params where rules match
  initiator?: { type: 'fetch'|'xhr'|'navigation'|'script'|'img'|'css'|'font'|'other'|'tool'; stack?: string; interactionId?: string };
  request: { headers: Header[]; body?: Body; bodyBytes?: number };
  response?: { status: number; statusText?: string; headers: Header[]; body?: Body; bodyBytes?: number; fromCache?: boolean };
  error?: { kind: 'network'|'aborted'|'timeout'|'blocked'|'cors'|'tls'; message?: string };
  timing?: { dnsMs?, connectMs?, tlsMs?, ttfbMs?, downloadMs?, totalMs: number };
  correlationIds: { header: string; value: string }[];   // x-request-id, traceparent, x-correlation-id … (configurable)
  classification: { isApi: boolean; isStatic: boolean; isTelemetry: boolean; isPolling?: boolean };   // Evidence Engine hints
  bodyCapture: { request: 'full'|'truncated'|'omitted'|'unavailable'; response: same };
};

type Body = { encoding: 'utf8'|'base64'|'json'; data: string; truncated: boolean; originalBytes?: number };

type Analysis = {
  provenance: 'ai';
  provider: string; model: string; generatedAt: string; inputHash: string;   // which redacted projection was sent
  summary?: string; description?: string; stepsToReproduce?: string[];
  expectedResult?: string; actualResult?: string; technicalAnalysis?: string;
  suspectedExchangeIds?: string[]; relatedErrorIds?: string[]; possibleComponent?: string;
  confidence: 'low'|'medium'|'high';
  caveats: string[];                   // model-supplied uncertainty, always rendered
};
```

Versioning rules:
- `schemaVersion` is semver `major.minor`. Minor = additive optional fields. Major = migration function required (`packages/schema/migrations`).
- Every connector declares which schema version it emits; core upgrades on ingest.
- JSON Schema is generated at build time and published for non-TS connectors.

---

## F. Connector architecture

Two connector shapes exist in practice; one interface covers both:

- **Embedded connectors** run inside the tool and produce `BugContext` directly (browser extension; Insomnia plugin).
- **Ingest connectors** receive a tool-specific raw payload or file at the Hub and normalize it (Postman snippet payload, Newman JSON, Bruno, JMeter JTL/listener, SoapUI, HAR).

```ts
// packages/connector-sdk/src/connector.ts

export interface ITestConnector<TRaw = unknown> {
  readonly id: string;                    // 'postman'
  readonly displayName: string;
  readonly version: string;
  readonly emitsSchemaVersion: string;    // '1.0'
  readonly capabilities: ConnectorCapabilities;

  /** For ingest routing when the payload isn't labelled. Returns confidence 0..1. */
  detect?(payload: unknown, hints?: { filename?: string; contentType?: string }): number;

  /** Parse + validate raw tool payload (Zod). Throws ConnectorValidationError. */
  parse(input: unknown): TRaw;

  /** Pure function: raw → BugContext. No I/O, no redaction, no evidence logic. */
  normalize(raw: TRaw, ctx: NormalizeContext): BugContext;

  /** Optional: raw files the connector wants kept as artifacts (JTL, Newman JSON). */
  artifacts?(raw: TRaw): ArtifactInput[];
}

export type ConnectorCapabilities = {
  rollingBuffer: boolean;
  screenshots: boolean; video: boolean; domReplay: boolean;
  requestBodies: 'full'|'partial'|'none'; responseBodies: 'full'|'partial'|'none';
  console: boolean; assertions: boolean; interactions: boolean; multiExchange: boolean;
};

export type NormalizeContext = {
  now: () => string;
  idgen: () => string;
  appConfig?: { originToAppName: Record<string, string>; environmentName?: string };
};
```

Rules enforced by the SDK and a lint rule:
- `packages/core/*` may import `connector-sdk` and `schema`, never `connectors/*`.
- `normalize()` is pure → every connector ships with golden fixtures (`fixtures/*.raw.json` → `*.context.json`).
- Connector-specific leftovers go in `extensions['x-postman']`, never new top-level fields.

Planned connectors and their integration mechanism:

| Tool | Mechanism | Fidelity | Phase |
|---|---|---|---|
| Browser | Extension (embedded) | Full | MVP |
| HAR / Newman JSON / JTL import | File upload to Hub or drag-drop into Review UI | Full for what the file contains | MVP (cheap, universal) |
| Postman | Collection-level Tests snippet → `pm.sendRequest` to Hub on failure; also `newman-reporter-testlens` for CLI/CI | Request/response/assertions/env/console partial | MVP (snippet), P2 (reporter) |
| Insomnia | Official plugin (`responseHooks`) → posts to Hub or writes BugContext | Request/response/env | P2 |
| Bruno | `post-response`/`tests` script snippet + Bruno CLI JSON import | Request/response/assertions | P2 |
| JMeter | Backend Listener (JVM) streaming failed samples to Hub; JTL import | Samples/assertions/threads | P2 |
| SoapUI | Groovy event handler / JUnit report import | Request/response/assertions | P3 |
| Playwright / Cypress / Selenium | Reporter packages (trace/HAR already exist in these tools → map to BugContext) | High | P3 |

Tracker side mirrors this:

```ts
export interface ITrackerAdapter {
  readonly id: 'jira-cloud' | 'jira-dc' | 'azure-devops' | 'github' | 'gitlab' | 'linear' | string;
  authenticate(cfg: TrackerAuthConfig): Promise<AuthSession>;
  listProjects(s): Promise<ProjectRef[]>;
  listIssueTypes(s, project): Promise<IssueTypeRef[]>;
  getCreateFields(s, project, issueType): Promise<FieldSchema[]>;    // required/optional, allowed values
  renderDescription(draft: BugDraft, pkg: EvidencePackage): TrackerDocument;  // ADF | wiki | markdown
  validate(draft, mapping, fields): ValidationResult;
  createIssue(s, draft, mapping): Promise<{ key: string; url: string }>;
  attach(s, key, artifacts: Artifact[]): Promise<AttachmentResult[]>;
  limits(): { maxAttachmentBytes: number; maxDescriptionChars: number };
}
```

---

## G. Security & privacy model

### G.1 Threat model (what we are protecting against)

| Risk | Where | Mitigation |
|---|---|---|
| Bearer tokens, cookies, API keys captured in headers/bodies | Buffers, Jira, AI | **Capture-time redaction** of a built-in deny list (authorization, cookie, set-cookie, x-api-key, password, token, access_token, refresh_token, client_secret, api_key, secret, otp, ssn, card*). Value replaced with `«redacted:sha256-8»` so equal values stay correlatable without being recoverable. |
| Secrets in unexpected places | Bodies, URLs, console | **Export-time rules**: JSONPath/regex rules (configurable, org-shippable), high-entropy string detector, JWT detector, known provider key formats (`sk-`, `AKIA…`, `ghp_…`). |
| PII in response bodies / production data | Bodies | Body capture **off for non-configured origins**; size caps; per-exchange include toggle in review UI; "bodies off" global switch. |
| Video / screenshots show other tabs, notifications, personal data | Visual artifacts | Prefer **tab capture** over screen capture; rrweb masks inputs by default; screenshot region selection; video is **never auto-attached** — user confirms. |
| Data leaving the machine to an AI vendor | AI | AI is **opt-in**, default off. Only a redacted **projection** (`AnalysisInput`) is sent — never raw artifacts, never video, screenshots only with explicit opt-in. Policy can disable AI org-wide or pin an enterprise endpoint. `inputHash` recorded so what was sent is auditable. |
| Jira project visible to many | Jira | Preview shows exactly what will be posted; attachments individually toggled; description contains **summaries**, not raw dumps. |
| Evidence sitting on disk in the browser profile | IndexedDB | Buffers are time- and size-bounded and auto-expire; frozen incidents auto-purge after N days (default 7); optional WebCrypto encryption-at-rest with a session key (P2). |
| Over-broad extension permissions | Store review, user trust | **Origin scoping**: user configures which origins TL monitors (host_permissions requested at runtime via `chrome.permissions.request`). `<all_urls>` is an opt-in "monitor everything" mode. |
| Prompt injection via captured content (console text, response bodies) | AI | Captured content is passed as data in a structured input, model emits structured JSON only, no tool use, outputs rendered as text (never executed), labelled as AI. |
| Hub as a honeypot (T2) | Hub | Auth (OIDC/SSO), per-incident ACL, encrypted blob store, audit log of every export and every Jira/AI call, retention policy. |

### G.2 Data lifecycle

```
captured → (capture-time redaction) → ring buffer (≤5 min / ≤ N MB, auto-expire)
   → freeze → incident (local, TTL 7d)
   → (export-time redaction + user toggles) → EvidencePackage
   → [AI projection]  → Analysis
   → Jira (description = summary; attachments = user-selected)
```

Each arrow that crosses a machine boundary (→ Hub, → AI, → Jira) is logged with the artifact hashes that crossed it.

---

## H. Browser limitations (the honest list)

Research baseline: Chromium MV3 (Chrome/Edge ≥ 120), Firefox ≥ 128 MV3. Verify against the current versions during Phase 0 spikes.

### H.1 Continuous screen/tab recording — **requirement must change**

| Mechanism | Needs gesture? | Scope | Survives | Notes |
|---|---|---|---|---|
| `chrome.tabCapture` (+ `getMediaStreamId` consumed in an offscreen doc) | **Yes — once per tab** (extension must be invoked on that tab) | One tab | In-tab navigation ✔, tab close ✘, new tab ✘ | No OS picker, no "sharing" chrome bar. Chrome/Edge only. |
| `getDisplayMedia` (screen/window/tab picker) | **Yes — every call shows the picker** | Whatever user picked | Until user stops / source closes | Must be called from a visible extension page (side panel, pinned tab). Firefox's only option. Shows "sharing" indicator. Captures *everything* on that screen. |
| `chrome.tabs.captureVisibleTab` | No (with host permission) | Visible tab, still image | n/a | Rate-limited (~2/s); only the active tab in the focused window. |
| `chrome.debugger` `Page.startScreencast` | No gesture, but shows the yellow "is debugging this browser" infobar permanently | One tab | Until detached | Intrusive; also conflicts with DevTools. Not for the default flow. |
| **rrweb DOM recording** (content script) | **No** | Every monitored tab/frame | Always | Not pixels: replays DOM mutations. Misses canvas/video content, cross-origin iframes. Tiny size. Masks inputs. Replays in Review UI; can be rendered to video server-side (P3). |

**Recommendation.**
- Default "visual evidence" = **screenshot at trigger + rrweb replay** for the 5-minute window. Zero friction, matches the flight-recorder promise.
- **"Record this tab" one-click mode** (tabCapture): the tester clicks TL once when they open the app under test; TL records that tab in a rolling buffer until the tab closes. We can make this nearly automatic: badge + toast "Click to enable video for this tab" when a monitored origin loads. This is the closest legal approximation to "grant once".
- **Rolling video buffer implementation**: MediaRecorder chunks from one `start(timeslice)` session are **not independently decodable** (only the first chunk carries the container header). Use **two alternating MediaRecorders** with 30-second segments and a one-segment overlap; keep the last 11 segments; on trigger, pick segments covering `[t0-5m, t0+Δ]`, and concatenate (or re-mux via WebCodecs for a clean single file, P2). Bitrate ~1 Mbps for tab capture → ~40 MB per 5 min, fits IndexedDB comfortably.
- Post-click window (10–30 s, configurable) is trivial: keep recording, seal at `t0+Δ`.
- Firefox: no tabCapture, no offscreen docs → video is "share screen" via sidebar only. Treat video as Chrome/Edge-first.

### H.2 Network interception

| What | Chrome/Edge MV3 | Firefox MV3 |
|---|---|---|
| URL, method, status, timing, request headers, response headers, request body (form/raw bytes) | `chrome.webRequest` observers ✔ (needs `webRequest` + host permission; **non-blocking** observers still work in MV3) | ✔ |
| **Response bodies** | ✘ via webRequest. Options: (a) MAIN-world `fetch`/`XHR` wrapping → bodies for page-JS calls (the ones testers care about), not for navigations/images/service-worker-initiated; (b) `chrome.debugger` Network domain → everything, but infobar; (c) `chrome.devtools.network` → only while DevTools open | `webRequest.filterResponseData` ✔ (Firefox-only, gives all bodies) |
| Requests from the page's Web/Service Workers | Headers via webRequest ✔; bodies ✘ without debugger | same |
| Cross-origin opaque responses (`no-cors`) | Body unreadable by design | same |

**Recommendation.** Hybrid: webRequest for the complete metadata picture of every request; MAIN-world wrapping for fetch/XHR bodies (cloned streams, size-capped, default 256 KB per body); join the two records by `(method, url, ±time)` plus the Chrome `requestId` when exposed. Offer **"Deep capture" (chrome.debugger)** as an explicit opt-in for the cases where bodies are missing. Expose `bodyCapture` status per exchange so the UI never pretends a body was captured when it wasn't.

### H.3 Console & errors

- No extension API reads the page console. Standard technique: MAIN-world script at `document_start` (`world: "MAIN"` is supported in manifest content_scripts in Chrome ≥ 111 and Firefox ≥ 128) wraps `console.*`, hooks `window.onerror`, `unhandledrejection`, and `error` events on resources; relays to the isolated world via `window.postMessage` with a nonce.
- Limitations: logs emitted *before* injection on a page (microseconds, usually fine); logs inside Web/Service Workers (not reachable without debugger); frameworks that cache `console` references before we patch (rare at `document_start`); pages that freeze `console` (rare).
- Arg serialization must be bounded (depth, length, cycles) and redacted.
- `all_frames: true` needed for iframes; cross-origin iframes of **non-monitored** origins are skipped by policy.

### H.4 Background behaviour (MV3 service worker)

- The SW is **killed after ~30 s idle** and can be killed mid-task. It must never be the sole holder of the buffer.
- Design: every event is written through to IndexedDB in batched transactions (≤250 ms flush). In-memory cache is rebuilt lazily on wake. `chrome.storage.session` holds small hot state (per-tab recording status, trigger in progress).
- Continuous webRequest / runtime.Port traffic keeps the SW alive while there's activity, which is exactly when we need it. `chrome.alarms` (≥30 s granularity) drives expiry sweeps.
- Offscreen document (Chrome) hosts MediaRecorder; it is persistent while the recording justification is active. Firefox has no offscreen API → persistent background page (allowed in Firefox MV3) does the job. Abstract behind `IMediaHost`.
- Popup windows close on blur, which kills any work started there → the Report Issue flow runs in the **Side Panel** (Chrome ≥ 114) or a dedicated extension tab. Firefox uses `sidebar_action`.

### H.5 Other constraints

- Extensions cannot run on `chrome://`, the Web Store, other extensions' pages, or pages blocked by enterprise policy (`runtime_blocked_hosts`).
- `captureVisibleTab` only captures the **visible** viewport, not full page; full-page capture needs scrolling + stitching or debugger `captureScreenshot` with `captureBeyondViewport`.
- Memory: 5 minutes of a chatty SPA can be 2,000+ exchanges; with bodies that is 100 MB+. Buffers are bounded by **time AND bytes** (default 5 min / 150 MB per tab), bodies truncated first, oldest evicted first.
- Chrome Web Store review will scrutinise `<all_urls>` + `webRequest` + `tabCapture`. Runtime-requested, origin-scoped permissions make review and enterprise adoption much easier.
- Jira Cloud attachment size is commonly limited to **10 MB by default** (admin-configurable). Video must be transcoded/trimmed to fit, or stored in the Hub and linked.

---

## I. MVP scope (Phase 1)

Goal: a tester on Chrome/Edge can report a browser bug to Jira Cloud with real evidence in under a minute, with zero infrastructure; and a Postman user can get the same via a local Hub.

**Extension (Chrome/Edge)**
- Origin-scoped monitoring, configurable in Options (plus "monitor all" opt-in).
- Rolling 5-min buffers: console, errors, network metadata (all), fetch/XHR bodies (capped), interactions, navigation, rrweb.
- Report Issue from popup → Side Panel incident view.
- Screenshot at trigger; post-window default 15 s.
- Capture-time redaction (built-in list) + export-time rules (user-editable JSON).
- Evidence Engine v1 (deterministic, explainable).
- Deterministic Composer (no AI): summary, description, steps (from interactions/navigation), environment, error details, evidence summary.
- Jira Cloud adapter: API token auth, project/issue type selection, required-field discovery, configurable mapping, ADF description, attachments (screenshot, console log, focused HAR, rrweb bundle; full HAR optional).
- Incident history (local), auto-purge.

**Hub (local, `npx testlens hub`)**
- `/ingest/postman` + Postman snippet; `/import` for HAR and Newman JSON.
- Same Review UI served at `http://localhost:7331`.
- Jira config shared with extension (extension can use Hub as its Jira proxy when present).

**Explicitly out of MVP:** real video, AI, Firefox, OAuth, Insomnia/Bruno/JMeter/SoapUI, hosted Hub, debugger deep-capture.

---

## J. Phase 2 / 3 roadmap

**Phase 2 — "Video and intelligence"**
- One-click tab video (rolling segmented buffer, offscreen doc, trimming to Jira limits).
- AI Analysis Provider via Hub (Anthropic first), `AnalysisInput` projection, policy switch, UI badges/caveats.
- Jira OAuth 2.0 (3LO) via Hub; Jira Data Center adapter (v2, wiki markup).
- Insomnia plugin, Bruno snippet + import, JMeter Backend Listener + JTL import, `newman-reporter-testlens`.
- Encryption at rest for frozen incidents; retention policies.
- Deep capture mode (`chrome.debugger`) opt-in for response bodies everywhere.
- Full-page screenshot; region selection.

**Phase 3 — "Teams and ecosystem"**
- Hosted Hub: SSO, shared mapping/redaction policy, audit log, incident sharing, S3 artifact store.
- Firefox extension (filterResponseData for bodies; sidebar; getDisplayMedia video).
- Azure DevOps, GitHub Issues, GitLab Issues, Linear adapters.
- Playwright / Cypress / Selenium reporters (map trace/HAR to BugContext).
- SoapUI connector.
- Duplicate detection (search tracker for similar focal signature), rrweb → mp4 rendering, correlation with backend traces (OpenTelemetry trace ID lookup).

---

## K. Key technical risks

| # | Risk | Likelihood | Impact | Mitigation / spike |
|---|---|---|---|---|
| 1 | Tab-capture rolling buffer reliability (offscreen lifetime, segment stitching, codec quirks) | High | High | Phase 0 spike (1 week) before committing video to a date; rrweb is the fallback that always works |
| 2 | Response-body coverage gaps confuse testers ("where's the body?") | High | Medium | Explicit `bodyCapture` status in UI; deep-capture opt-in; Firefox gets full bodies |
| 3 | MV3 SW termination loses events | Medium | High | Write-through IndexedDB design; chaos test that kills the SW every 10 s in Playwright e2e |
| 4 | Buffer memory/disk blow-up on chatty apps | Medium | Medium | Time+byte bounds, body truncation, static/telemetry classification before storage |
| 5 | Evidence Engine picks the wrong focal event | Medium | Medium | Scoring with explanations; user can re-pick; collect anonymised "user changed focal" metric locally to tune |
| 6 | Redaction misses a secret → leaks to Jira/AI | Medium | **Critical** | Layered: capture-time list, export-time regex/entropy, preview, per-item toggles, AI off by default, red-team fixture suite in CI |
| 7 | Jira variability (required custom fields, screens, DC vs Cloud, ADF rendering) | High | Medium | Field discovery API + mapping config + preflight validation; Cloud first |
| 8 | Chrome Web Store rejection for broad permissions | Medium | High | Origin-scoped runtime permissions; clear privacy policy; enterprise policy install path as a backup |
| 9 | Postman has no plugin system; snippet approach is fragile | Medium | Medium | Snippet + Newman reporter + HAR/JSON import give three paths |
| 10 | Schema churn across connectors | Medium | Medium | Versioned schema, golden tests per connector, `extensions` namespace |
| 11 | AI output presented as fact | Low (design) | High (trust) | Mandatory provenance, badges, caveats, no AI text in Jira without being inside an "AI analysis" section |
| 12 | Hub becomes mandatory by accident | Medium | Medium | T0 topology is a CI-tested configuration |

---

## L. Recommended repository structure

```
testlens/
├── apps/
│   ├── extension/                 # WXT project (Chrome/Edge MVP; Firefox target later)
│   │   ├── entrypoints/
│   │   │   ├── background.ts      # SW: webRequest, ring buffers, trigger, routing
│   │   │   ├── content.ts         # isolated world: interactions, rrweb, relay
│   │   │   ├── main-world.ts      # console/error/fetch/XHR instrumentation
│   │   │   ├── offscreen.html/.ts # MediaRecorder host (P2)
│   │   │   ├── sidepanel/         # Review UI shell (uses packages/ui)
│   │   │   ├── popup/
│   │   │   └── options/
│   │   └── src/
│   │       ├── capture/           # consoleCapture, networkCapture, interactionCapture, rrwebCapture
│   │       ├── buffer/            # RingBufferStore (IndexedDB), expiry, freeze
│   │       ├── media/             # IMediaHost impls (P2)
│   │       └── services/          # hubClient, jiraClient (uses packages/trackers)
│   └── hub/                       # Fastify server; `npx testlens hub`
│       ├── src/routes/            # ingest, import, incidents, artifacts, trackers, ai, config
│       ├── src/storage/           # IArtifactStore (fs | s3), Drizzle schema (sqlite | pg)
│       └── src/ui/                # serves packages/ui build
├── packages/
│   ├── schema/                    # BugContext Zod + JSON Schema + migrations + fixtures
│   ├── connector-sdk/             # ITestConnector, NormalizeContext, golden-test helpers
│   ├── connectors/
│   │   ├── browser/               # raw extension capture → BugContext
│   │   ├── har/
│   │   ├── postman/               # snippet payload + Newman JSON
│   │   ├── insomnia/              # P2
│   │   ├── bruno/                 # P2
│   │   └── jmeter/                # JTL + listener payload (TS side) P2
│   ├── redaction/                 # built-in list, rule engine, entropy/JWT detectors, red-team fixtures
│   ├── evidence-engine/           # timeline, focal scoring, correlation, selection, HAR writer, package builder
│   ├── composer/                  # deterministic composer + AI-aware composer; BugDraft model
│   ├── ai/                        # IAnalysisProvider, AnalysisInput projection, anthropic provider (Hub-only)
│   ├── trackers/
│   │   ├── core/                  # ITrackerAdapter, BugDraft→TrackerDocument, mapping config schema
│   │   ├── jira-cloud/            # REST v3, ADF builder, field discovery, attachments
│   │   └── jira-dc/               # P2
│   ├── ui/                        # React Review UI: timeline, evidence toggles, Jira preview, field editor
│   ├── storage/                   # ring buffer + blob abstractions shared by extension and hub
│   └── config/                    # tsconfig, biome, vitest presets
├── integrations/                  # things that live inside other tools
│   ├── postman/                   # collection Tests snippet, newman-reporter-testlens
│   ├── insomnia-plugin/           # P2
│   ├── bruno/                     # P2
│   └── jmeter-listener/           # Kotlin/Gradle Backend Listener (P2)
├── docs/
│   ├── architecture/              # this document, ADRs
│   ├── schema/                    # generated JSON Schema
│   └── privacy/                   # data handling, permissions rationale (also for store listing)
├── e2e/                           # Playwright: extension + fixture app with planted bugs
├── fixtures/app-under-test/       # tiny web app that throws 500s, console errors, etc.
├── turbo.json  pnpm-workspace.yaml  package.json  biome.json
```

Dependency direction (enforced by lint): `apps/* → packages/*`; `packages/core-ish (evidence, composer, redaction, ai, trackers, ui) → schema, connector-sdk`; `connectors/* → schema, connector-sdk` only. Nothing in `packages/` imports from `apps/`.

---

## M. Items that are unrealistic or need to change, and decisions I need

### M.1 Requirement changes
1. **Video: "permission once, record forever" → "one click per tab" (Chrome/Edge) plus permission-free DOM replay.** Firefox video will be screen-share only.
2. **Response bodies cannot be captured for 100% of requests without the intrusive debugger mode.** Accept hybrid capture with explicit per-exchange status; offer deep capture as opt-in.
3. **Video cannot be auto-redacted.** It must always be an explicit attach decision by the tester.
4. **5 minutes must be bounded by bytes too**, or chatty apps will exhaust storage. Proposed: 5 min / 150 MB per tab, bodies truncated at 256 KB.
5. **"Report Issue" should live in the side panel, not the popup**, because popups close on blur.
6. **A Hub is required for AI and for API-tool connectors** (they need somewhere to send data; AI keys cannot ship in an extension). It can be local and optional for browser-only use.
7. **Jira attachment limits** (often 10 MB) constrain video; plan for trimming or Hub-hosted links.

### M.2 Decisions for you
| # | Question | My recommendation |
|---|---|---|
| 1 | Jira Cloud only for MVP, or Data Center too? | Cloud only; DC in P2 |
| 2 | Is a local Hub (`npx testlens hub`) acceptable for the Postman MVP path, or must MVP be extension-only? | Local Hub in MVP; it unlocks API connectors and is where AI lives later |
| 3 | Video in MVP (one-click-per-tab) or Phase 2? | Phase 2, after a Phase 0 spike proves the rolling buffer; rrweb + screenshot in MVP |
| 4 | Default monitoring scope: user-configured origins, or everything? | Configured origins; "monitor all" as opt-in |
| 5 | AI provider and hosting constraints (Anthropic direct, Bedrock/Vertex, customer-hosted gateway)? | Anthropic via Hub first; provider interface keeps options open |
| 6 | Firefox priority? | Phase 3 unless you have Firefox testers now |
| 7 | Which API tool first: Postman (snippet) or Insomnia (real plugin)? | Postman by market share, plus HAR import for everyone else |
| 8 | Packaging of the Hub for teams: Docker image, or Node `npx` only? | Both; same code |

### M.3 Positioning alternatives
Current: "See what happened. Capture why. Create the issue."

Alternatives:
- "The flight recorder for testing."
- "You saw the bug. TestLens saw everything."
- "Already captured. Just report."
- "Rewind. Review. Report."
- "Stop collecting evidence. Start reporting bugs."

My pick: **"You saw the bug. TestLens saw everything."** It states the product's promise (continuous monitoring) in the tester's voice.

---

## N. Proposed Phase 0 (before MVP code): 1–2 weeks of spikes

1. MV3 buffer durability: write-through IndexedDB ring buffer surviving forced SW termination.
2. Network join: webRequest metadata ↔ MAIN-world fetch/XHR bodies, measure match rate on three real SPAs.
3. Tab-capture rolling video with alternating MediaRecorders; measure gap at segment boundaries and file size.
4. Jira Cloud field discovery + ADF description + attachment on a sandbox project.
5. Postman snippet: confirm `pm.sendRequest` to `http://localhost` works in Postman desktop and Newman, and what `pm.response`/`pm.test` expose.

Each spike produces an ADR in `docs/architecture/adr/`.
