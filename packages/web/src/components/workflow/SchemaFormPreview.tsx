'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useRepositories } from '@/hooks/useWorkflows';
import { connectionLabel } from '@/lib/connectionDisplay';

function PreviewConnectionPicker({
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

function PreviewFieldInput({
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
      <PreviewConnectionPicker
        connectionType={prop.connectionType}
        hint={hint}
        label={label}
        onChange={(v) => onChange(v)}
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

function buildInitialPayload(schema: InputSchema): Record<string, unknown> {
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

export function SchemaFormPreview({ schema }: { schema: InputSchema | null | undefined }) {
  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );

  if (!schema || Object.keys(schema.properties).length === 0) {
    return (
      <p className="rounded border border-dashed border-ink-600 py-6 text-center text-xs text-paper-500">
        No fields defined — add fields above to see a preview
      </p>
    );
  }

  const requiredKeys = new Set(schema.required ?? []);

  const setField = (key: string, value: unknown) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          Preview — how this form will look to users
        </span>
      </div>
      <div className="space-y-4 rounded border border-ink-600 bg-ink-900 p-4">
        {Object.entries(schema.properties).map(([key, prop]) => (
          <PreviewFieldInput
            key={key}
            name={key}
            onChange={(v) => setField(key, v)}
            prop={prop}
            required={requiredKeys.has(key)}
            value={payload[key]}
          />
        ))}
        <div className="flex justify-end gap-2 border-t border-ink-600 pt-3">
          <Button disabled size="sm" variant="secondary">
            Cancel
          </Button>
          <Button disabled size="sm" variant="primary">
            Run →
          </Button>
        </div>
      </div>
    </div>
  );
}
