'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import Link from 'next/link';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useRepositories } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';

function ConnectionPicker({
  label,
  hint,
  value,
  onChange,
  connectionType,
  required,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  connectionType?: string;
  required?: boolean;
  error?: string;
}) {
  const { data: connections = [] } = useRepositories();
  const visible = connectionType
    ? connections.filter((c) => (c.type ?? 'git_repo') === connectionType)
    : connections;

  if (visible.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          {label}
          {required ? ' *' : ''}
        </span>
        <p className="text-xs text-brick-400">
          No {connectionType ? `${connectionType.replace(/_/g, ' ')} ` : ''}connections configured.{' '}
          <Link className="text-ember-400 hover:underline" href="/connections">
            Add one in Connections.
          </Link>
        </p>
      </div>
    );
  }

  return (
    <Select
      error={error}
      hint={hint}
      label={label}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      value={value}
    >
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
  error,
}: {
  name: string;
  prop: InputSchemaProperty;
  value: unknown;
  onChange: (v: unknown) => void;
  required?: boolean;
  error?: string;
}) {
  const base = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
  const label = required ? `${base} *` : base;
  const hint = prop.description;

  if (prop.type === 'connection') {
    return (
      <ConnectionPicker
        connectionType={prop.connectionType}
        error={error}
        hint={hint}
        label={label}
        onChange={onChange}
        required={required}
        value={typeof value === 'string' ? value : ''}
      />
    );
  }

  if (prop.type === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center gap-3">
        <input
          aria-errormessage={error ? `${name}-error` : undefined}
          aria-invalid={error ? true : undefined}
          checked={Boolean(value)}
          className="h-4 w-4 accent-ember-400"
          onChange={(e) => onChange(e.target.checked)}
          type="checkbox"
        />
        <span className="text-sm text-paper-200">
          {label}
          {hint && <span className="ml-1 text-paper-500">— {hint}</span>}
        </span>
        {error && (
          <span className="text-xs text-brick-400" id={`${name}-error`}>
            {error}
          </span>
        )}
      </label>
    );
  }

  if (prop.enum) {
    return (
      <Select
        error={error}
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value)}
        required={required}
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
        error={error}
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        required={required}
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
      />
    );
  }

  // string (including uuid format) and fallback
  return (
    <Input
      error={error}
      hint={prop.format === 'uuid' ? `${hint ?? ''} (UUID)`.trim() : hint}
      label={label}
      onChange={(e) => onChange(e.target.value)}
      placeholder={prop.format === 'uuid' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : undefined}
      required={required}
      type={prop.format === 'uuid' ? 'text' : 'text'}
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
      // Keep enum fields unselected initially so the user makes an explicit choice.
      payload[key] = '';
    } else {
      payload[key] = '';
    }
  }
  return payload;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateField(
  prop: InputSchemaProperty,
  value: unknown,
  required?: boolean
): string | undefined {
  if (required && (value === '' || value === undefined || value === null)) {
    return 'This field is required';
  }
  if (prop.type === 'number') {
    if (
      value !== undefined &&
      value !== '' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      return 'Must be a valid number';
    }
  }
  if (prop.type === 'string' && prop.format === 'uuid' && value !== '' && value !== undefined) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return 'Must be a valid UUID';
    }
  }
  if (prop.enum && value !== '' && value !== undefined) {
    if (!prop.enum.some((opt) => String(opt) === value)) {
      return `Must be one of: ${prop.enum.join(', ')}`;
    }
  }
  if (prop.type === 'connection' && value !== '' && value !== undefined) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return 'Select a valid connection';
    }
  }
  return undefined;
}

export function validatePayload(
  schema: InputSchema,
  payload: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const error = validateField(prop, payload[key], required.has(key));
    if (error) {
      errors[key] = error;
    }
  }
  return errors;
}
