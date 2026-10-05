import React from 'react';
import type { FieldSchema } from '@testlens/trackers-core';

/** Dropdown / multi-select / text box for one Jira field, driven by its create-screen schema. */
export function FieldControl({ field, value, onChange, allowEmpty, compact }: { field: FieldSchema; value: string; onChange: (v: string) => void; allowEmpty?: boolean; compact?: boolean }) {
  const multi = field.type === 'array';
  const width = compact ? { flex: 1, minWidth: 160 } : { minWidth: 220 };
  if (field.allowedValues?.length) {
    const selected = value ? value.split(',').map((x) => x.trim()).filter(Boolean) : [];
    if (multi) {
      return (
        <div style={width}>
          <label>
            {field.name}
            {field.required ? ' *' : ''} <span className="badge">multi</span>
          </label>
          <select multiple size={Math.min(compact ? 3 : 5, field.allowedValues.length)} value={selected} onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value).join(', '))}>
            {field.allowedValues.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      );
    }
    return (
      <div style={width}>
        <label>
          {field.name}
          {field.required ? ' *' : ''}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {allowEmpty && <option value="">— none —</option>}
          {field.allowedValues.map((v) => (
            <option key={v.id} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div style={width}>
      <label>
        {field.name}
        {field.required ? ' *' : ''} <span className="badge">{field.type}</span>
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.type === 'date' ? 'YYYY-MM-DD' : ''} />
    </div>
  );
}
