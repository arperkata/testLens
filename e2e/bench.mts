import { performance } from "node:perf_hooks";
import { buildTimeline } from "@testlens/schema";
import { runEvidenceEngine, buildHar, buildNetworkLog } from "@testlens/evidence-engine";
import { compose } from "@testlens/composer";
import { redactContext } from "@testlens/redaction";
const T0 = Date.now();
const ex = [];
for (let i = 0; i < 3000; i++) {
  const ts = T0 - 300000 + i * 100;
  const fail = i % 97 === 0;
  ex.push({ id: "x"+i, ts, method: i % 3 ? "GET" : "POST", url: `https://api.example.com/api/items/${i % 50}?q=${i}`,
    initiator: { type: "fetch" }, request: { headers: [{ name: "authorization", value: "Bearer tok"+i }, { name: "content-type", value: "application/json" }], body: { encoding: "json", data: JSON.stringify({ n: i, password: "p"+i }), truncated: false } },
    response: { status: fail ? 500 : 200, headers: [{ name: "x-request-id", value: "r"+i }, { name: "content-type", value: "application/json" }], body: { encoding: "json", data: JSON.stringify({ ok: !fail, items: Array.from({length:20},(_,k)=>({id:k,name:"item "+k})) }), truncated: false } },
    correlationIds: [], classification: { isApi: true, isStatic: false, isTelemetry: false }, bodyCapture: { request: "full", response: "full" }, timing: { totalMs: 120 } });
}
const base = { schemaVersion: "1.0", incidentId: "inc", createdAt: T0, source: { connectorId: "browser", connectorVersion: "1", tool: { name: "Chrome" }, captureMode: "rolling" },
  trigger: { at: T0, preWindowMs: 300000, postWindowMs: 15000, initiatedBy: "user" }, environment: {}, application: { url: "https://app.example.com" },
  exchanges: ex, console: Array.from({length:400},(_,i)=>({id:"c"+i, ts: T0-300000+i*700, level: i%40?"log":"error", args:["msg "+i]})),
  errors: Array.from({length:30},(_,i)=>({id:"e"+i, ts: T0-200000+i*5000, kind:"uncaught", message:"boom "+i})),
  interactions: Array.from({length:600},(_,i)=>({id:"i"+i, ts: T0-300000+i*480, kind:"click", target:{selector:"#b"+i, tag:"button", text:"B"+i}})),
  navigation: [], assertions: [], artifacts: [], redaction: { appliedAt: [], rulesVersion: "1", counts: {} } };
const ctx0 = { ...base, timeline: buildTimeline(base) };
let t = performance.now(); const red = redactContext(ctx0); const tRed = performance.now()-t;
t = performance.now(); const ctx = runEvidenceEngine(red); const tEng = performance.now()-t;
t = performance.now(); const draft = compose(ctx); const tComp = performance.now()-t;
t = performance.now(); const har = buildHar(ctx); const tHar = performance.now()-t;
t = performance.now(); const log = buildNetworkLog(ctx); const tLog = performance.now()-t;
console.log(JSON.stringify({ redactMs: +tRed.toFixed(0), engineMs: +tEng.toFixed(0), composeMs: +tComp.toFixed(0), harMs: +tHar.toFixed(0), harKB: Math.round(har.length/1024), netlogMs: +tLog.toFixed(0), netlogKB: Math.round(log.length/1024), focal: ctx.evidence.focal?.refId, items: ctx.evidence.items.length }));
