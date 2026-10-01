/** Extension settings, persisted in chrome.storage.local under `tl.settings`. */
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
  /** Origins to monitor, e.g. "https://app.example.com". "*" monitors every site. Include API origins too. */
  monitoredOrigins: string[];
  preWindowMs: number;
  postWindowMs: number;
  captureBodies: boolean;
  maxBodyBytes: number;
  domReplay: boolean;
  maskAllInputs: boolean;
  environmentName: string;
  /** origin → human app name */
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

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  const stored = (res[KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored, redaction: { ...DEFAULT_SETTINGS.redaction, ...(stored.redaction ?? {}) } };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) loadSettings().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function monitorsAll(s: Settings) {
  return s.monitoredOrigins.includes('*');
}

export function isMonitoredUrl(url: string | undefined, s: Settings): boolean {
  if (!url || !/^https?:/.test(url)) return false;
  if (monitorsAll(s)) return true;
  try {
    const origin = new URL(url).origin;
    return s.monitoredOrigins.some((o) => o === origin || (o.startsWith('*.') && origin.endsWith(o.slice(1))));
  } catch {
    return false;
  }
}

/** Convert configured origins to match patterns usable for permissions and content scripts. */
export function originsToMatchPatterns(origins: string[]): string[] {
  if (origins.includes('*')) return ['<all_urls>'];
  const out: string[] = [];
  for (const o of origins) {
    try {
      if (o.startsWith('*.')) {
        out.push(`https://${o}/*`, `http://${o}/*`);
      } else {
        const u = new URL(o);
        out.push(`${u.protocol}//${u.host}/*`);
      }
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

export function normalizeOriginInput(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (t === '*') return '*';
  if (t.startsWith('*.')) return t.toLowerCase();
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    return u.origin;
  } catch {
    return undefined;
  }
}
