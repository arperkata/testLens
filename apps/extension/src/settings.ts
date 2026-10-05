/**
 * Extension settings.
 *
 * Storage layout (configure once per browser profile):
 *  - chrome.storage.sync  `tl.settings`  → everything except the Jira token. Synced across the
 *    user's signed-in Chrome profiles, shared between normal and Incognito windows.
 *  - chrome.storage.local `tl.secrets`   → { jiraToken }. Never leaves this machine.
 *  - chrome.storage.local `tl.settings`  → legacy location (pre-sync builds); read as fallback.
 */
import type { TrackerMapping } from '@testlens/trackers-core';

export interface JiraSettings {
  baseUrl: string;
  email: string;
  token: string;
  projectKey: string;
  issueTypeId: string;
  issueTypeName?: string;
  mapping: TrackerMapping;
}

export interface Settings {
  /**
   * Sites to monitor. Entries are domains ("*.example.com" = example.com and every subdomain,
   * http and https, any port), exact origins ("http://localhost:4317") or "*" for every site.
   */
  monitoredOrigins: string[];
  preWindowMs: number;
  postWindowMs: number;
  captureBodies: boolean;
  maxBodyBytes: number;
  domReplay: boolean;
  maskAllInputs: boolean;
  environmentName: string;
  /** monitored entry → human app name */
  appNames: Record<string, string>;
  redaction: { extraKeys: string[]; extraPatterns: { id: string; regex: string }[] };
  traceLinkTemplates: Record<string, string>;
  telemetryHostsExtra: string[];
  retentionDays: number;
  jira?: JiraSettings;
  /** Set once the user has completed the first-run wizard. */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  monitoredOrigins: [],
  preWindowMs: 5 * 60 * 1000,
  postWindowMs: 15 * 1000,
  captureBodies: true,
  maxBodyBytes: 256 * 1024,
  domReplay: true,
  maskAllInputs: true,
  environmentName: '',
  appNames: {},
  redaction: { extraKeys: [], extraPatterns: [] },
  traceLinkTemplates: {},
  telemetryHostsExtra: [],
  retentionDays: 7,
  onboarded: false,
};

const KEY = 'tl.settings';
const SECRETS_KEY = 'tl.secrets';

function syncArea(): chrome.storage.StorageArea | undefined {
  try {
    return chrome.storage.sync;
  } catch {
    return undefined;
  }
}

export async function loadSettings(): Promise<Settings> {
  let stored: Partial<Settings> | undefined;
  const sync = syncArea();
  if (sync) {
    try {
      stored = (await sync.get(KEY))[KEY] as Partial<Settings> | undefined;
    } catch {
      /* sync unavailable (policy, offline profile) */
    }
  }
  if (!stored) stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  const secrets = ((await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] ?? {}) as { jiraToken?: string };
  const s: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}), redaction: { ...DEFAULT_SETTINGS.redaction, ...(stored?.redaction ?? {}) } };
  if (s.jira) s.jira = { ...s.jira, token: secrets.jiraToken ?? s.jira.token ?? '' };
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  const token = s.jira?.token ?? '';
  const shareable: Settings = { ...s, jira: s.jira ? { ...s.jira, token: '' } : undefined };
  await chrome.storage.local.set({ [SECRETS_KEY]: { jiraToken: token } });
  const sync = syncArea();
  let synced = false;
  if (sync) {
    try {
      await sync.set({ [KEY]: shareable });
      synced = true;
    } catch {
      /* quota or sync disabled: fall back to local */
    }
  }
  // Always keep a local copy so the extension works when sync is unavailable.
  await chrome.storage.local.set({ [KEY]: synced ? shareable : { ...shareable } });
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if ((area === 'sync' || area === 'local') && (changes[KEY] || changes[SECRETS_KEY])) loadSettings().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Settings as a shareable JSON document (no token). */
export function exportSettings(s: Settings): string {
  const { jira, ...rest } = s;
  return JSON.stringify({ testlensSettings: 1, ...rest, jira: jira ? { ...jira, token: undefined } : undefined }, null, 2);
}

/** Merge an exported document into current settings. Keeps the local token. */
export function importSettings(current: Settings, json: string): Settings {
  const doc = JSON.parse(json) as Partial<Settings> & { testlensSettings?: number };
  if (doc.testlensSettings !== 1) throw new Error('Not a TestLens settings file');
  const { testlensSettings: _v, ...incoming } = doc;
  return {
    ...current,
    ...incoming,
    redaction: { ...current.redaction, ...(incoming.redaction ?? {}) },
    jira: incoming.jira ? { ...incoming.jira, token: current.jira?.token ?? '' } : current.jira,
    onboarded: true,
  };
}

// ---------------------------------------------------------------------------
// Monitoring scope
// ---------------------------------------------------------------------------

export function monitorsAll(s: Settings) {
  return s.monitoredOrigins.includes('*');
}

/** Hostname with the leading "*." stripped, or undefined for non-domain entries. */
function domainOf(entry: string): string | undefined {
  return entry.startsWith('*.') ? entry.slice(2).toLowerCase() : undefined;
}

export function isMonitoredUrl(url: string | undefined, s: Settings): boolean {
  if (!url || !/^https?:/.test(url)) return false;
  if (monitorsAll(s)) return true;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return s.monitoredOrigins.some((o) => {
      const d = domainOf(o);
      if (d) return host === d || host.endsWith(`.${d}`);
      return o === u.origin;
    });
  } catch {
    return false;
  }
}

/** Convert monitored entries to Chrome match patterns (no port component; a pattern matches every port). */
export function originsToMatchPatterns(origins: string[]): string[] {
  if (origins.includes('*')) return ['<all_urls>'];
  const out = new Set<string>();
  for (const o of origins) {
    try {
      const d = domainOf(o);
      if (d) {
        out.add(`https://*.${d}/*`);
        out.add(`http://*.${d}/*`);
      } else {
        const u = new URL(o);
        out.add(`${u.protocol}//${u.hostname}/*`);
      }
    } catch {
      /* skip invalid */
    }
  }
  return Array.from(out);
}

const TWO_LEVEL_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'co.za', 'com.tr', 'com.cn', 'com.tw']);

/** Registrable domain, e.g. app.qa.example.co.uk → example.co.uk. Returns undefined for localhost / IPs / single labels. */
export function registrableDomain(hostname: string): string | undefined {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || !h.includes('.')) return undefined;
  const parts = h.split('.');
  const lastTwo = parts.slice(-2).join('.');
  const n = TWO_LEVEL_TLDS.has(lastTwo) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/**
 * Normalise user input into a monitored entry.
 * Public hosts become domain-wide entries ("*.example.com"); localhost, IPs and single-label
 * intranet hosts stay exact origins because a domain cannot be derived for them.
 */
export function normalizeOriginInput(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (t === '*') return '*';
  if (t.startsWith('*.')) return t.toLowerCase();
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    const d = registrableDomain(u.hostname);
    return d ? `*.${d}` : u.origin;
  } catch {
    return undefined;
  }
}

/** Human description of an entry for the UI. */
export function describeEntry(entry: string): string {
  if (entry === '*') return 'every site';
  const d = domainOf(entry);
  if (d) return `${d} and all subdomains (http/https, any port)`;
  return `${entry} only`;
}
