/**
 * @testlens/trackers-core — tracker-neutral adapter contract and mapping config.
 */
import type { Artifact, BugDraft } from '@testlens/schema';

export interface TrackerAuthConfig {
  baseUrl: string;
  /** Jira Cloud: 'basic' (email + API token). Jira DC: 'pat' (bearer). Others may add more. */
  method: 'basic' | 'pat' | 'oauth';
  email?: string;
  secret: string;
}

export interface AuthSession {
  baseUrl: string;
  accountId?: string;
  displayName?: string;
  headers: Record<string, string>;
}

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
}
export interface IssueTypeRef {
  id: string;
  name: string;
  subtask: boolean;
}
export interface FieldOption {
  id: string;
  name: string;
}
export interface FieldSchema {
  key: string; // 'summary', 'customfield_10042'
  name: string;
  required: boolean;
  type: string; // 'string' | 'array' | 'option' | 'priority' | 'user' | 'number' | 'date' | 'doc' ...
  itemsType?: string;
  allowedValues?: FieldOption[];
  hasDefault?: boolean;
}

/**
 * Mapping config: how a BugDraft becomes tracker fields. Values support
 * `{{...}}` templates resolved against { draft, ctx }.
 *
 * Special values:
 *   "$description"  → rendered description document
 *   "$summary"      → draft.summary
 *   "$labels"       → draft.labels (+ extra static labels)
 */
export interface TrackerMapping {
  trackerId: string;
  projectKey: string;
  issueTypeId: string;
  fields: Record<string, unknown>;
  /** Which artifact kinds are attached by default (tester can still toggle). */
  attachKinds: string[];
  /** Max description characters before TL moves sections to attachments. */
  maxDescriptionChars?: number;
}

export interface ValidationResult {
  ok: boolean;
  problems: { field: string; message: string }[];
}

export interface CreateResult {
  key: string;
  id: string;
  url: string;
}

export interface AttachmentResult {
  artifactId: string;
  ok: boolean;
  id?: string;
  error?: string;
}

export interface TrackerLimits {
  maxAttachmentBytes: number;
  maxDescriptionChars: number;
}

export interface ITrackerAdapter<TDoc = unknown> {
  readonly id: string;
  readonly displayName: string;
  authenticate(cfg: TrackerAuthConfig): Promise<AuthSession>;
  listProjects(s: AuthSession, query?: string): Promise<ProjectRef[]>;
  listIssueTypes(s: AuthSession, projectKey: string): Promise<IssueTypeRef[]>;
  getCreateFields(s: AuthSession, projectKey: string, issueTypeId: string): Promise<FieldSchema[]>;
  renderDescription(draft: BugDraft): TDoc;
  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult;
  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown;
  createIssue(s: AuthSession, payload: unknown): Promise<CreateResult>;
  attach(s: AuthSession, issueKey: string, files: { artifact: Artifact; blob: Blob }[]): Promise<AttachmentResult[]>;
  findSimilar?(s: AuthSession, projectKey: string, signature: string): Promise<{ key: string; summary: string; url: string; status: string }[]>;
  limits(s?: AuthSession): Promise<TrackerLimits>;
}

/** Minimal mustache-style template: {{draft.summary}}, {{ctx.browser.name}} */
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), scope);
    return v === undefined || v === null ? '' : String(v);
  });
}

export class TrackerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}
