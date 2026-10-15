# testlens-hub

Local ingestion server for [TestLens](https://github.com/testlens/testlens), the open-source testing flight recorder. The Hub receives evidence from API-testing tools (Postman, Newman, HAR files), runs the same redaction → evidence engine → composer pipeline as the browser extension, and the TestLens extension pulls the resulting incidents for review and bug creation in Jira, Azure DevOps, GitHub, GitLab or Linear.

The Hub holds no tracker credentials and never leaves your machine. It is a single JavaScript file with zero runtime dependencies; the only requirement is Node.js 18 or newer.

## Run

Download the single file and start it (Windows: use `curl.exe`):

```bash
curl -L -o testlens-hub.mjs https://arperkata.github.io/testLens/testlens-hub.mjs && node testlens-hub.mjs
```

The TestLens side panel's **API testing** tab shows this command for your OS and offers double-click start scripts. With npm, once published: `npx testlens-hub`.

Options via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TL_HUB_PORT` | `7331` | Port to listen on (127.0.0.1 only) |
| `TL_HUB_DATA` | `~/.testlens/hub` | Where incidents and artifacts are stored |

## Use

1. Open `http://localhost:7331` for the Postman snippet, or open the TestLens side panel → **API testing** tab, which detects the Hub and shows the snippet with your port baked in.
2. In TestLens settings → **API testing tools**, click **Connect & test**.
3. Postman: paste the snippet into the collection's Post-response script. Newman: `newman run collection.json -r cli,testlens --reporter-testlens-hub http://localhost:7331` with `newman-reporter-testlens` installed, or import the run JSON / a HAR file from the side panel.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Landing page with the snippet |
| GET | `/health` | `{ ok, version, port, dataDir }` |
| GET | `/snippet` | Postman snippet for this Hub |
| POST | `/ingest/postman` | Payload from the snippet or the Newman reporter |
| POST | `/import` | HAR 1.2, Newman run JSON or Postman payload (auto-detected) |
| GET | `/incidents` | List, newest first |
| GET | `/incidents/:id` | Full incident (context, draft, artifact index) |
| GET | `/incidents/:id/artifacts/:artifactId` | Download an artifact |
| DELETE | `/incidents/:id` | Remove |

## Build from source

```bash
npm run hub:build   # apps/hub/dist/testlens-hub.mjs
npm run test:hub    # build + standalone smoke test
```

MIT licensed.
