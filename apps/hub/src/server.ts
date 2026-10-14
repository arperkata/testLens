/**
 * TestLens Hub — a small local server that receives evidence from API-testing tools and
 * normalises it into BugContext incidents. The browser extension pulls those incidents and
 * handles review, AI and tracker creation, so the Hub holds no tracker credentials.
 *
 *   npx testlens-hub            → http://localhost:7331
 *   TL_HUB_PORT=8080 npx testlens-hub
 *
 * Endpoints
 *   GET  /                       landing page with the Postman snippet
 *   GET  /health
 *   POST /ingest/postman         payload from the Postman Tests snippet or the Newman reporter
 *   POST /import                 raw HAR / Newman run JSON / Postman payload (auto-detected)
 *   GET  /incidents              list (newest first, without heavy context)
 *   GET  /incidents/:id          full incident (context + draft + artifact index)
 *   GET  /incidents/:id/artifacts/:artifactId
 *   DELETE /incidents/:id
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { HUB_VERSION, LANDING_HTML, SNIPPET_JS } from './embedded';
import type { Artifact, BugContext, BugDraft } from '@testlens/schema';
import { DEFAULT_RULES, redactContext } from '@testlens/redaction';
import { buildConsoleLog, buildHar, buildNetworkLog, runEvidenceEngine, selectedExchangeIds } from '@testlens/evidence-engine';
import { compose, withEvidenceIndex } from '@testlens/composer';
import { isNewmanRun, isPostmanPayload, normalizeNewmanRun, normalizePostmanPayload } from '@testlens/connectors-postman';
import { isHar, normalizeHar } from '@testlens/connectors-har';

const PORT = Number(process.env.TL_HUB_PORT ?? 7331);
const DATA_DIR = process.env.TL_HUB_DATA ?? path.join(os.homedir(), '.testlens', 'hub');
const MAX_BODY = 50 * 1024 * 1024;

export interface HubIncident {
  incidentId: string;
  createdAt: number;
  source: string;
  title: string;
  status: 'ready';
  context: BugContext;
  draft: BugDraft;
  /** artifact id → file name on disk */
  files: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pipeline (same stages as the extension, minus browser-only artifacts)
// ---------------------------------------------------------------------------

async function processContext(raw: BugContext, rawPayload: unknown, rawName: string): Promise<HubIncident> {
  const redacted = redactContext(raw, DEFAULT_RULES);
  const ctx = runEvidenceEngine(redacted);
  const dir = path.join(DATA_DIR, 'incidents', ctx.incidentId);
  await fs.mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  const artifacts: Artifact[] = [];
  const add = async (kind: Artifact['kind'], fileName: string, mime: string, content: string, include = true) => {
    const id = `${ctx.incidentId}:${kind}`;
    await fs.writeFile(path.join(dir, fileName), content, 'utf8');
    files[id] = fileName;
    artifacts.push({ id, kind, fileName, mime, bytes: Buffer.byteLength(content), storage: { type: 'hub', ref: `/incidents/${ctx.incidentId}/artifacts/${encodeURIComponent(id)}` }, redaction: { status: 'redacted', rulesApplied: ['default'] }, include });
  };
  await add('console-log', 'console.log', 'text/plain', buildConsoleLog(ctx), ctx.console.length > 0);
  await add('network-log', 'network.log', 'text/plain', buildNetworkLog(ctx));
  await add('har-focused', 'network-focused.har', 'application/json', buildHar(ctx, selectedExchangeIds(ctx)));
  await add('har', 'network-full.har', 'application/json', buildHar(ctx), false);
  await add('raw-connector-payload', rawName, 'application/json', JSON.stringify(rawPayload, null, 2), false);
  const withArtifacts: BugContext = { ...ctx, artifacts };
  const draft = withEvidenceIndex(compose(withArtifacts), withArtifacts);
  const inc: HubIncident = { incidentId: ctx.incidentId, createdAt: ctx.createdAt, source: ctx.source.connectorId, title: draft.summary, status: 'ready', context: withArtifacts, draft, files };
  await fs.writeFile(path.join(dir, 'incident.json'), JSON.stringify(inc), 'utf8');
  // small summary next to the full record so listing never parses full contexts
  const { context: _c, draft: _d, ...meta } = inc;
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  return inc;
}

export function detectAndNormalize(payload: unknown, fileName?: string): { ctx: BugContext; rawName: string } {
  if (isPostmanPayload(payload)) return { ctx: normalizePostmanPayload(payload), rawName: 'postman-payload.json' };
  if (isNewmanRun(payload)) return { ctx: normalizeNewmanRun(payload), rawName: fileName ?? 'newman-run.json' };
  if (isHar(payload)) return { ctx: normalizeHar(payload, { fileName }), rawName: fileName ?? 'import.har' };
  throw new HttpError(400, 'Unrecognised payload: expected a TestLens Postman payload, a Newman run JSON or a HAR 1.2 file');
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function listIncidents(): Promise<Omit<HubIncident, 'context' | 'draft'>[]> {
  const root = path.join(DATA_DIR, 'incidents');
  await fs.mkdir(root, { recursive: true });
  const ids = await fs.readdir(root);
  const out: Omit<HubIncident, 'context' | 'draft'>[] = [];
  for (const id of ids) {
    try {
      // prefer the small meta.json; fall back to the full record for incidents written before it existed
      try {
        out.push(JSON.parse(await fs.readFile(path.join(root, id, 'meta.json'), 'utf8')) as Omit<HubIncident, 'context' | 'draft'>);
      } catch {
        const inc = JSON.parse(await fs.readFile(path.join(root, id, 'incident.json'), 'utf8')) as HubIncident;
        const { context: _c, draft: _d, ...rest } = inc;
        out.push(rest);
      }
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function getIncident(id: string): Promise<HubIncident | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'incidents', safeId(id), 'incident.json'), 'utf8')) as HubIncident;
  } catch {
    return undefined;
  }
}

function safeId(id: string) {
  if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'bad id');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function cors(res: http.ServerResponse) {
  // Extensions and Postman's sandbox both need permissive CORS for a localhost tool.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TestLens-Filename');
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  cors(res);
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'payload too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Snippet with this Hub's URL baked in (assets are embedded so the single-file build needs no repo). */
function snippetForThisHub(): string {
  return SNIPPET_JS.replace("'http://localhost:7331'", `'http://localhost:${PORT}'`);
}

async function landing(): Promise<string> {
  return LANDING_HTML.split('{{PORT}}').join(String(PORT)).replace('{{SNIPPET}}', snippetForThisHub().replace(/</g, '&lt;'));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await landing(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, name: 'testlens-hub', version: HUB_VERSION, dataDir: DATA_DIR, port: PORT });
      // the Postman snippet, with this Hub's URL baked in, for the extension's API tab
      if (req.method === 'GET' && url.pathname === '/snippet') return send(res, 200, snippetForThisHub(), 'text/javascript; charset=utf-8');

      if (req.method === 'POST' && (url.pathname === '/ingest/postman' || url.pathname === '/import')) {
        const buf = await readBody(req);
        let payload: unknown;
        try {
          payload = JSON.parse(buf.toString('utf8'));
        } catch {
          throw new HttpError(400, 'body must be JSON');
        }
        const fileName = (req.headers['x-testlens-filename'] as string | undefined) ?? url.searchParams.get('name') ?? undefined;
        const { ctx, rawName } = detectAndNormalize(payload, fileName);
        const inc = await processContext(ctx, payload, rawName);
        console.log(`[hub] incident ${inc.incidentId} (${inc.source}): ${inc.title}`);
        return send(res, 201, { incidentId: inc.incidentId, title: inc.title, source: inc.source, reviewHint: 'Open the TestLens side panel → Incidents → Sync from Hub' });
      }

      if (req.method === 'GET' && url.pathname === '/incidents') return send(res, 200, await listIncidents());

      const m = url.pathname.match(/^\/incidents\/([^/]+)(?:\/artifacts\/(.+))?$/);
      if (m) {
        const inc = await getIncident(decodeURIComponent(m[1]!));
        if (!inc) throw new HttpError(404, 'incident not found');
        if (req.method === 'DELETE') {
          await fs.rm(path.join(DATA_DIR, 'incidents', inc.incidentId), { recursive: true, force: true });
          return send(res, 200, { ok: true });
        }
        if (!m[2]) return send(res, 200, inc);
        const fileName = inc.files[decodeURIComponent(m[2])];
        if (!fileName) throw new HttpError(404, 'artifact not found');
        const data = await fs.readFile(path.join(DATA_DIR, 'incidents', inc.incidentId, fileName));
        cors(res);
        res.writeHead(200, { 'content-type': fileName.endsWith('.har') || fileName.endsWith('.json') ? 'application/json' : 'text/plain', 'content-disposition': `attachment; filename="${fileName}"` });
        return res.end(data);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[hub]', e);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// Start when run directly (repo via tsx, the single-file bundle, or the bin shim); stay quiet when imported.
const runDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && (pathToFileURL(path.resolve(process.argv[1]!)).href === import.meta.url || /testlens-hub(\.mjs|\.js)?$|server\.(ts|mjs|js)$/.test(process.argv[1]!));
  } catch {
    return false;
  }
})();
if (runDirectly && !process.env.TL_HUB_NO_LISTEN) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`TestLens Hub ${HUB_VERSION} listening on http://localhost:${PORT}  (data: ${DATA_DIR})`);
    console.log('Open that URL for the Postman snippet. Incidents appear in the TestLens side panel → API testing.');
  });
}
