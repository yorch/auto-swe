'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import Link from 'next/link';
import { useId } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { RequiredMark } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useRepositories } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';

export function ConnectionPicker({
  id,
  label,
  hint,
  value,
  onChange,
  connectionType,
  connectionTypes,
  required,
  error,
}: {
  id?: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  connectionType?: string;
  /** Any of these types; takes the place of `connectionType` when a provider accepts several. */
  connectionTypes?: string[];
  required?: boolean;
  error?: string;
}) {
  const { data: connections = [] } = useRepositories();
  const accepted = connectionTypes?.length
    ? connectionTypes
    : connectionType
      ? [connectionType]
      : [];
  const visible = accepted.length
    ? connections.filter((c) => accepted.includes(c.type ?? 'git_repo'))
    : connections;
  const typeLabel = accepted.map((type) => type.replace(/_/g, ' ')).join(' or ');

  if (visible.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className="label-mono block">
          {label}
          {required && <RequiredMark />}
        </span>
        <Alert className="text-xs">
          No {typeLabel ? `${typeLabel} ` : ''}connections configured.{' '}
          <Link className="text-ember-400 hover:underline" href="/connections">
            Add one in Connections.
          </Link>
        </Alert>
      </div>
    );
  }

  return (
    <Combobox
      emptyMessage="No connections match"
      error={error}
      hint={hint}
      id={id}
      label={label}
      onChange={onChange}
      options={visible.map((c) => ({ label: connectionLabel(c), value: c.id }))}
      placeholder="— select connection —"
      required={required}
      value={value}
    />
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
  const fieldId = useId();
  const base = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
  const hint = prop.description;

  if (prop.type === 'connection') {
    return (
      <ConnectionPicker
        connectionType={prop.connectionType}
        error={error}
        hint={hint}
        id={fieldId}
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
          aria-errormessage={error ? `${fieldId}-error` : undefined}
          aria-invalid={error ? true : undefined}
          checked={Boolean(value)}
          hint={hint}
          id={fieldId}
          label={base}
          marked={required}
          onChange={(e) => onChange(e.target.checked)}
        />
        {error && (
          <div id={`${fieldId}-error`}>
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
        id={fieldId}
        label={base}
        onChange={onChange}
        options={[
          { label: '— select —', value: '' },
          ...prop.enum.map((opt) => ({ label: String(opt), value: String(opt) })),
        ]}
        required={required}
        value={typeof value === 'string' ? value : ''}
      />
    );
  }

  if (prop.type === 'number') {
    return (
      <Input
        error={error}
        hint={hint}
        id={fieldId}
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
      id={fieldId}
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
