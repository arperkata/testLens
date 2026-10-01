/**
 * Fixture app under test + mock Jira Cloud, used by the e2e run.
 *   http://localhost:PORT/           app with planted bugs
 *   http://localhost:PORT/api/*      app API (receipt fails on the 3rd call)
 *   http://localhost:PORT/jira/...   mock Jira Cloud REST v3
 */
import http from 'node:http';

export function startFixture(port = 4317) {
  let receiptCalls = 0;
  const jira = { issues: [], attachments: [] };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Shop — Checkout</title>
<meta name="app-version" content="2.3.1-rc4">
<style>body{font-family:sans-serif;padding:24px}button{margin:4px;padding:8px 12px}#log{white-space:pre;background:#eee;padding:8px;margin-top:12px}</style></head>
<body><h1>Checkout</h1>
<input id="amount" name="amount" placeholder="amount" value="42">
<input id="card" name="cardNumber" placeholder="card" value="4111111111111111">
<div>
<button id="ok">Load status</button>
<button id="submit">Submit receipt</button>
<button id="boom">Throw error</button>
<button id="reject">Reject promise</button>
<button id="route">Go to /orders</button>
</div>
<div id="log"></div>
<script>
const log=(m)=>{document.getElementById('log').textContent+=m+'\\n'};
document.getElementById('ok').onclick=async()=>{const r=await fetch('/api/merchant/status',{headers:{'x-api-key':'sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ','authorization':'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz'}});log('status '+r.status);console.log('status loaded',await r.json())};
document.getElementById('submit').onclick=async()=>{console.info('submitting receipt');const r=await fetch('/api/merchant/receipt',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer secret-token-value-1234567890'},body:JSON.stringify({amount:42,password:'hunter2',card:'4111111111111111'})});log('receipt '+r.status);if(!r.ok){console.error('Failed to submit receipt: '+r.status);Promise.reject(new TypeError("Cannot read properties of undefined (reading 'receiptId')"))}};
document.getElementById('boom').onclick=()=>{throw new Error('Kaboom from button')};
document.getElementById('reject').onclick=()=>{Promise.reject(new Error('unhandled thing'))};
document.getElementById('route').onclick=()=>{history.pushState({}, '', '/orders');document.title='Orders'};
console.log('fixture booted');
</script></body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const rid = `req-${Math.random().toString(36).slice(2, 8)}`;
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': rid, ...headers });
      res.end(JSON.stringify(body));
    };
    const body = await readBody(req);

    // ---- app ----
    if (url.pathname === '/' || url.pathname === '/orders') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (url.pathname === '/api/merchant/status') return json(200, { ok: true, merchant: 'acme', token: 'should-be-redacted' });
    if (url.pathname === '/api/merchant/receipt') {
      receiptCalls++;
      if (receiptCalls % 3 === 0) {
        await new Promise((r) => setTimeout(r, 300));
        return json(500, { error: 'db timeout', hint: 'receipt service unavailable' });
      }
      return json(200, { receiptId: `R-${receiptCalls}` });
    }

    // ---- mock Jira Cloud ----
    if (url.pathname.startsWith('/jira/rest/api/3/')) {
      const p = url.pathname.slice('/jira/rest/api/3/'.length);
      if (!req.headers.authorization?.startsWith('Basic ')) return json(401, { errorMessages: ['Unauthorized'] });
      if (p === 'myself') return json(200, { accountId: 'acc-1', displayName: 'Test Tester' });
      if (p === 'project/search') return json(200, { values: [{ id: '10000', key: 'SHOP', name: 'Shop' }], isLast: true });
      if (p === 'issue/createmeta/SHOP/issuetypes') return json(200, { issueTypes: [{ id: '10004', name: 'Bug', subtask: false }] });
      if (p === 'issue/createmeta/SHOP/issuetypes/10004')
        return json(200, {
          fields: [
            { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
            { fieldId: 'description', name: 'Description', required: false, schema: { type: 'doc' } },
            { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string' } },
            { fieldId: 'priority', name: 'Priority', required: false, hasDefaultValue: true, schema: { type: 'priority' }, allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }] },
            { fieldId: 'customfield_10042', name: 'Environment', required: true, schema: { type: 'string' } },
          ],
        });
      if (p === 'attachment/meta') return json(200, { attachmentsEnabled: true, uploadLimit: 10485760 });
      if (p === 'search/jql' && req.method === 'POST') return json(200, { issues: [{ key: 'SHOP-1', fields: { summary: 'POST /api/merchant/receipt flaky 500', status: { name: 'Open' } } }] });
      if (p === 'issue' && req.method === 'POST') {
        const payload = JSON.parse(body.toString());
        const key = `SHOP-${100 + jira.issues.length}`;
        jira.issues.push({ key, payload });
        return json(201, { id: String(1000 + jira.issues.length), key, self: `${url.origin}/jira/rest/api/3/issue/${key}` });
      }
      const m = p.match(/^issue\/([A-Z]+-\d+)\/attachments$/);
      if (m && req.method === 'POST') {
        if (req.headers['x-atlassian-token'] !== 'no-check') return json(403, { errorMessages: ['XSRF check failed'] });
        const ct = req.headers['content-type'] ?? '';
        const names = [...body.toString('latin1').matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
        jira.attachments.push({ key: m[1], names, bytes: body.length, ct });
        return json(200, names.map((n, i) => ({ id: `${jira.attachments.length}-${i}`, filename: n, size: body.length })));
      }
      return json(404, { errorMessages: [`no mock for ${req.method} ${p}`] });
    }
    if (url.pathname === '/__state') return json(200, { receiptCalls, jira });
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => server.listen(port, () => resolve({ server, port, state: () => ({ receiptCalls, jira }) })));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  startFixture(Number(process.env.PORT ?? 4317)).then(({ port }) => console.log(`fixture on http://localhost:${port}`));
}
