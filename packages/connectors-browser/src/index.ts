/**
 * @testlens/connectors-browser — normalizes the extension's raw frozen incident
 * into a BugContext. Pure function; no browser APIs.
 */
import { buildTimeline, SCHEMA_VERSION } from '@testlens/schema';
import type { Artifact, BugContext, ConsoleEntry, ErrorEntry, HttpExchange, InteractionEntry, NavigationEntry } from '@testlens/schema';

export const CONNECTOR_ID = 'browser';
export const CONNECTOR_VERSION = '1.0.0';

/** What the extension freezes at "Report Issue" time. */
export interface RawBrowserIncident {
  incidentId: string;
  triggerAt: number;
  preWindowMs: number;
  postWindowMs: number;
  userNote?: string;
  tab: { id: number; url: string; title: string };
  page: { viewport: { width: number; height: number; dpr: number }; locale: string; timezone: string; online: boolean; appVersion?: string } | undefined;
  userAgent: string;
  extensionVersion: string;
  environmentName?: string;
  appName?: string;
  exchanges: HttpExchange[];
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  interactions: InteractionEntry[];
  navigation: NavigationEntry[];
  artifacts: Artifact[];
  redactionCounts: Record<string, number>;
  redactionRulesVersion: string;
}

export function normalizeBrowserIncident(raw: RawBrowserIncident): BugContext {
  const ua = parseUserAgent(raw.userAgent);
  const base: Omit<BugContext, 'timeline'> = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: raw.incidentId,
    createdAt: Date.now(),
    source: {
      connectorId: CONNECTOR_ID,
      connectorVersion: CONNECTOR_VERSION,
      tool: { name: ua.browser, version: ua.browserVersion },
      captureMode: 'rolling',
    },
    trigger: {
      at: raw.triggerAt,
      preWindowMs: raw.preWindowMs,
      postWindowMs: raw.postWindowMs,
      initiatedBy: 'user',
      userNote: raw.userNote,
    },
    environment: {
      name: raw.environmentName,
      os: { name: ua.os, version: ua.osVersion },
      locale: raw.page?.locale,
      timezone: raw.page?.timezone,
      online: raw.page?.online,
    },
    application: {
      name: raw.appName ?? safeHost(raw.tab.url),
      baseUrl: safeOrigin(raw.tab.url),
      url: raw.tab.url,
      title: raw.tab.title,
      version: raw.page?.appVersion,
    },
    browser: {
      name: ua.browser,
      version: ua.browserVersion,
      userAgent: raw.userAgent,
      viewport: raw.page?.viewport ?? { width: 0, height: 0 },
      tabId: raw.tab.id,
      extensionVersion: raw.extensionVersion,
    },
    exchanges: [...raw.exchanges].sort((a, b) => a.ts - b.ts),
    console: [...raw.console].sort((a, b) => a.ts - b.ts),
    errors: [...raw.errors].sort((a, b) => a.ts - b.ts),
    interactions: [...raw.interactions].sort((a, b) => a.ts - b.ts),
    navigation: [...raw.navigation].sort((a, b) => a.ts - b.ts),
    assertions: [],
    artifacts: raw.artifacts,
    redaction: { appliedAt: ['capture'], rulesVersion: raw.redactionRulesVersion, counts: raw.redactionCounts },
  };
  return { ...base, timeline: buildTimeline(base) };
}

export function parseUserAgent(ua: string): { browser: string; browserVersion: string; os: string; osVersion?: string } {
  let browser = 'Unknown';
  let browserVersion = '';
  const edge = ua.match(/Edg\/([\d.]+)/);
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  const firefox = ua.match(/Firefox\/([\d.]+)/);
  const safari = ua.match(/Version\/([\d.]+).*Safari/);
  if (edge) [browser, browserVersion] = ['Microsoft Edge', edge[1]!];
  else if (chrome) [browser, browserVersion] = ['Chrome', chrome[1]!];
  else if (firefox) [browser, browserVersion] = ['Firefox', firefox[1]!];
  else if (safari) [browser, browserVersion] = ['Safari', safari[1]!];

  let os = 'Unknown';
  let osVersion: string | undefined;
  const win = ua.match(/Windows NT ([\d.]+)/);
  const mac = ua.match(/Mac OS X ([\d_]+)/);
  const android = ua.match(/Android ([\d.]+)/);
  const ios = ua.match(/(?:iPhone|iPad).*OS ([\d_]+)/);
  if (win) {
    os = 'Windows';
    osVersion = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[win[1]!] ?? win[1]!;
  } else if (android) [os, osVersion] = ['Android', android[1]!];
  else if (ios) [os, osVersion] = ['iOS', ios[1]!.replace(/_/g, '.')];
  else if (mac) [os, osVersion] = ['macOS', mac[1]!.replace(/_/g, '.')];
  else if (/Linux/.test(ua)) os = 'Linux';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  return { browser, browserVersion, os, osVersion };
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
