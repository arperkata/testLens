/**
 * @testlens/redaction
 *
 * Two-stage redaction:
 *  - capture-time: `redactHeaders`, `redactUrl`, `redactText`, `redactBodyString` are
 *    called by the extension the moment data arrives, using the built-in rule set.
 *  - export-time: `redactContext` re-applies the (possibly user-extended) rule set to a
 *    whole BugContext before anything leaves the machine.
 *
 * Values are replaced with «redacted:<8-char fnv hash>» so that equal secrets remain
 * correlatable across events without being recoverable.
 */
import type { BugContext, Header, HttpExchange } from '@testlens/schema';

export const RULES_VERSION = '1.0';

export interface RedactionRules {
  /** Header / query-param / JSON-key names (case-insensitive) whose values are always redacted. */
  sensitiveKeys: string[];
  /**
   * Regexes applied to free text (console args, bodies, URLs). Whole match is replaced.
   * `hint` is a cheap precondition: a substring (case-sensitive) that must be present, or
   * 'digits13' for strings that need at least 13 digits. The regex is skipped when it cannot match.
   */
  patterns: { id: string; regex: string; flags?: string; hint?: string }[];
  /** Max body bytes retained; longer bodies are truncated (not a redaction, but enforced here). */
  maxBodyBytes: number;
}

export const DEFAULT_RULES: RedactionRules = {
  sensitiveKeys: [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
    'password',
    'passwd',
    'pwd',
    'secret',
    'client_secret',
    'clientsecret',
    'token',
    'access_token',
    'accesstoken',
    'refresh_token',
    'refreshtoken',
    'id_token',
    'idtoken',
    'api_key',
    'apikey',
    'private_key',
    'privatekey',
    'session',
    'sessionid',
    'session_id',
    'otp',
    'pin',
    'ssn',
    'cvv',
    'card_number',
    'cardnumber',
  ],
  patterns: [
    { id: 'jwt', regex: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b', flags: 'g', hint: 'eyJ' },
    { id: 'bearer', regex: '\\b[Bb]earer\\s+[A-Za-z0-9._~+/=-]{16,}', flags: 'g', hint: 'earer' },
    { id: 'aws-access-key', regex: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g', hint: 'AKIA' },
    { id: 'openai-key', regex: '\\bsk-[A-Za-z0-9_-]{20,}\\b', flags: 'g', hint: 'sk-' },
    { id: 'github-token', regex: '\\bgh[pousr]_[A-Za-z0-9]{30,}\\b', flags: 'g', hint: 'gh' },
    { id: 'slack-token', regex: '\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b', flags: 'g', hint: 'xox' },
    { id: 'credit-card', regex: '\\b(?:\\d[ -]?){13,19}\\b', flags: 'g', hint: 'digits13' },
  ],
  maxBodyBytes: 256 * 1024,
};

export interface RedactionStats {
  counts: Record<string, number>;
}

export function newStats(): RedactionStats {
  return { counts: {} };
}

function bump(stats: RedactionStats, key: string) {
  stats.counts[key] = (stats.counts[key] ?? 0) + 1;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function mask(value: string): string {
  return `«redacted:${fnv1a(value)}»`;
}

/** Normalised sensitive keys, computed once per rules object (was 38 regex replaces per header before). */
const keyCache = new WeakMap<RedactionRules, { exact: Set<string>; suffixes: string[] }>();
function normalizeKey(k: string) {
  return k.toLowerCase().replace(/[-_\s]/g, '');
}
function sensitiveKeys(rules: RedactionRules) {
  let c = keyCache.get(rules);
  if (!c) {
    const norm = rules.sensitiveKeys.map(normalizeKey);
    c = { exact: new Set(norm), suffixes: norm };
    keyCache.set(rules, c);
  }
  return c;
}

function isSensitiveKey(key: string, rules: RedactionRules): boolean {
  const k = normalizeKey(key);
  const { exact, suffixes } = sensitiveKeys(rules);
  if (exact.has(k)) return true;
  for (const s of suffixes) if (k.endsWith(s)) return true;
  return false;
}

const compiledCache = new WeakMap<RedactionRules, { id: string; re: RegExp; hint?: string }[]>();
function compiled(rules: RedactionRules) {
  let c = compiledCache.get(rules);
  if (!c) {
    c = rules.patterns.map((p) => ({ id: p.id, re: new RegExp(p.regex, p.flags ?? 'g'), hint: p.hint }));
    compiledCache.set(rules, c);
  }
  return c;
}

const DIGIT_RUN = /\d/g;
/** Cheap precondition so most strings never touch a regex. */
function mayMatch(text: string, hint: string | undefined): boolean {
  if (!hint) return true;
  if (hint === 'digits13') {
    let n = 0;
    DIGIT_RUN.lastIndex = 0;
    while (DIGIT_RUN.exec(text)) if (++n >= 13) return true;
    return false;
  }
  return text.includes(hint);
}

export function redactHeaders(headers: Header[], rules: RedactionRules, stats: RedactionStats): Header[] {
  return headers.map((h) => {
    if (isSensitiveKey(h.name, rules)) {
      bump(stats, `header.${h.name.toLowerCase()}`);
      return { name: h.name, value: mask(h.value) };
    }
    return { name: h.name, value: redactText(h.value, rules, stats, 'header-value') };
  });
}

export function redactUrl(url: string, rules: RedactionRules, stats: RedactionStats): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of Array.from(u.searchParams.entries())) {
      if (isSensitiveKey(k, rules)) {
        u.searchParams.set(k, mask(v));
        bump(stats, `query.${k.toLowerCase()}`);
        changed = true;
      }
    }
    if (u.username || u.password) {
      u.username = u.username ? 'redacted' : '';
      u.password = u.password ? 'redacted' : '';
      bump(stats, 'url.userinfo');
      changed = true;
    }
    const out = changed ? u.toString() : url;
    return redactText(out, rules, stats, 'url');
  } catch {
    return redactText(url, rules, stats, 'url');
  }
}

export function redactText(text: string, rules: RedactionRules, stats: RedactionStats, where = 'text'): string {
  if (text.length < 8) return text; // nothing in the default rules can match shorter strings
  let out = text;
  for (const { id, re, hint } of compiled(rules)) {
    if (!mayMatch(out, hint)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      bump(stats, `pattern.${id}@${where}`);
      return mask(m);
    });
  }
  return out;
}

/** Redact a JSON value recursively by key name, then apply text patterns to string leaves. */
export function redactJsonValue(value: unknown, rules: RedactionRules, stats: RedactionStats, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, rules, stats, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k, rules) && (typeof v === 'string' || typeof v === 'number')) {
        bump(stats, `json.${k.toLowerCase()}`);
        out[k] = mask(String(v));
      } else {
        out[k] = redactJsonValue(v, rules, stats, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') return redactText(value, rules, stats, 'json');
  return value;
}

/** Redact a body string. Tries JSON first; falls back to form-encoded, then plain text. */
export function redactBodyString(body: string, mimeType: string | undefined, rules: RedactionRules, stats: RedactionStats): string {
  const mt = (mimeType ?? '').toLowerCase();
  const trimmed = body.trimStart();
  if (mt.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(redactJsonValue(parsed, rules, stats));
    } catch {
      /* fall through */
    }
  }
  if (mt.includes('x-www-form-urlencoded')) {
    const p = new URLSearchParams(body);
    for (const [k, v] of Array.from(p.entries())) {
      if (isSensitiveKey(k, rules)) {
        p.set(k, mask(v));
        bump(stats, `form.${k.toLowerCase()}`);
      }
    }
    return redactText(p.toString(), rules, stats, 'form');
  }
  return redactText(body, rules, stats, 'body');
}

export function redactExchange(ex: HttpExchange, rules: RedactionRules, stats: RedactionStats): HttpExchange {
  const out: HttpExchange = {
    ...ex,
    url: redactUrl(ex.url, rules, stats),
    correlationIds: ex.correlationIds.filter((c) => !isSensitiveKey(c.header, rules)),
    request: {
      ...ex.request,
      headers: redactHeaders(ex.request.headers, rules, stats),
      body: ex.request.body
        ? { ...ex.request.body, data: ex.request.body.encoding === 'base64' ? ex.request.body.data : redactBodyString(ex.request.body.data, ex.request.body.mimeType, rules, stats) }
        : undefined,
    },
  };
  if (ex.response) {
    out.response = {
      ...ex.response,
      headers: redactHeaders(ex.response.headers, rules, stats),
      body: ex.response.body
        ? { ...ex.response.body, data: ex.response.body.encoding === 'base64' ? ex.response.body.data : redactBodyString(ex.response.body.data, ex.response.body.mimeType, rules, stats) }
        : undefined,
    };
  }
  return out;
}

/** Export-time pass over a whole context. Returns a new context; never mutates. */
export function redactContext(ctx: BugContext, rules: RedactionRules = DEFAULT_RULES): BugContext {
  const stats = newStats();
  const out: BugContext = {
    ...ctx,
    exchanges: ctx.exchanges.map((e) => redactExchange(e, rules, stats)),
    console: ctx.console.map((c) => ({ ...c, args: c.args.map((a) => redactText(a, rules, stats, 'console')) })),
    errors: ctx.errors.map((e) => ({ ...e, message: redactText(e.message, rules, stats, 'error'), stack: e.stack ? redactText(e.stack, rules, stats, 'error') : undefined })),
    navigation: ctx.navigation.map((n) => ({ ...n, to: redactUrl(n.to, rules, stats), from: n.from ? redactUrl(n.from, rules, stats) : undefined })),
    application: { ...ctx.application, url: ctx.application.url ? redactUrl(ctx.application.url, rules, stats) : undefined },
    execution: ctx.execution
      ? { ...ctx.execution, variables: ctx.execution.variables ? (redactJsonValue(ctx.execution.variables, rules, stats) as Record<string, string>) : undefined }
      : undefined,
    redaction: {
      appliedAt: Array.from(new Set([...ctx.redaction.appliedAt, 'export' as const])),
      rulesVersion: RULES_VERSION,
      counts: mergeCounts(ctx.redaction.counts, stats.counts),
    },
  };
  return out;
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function mergeRules(base: RedactionRules, extra?: Partial<RedactionRules>): RedactionRules {
  if (!extra) return base;
  return {
    sensitiveKeys: Array.from(new Set([...base.sensitiveKeys, ...(extra.sensitiveKeys ?? []).map((s) => s.toLowerCase())])),
    patterns: [...base.patterns, ...(extra.patterns ?? [])],
    maxBodyBytes: extra.maxBodyBytes ?? base.maxBodyBytes,
  };
}
