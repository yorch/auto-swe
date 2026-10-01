'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { RequiredMark } from '@/components/ui/FieldWrapper';
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
        <span className="label-mono block">
          {label}
          {required && <RequiredMark />}
        </span>
        <Alert className="text-xs">
          No {connectionType ? `${connectionType.replace(/_/g, ' ')} ` : ''}connections configured.{' '}
          <Link className="text-ember-400 hover:underline" href="/connections">
            Add one in Connections.
          </Link>
        </Alert>
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
  const hint = prop.description;

  if (prop.type === 'connection') {
    return (
      <ConnectionPicker
        connectionType={prop.connectionType}
        error={error}
        hint={hint}
        label={base}
        onChange={onChange}
        required={required}
        value={typeof value === 'string' ? value : ''}
      />
    );
  }

  if (prop.type === 'boolean') {
    return (
      <div className="space-y-1.5">
        <Checkbox
          aria-errormessage={error ? `${name}-error` : undefined}
          aria-invalid={error ? true : undefined}
          checked={Boolean(value)}
          hint={hint}
          label={base}
          marked={required}
          onChange={(e) => onChange(e.target.checked)}
        />
        {error && (
          <div id={`${name}-error`}>
            <Alert className="text-xs">{error}</Alert>
          </div>
        )}
      </div>
    );
  }

  if (prop.enum) {
    return (
      <Select
        error={error}
        hint={hint}
        label={base}
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
        label={base}
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
      label={base}
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
