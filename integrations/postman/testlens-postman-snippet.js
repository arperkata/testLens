// ---- TestLens snippet v1 — paste into the collection's Post-response (Tests) script ----
// Sends evidence to your local TestLens Hub ONLY when something failed:
//   • response status >= 400, or a request error
//   • a pm.test(...) in this script failed (wrap your tests below the "pm.test = tlTest" line)
//   • you set pm.variables.set("TL_REPORT", "why") before this script runs
// Review and create the bug in the TestLens side panel (Incidents → Sync from Hub).
(function () {
  var TL_HUB = pm.variables.get('TL_HUB') || 'http://localhost:7331';
  var tlTests = [];
  var _test = pm.test;
  // wrapper that records assertion outcomes without changing Postman's own reporting
  pm.test = function tlTest(name, fn) {
    return _test(name, function () {
      try {
        fn();
        tlTests.push({ name: name, passed: true });
      } catch (e) {
        tlTests.push({ name: name, passed: false, error: e && e.message ? e.message : String(e) });
        throw e;
      }
    });
  };

  // Put your own pm.test(...) calls here (or in request-level scripts that run in this sandbox).

  var forced = pm.variables.get('TL_REPORT');
  var code = pm.response ? pm.response.code : 0;
  var failedTests = tlTests.filter(function (t) { return !t.passed; });
  if (!(forced || code >= 400 || code === 0 || failedTests.length)) return;
  if (forced) pm.variables.unset('TL_REPORT');

  var headersOf = function (list) {
    var out = [];
    try { list.each(function (h) { out.push({ key: h.key, value: String(h.value) }); }); } catch (e) {}
    return out;
  };
  var reqBody = '';
  try { reqBody = pm.request.body ? (pm.request.body.raw || JSON.stringify(pm.request.body.toJSON())) : ''; } catch (e) {}
  var resBody = '';
  try { resBody = pm.response ? pm.response.text() : ''; } catch (e) {}
  if (resBody && resBody.length > 262144) resBody = resBody.slice(0, 262144) + '\n...[truncated by TestLens]';

  var info = (pm.info || {});
  var payload = {
    source: 'postman',
    snippetVersion: '1',
    timestamp: new Date().toISOString(),
    note: typeof forced === 'string' && forced !== 'true' ? forced : undefined,
    collection: (pm.collectionVariables && pm.collectionVariables.get('TL_COLLECTION')) || undefined,
    requestName: info.requestName,
    iteration: info.iteration,
    environment: { name: pm.environment ? pm.environment.name : undefined },
    request: {
      method: pm.request.method,
      url: pm.request.url.toString(),
      headers: headersOf(pm.request.headers),
      body: { mode: pm.request.body ? pm.request.body.mode : undefined, raw: reqBody }
    },
    response: pm.response ? {
      code: pm.response.code,
      status: pm.response.status,
      headers: headersOf(pm.response.headers),
      body: resBody,
      responseTime: pm.response.responseTime,
      responseSize: pm.response.responseSize
    } : undefined,
    tests: tlTests
  };

  pm.sendRequest({
    url: TL_HUB + '/ingest/postman',
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: { mode: 'raw', raw: JSON.stringify(payload) }
  }, function (err, res) {
    if (err) console.warn('TestLens Hub not reachable at ' + TL_HUB + ' (' + err + '). Start it with: npx testlens-hub');
    else console.log('TestLens: incident sent → open the side panel → Incidents → Sync from Hub');
  });
})();
