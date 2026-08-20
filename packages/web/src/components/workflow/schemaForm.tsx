'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useRepositories } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';

export function ConnectionPicker({
  label,
  hint,
  value,
  onChange,
  connectionType,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  connectionType?: string;
}) {
  const { data: connections = [] } = useRepositories();
  const visible = connectionType
    ? connections.filter((c) => (c.type ?? 'git_repo') === connectionType)
    : connections;
  return (
    <Select hint={hint} label={label} onChange={(e) => onChange(e.target.value)} value={value}>
      <option value="">— select connection —</option>
      {visible.map((c) => (
        <option key={c.id} value={c.id}>
          {connectionLabel(c)}
        </option>
      ))}
    </Select>
  );
}

/** Renders the widget for an `InputSchemaProperty`, shared by the live run form and its preview. */
export function SchemaFieldInput({
  name,
  prop,
  value,
  onChange,
  required,
}: {
  name: string;
  prop: InputSchemaProperty;
  value: unknown;
  onChange: (v: unknown) => void;
  required?: boolean;
}) {
  const base = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
  const label = required ? `${base} *` : base;
  const hint = prop.description;

  if (prop.type === 'connection') {
    return (
      <ConnectionPicker
        connectionType={prop.connectionType}
        hint={hint}
        label={label}
        onChange={onChange}
        value={typeof value === 'string' ? value : ''}
      />
    );
  }

  if (prop.type === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center gap-3">
        <input
          checked={Boolean(value)}
          className="h-4 w-4 accent-ember-400"
          onChange={(e) => onChange(e.target.checked)}
          type="checkbox"
        />
        <span className="text-sm text-paper-200">
          {label}
          {hint && <span className="ml-1 text-paper-500">— {hint}</span>}
        </span>
      </label>
    );
  }

  if (prop.enum) {
    return (
      <Select
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value)}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">— select —</option>
        {prop.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </Select>
    );
  }

  if (prop.type === 'number') {
    return (
      <Input
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
      />
    );
  }

  // string (including uuid format) and fallback
  return (
    <Input
      hint={prop.format === 'uuid' ? `${hint ?? ''} (UUID)`.trim() : hint}
      label={label}
      onChange={(e) => onChange(e.target.value)}
      placeholder={prop.format === 'uuid' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : undefined}
      value={typeof value === 'string' ? value : ''}
    />
  );
}

export function buildInitialPayload(schema: InputSchema): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'boolean') {
      payload[key] = false;
    } else if (prop.enum && prop.enum.length > 0) {
      payload[key] = prop.enum[0];
    } else {
      payload[key] = '';
    }
  }
  return payload;
}
