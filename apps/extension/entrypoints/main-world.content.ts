/**
 * MAIN-world instrumentation. Runs inside the page's JS context at document_start.
 * Captures console, uncaught errors, unhandled rejections, SPA navigation and
 * fetch/XHR exchanges (with bodies), and relays everything to the isolated-world
 * content script via a DOM CustomEvent. Must stay dependency-light and defensive.
 *
 * Registered dynamically by the background script (scripting.registerContentScripts)
 * for monitored origins only, so it never runs on sites the tester did not opt in.
 */
import { defineContentScript } from 'wxt/sandbox';
import { PAGE_EVENT, type PageExchange, type PageToContentMessage } from '../src/messages';

export default defineContentScript({
  matches: ['*://*/*'],
  registration: 'runtime',
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    install();
  },
});

const FLAG = '__testlens_installed__';

function install() {
  const w = window as unknown as Record<string, unknown>;
  if (w[FLAG]) return;
  w[FLAG] = true;

  // Config injected by the isolated script via a data attribute (set before we run, when possible)
  // or via a CustomEvent (when the isolated script runs after us). Both orders are supported.
  const cfg = readConfig();
  document.addEventListener('__testlens_config__', (ev) => {
    try {
      Object.assign(cfg, JSON.parse((ev as CustomEvent<string>).detail) as Partial<typeof cfg>);
    } catch {
      /* ignore */
    }
  });
  let seq = 0;
  const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;

  const send = (msg: PageToContentMessage) => {
    try {
      document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: JSON.stringify(msg) }));
    } catch {
      /* page may have frozen CustomEvent; ignore */
    }
  };

  // ---------------- console ----------------
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const orig = console[level];
    if (typeof orig !== 'function') continue;
    console[level] = function (this: unknown, ...args: unknown[]) {
      try {
        if (cfg.consoleLevels.includes(level)) {
          send({ type: 'console', entry: { id: newId('c'), ts: Date.now(), level, args: args.map((a) => serialize(a, 0)), stack: level === 'error' || level === 'warn' ? captureStack(2) : undefined } });
        }
      } catch {
        /* never break the page */
      }
      return Reflect.apply(orig, this, args);
    };
  }

  // ---------------- errors ----------------
  window.addEventListener(
    'error',
    (ev) => {
      try {
        const anyEv = ev as Event;
        if (anyEv.target && anyEv.target !== window && !(anyEv instanceof ErrorEvent)) {
          const t = anyEv.target as HTMLElement & { src?: string; href?: string };
          send({ type: 'error', entry: { id: newId('e'), ts: Date.now(), kind: 'resource', message: `Failed to load ${t.tagName?.toLowerCase() ?? 'resource'}: ${t.src ?? t.href ?? ''}`, source: t.src ?? t.href } });
          return;
        }
        const e = ev as ErrorEvent;
        send({ type: 'error', entry: { id: newId('e'), ts: Date.now(), kind: 'uncaught', message: String(e.message ?? e.error ?? 'Unknown error'), stack: e.error?.stack, source: e.filename, line: e.lineno, column: e.colno } });
      } catch {
        /* ignore */
      }
    },
    true,
  );
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const r = ev.reason;
      send({ type: 'error', entry: { id: newId('e'), ts: Date.now(), kind: 'unhandledrejection', message: r instanceof Error ? r.message : serialize(r, 0), stack: r instanceof Error ? r.stack : undefined } });
    } catch {
      /* ignore */
    }
  });
  document.addEventListener('securitypolicyviolation', (ev) => {
    send({ type: 'error', entry: { id: newId('e'), ts: Date.now(), kind: 'csp', message: `CSP violation: ${ev.violatedDirective} blocked ${ev.blockedURI}`, source: ev.sourceFile, line: ev.lineNumber, column: ev.columnNumber } });
  });

  // ---------------- SPA navigation ----------------
  let lastUrl = location.href;
  const nav = (kind: 'pushState' | 'replaceState' | 'popstate' | 'hashchange') => {
    const to = location.href;
    if (to === lastUrl && kind !== 'popstate') return;
    send({ type: 'navigation', entry: { id: newId('n'), ts: Date.now(), kind, from: lastUrl, to, title: document.title } });
    lastUrl = to;
  };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = Reflect.apply(orig, this, args);
      queueMicrotask(() => nav(m));
      return r;
    };
  }
  window.addEventListener('popstate', () => nav('popstate'));
  window.addEventListener('hashchange', () => nav('hashchange'));
  send({ type: 'navigation', entry: { id: newId('n'), ts: Date.now(), kind: 'load', to: location.href, title: document.title } });

  // ---------------- fetch ----------------
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const ts = Date.now();
      const id = newId('x');
      let method = 'GET';
      let url = '';
      let reqHeaders: { name: string; value: string }[] = [];
      let reqBody: PageExchange['requestBody'];
      try {
        const req = input instanceof Request ? input : undefined;
        url = absolute(req ? req.url : String(input instanceof URL ? input.href : input));
        method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
        reqHeaders = headersToArray(init?.headers ?? req?.headers);
        if (cfg.captureBodies) reqBody = await bodyFromInit(init?.body, req, cfg.maxBodyBytes);
      } catch {
        /* ignore */
      }
      const stack = captureStack(2);
      let res: Response;
      try {
        res = await Reflect.apply(origFetch, this, [input, init]);
      } catch (err) {
        send({ type: 'page-exchange', exchange: { id, ts, endTs: Date.now(), kind: 'fetch', method, url, requestHeaders: reqHeaders, requestBody: reqBody, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack } });
        throw err;
      }
      try {
        const ex: PageExchange = { id, ts, endTs: Date.now(), kind: 'fetch', method, url, requestHeaders: reqHeaders, requestBody: reqBody, status: res.status, statusText: res.statusText, responseHeaders: headersToArray(res.headers), stack };
        if (res.type === 'opaque' || res.type === 'opaqueredirect') {
          ex.responseBody = { data: '', truncated: false, originalBytes: 0, omitted: 'opaque' };
          send({ type: 'page-exchange', exchange: ex });
        } else if (!cfg.captureBodies) {
          send({ type: 'page-exchange', exchange: ex });
        } else {
          const mime = res.headers.get('content-type') ?? '';
          if (!isTextual(mime)) {
            ex.responseBody = { data: '', truncated: false, originalBytes: Number(res.headers.get('content-length') ?? 0), mimeType: mime, omitted: 'binary' };
            send({ type: 'page-exchange', exchange: ex });
          } else {
            // read a clone asynchronously; do not delay the page
            const clone = res.clone();
            void readText(clone, cfg.maxBodyBytes)
              .then((b) => {
                ex.responseBody = { ...b, mimeType: mime };
                ex.endTs = Date.now();
                send({ type: 'page-exchange', exchange: ex });
              })
              .catch(() => {
                ex.responseBody = { data: '', truncated: false, originalBytes: 0, mimeType: mime, omitted: 'unreadable' };
                send({ type: 'page-exchange', exchange: ex });
              });
          }
        }
      } catch {
        /* ignore */
      }
      return res;
    };
  }

  // ---------------- XHR ----------------
  if (typeof XMLHttpRequest !== 'undefined') {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;
    const origSetHeader = XP.setRequestHeader;
    type Meta = { id: string; ts: number; method: string; url: string; headers: { name: string; value: string }[]; stack?: string; body?: PageExchange['requestBody'] };
    const metaMap = new WeakMap<XMLHttpRequest, Meta>();

    XP.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        metaMap.set(this, { id: newId('x'), ts: Date.now(), method: String(method).toUpperCase(), url: absolute(String(url)), headers: [], stack: captureStack(2) });
      } catch {
        /* ignore */
      }
      return Reflect.apply(origOpen, this, [method, url, ...rest]);
    } as typeof XP.open;

    XP.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      metaMap.get(this)?.headers.push({ name, value });
      return Reflect.apply(origSetHeader, this, [name, value]);
    };

    XP.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = metaMap.get(this);
      if (meta) {
        meta.ts = Date.now();
        if (cfg.captureBodies) void bodyFromInit(body as BodyInit | null | undefined, undefined, cfg.maxBodyBytes).then((b) => (meta.body = b));
        const finish = (error?: string) => {
          try {
            const ex: PageExchange = { id: meta.id, ts: meta.ts, endTs: Date.now(), kind: 'xhr', method: meta.method, url: meta.url, requestHeaders: meta.headers, requestBody: meta.body, stack: meta.stack };
            if (error) ex.error = error;
            else {
              ex.status = this.status;
              ex.statusText = this.statusText;
              ex.responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
              const mime = this.getResponseHeader('content-type') ?? '';
              if (cfg.captureBodies) {
                if (this.responseType === '' || this.responseType === 'text') ex.responseBody = { ...clip(this.responseText ?? '', cfg.maxBodyBytes), mimeType: mime };
                else if (this.responseType === 'json') ex.responseBody = { ...clip(safeStringify(this.response), cfg.maxBodyBytes), mimeType: mime };
                else ex.responseBody = { data: '', truncated: false, originalBytes: 0, mimeType: mime, omitted: 'binary' };
              }
            }
            send({ type: 'page-exchange', exchange: ex });
          } catch {
            /* ignore */
          }
        };
        this.addEventListener('load', () => finish());
        this.addEventListener('error', () => finish('network error'));
        this.addEventListener('abort', () => finish('aborted'));
        this.addEventListener('timeout', () => finish('timeout'));
      }
      return Reflect.apply(origSend, this, [body]);
    };
  }

  // ---------------- helpers ----------------
  function readConfig() {
    const defaults = { captureBodies: true, maxBodyBytes: 262144, domReplay: true, maskAllInputs: true, consoleLevels: ['log', 'info', 'warn', 'error', 'debug'] as string[] };
    try {
      const raw = document.documentElement?.getAttribute('data-testlens-config');
      if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<typeof defaults>) };
    } catch {
      /* ignore */
    }
    return defaults;
  }
  function absolute(u: string) {
    try {
      return new URL(u, location.href).href;
    } catch {
      return u;
    }
  }
  function headersToArray(h: HeadersInit | Headers | undefined): { name: string; value: string }[] {
    if (!h) return [];
    try {
      if (h instanceof Headers) return Array.from(h.entries()).map(([name, value]) => ({ name, value }));
      if (Array.isArray(h)) return h.map(([name, value]) => ({ name, value: String(value) }));
      return Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
    } catch {
      return [];
    }
  }
  function parseRawHeaders(raw: string) {
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      });
  }
  function isTextual(mime: string) {
    return !mime || /json|text|xml|javascript|x-www-form-urlencoded|graphql|html|csv|yaml|problem\+json/i.test(mime);
  }
  async function readText(res: Response, max: number) {
    const txt = await res.text();
    return clip(txt, max);
  }
  function clip(txt: string, max: number) {
    const bytes = txt.length; // approximation
    return bytes > max ? { data: txt.slice(0, max), truncated: true, originalBytes: bytes } : { data: txt, truncated: false, originalBytes: bytes };
  }
  async function bodyFromInit(body: BodyInit | Document | null | undefined, req: Request | undefined, max: number): Promise<PageExchange['requestBody']> {
    try {
      if (body == null && req && req.body) {
        const txt = await req.clone().text();
        return clip(txt, max);
      }
      if (body == null) return undefined;
      if (typeof body === 'string') return clip(body, max);
      if (body instanceof URLSearchParams) return { ...clip(body.toString(), max), mimeType: 'application/x-www-form-urlencoded' };
      if (body instanceof FormData) {
        const parts: string[] = [];
        body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v : `<file ${v.name} ${v.size}B>`}`));
        return { ...clip(parts.join('&'), max), mimeType: 'multipart/form-data' };
      }
      if (body instanceof Blob) return { data: '', truncated: false, originalBytes: body.size, mimeType: body.type, omitted: 'binary' };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { data: '', truncated: false, originalBytes: body.byteLength, omitted: 'binary' };
      if (typeof Document !== 'undefined' && body instanceof Document) return clip(new XMLSerializer().serializeToString(body), max);
      return { data: '', truncated: false, originalBytes: 0, omitted: 'stream' };
    } catch {
      return undefined;
    }
  }
  function serialize(v: unknown, depth: number): string {
    try {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v === 'string') return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
      if (typeof v === 'function') return `[Function ${(v as { name?: string }).name ?? ''}]`;
      if (typeof v === 'symbol') return v.toString();
      if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
      if (typeof Element !== 'undefined' && v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? `#${v.id}` : ''}${v.className && typeof v.className === 'string' ? `.${v.className.split(/\s+/).join('.')}` : ''}>`;
      if (depth > 3) return Array.isArray(v) ? `[Array(${v.length})]` : '[Object]';
      const seen = new WeakSet<object>();
      const s = JSON.stringify(
        v,
        (_k, val) => {
          if (typeof val === 'bigint') return String(val);
          if (val && typeof val === 'object') {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          return val;
        },
        0,
      );
      return s && s.length > 4000 ? `${s.slice(0, 4000)}…` : (s ?? String(v));
    } catch {
      return String(v);
    }
  }
  function safeStringify(v: unknown) {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return String(v);
    }
  }
  function captureStack(skip: number): string | undefined {
    try {
      const s = new Error().stack;
      if (!s) return undefined;
      const lines = s.split('\n').slice(1 + skip).filter((l) => !l.includes('main-world'));
      return lines.slice(0, 8).join('\n');
    } catch {
      return undefined;
    }
  }
}
