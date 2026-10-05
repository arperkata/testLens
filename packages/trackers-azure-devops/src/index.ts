/**
 * @testlens/trackers-azure-devops — Azure DevOps Boards (work items) adapter.
 * REST 7.1, Personal Access Token, HTML descriptions, native attachments.
 */
import type { Artifact, BugDraft } from '@testlens/schema';
import { TrackerError, renderHtml, resolveMappedValue, safeText, searchNeedle, validateRequired } from '@testlens/trackers-core';
import type {
  AttachmentResult,
  AuthSession,
  CreateResult,
  FieldSchema,
  ITrackerAdapter,
  IssueTypeRef,
  ProjectRef,
  SimilarIssue,
  TrackerAuthConfig,
  TrackerDescriptor,
  TrackerLimits,
  TrackerMapping,
  ValidationResult,
} from '@testlens/trackers-core';

const API = 'api-version=7.1';

export const AZURE_DEVOPS_DESCRIPTOR: TrackerDescriptor = {
  id: 'azure-devops',
  displayName: 'Azure DevOps Boards',
  blurb: 'Work items in Azure DevOps Services or Server. Uses a Personal Access Token with "Work Items (Read & Write)" scope.',
  authFields: [
    { key: 'baseUrl', label: 'Organization URL', placeholder: 'https://dev.azure.com/yourorg', type: 'url', help: 'Azure DevOps Server: https://server/tfs/DefaultCollection' },
    { key: 'secret', label: 'Personal access token', type: 'password', help: 'User settings → Personal access tokens → New Token (Work Items: Read & write)' },
  ],
  tokenHelpUrl: 'https://dev.azure.com/_usersSettings/tokens',
  containerLabel: 'Project',
  typeLabel: 'Work item type',
  attachments: 'native',
  authMethod: 'pat',
};

/** Fields TestLens fills itself; never shown as mapping requirements. */
const SYSTEM_FILLED = new Set(['System.Title', 'System.Description', 'Microsoft.VSTS.TCM.ReproSteps', 'System.WorkItemType', 'System.TeamProject', 'System.AreaPath', 'System.IterationPath', 'System.State', 'System.Reason', 'System.CreatedBy', 'System.ChangedBy', 'System.Tags']);

export class AzureDevOpsAdapter implements ITrackerAdapter<string> {
  readonly id = 'azure-devops';
  readonly displayName = 'Azure DevOps Boards';
  readonly descriptor = AZURE_DEVOPS_DESCRIPTOR;

  async authenticate(cfg: TrackerAuthConfig): Promise<AuthSession> {
    const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Basic ${btoa(`:${cfg.secret}`)}` };
    // Any authenticated call works as a probe; projects is cheap and needed anyway.
    const res = await this.json<{ count: number }>({ baseUrl, headers }, 'GET', `/_apis/projects?${API}&$top=1`);
    if (typeof res.count !== 'number') throw new TrackerError('Unexpected response from Azure DevOps; check the organization URL');
    let displayName: string | undefined;
    try {
      const me = await this.json<{ displayName?: string; emailAddress?: string }>({ baseUrl: 'https://app.vssps.visualstudio.com', headers }, 'GET', `/_apis/profile/profiles/me?${API}`);
      displayName = me.displayName ?? me.emailAddress;
    } catch {
      /* Server installs have no profile endpoint */
    }
    return { baseUrl, headers, displayName: displayName ?? 'Azure DevOps user' };
  }

  async listProjects(s: AuthSession): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    let token: string | undefined;
    for (;;) {
      const res = await fetch(`${s.baseUrl}/_apis/projects?${API}&$top=100${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`, { headers: s.headers });
      if (!res.ok) throw new TrackerError(await describeError(res, 'Azure DevOps'), res.status);
      const body = (await res.json()) as { value: { id: string; name: string }[] };
      out.push(...body.value.map((p) => ({ id: p.id, key: p.name, name: p.name })));
      token = res.headers.get('x-ms-continuationtoken') ?? undefined;
      if (!token || out.length >= 500) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listIssueTypes(s: AuthSession, projectKey: string): Promise<IssueTypeRef[]> {
    const res = await this.json<{ value: { name: string; referenceName: string; isDisabled: boolean }[] }>(s, 'GET', `/${enc(projectKey)}/_apis/wit/workitemtypes?${API}`);
    // Put Bug first; TestLens picks "Bug" automatically when present.
    return res.value
      .filter((t) => !t.isDisabled)
      .map((t) => ({ id: t.name, name: t.name, subtask: false }))
      .sort((a, b) => (a.name === 'Bug' ? -1 : b.name === 'Bug' ? 1 : a.name.localeCompare(b.name)));
  }

  async getCreateFields(s: AuthSession, projectKey: string, issueTypeId: string): Promise<FieldSchema[]> {
    const res = await this.json<{ value: { referenceName: string; name: string; alwaysRequired: boolean; allowedValues?: string[]; defaultValue?: unknown; helpText?: string }[] }>(s, 'GET', `/${enc(projectKey)}/_apis/wit/workitemtypes/${enc(issueTypeId)}/fields?$expand=all&${API}`);
    const fields: FieldSchema[] = [];
    for (const f of res.value) {
      if (SYSTEM_FILLED.has(f.referenceName)) continue;
      if (/^(System\.|Microsoft\.VSTS\.Common\.(StateChangeDate|ActivatedDate|ActivatedBy|ResolvedDate|ResolvedBy|ClosedDate|ClosedBy|StackRank|BacklogPriority))/.test(f.referenceName) && !f.alwaysRequired) continue;
      fields.push({
        key: f.referenceName,
        name: f.name,
        required: f.alwaysRequired,
        type: f.allowedValues?.length ? 'option' : 'string',
        hasDefault: f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '',
        allowedValues: f.allowedValues?.map((v) => ({ id: v, name: v })),
      });
    }
    // Area / iteration are common optional targets; expose them as free text.
    fields.push({ key: 'System.AreaPath', name: 'Area path', required: false, type: 'string' });
    fields.push({ key: 'System.IterationPath', name: 'Iteration path', required: false, type: 'string' });
    fields.push({ key: 'System.Tags', name: 'Tags', required: false, type: 'array', itemsType: 'string' });
    return fields;
  }

  renderDescription(draft: BugDraft): string {
    return renderHtml(draft);
  }

  validate(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): ValidationResult {
    const payload = this.buildPayload(draft, mapping, fields) as { fields: Record<string, unknown> };
    const v = validateRequired(draft, payload.fields, fields, [], 255);
    return v;
  }

  /** Payload shape: { fields: {refName: value} } → converted to JSON Patch on create. */
  buildPayload(draft: BugDraft, mapping: TrackerMapping, fields: FieldSchema[]): unknown {
    const html = this.renderDescription(draft);
    const out: Record<string, unknown> = { 'System.Title': draft.summary.slice(0, 255) };
    // Bugs show "Repro Steps" prominently; other types use Description.
    if (/^bug$/i.test(mapping.issueTypeId)) {
      out['Microsoft.VSTS.TCM.ReproSteps'] = html;
      out['System.Description'] = `<p>${escapeHtml(draft.actualResult)}</p>`;
    } else out['System.Description'] = html;
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const tags = new Set<string>(draft.labels);
    for (const [key, raw] of Object.entries(mapping.fields)) {
      if (key === 'labels' || key === 'System.Tags') {
        const v = resolveMappedValue(raw, draft, { key, name: 'Tags', required: false, type: 'array', itemsType: 'string' }, () => html);
        for (const t of (Array.isArray(v) ? v : [v]) as unknown[]) if (t) tags.add(String(typeof t === 'object' ? (t as { name?: string }).name ?? '' : t));
        continue;
      }
      const v = resolveMappedValue(raw, draft, byKey.get(key), () => html);
      if (v === undefined) continue;
      out[key] = Array.isArray(v) ? v.map(plain).join('; ') : plain(v);
    }
    if (tags.size) out['System.Tags'] = Array.from(tags).join('; ');
    return { fields: out };
  }

  async createIssue(s: AuthSession, payload: unknown, mapping: TrackerMapping): Promise<CreateResult> {
    const { fields } = payload as { fields: Record<string, unknown> };
    const ops = Object.entries(fields).map(([k, v]) => ({ op: 'add', path: `/fields/${k}`, value: v }));
    const res = await fetch(`${s.baseUrl}/${enc(mapping.projectKey)}/_apis/wit/workitems/$${enc(mapping.issueTypeId)}?${API}`, {
      method: 'POST',
      headers: { ...s.headers, 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(ops),
    });
    if (!res.ok) throw new TrackerError(await describeError(res, 'Azure DevOps'), res.status);
    const wi = (await res.json()) as { id: number; _links?: { html?: { href: string } } };
    return { id: String(wi.id), key: `#${wi.id}`, url: wi._links?.html?.href ?? `${s.baseUrl}/${enc(mapping.projectKey)}/_workitems/edit/${wi.id}` };
  }

  async attach(s: AuthSession, created: CreateResult, files: { artifact: Artifact; blob: Blob }[], mapping: TrackerMapping): Promise<AttachmentResult[]> {
    const results: AttachmentResult[] = [];
    const relations: unknown[] = [];
    for (const f of files) {
      try {
        const up = await fetch(`${s.baseUrl}/${enc(mapping.projectKey)}/_apis/wit/attachments?fileName=${encodeURIComponent(f.artifact.fileName)}&${API}`, {
          method: 'POST',
          headers: { ...s.headers, 'Content-Type': 'application/octet-stream' },
          body: f.blob,
        });
        if (!up.ok) {
          results.push({ artifactId: f.artifact.id, ok: false, error: `${up.status} ${await safeText(up)}` });
          continue;
        }
        const body = (await up.json()) as { id: string; url: string };
        relations.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: body.url, attributes: { comment: `TestLens ${f.artifact.kind}` } } });
        results.push({ artifactId: f.artifact.id, ok: true, id: body.id });
      } catch (e) {
        results.push({ artifactId: f.artifact.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (relations.length) {
      const res = await fetch(`${s.baseUrl}/_apis/wit/workitems/${created.id}?${API}`, { method: 'PATCH', headers: { ...s.headers, 'Content-Type': 'application/json-patch+json' }, body: JSON.stringify(relations) });
      if (!res.ok) {
        const err = `linking attachments failed: ${res.status} ${await safeText(res)}`;
        for (const r of results) if (r.ok) r.error = err;
      }
    }
    return results;
  }

  async findSimilar(s: AuthSession, projectKey: string, signature: string): Promise<SimilarIssue[]> {
    const needle = searchNeedle(signature);
    if (!needle) return [];
    try {
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') AND [System.Title] CONTAINS '${needle.replace(/'/g, "''")}' ORDER BY [System.CreatedDate] DESC`;
      const q = await this.json<{ workItems: { id: number }[] }>(s, 'POST', `/${enc(projectKey)}/_apis/wit/wiql?${API}&$top=5`, { query: wiql });
      if (!q.workItems.length) return [];
      const ids = q.workItems.slice(0, 5).map((w) => w.id).join(',');
      const items = await this.json<{ value: { id: number; fields: Record<string, string>; _links?: { html?: { href: string } } }[] }>(s, 'GET', `/_apis/wit/workitems?ids=${ids}&fields=System.Title,System.State&${API}`);
      return items.value.map((w) => ({ key: `#${w.id}`, summary: w.fields['System.Title'] ?? '', status: w.fields['System.State'] ?? '', url: w._links?.html?.href ?? `${s.baseUrl}/${enc(projectKey)}/_workitems/edit/${w.id}` }));
    } catch {
      return [];
    }
  }

  async limits(): Promise<TrackerLimits> {
    return { maxAttachmentBytes: 60 * 1024 * 1024, maxDescriptionChars: 1_000_000 };
  }

  private async json<T>(s: { baseUrl: string; headers: Record<string, string> }, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${s.baseUrl}${path}`, { method, headers: { ...s.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new TrackerError(await describeError(res, 'Azure DevOps'), res.status);
    return (await res.json()) as T;
  }
}

function enc(s: string) {
  return encodeURIComponent(s);
}
function plain(v: unknown): unknown {
  return v && typeof v === 'object' && 'name' in v ? (v as { name: string }).name : v;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
export async function describeError(res: Response, tool: string): Promise<string> {
  const txt = await safeText(res);
  let msg = txt.slice(0, 300);
  try {
    const j = JSON.parse(txt) as { message?: string; error?: string; errors?: unknown };
    msg = j.message ?? j.error ?? (j.errors ? JSON.stringify(j.errors).slice(0, 300) : msg);
  } catch {
    /* text */
  }
  if (res.status === 401) return `${tool} 401: authentication failed — check the URL and token`;
  if (res.status === 403) return `${tool} 403: the token lacks permission for this action`;
  if (res.status === 404) return `${tool} 404: not found — check the URL and project${msg ? ` (${msg})` : ''}`;
  return `${tool} ${res.status}: ${msg || 'request failed'}`;
}
