'use client';

import type {
  InputFieldType,
  InputSchema,
  InputSchemaProperty,
} from '@auto-swe/shared/lib/inputSchema';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { selectableConnectionTypes } from '@/lib/connectionForm';

const FIELD_TYPES: { label: string; value: InputFieldType }[] = [
  { label: 'String', value: 'string' },
  { label: 'Number', value: 'number' },
  { label: 'Boolean', value: 'boolean' },
  { label: 'Array', value: 'array' },
  { label: 'Connection', value: 'connection' },
];

interface FieldDraft {
  id: string;
  key: string;
  type: InputFieldType;
  description: string;
  required: boolean;
  enumValues: string;
  format: '' | 'uuid';
  itemType: Exclude<InputFieldType, 'array' | 'connection'>;
  connectionType: string;
}

function fieldToProperty(draft: FieldDraft): InputSchemaProperty {
  const prop: InputSchemaProperty = { type: draft.type };
  if (draft.description.trim()) {
    prop.description = draft.description.trim();
  }
  if (draft.type === 'string' && draft.format === 'uuid') {
    prop.format = 'uuid';
  }
  if (draft.type !== 'boolean' && draft.type !== 'array' && draft.enumValues.trim()) {
    prop.enum = draft.enumValues
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (draft.type === 'array') {
    prop.items = { type: draft.itemType };
  }
  if (draft.type === 'connection' && draft.connectionType) {
    prop.connectionType = draft.connectionType;
  }
  return prop;
}

function propertyToDraft(key: string, prop: InputSchemaProperty, required: boolean): FieldDraft {
  return {
    connectionType: prop.connectionType ?? '',
    description: prop.description ?? '',
    enumValues: prop.enum ? prop.enum.join(', ') : '',
    format: prop.format === 'uuid' ? 'uuid' : '',
    id: crypto.randomUUID(),
    itemType: prop.items?.type ?? 'string',
    key,
    required,
    type: prop.type,
  };
}

function toSchema(fields: FieldDraft[]): InputSchema | null {
  const properties: Record<string, InputSchemaProperty> = {};
  const required: string[] = [];
  for (const d of fields) {
    const k = d.key.trim();
    if (!k) {
      continue;
    }
    properties[k] = fieldToProperty(d);
    if (d.required) {
      required.push(k);
    }
  }
  if (Object.keys(properties).length === 0) {
    return null;
  }
  return { properties, type: 'object', ...(required.length ? { required } : {}) };
}

export function InputSchemaBuilder({
  value,
  onChange,
}: {
  value: InputSchema | null | undefined;
  onChange: (schema: InputSchema | null) => void;
}) {
  const [fields, setFields] = useState<FieldDraft[]>(() => {
    const s = value ?? { properties: {}, required: [], type: 'object' as const };
    return Object.entries(s.properties).map(([k, p]) =>
      propertyToDraft(k, p, (s.required ?? []).includes(k))
    );
  });

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const f of fields) {
      const k = f.key.trim();
      if (k) {
        if (seen.has(k)) {
          dupes.add(k);
        } else {
          seen.add(k);
        }
      }
    }
    return dupes;
  }, [fields]);

  function update(next: FieldDraft[]) {
    setFields(next);
    onChange(toSchema(next));
  }

  function addField() {
    update([
      ...fields,
      {
        connectionType: '',
        description: '',
        enumValues: '',
        format: '',
        id: crypto.randomUUID(),
        itemType: 'string',
        key: '',
        required: false,
        type: 'string',
      },
    ]);
  }

  function removeField(i: number) {
    update(fields.filter((_, idx) => idx !== i));
  }

  function updateField(i: number, patch: Partial<FieldDraft>) {
    update(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  return (
    <div className="space-y-3">
      {fields.length === 0 && (
        <EmptyState
          action={
            <Button onClick={addField} size="sm" variant="primary">
              <Icon name="plus" size={13} />
              Add field
            </Button>
          }
          bordered
          hint="Add a field to ask for structured input, such as a ticket ID, when someone runs this workflow."
          icon="sliders"
          title="No launch inputs"
        />
      )}
      {fields.map((f, i) => (
        <Card className="space-y-3 p-4" key={f.id} variant="inset">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-paper-200">
              Field {i + 1}
              {f.key.trim() && (
                <span className="ml-2 font-mono text-xs font-normal text-paper-500">
                  {f.key.trim()}
                </span>
              )}
            </h3>
            <Button
              aria-label={`Remove field ${f.key.trim() || i + 1}`}
              className="px-2 hover:text-brick-400"
              onClick={() => removeField(i)}
              size="sm"
              title="Remove field"
              variant="ghost"
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_10rem_auto]">
            <Input
              className="font-mono text-[13px]"
              hint={
                !f.key.trim()
                  ? 'Key required — this field will not be saved'
                  : duplicateKeys.has(f.key.trim())
                    ? 'Duplicate key — overwrites another field'
                    : undefined
              }
              label="Field key"
              onChange={(e) => updateField(i, { key: e.target.value })}
              placeholder="ticketId"
              value={f.key}
            />
            <Select
              id={`field-type-${i}`}
              label="Type"
              onChange={(v) => {
                if (FIELD_TYPES.some((t) => t.value === v)) {
                  updateField(i, { type: v as InputFieldType });
                }
              }}
              options={FIELD_TYPES.map(({ label, value: v }) => ({ label, value: v }))}
              value={f.type}
            />
            <Checkbox
              checked={f.required}
              className="sm:pb-2.5"
              label="Required"
              onChange={(e) => updateField(i, { required: e.target.checked })}
            />
          </div>
          <Input
            hint="Shown to users in the run form"
            label="Description"
            onChange={(e) => updateField(i, { description: e.target.value })}
            placeholder="e.g. The Jira ticket ID to implement"
            value={f.description}
          />
          {f.type === 'string' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                hint="Optional, comma-separated"
                label="Allowed values"
                onChange={(e) => updateField(i, { enumValues: e.target.value })}
                placeholder="red, green, blue"
                value={f.enumValues}
              />
              <Select
                id={`field-format-${i}`}
                label="Format"
                onChange={(v) => {
                  if (v === '' || v === 'uuid') {
                    updateField(i, { format: v });
                  }
                }}
                options={[
                  { label: 'None', value: '' },
                  { label: 'UUID', value: 'uuid' },
                ]}
                value={f.format}
              />
            </div>
          )}
          {f.type === 'array' && (
            <Select
              id={`item-type-${i}`}
              label="Item type"
              onChange={(v) => {
                if (v === 'string' || v === 'number' || v === 'boolean') {
                  updateField(i, { itemType: v });
                }
              }}
              options={[
                { label: 'String', value: 'string' },
                { label: 'Number', value: 'number' },
                { label: 'Boolean', value: 'boolean' },
              ]}
              value={f.itemType}
            />
          )}
          {f.type === 'connection' && (
            <Select
              hint="Only show connections of this type in the run form"
              id={`conn-type-${i}`}
              label="Filter by connection type"
              onChange={(v) => updateField(i, { connectionType: v })}
              options={[
                { label: 'Any type', value: '' },
                ...selectableConnectionTypes().map(({ label, value }) => ({ label, value })),
              ]}
              value={f.connectionType}
            />
          )}
        </Card>
      ))}
      {fields.length > 0 && (
        <Button onClick={addField} size="sm" variant="secondary">
          <Icon name="plus" size={13} />
          Add field
        </Button>
      )}
    </div>
  );
}
