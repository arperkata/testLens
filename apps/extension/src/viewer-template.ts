/**
 * Self-contained incident viewer: one HTML file with the BugContext embedded.
 * A developer opens it from the Jira attachment and gets a DevTools-like view
 * (timeline, requests with bodies, console, screenshot, DOM replay) with no
 * TestLens install. rrweb-player is loaded from a CDN only if replay data exists.
 */
import type { BugContext, BugDraft } from '@testlens/schema';

export function renderViewerHtml(ctx: BugContext, draft: BugDraft, extras: { screenshotDataUrl?: string; rrwebEvents?: unknown[] }): string {
  const payload = JSON.stringify({ ctx: { ...ctx, artifacts: ctx.artifacts.map((a) => ({ ...a, storage: { type: 'inline', ref: '' } })) }, draft, screenshot: extras.screenshotDataUrl ?? null, rrweb: extras.rrwebEvents ?? null }).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TestLens incident ${esc(ctx.incidentId)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e6e8ee;--muted:#8b93a7;--acc:#4f8cff;--err:#ff5c5c;--warn:#ffb020;--ok:#3ecf8e;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-size:13px}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header h1{font-size:16px;margin:0}header .meta{color:var(--muted)}
nav{display:flex;gap:4px;padding:8px 20px;border-bottom:1px solid var(--line)}
nav button{background:transparent;border:1px solid var(--line);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer}
nav button.active{background:var(--acc);border-color:var(--acc);color:#fff}
main{padding:16px 20px}section{display:none}section.active{display:block}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-family:ui-monospace,Consolas,monospace;font-size:12px}
th{color:var(--muted);font-weight:500}tr.clickable{cursor:pointer}tr.clickable:hover{background:var(--panel)}
.s5{color:var(--err);font-weight:600}.s4{color:var(--warn);font-weight:600}.s2{color:var(--ok)}.focal{outline:2px solid var(--acc);outline-offset:-2px}
pre{background:var(--panel);border:1px solid var(--line);padding:10px;border-radius:6px;overflow:auto;max-height:360px;white-space:pre-wrap;word-break:break-all;font-size:12px}
.detail{margin:8px 0 16px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;background:var(--line);color:var(--muted);font-size:11px;margin-left:6px}
.tl{position:relative;padding-left:18px;border-left:2px solid var(--line);margin-left:6px}.tl .ev{position:relative;padding:4px 0 4px 10px}.tl .ev:before{content:"";position:absolute;left:-23px;top:9px;width:8px;height:8px;border-radius:50%;background:var(--muted)}
.tl .ev.error:before,.tl .ev.fail:before{background:var(--err)}.tl .ev.trigger:before{background:var(--acc);width:12px;height:12px;left:-25px;top:7px}.tl .ev.interaction:before{background:var(--ok)}
.t{color:var(--muted);font-family:ui-monospace,monospace;margin-right:8px}
h2{font-size:14px;margin:18px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
img.shot{max-width:100%;border:1px solid var(--line);border-radius:8px}
.ai{border-left:3px solid var(--warn);padding-left:10px}.prov{font-size:11px;color:var(--muted)}
#replay{background:#000;border-radius:8px;overflow:hidden}
label.f{display:inline-flex;gap:6px;align-items:center;margin-right:14px;color:var(--muted)}
</style></head><body>
<header><h1>TestLens incident</h1><span class="meta" id="hmeta"></span></header>
<nav id="nav"></nav>
<main>
<section id="summary" class="active"></section>
<section id="timeline"></section>
<section id="network"></section>
<section id="console"></section>
<section id="replay"></section>
<section id="raw"><pre id="rawpre"></pre></section>
</main>
<script id="tl-data" type="application/json">${payload}</script>
<script>
(function(){
const D=JSON.parse(document.getElementById('tl-data').textContent);const C=D.ctx,B=D.draft;
const $=s=>document.querySelector(s);const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const t=ts=>new Date(ts).toISOString().slice(11,23);const rel=ts=>{const d=(ts-C.trigger.at)/1000;return (d<=0?'-':'+')+Math.abs(d).toFixed(1)+'s'};
const tabs=[['summary','Summary'],['timeline','Timeline'],['network','Network ('+C.exchanges.length+')'],['console','Console ('+(C.console.length+C.errors.length)+')'],['replay','Replay'],['raw','Raw JSON']];
$('#nav').innerHTML=tabs.map(([k,l],i)=>'<button data-k="'+k+'" class="'+(i===0?'active':'')+'">'+l+'</button>').join('');
$('#nav').onclick=e=>{const b=e.target.closest('button');if(!b)return;document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('section').forEach(s=>s.classList.toggle('active',s.id===b.dataset.k));if(b.dataset.k==='replay')initReplay();};
$('#hmeta').textContent=C.incidentId+' · reported '+new Date(C.trigger.at).toLocaleString()+' · '+(C.browser?C.browser.name+' '+C.browser.version:'')+' · '+(C.application.url||'');
const focal=C.evidence&&C.evidence.focal;const inc=new Set((C.evidence?C.evidence.items:[]).filter(i=>i.include).map(i=>i.kind+':'+i.refId));
// summary
$('#summary').innerHTML='<h2>'+esc(B.summary)+'</h2>'+
 (focal?'<div class="detail"><b>Focal event</b><span class="badge">'+esc(focal.kind)+'</span><div>'+focal.reasons.map(esc).join(' · ')+'</div></div>':'')+
 '<h2>Steps to reproduce</h2><ol>'+B.stepsToReproduce.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ol>'+
 '<h2>Expected</h2><p>'+esc(B.expectedResult)+'</p><h2>Actual</h2><p>'+esc(B.actualResult)+'</p>'+
 (D.screenshot?'<h2>Screenshot at Report Issue</h2><img class="shot" src="'+D.screenshot+'">':'')+
 B.sections.map(s=>'<div class="'+(s.provenance==='ai'?'ai':'')+'"><h2>'+esc(s.title)+' <span class="prov">'+esc(s.provenance)+'</span></h2>'+(s.code?'<pre>'+esc(s.body)+'</pre>':'<p>'+esc(s.body).replace(/\\n/g,'<br>')+'</p>')+'</div>').join('')+
 (C.evidence?'<h2>Capture quality</h2><p>'+C.evidence.captureQuality.score+'/100 — '+C.evidence.captureQuality.notes.map(esc).join(' ')+'</p>':'');
// timeline
const byId={};for(const e of C.exchanges)byId['exchange:'+e.id]=e;for(const e of C.console)byId['console:'+e.id]=e;for(const e of C.errors)byId['error:'+e.id]=e;for(const e of C.interactions)byId['interaction:'+e.id]=e;for(const e of C.navigation)byId['navigation:'+e.id]=e;
let onlySel=true;function renderTl(){const rows=C.timeline.filter(r=>!onlySel||r.kind==='trigger'||inc.has(r.kind+':'+r.refId)).map(r=>{const e=byId[r.kind+':'+r.refId];let cls=r.kind,txt='';
 if(r.kind==='trigger'){cls='trigger';txt='<b>Tester clicked Report Issue</b>'}
 else if(r.kind==='exchange'){const st=e.error?'ERR '+e.error.kind:e.response?e.response.status:'-';cls=(e.error||(e.response&&e.response.status>=400))?'fail':'exchange';txt='<span class="'+(e.response?'s'+String(e.response.status)[0]:'s5')+'">'+st+'</span> '+esc(e.method)+' '+esc(e.url)+(e.timing?' <span class="badge">'+Math.round(e.timing.totalMs)+'ms</span>':'')}
 else if(r.kind==='console'){cls=e.level==='error'?'error':'console';txt='console.'+e.level+': '+esc(e.args.join(' ').slice(0,300))}
 else if(r.kind==='error'){cls='error';txt=esc(e.kind)+': '+esc(e.message.slice(0,300))}
 else if(r.kind==='interaction'){txt=esc(e.kind)+' '+esc(e.target.text||e.target.selector)}
 else if(r.kind==='navigation'){txt='→ '+esc(e.kind)+' '+esc(e.to)}
 const f=focal&&focal.kind===r.kind&&focal.refId===r.refId;return '<div class="ev '+cls+(f?' focal':'')+'"><span class="t">'+t(r.ts)+' '+rel(r.ts)+'</span>'+txt+(f?'<span class="badge">focal</span>':'')+'</div>'}).join('');
 $('#timeline').innerHTML='<label class="f"><input type="checkbox" id="onlysel" '+(onlySel?'checked':'')+'> show only selected evidence</label><div class="tl">'+rows+'</div>';$('#onlysel').onchange=e=>{onlySel=e.target.checked;renderTl()}}
renderTl();
// network
function renderNet(){const rows=[...C.exchanges].sort((a,b)=>a.ts-b.ts).map((e,i)=>{const st=e.error?'ERR':e.response?e.response.status:'-';const f=focal&&focal.kind==='exchange'&&focal.refId===e.id;
 return '<tr class="clickable'+(f?' focal':'')+'" data-i="'+i+'"><td>'+t(e.ts)+'</td><td class="'+(e.response?'s'+String(e.response.status)[0]:'s5')+'">'+st+'</td><td>'+esc(e.method)+'</td><td>'+esc(e.url)+'</td><td>'+(e.timing?Math.round(e.timing.totalMs)+'ms':'')+'</td><td>'+(e.initiator?esc(e.initiator.type):'')+'</td><td>'+(inc.has('exchange:'+e.id)?'✓':'')+'</td></tr>'}).join('');
 $('#network').innerHTML='<table><thead><tr><th>time</th><th>status</th><th>method</th><th>url</th><th>dur</th><th>init</th><th>sel</th></tr></thead><tbody>'+rows+'</tbody></table><div id="netdetail"></div>';
 const sorted=[...C.exchanges].sort((a,b)=>a.ts-b.ts);$('#network tbody').onclick=ev=>{const tr=ev.target.closest('tr');if(!tr)return;const e=sorted[+tr.dataset.i];
 const h=hs=>hs.map(x=>esc(x.name)+': '+esc(x.value)).join('\\n');$('#netdetail').innerHTML='<div class="detail"><b>'+esc(e.method)+' '+esc(e.url)+'</b> <span class="badge">'+(e.error?'ERR '+esc(e.error.kind):e.response?e.response.status:'')+'</span>'+(e.correlationIds.length?'<div>correlation: '+e.correlationIds.map(c=>esc(c.header)+'='+esc(c.value)).join(', ')+'</div>':'')+
 '<h2>Request headers</h2><pre>'+h(e.request.headers)+'</pre>'+(e.request.body?'<h2>Request body <span class="badge">'+e.bodyCapture.request+'</span></h2><pre>'+esc(pretty(e.request.body.data))+'</pre>':'')+
 (e.response?'<h2>Response headers</h2><pre>'+h(e.response.headers)+'</pre><h2>Response body <span class="badge">'+e.bodyCapture.response+'</span></h2><pre>'+(e.response.body?esc(pretty(e.response.body.data)):'&lt;'+e.bodyCapture.response+'&gt;')+'</pre>':'')+(e.initiator&&e.initiator.stack?'<h2>Initiator stack</h2><pre>'+esc(e.initiator.stack)+'</pre>':'')+'</div>';$('#netdetail').scrollIntoView({behavior:'smooth'})}}
function pretty(s){try{return JSON.stringify(JSON.parse(s),null,2)}catch(e){return s}}
renderNet();
// console
const crows=[...C.console.map(c=>({ts:c.ts,cls:c.level==='error'?'s5':c.level==='warn'?'s4':'',txt:'console.'+c.level+' '+c.args.join(' ')+(c.stack?'\\n'+c.stack:'')})),...C.errors.map(e=>({ts:e.ts,cls:'s5',txt:e.kind+': '+e.message+(e.stack?'\\n'+e.stack:'')}))].sort((a,b)=>a.ts-b.ts);
$('#console').innerHTML='<table><tbody>'+crows.map(r=>'<tr><td style="white-space:nowrap">'+t(r.ts)+'</td><td class="'+r.cls+'"><pre style="margin:0;max-height:none;background:none;border:0;padding:0">'+esc(r.txt)+'</pre></td></tr>').join('')+'</tbody></table>';
// replay
let replayInit=false;function initReplay(){if(replayInit)return;replayInit=true;if(!D.rrweb||!D.rrweb.length){$('#replay').innerHTML='<p>No DOM replay in this incident.</p>';return}
 $('#replay').innerHTML='<p class="prov">Loading rrweb-player from jsdelivr (requires internet)…</p><div id="rrp"></div>';const l=document.createElement('link');l.rel='stylesheet';l.href='https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/style.css';document.head.appendChild(l);
 const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.17/dist/index.js';s.onload=()=>{try{$('#replay p').remove();new rrwebPlayer({target:$('#rrp'),props:{events:D.rrweb,width:Math.min(1100,innerWidth-60),height:600,autoPlay:false,skipInactive:true}})}catch(e){$('#replay').innerHTML='<p>Replay failed: '+esc(e.message)+'</p>'}};s.onerror=()=>{$('#replay').innerHTML='<p>Could not load rrweb-player (offline?). The replay data is in replay.rrweb.json.</p>'};document.body.appendChild(s)}
$('#rawpre').textContent=JSON.stringify(C,null,2);
})();
</script></body></html>`;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
