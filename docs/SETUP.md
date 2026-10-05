# TestLens — Setup and Configuration Guide

This guide covers everything from a clean machine to filing your first Jira issue, plus every setting TestLens exposes and how to troubleshoot it.

Contents

1. [Prerequisites](#1-prerequisites)
2. [Install and build](#2-install-and-build)
3. [Load the extension in Chrome or Edge](#3-load-the-extension-in-chrome-or-edge)
4. [First-run configuration](#4-first-run-configuration)
   - 4.1 Monitored sites
   - 4.2 Capture settings
   - 4.3 Jira Cloud connection
   - 4.4 Required fields and field mapping
   - 4.5 Redaction rules
   - 4.6 Backend trace links and noise filters
   - 4.7 Data retention
5. [Daily use](#5-daily-use)
6. [What TestLens captures and what it cannot](#6-what-testlens-captures-and-what-it-cannot)
7. [Attachments and the evidence package](#7-attachments-and-the-evidence-package)
8. [Updating, rebuilding and development mode](#8-updating-rebuilding-and-development-mode)
9. [Running the tests](#9-running-the-tests)
10. [Troubleshooting](#10-troubleshooting)
11. [Privacy and data handling](#11-privacy-and-data-handling)
12. [Uninstall and data removal](#12-uninstall-and-data-removal)

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or newer (tested on 25) | https://nodejs.org |
| npm | 10 or newer | ships with Node |
| Browser | Chrome 116+ or Edge 116+ | Manifest V3 with side panel support |
| Jira | Jira Cloud (`*.atlassian.net`) | Jira Server / Data Center is not supported yet |
| Jira account | your own | you need "Create issues" permission in the target project |

No other services, accounts or licences are needed. TestLens talks to Jira directly from your browser with your own credentials.

---

## 2. Install and build

```bash
git clone <your-repo-url> testLens
cd testLens
npm install --ignore-scripts
npm run build
```

`--ignore-scripts` skips a WXT preparation hook that is not needed for a plain build.

The build output is written to:

```
apps/extension/.output/chrome-mv3
```

That folder is the extension. Keep it where it is; the browser loads it from disk.

Other useful commands:

| Command | What it does |
|---|---|
| `npm test` | unit tests for all core packages |
| `npm run build` | production build of the extension |
| `npm run dev` | development mode with hot reload in its own browser profile |
| `npm run zip` | zipped extension for distribution or store upload |
| `npm run e2e` | browser end-to-end test (see §9) |

---

## 3. Load the extension in Chrome or Edge

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right in Chrome, left sidebar in Edge).
3. Click **Load unpacked**.
4. Select `apps/extension/.output/chrome-mv3`.
5. The TestLens settings page opens automatically on first install. Pin the TestLens icon to the toolbar via the puzzle-piece menu so it is one click away.

Rebuilding does not require loading again; see §8.

---

## 4. First-run configuration

Open settings at any time from the popup's **Settings** button or by right-clicking the TestLens icon → **Options**.

### 4.1 Monitored sites

TestLens records only the sites you list here. Nothing is captured anywhere else.

Monitoring is **domain-wide**. Entering `app.example.com` monitors `example.com` and every subdomain (`api.example.com`, `auth.example.com`…), over http and https, on any port. One entry therefore normally covers the application and the APIs it calls. `localhost` and IP addresses are kept exact because no domain can be derived from them.

1. Enter the application under test (`app.example.com`, a full URL, or `*.example.com`) and click **Add**. TestLens shows the resulting scope under the entry.
2. If the application calls APIs on a different domain (not just a different subdomain), add that domain too.
3. Optionally give each entry an **app name**; it appears in the bug's Environment section.
4. Set **Environment name** (QA, Staging, INT…). It is added as a label and shown in every bug.
5. Click **Apply monitoring** and accept the browser permission prompt.
6. Reload any open tab of the application so the recorder attaches.

| Entry | Meaning |
|---|---|
| `*.example.com` (what `app.example.com` becomes) | example.com and all subdomains, http and https, any port |
| `http://localhost:4317` | that exact origin only |
| `*` | every site. Not recommended; use only on a dedicated test browser profile |

**Configure once per browser.** Settings are stored in Chrome's synced storage, so they apply to every window of this browser profile and follow a signed-in Chrome profile to other machines. The Jira API token is kept in local storage only and never syncs. Use **Export settings** / **Import settings** to share a configuration file with the team; the export contains no token.

**Incognito windows.** TestLens is built to share one configuration and one recorder between normal and Incognito windows, but Chrome requires the user to allow it once: the Monitored sites card shows whether Incognito is allowed and offers **Open extension details**, where you turn on **Allow in Incognito**. After that, Incognito tabs of monitored sites are recorded with no further setup. Incognito incidents are stored like any other and are purged by the same retention rule.

Monitoring status is shown in the popup: a green dot with live counts means the buffer is active for the current tab. On an unmonitored site the popup offers **Monitor <domain>**, which adds the domain, requests permission and reloads the tab in one step.

### 4.2 Capture settings

| Setting | Default | Notes |
|---|---|---|
| Rolling window | 5 min | how much history is preserved when you click Report Issue |
| Post-click window | 15 s | capture continues this long after the click, for errors still completing |
| Max body size | 256 KB | request/response bodies above this are truncated; the full size is recorded |
| Capture request/response bodies | on | bodies of page fetch/XHR calls |
| DOM replay recording | on | rrweb session replay, viewable in the HTML viewer |
| Mask all input values in replay | on | keeps typed values out of the replay |

Click **Save** after changes. Buffer settings take effect immediately; replay and body settings apply to tabs after reload.

### 4.3 Jira Cloud connection

1. Create an API token: sign in at https://id.atlassian.com/manage-profile/security/api-tokens, click **Create API token**, label it "TestLens", copy the value. It is shown only once.
2. In TestLens settings → **Jira Cloud**, enter:
   - **Jira site URL**: `https://yourcompany.atlassian.net`
   - **Email**: the email you log into Jira with
   - **API token**: the value you copied
3. Click **Connect & load projects**. Accept the browser prompt granting TestLens access to your Jira site.
4. "Connected as <your name>" confirms authentication. Choose the **Project**. TestLens auto-selects the **Bug** issue type when the project has one; change it if needed.

The token is stored in `chrome.storage.local` for this browser profile only. It is never sent anywhere except your Jira site.

If your organisation blocks API tokens (the token page says so), ask your Atlassian admin, or request the OAuth sign-in option on the roadmap.

### 4.4 Required fields and field mapping

When you pick an issue type, TestLens reads the project's create screen and shows **Required by this project**: one dropdown or text box per mandatory field, prefilled with a sensible default (newest version for version fields, first option otherwise). Adjust and click **Save Jira settings**. The mapping is also saved automatically the moment fields load, so the side panel works without the extra click.

**Optional defaults** lists non-required fields with fixed options (Priority, Components…) if you want a standing value.

**Advanced: raw field mapping (JSON)** shows the generated mapping and lets you use templates:

```json
{
  "labels": ["$labels", "regression"],
  "priority": "High",
  "components": "Checkout, API - Pay",
  "customfield_10042": "{{draft.environmentSummary}}",
  "customfield_11101": "QA"
}
```

| Value form | Meaning |
|---|---|
| `"$labels"` | labels generated by TestLens (`testlens`, environment, `server-error`, `js-error`) |
| `"$summary"` / `"$description"` | the composed summary / description (already set by default) |
| `"Option name"` | resolved against the field's allowed values by name or id |
| `"A, B"` | several values for multi-select, components, versions |
| `"{{draft.environmentSummary}}"` | template; any `draft.*` field is available |
| `{ "id": "3" }` | raw Jira value object, passed through unchanged |

Summary, description, project and issue type are always filled by TestLens and need no mapping. The Jira tab in the side panel validates the payload against the required fields before Create is enabled.

### 4.5 Redaction rules

Built-in rules always run and cannot be disabled. They mask header, query, form and JSON values whose key matches: authorization, proxy-authorization, cookie, set-cookie, x-api-key, x-auth-token, x-csrf-token, password, passwd, pwd, secret, client_secret, token, access_token, refresh_token, id_token, api_key, private_key, session, sessionid, otp, pin, ssn, cvv, card_number. Pattern rules catch JWTs, bearer tokens, AWS, OpenAI, GitHub and Slack key formats and card-number-like digit runs anywhere in text.

Masked values look like `«redacted:7f5b6271»`. The hash is derived from the value, so the same secret shows the same tag across requests and remains correlatable without being recoverable.

Add your own in settings → **Redaction**:

- **Extra sensitive header / field names**: comma separated, for example `x-tenant-secret, internalToken`
- **Extra regex patterns**: one per line as `id = regex`, for example `employee-id = \bEMP-\d{6}\b`

Redaction runs twice: at capture time (into the buffer) and again at export time with your rules when an incident is assembled. The Evidence tab shows how many values were redacted and by which rule.

### 4.6 Backend trace links and noise filters

**Trace link templates** turn correlation ids on failed responses into deep links in the bug. One per line:

```
x-request-id = https://logs.example.com/app/discover#/?_a=(query:(query:'{value}'))
traceparent  = https://tempo.example.com/trace/{value}
* = https://search.example.com/?q={value}
```

`{value}` is replaced with the id, `{header}` with the header name. `*` applies to any correlation header. Recognised correlation headers: x-request-id, x-correlation-id, x-trace-id, traceparent, x-amzn-trace-id, x-b3-traceid, request-id, x-cloud-trace-context, cf-ray.

**Extra telemetry hosts to ignore** removes analytics and monitoring traffic from evidence selection. Common vendors (Google Analytics, Segment, Sentry, Datadog, Hotjar, Intercom and others) are already excluded.

### 4.7 Data retention

- Buffered events expire continuously once older than the rolling window.
- Frozen incidents are kept locally for **Keep incidents for (days)**, default 7, then purged.
- **Clear all local data** deletes buffers, incidents and attachments from this browser. Settings and the Jira connection are kept.
- **Reset other settings to defaults** keeps monitored sites and Jira, resets the rest.

---

## 5. Daily use

1. Test normally in a monitored tab. The popup shows the live buffer: requests, console lines, errors, actions and whether replay is recording.
2. When something goes wrong, click the TestLens icon. Optionally type what you saw in **What went wrong?**. Click **Report Issue**.
3. The side panel opens on that tab only. It shows "Evidence preserved" while the post-click window runs, then the composed bug.
4. **Bug tab**: check the focal event (change it from the candidate list if TestLens picked the wrong one), edit summary, steps, expected and actual, labels. Click **Save edits**.
5. **Evidence tab**: tick or untick attachments and individual evidence items. Click a request to see request headers, payload, response headers and body; correlation ids are highlighted. The capture quality score explains any gaps.
6. **Jira tab**: the destination (project, issue type, required field values) is prefilled from Settings and marked "default from settings". Click **Change** to pick a different project or issue type for this bug only; the required fields for that choice appear with defaults filled, and **Save as default** makes the new choice the default for future bugs. Review the exact description and fields that will be posted, any similar open issues found, and attachment sizes. Click **Create in <project>**. Nothing reaches Jira before this click.
7. The issue key appears with a link. The incident stays in the **Incidents** list for the retention period.

**Pop out** in the panel header opens the same review in a separate window. **Incidents** in the popup lists past incidents for the current tab's window.

---

## 6. What TestLens captures and what it cannot

| Signal | How | Limits |
|---|---|---|
| Request/response metadata, all headers, status, timing | `chrome.webRequest` | every request in monitored tabs, including images, scripts, navigations |
| Request and response bodies | page-world `fetch` / `XMLHttpRequest` wrapping | fetch/XHR issued by page JavaScript only. Not: navigations, images, Service Worker or Web Worker requests, opaque cross-origin responses, binary bodies. Each request shows its body capture status |
| console.log/info/warn/error/debug, uncaught errors, unhandled rejections, CSP violations, failed resource loads | page-world instrumentation at document start | logs from Web Workers are not captured |
| Clicks, inputs, selects, submits, Enter/Escape keys, SPA route changes, page loads | isolated content script and `webNavigation` | input values are never captured, only that a field changed |
| DOM replay | rrweb | canvas and video content, cross-origin iframes are not replayed |
| Screenshot | `captureVisibleTab` at Report Issue | visible viewport of the active tab only |
| Tab video | not in this build | planned: one click per tab |
| Page info | viewport, locale, timezone, online state, `<meta name="version">` | |

TestLens cannot run on `chrome://` pages, the Chrome Web Store, other extensions' pages or sites blocked by enterprise policy.

---

## 7. Attachments and the evidence package

| File | Content | Attached by default |
|---|---|---|
| `screenshot.png` | viewport at Report Issue | yes |
| `replay.rrweb.json` | DOM replay for the window | yes |
| `console.log` | console and errors in time order with the Report Issue marker | yes |
| `network.log` | index of every request, then full request headers / payload / response headers / body for API and failed requests, correlation ids marked `>>>` | yes |
| `network-focused.har` | HAR 1.2 of the selected evidence requests, with bodies | yes |
| `network-full.har` | HAR 1.2 of every request in the window | no |
| `testlens-incident.html` | self-contained viewer: timeline, network with bodies, console, replay player, raw JSON | yes |

Jira Cloud usually limits attachments to 10 MB by default. TestLens reads the instance limit and skips files above it, reporting them in the side panel. The HTML viewer loads the replay player from jsdelivr when opened, so replay needs internet access; everything else in it works offline.

---

## 8. Updating, rebuilding and development mode

**Using the extension**: build once, load once. It keeps working across browser restarts.

**After pulling or editing code**:

```bash
npm run build
```

then click the reload icon on the TestLens card in `chrome://extensions` and reload monitored tabs.

**Development mode**:

```bash
npm run dev
```

WXT opens a separate Chromium profile with the extension loaded and rebuilds on every save. Configure monitored sites and Jira in that profile once. Do not point your everyday browser at the output folder while dev mode runs: dev mode replaces the folder contents with a layout that only works while the dev server is up, and the browser then shows `ERR_FILE_NOT_FOUND` for TestLens pages. Run `npm run build` to restore the production layout.

---

## 9. Running the tests

Unit tests (schema, redaction, evidence engine, composer, Jira adapter):

```bash
npm test
```

Browser end-to-end test. It starts a fixture web app with planted bugs and a mock Jira Cloud, loads the extension into Chromium, drives the app, reports an issue, verifies the BugContext, redaction, evidence selection, composed draft and creates an issue with attachments:

```bash
cd apps/extension && TL_E2E=1 npx wxt build && cd ../..
npm run e2e
```

On PowerShell set the variable first: `$env:TL_E2E="1"; npx wxt build; Remove-Item Env:TL_E2E`.

The e2e build grants `<all_urls>` statically so automation can skip the permission prompt; always run a plain `npm run build` afterwards before using the extension yourself. The test needs a Chromium that honours `--load-extension`: Playwright's bundled Chromium (found automatically under `%LOCALAPPDATA%\ms-playwright`) or any Chromium given via `TL_EXE=<path>`. Google Chrome 137 and newer ignores that flag. Screenshots and the generated artifacts land in `e2e/.out/`.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Popup says "This site is not monitored yet" | origin not added, or permission not granted | click **Monitor this site** in the popup, or add it in settings and **Apply monitoring**, then reload the tab |
| Counts stay at zero on a monitored site | tab was open before monitoring was applied | reload the tab |
| Requests show `body: unavailable` | request was not a page fetch/XHR (navigation, image, Service Worker), or the API origin is not monitored | add the API origin to monitored sites; see §6 for inherent limits |
| No console entries at all | page loaded before TestLens attached | reload the tab |
| `ERR_FILE_NOT_FOUND` on TestLens pages | build folder incomplete after dev mode or an interrupted build | `npm run build`, then reload the extension card |
| "Screenshot failed: <all_urls> or activeTab permission is required" | Report Issue was triggered without clicking the toolbar icon | use the popup; the click grants the needed permission |
| Jira 401 | wrong email or token, or token for a different Atlassian account | recreate the token while signed in with the email you entered |
| Jira 403 | no "Create issues" permission in that project | ask the project admin |
| Jira 404 | site URL is not a Jira Cloud site, or has a path after the host | use `https://<site>.atlassian.net` exactly |
| "Permission to call … was not granted" | browser prompt dismissed | click **Connect** again and accept |
| Jira tab lists problems like "Required field X has no value" | mandatory field without a default | choose a value under **Required by this project** in settings |
| Attachment "exceeds Jira attachment limit" | file larger than the instance limit | untick `network-full.har`, or lower max body size, or shorten the rolling window |
| Side panel appears in another window | an old global panel from a previous build | close it once; from this build on it is enabled per tab |
| Service worker errors | open `chrome://extensions`, click **service worker** on the TestLens card to see its console | include the red lines when reporting a problem |

---

## 11. Privacy and data handling

- Capture is limited to the origins you list. Content scripts are registered only for those origins and only after you grant permission.
- Secrets are masked before they are written to the buffer and again at export. Masked values are not recoverable.
- Everything stays in this browser profile (IndexedDB and `chrome.storage.local`) until you click **Create**. Then exactly the previewed description and the ticked attachments go to your Jira site, under your account.
- No analytics, no telemetry, no AI provider in this build.
- Buffers expire by time; incidents expire by the retention setting; **Clear all local data** removes everything at once.

---

## 12. Uninstall and data removal

1. TestLens settings → **Data** → **Clear all local data**.
2. `chrome://extensions` → TestLens → **Remove**. This also deletes the extension's storage.
3. Revoke the API token at https://id.atlassian.com/manage-profile/security/api-tokens if you no longer need it.
