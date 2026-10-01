# TestLens (TL)

**You saw the bug. TestLens saw everything.**

TestLens is a testing flight recorder. It keeps a rolling 5-minute buffer of console output, JavaScript errors, network traffic, user interactions, navigation and a DOM replay for the sites a tester chooses. When something goes wrong the tester clicks **Report Issue**; TestLens freezes the evidence, picks the most relevant failure, composes a bug with steps, expected/actual and attachments, and lets the tester review and create the Jira issue. Nothing is created in Jira without an explicit click.

Open source (MIT). Works with the tester's own Jira Cloud account via an API token. No hosted service, no licence, nothing leaves the machine until the tester clicks Create.

## Repository layout

```
apps/extension               Chrome/Edge extension (WXT, MV3, React)
packages/schema              BugContext v1 model (Zod)
packages/redaction           capture-time + export-time secret masking
packages/evidence-engine     deterministic focal-event scoring, correlation, HAR/log writers
packages/composer            BugDraft composition (no AI), cURL export, trace links
packages/trackers-core       ITrackerAdapter contract + mapping config
packages/trackers-jira-cloud Jira Cloud REST v3 adapter, ADF renderer
packages/connectors-browser  raw extension capture → BugContext
docs/architecture            architecture proposal
```

## Build

```bash
npm install --ignore-scripts
npm test
npm run build          # → apps/extension/.output/chrome-mv3
```

Load `apps/extension/.output/chrome-mv3` as an unpacked extension (chrome://extensions → Developer mode → Load unpacked). For live development run `npm run dev`.

## First run

1. Open TestLens settings (opens automatically on install).
2. **Monitored sites**: add the app under test and any API origins it calls, then **Apply monitoring** and grant the permission prompt.
3. **Jira Cloud**: enter site URL, email and an API token from id.atlassian.com, click **Connect**, choose project and issue type. If the issue type has required custom fields, map them in the JSON mapping.
4. Reload the app tab. The TestLens popup now shows the live buffer counts.
5. Test normally. When something breaks, click the TestLens icon → **Report Issue**. The side panel opens with the composed bug, evidence toggles and the Jira preview. Click **Create Jira issue** when satisfied.

## What gets captured

| Signal | Mechanism | Notes |
|---|---|---|
| Request/response metadata, headers, timing | `chrome.webRequest` observers | every request in monitored tabs |
| Request/response bodies | page-world `fetch`/`XMLHttpRequest` wrapping | fetch/XHR only; bodies capped (default 256 KB); status shown per request |
| Console, uncaught errors, unhandled rejections, CSP violations | page-world instrumentation at `document_start` | workers are not covered |
| Clicks, inputs (values masked), submits, SPA route changes | isolated content script | |
| DOM replay | rrweb, inputs masked by default | replays in the attached HTML viewer |
| Screenshot | `captureVisibleTab` at the moment of Report Issue | |
| Tab video | not in this build | one-click-per-tab recording is planned |

## Privacy

Secrets are masked at capture time (authorization, cookie, tokens, passwords, API keys, JWTs, known key formats, card-like numbers) and again with user-configurable rules at export time. Masked values keep a short hash so equal values remain correlatable. The tester sees exactly what will be posted and can exclude any evidence item or attachment. No AI provider is contacted in this build.

## Attachments created per incident

`screenshot.png`, `console.log`, `network.log`, `network-focused.har`, `network-full.har` (off by default), `replay.rrweb.json`, `testlens-incident.html` (self-contained viewer with timeline, requests, console and replay).

## Status

MVP. See `docs/architecture/TestLens-Architecture-Proposal.md` for the roadmap (tab video, API-tool connectors via a local Hub, AI analysis, Jira Data Center, other trackers).
