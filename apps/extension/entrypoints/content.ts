/**
 * Isolated-world content script. Relays MAIN-world events to the background,
 * captures user interactions, records DOM replay (rrweb) and reports page info.
 */
import { defineContentScript } from 'wxt/sandbox';
import { record } from 'rrweb';
import type { InteractionEntry } from '@testlens/schema';
import { PAGE_EVENT, type CaptureMessage, type ContentConfig, type PageToContentMessage } from '../src/messages';

export default defineContentScript({
  matches: ['*://*/*'],
  registration: 'runtime',
  runAt: 'document_start',
  allFrames: true,
  async main() {
    const isTop = window === window.top;
    const frameUrl = location.href;

    // ---- connect to background ----
    let port: chrome.runtime.Port | undefined;
    let queue: CaptureMessage[] = [];
    const connect = () => {
      try {
        port = chrome.runtime.connect({ name: 'tl-capture' });
        port.onDisconnect.addListener(() => {
          port = undefined;
          // SW may have been restarted; reconnect lazily on next message
        });
        for (const m of queue.splice(0)) port.postMessage(m);
      } catch {
        port = undefined;
      }
    };
    const post = (m: CaptureMessage) => {
      if (!port) connect();
      if (port) {
        try {
          port.postMessage(m);
          return;
        } catch {
          port = undefined;
        }
      }
      queue.push(m);
      if (queue.length > 500) queue = queue.slice(-500);
    };
    connect();

    // ---- config for the MAIN world ----
    const cfg = await getConfig();
    try {
      document.documentElement.setAttribute('data-testlens-config', JSON.stringify(cfg));
      document.dispatchEvent(new CustomEvent('__testlens_config__', { detail: JSON.stringify(cfg) }));
    } catch {
      /* ignore */
    }

    // ---- relay MAIN-world events ----
    document.addEventListener(PAGE_EVENT, (ev) => {
      try {
        const msg = JSON.parse((ev as CustomEvent<string>).detail) as PageToContentMessage;
        if (msg.type === 'console') post({ type: 'console', entry: { ...msg.entry, frameUrl: isTop ? undefined : frameUrl } });
        else if (msg.type === 'error') post({ type: 'error', entry: { ...msg.entry, frameUrl: isTop ? undefined : frameUrl } });
        else post(msg);
      } catch {
        /* ignore malformed */
      }
    });

    // ---- interactions ----
    let seq = 0;
    const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
    const describe = (el: Element): InteractionEntry['target'] => {
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || (input.value && (tag === 'button' || input.type === 'submit') ? input.value : undefined) || input.getAttribute?.('aria-label') || input.getAttribute?.('title') || input.placeholder || undefined;
      return { selector: cssPath(el), tag, text: text || undefined, role: el.getAttribute('role') ?? undefined, name: input.name || el.id || undefined, type: input.type || undefined };
    };
    const emit = (kind: InteractionEntry['kind'], el: Element, valueMasked?: boolean) => {
      post({ type: 'interaction', entry: { id: newId('i'), ts: Date.now(), kind, target: describe(el), valueMasked, frameUrl: isTop ? undefined : frameUrl } });
    };
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        if (!t || !(t instanceof Element)) return;
        emit('click', (t.closest('button,a,[role=button],input,label,summary,[onclick]') as Element | null) ?? t);
      },
      true,
    );
    document.addEventListener('submit', (e) => e.target instanceof Element && emit('submit', e.target), true);
    let lastInput: { el: Element; ts: number } | undefined;
    document.addEventListener(
      'input',
      (e) => {
        const t = e.target as Element | null;
        if (!t || !(t instanceof Element)) return;
        if (lastInput && lastInput.el === t && Date.now() - lastInput.ts < 1500) {
          lastInput.ts = Date.now();
          return; // collapse keystrokes
        }
        lastInput = { el: t, ts: Date.now() };
        emit('input', t, true);
      },
      true,
    );
    document.addEventListener('change', (e) => e.target instanceof Element && (e.target as HTMLElement).tagName === 'SELECT' && emit('change', e.target, true), true);
    document.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === 'Escape') && e.target instanceof Element && emit('keydown', e.target), true);

    // ---- page info (top frame only) ----
    if (isTop) {
      const sendInfo = () =>
        post({
          type: 'page-info',
          info: {
            viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
            locale: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            online: navigator.onLine,
            appVersion: document.querySelector('meta[name="version"],meta[name="app-version"],meta[name="build"],meta[name="build-version"]')?.getAttribute('content') ?? undefined,
            title: document.title,
            url: location.href,
          },
        });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sendInfo);
      else sendInfo();
      window.addEventListener('load', sendInfo);
      window.addEventListener('resize', debounce(sendInfo, 500));
      setInterval(sendInfo, 30_000);
    }

    // ---- rrweb DOM replay (top frame only; iframes are recorded via parent when same-origin) ----
    if (isTop && cfg.domReplay) {
      const start = () => {
        let batch: unknown[] = [];
        const flushBatch = () => {
          if (!batch.length) return;
          const b = batch;
          batch = [];
          post({ type: 'rrweb', events: b, ts: Date.now() });
        };
        setInterval(flushBatch, 1000);
        try {
          record({
            emit(event) {
              batch.push(event);
              if (batch.length >= 200) flushBatch();
            },
            checkoutEveryNms: 60_000,
            maskAllInputs: cfg.maskAllInputs,
            maskTextSelector: cfg.maskAllInputs ? '[data-sensitive],[data-private],.sensitive' : undefined,
            blockSelector: '[data-testlens-block]',
            sampling: { mousemove: false, mouseInteraction: { MouseUp: false, MouseDown: false, Click: true, ContextMenu: false, DblClick: true, Focus: false, Blur: false, TouchStart: false, TouchEnd: false }, scroll: 250, input: 'last' },
            slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true },
            inlineStylesheet: true,
            recordCanvas: false,
          });
        } catch {
          /* rrweb may fail on exotic pages; capture continues without replay */
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    }

    async function getConfig(): Promise<ContentConfig> {
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'tl:get-config' })) as { ok: boolean; data?: ContentConfig };
        if (res?.ok && res.data) return res.data;
      } catch {
        /* background asleep or unavailable */
      }
      return { captureBodies: true, maxBodyBytes: 262144, domReplay: true, maskAllInputs: true, consoleLevels: ['log', 'info', 'warn', 'error', 'debug'] };
    }
  },
});

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
  if (testId) return `[data-testid="${testId}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const cls = Array.from(cur.classList).filter((c) => !/^(ng-|css-|sc-|_|jsx-)/.test(c) && c.length < 30).slice(0, 2);
    if (cls.length) part += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((s) => s.tagName === cur!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
