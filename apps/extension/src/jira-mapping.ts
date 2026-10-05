/** Shared helpers for turning Jira create-screen fields into a mapping, used by Options and the side panel. */
import type { FieldSchema } from '@testlens/trackers-core';

export const STANDARD_FIELDS = ['project', 'issuetype', 'summary', 'description', 'reporter', 'labels'];

export function requiredFields(fields: FieldSchema[]) {
  return fields.filter((f) => f.required && !f.hasDefault && !STANDARD_FIELDS.includes(f.key));
}

export function optionalFieldsWithValues(fields: FieldSchema[]) {
  return fields.filter((f) => !f.required && f.allowedValues?.length && !['issuetype', 'project', 'parent'].includes(f.key));
}

/** Pick a sensible default: newest version, otherwise the first allowed value; free-text fields stay empty. */
export function defaultFor(field: FieldSchema): string | undefined {
  const vals = field.allowedValues;
  if (!vals?.length) return undefined;
  if (field.itemsType === 'version' || field.type === 'version') {
    const sorted = [...vals].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return sorted[sorted.length - 1]!.name;
  }
  return vals[0]!.name;
}

/** Mapping values → editable string form (comma-joined for arrays). Labels are managed separately. */
export function stringValues(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'labels') continue;
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').join(', ');
    else if (v && typeof v === 'object' && 'name' in v) out[k] = String((v as { name: unknown }).name);
  }
  return out;
}

/** Editable string form → mapping fields. Unknown keys are dropped when a field list is available. */
export function buildMappingFields(values: Record<string, string>, fields: FieldSchema[]): Record<string, unknown> {
  const out: Record<string, unknown> = { labels: ['$labels'] };
  const known = new Set(fields.map((f) => f.key));
  for (const [k, v] of Object.entries(values)) {
    if (!v.trim()) continue;
    if (fields.length && !known.has(k)) continue;
    out[k] = v.trim();
  }
  return out;
}

/** Fill defaults for required fields that have no value yet. Returns a new object. */
export function withDefaults(values: Record<string, string>, fields: FieldSchema[]): Record<string, string> {
  const next = { ...values };
  for (const f of requiredFields(fields)) {
    if (next[f.key]) continue;
    const d = defaultFor(f);
    if (d !== undefined) next[f.key] = d;
  }
  return next;
}
