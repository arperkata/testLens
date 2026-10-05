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

/** Connection + default destination for the configured bug tracker. */
export interface TrackerSettings {
  /** Adapter id: 'jira-cloud' | 'jira-dc' | 'azure-devops' | 'github' | 'gitlab' | 'linear' */
  trackerId: string;
  baseUrl: string;
  email: string;
  token: string;
  /** Container key: Jira project key, ADO project name, GitHub owner/repo, GitLab path, Linear team id. */
  projectKey: string;
  projectName?: string;
  issueTypeId: string;
  issueTypeName?: string;
  mapping: TrackerMapping;
}

export interface AiSettings {
  enabled: boolean;
  provider: 'openai';
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Run analysis automatically when an incident is finalized. */
  autoRun: boolean;
  /** Include short (redacted) request/response body snippets of the focal request in what is sent. */
  includeBodies: boolean;
}

export const DEFAULT_AI: AiSettings = { enabled: false, provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', autoRun: true, includeBodies: true };

/** @deprecated pre-multi-tracker shape; migrated to `tracker` on load. */
export type JiraSettings = Omit<TrackerSettings, 'trackerId' | 'projectName'>;

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
  /** Start tab video automatically when the popup is opened on a monitored tab (Chrome needs that invocation). */
  autoRecordOnOpen: boolean;
  /** Which artifact kinds are pre-ticked for attachment; the tester can still change each one before Create. */
  attachDefaults: Record<string, boolean>;
  tracker?: TrackerSettings;
  /** Optional AI analysis. Off by default; the key is stored locally and never syncs. */
  ai: AiSettings;
  /** @deprecated legacy field kept only so old stored settings can be migrated. */
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
  autoRecordOnOpen: true,
  attachDefaults: { screenshot: true, video: true, rrweb: true, 'console-log': true, 'network-log': true, 'har-focused': true, har: false, 'incident-viewer': true },
  ai: DEFAULT_AI,
  onboarded: false,
};

export const ARTIFACT_KIND_LABELS: Record<string, string> = {
  screenshot: 'Screenshot',
  video: 'Tab video segments',
  rrweb: 'DOM replay',
  'console-log': 'Console log',
  'network-log': 'Network log (full request/response detail)',
  'har-focused': 'HAR of selected requests',
  har: 'HAR of all requests',
  'incident-viewer': 'HTML incident viewer',
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
  const secrets = ((await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] ?? {}) as { jiraToken?: string; trackerToken?: string; aiKey?: string };
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    redaction: { ...DEFAULT_SETTINGS.redaction, ...(stored?.redaction ?? {}) },
    attachDefaults: { ...DEFAULT_SETTINGS.attachDefaults, ...(stored?.attachDefaults ?? {}) },
    ai: { ...DEFAULT_AI, ...(stored?.ai ?? {}) },
  };
  // Migrate the pre-multi-tracker `jira` block into `tracker`.
  if (!s.tracker && s.jira) s.tracker = { trackerId: 'jira-cloud', ...s.jira };
  delete s.jira;
  if (s.tracker) s.tracker = { ...s.tracker, token: secrets.trackerToken ?? secrets.jiraToken ?? s.tracker.token ?? '' };
  s.ai.apiKey = secrets.aiKey ?? s.ai.apiKey ?? '';
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  const token = s.tracker?.token ?? '';
  const shareable: Settings = { ...s, jira: undefined, tracker: s.tracker ? { ...s.tracker, token: '' } : undefined, ai: { ...s.ai, apiKey: '' } };
  await chrome.storage.local.set({ [SECRETS_KEY]: { trackerToken: token, aiKey: s.ai.apiKey ?? '' } });
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
  const { tracker, jira: _legacy, ai, ...rest } = s;
  return JSON.stringify({ testlensSettings: 1, ...rest, tracker: tracker ? { ...tracker, token: undefined } : undefined, ai: { ...ai, apiKey: undefined } }, null, 2);
}

/** Merge an exported document into current settings. Keeps the local token when the tracker is unchanged. */
export function importSettings(current: Settings, json: string): Settings {
  const doc = JSON.parse(json) as Partial<Settings> & { testlensSettings?: number };
  if (doc.testlensSettings !== 1) throw new Error('Not a TestLens settings file');
  const { testlensSettings: _v, jira: legacy, ...incoming } = doc;
  const incomingTracker = incoming.tracker ?? (legacy ? { trackerId: 'jira-cloud', ...legacy } : undefined);
  const keepToken = incomingTracker && current.tracker && incomingTracker.trackerId === current.tracker.trackerId && incomingTracker.baseUrl === current.tracker.baseUrl;
  return {
    ...current,
    ...incoming,
    jira: undefined,
    redaction: { ...current.redaction, ...(incoming.redaction ?? {}) },
    tracker: incomingTracker ? { ...incomingTracker, token: keepToken ? current.tracker!.token : '' } : current.tracker,
    ai: { ...DEFAULT_AI, ...current.ai, ...(incoming.ai ?? {}), apiKey: current.ai.apiKey },
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
