'use client';

import type {
  InputFieldType,
  InputSchema,
  InputSchemaProperty,
} from '@auto-swe/shared/lib/inputSchema';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

const FIELD_TYPES: { label: string; value: InputFieldType }[] = [
  { label: 'String', value: 'string' },
  { label: 'Number', value: 'number' },
  { label: 'Boolean', value: 'boolean' },
  { label: 'Array', value: 'array' },
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
}

function fieldToProperty(draft: FieldDraft): InputSchemaProperty {
  const prop: InputSchemaProperty = { type: draft.type };
  if (draft.description.trim()) prop.description = draft.description.trim();
  if (draft.type === 'string' && draft.format === 'uuid') prop.format = 'uuid';
  if (draft.type !== 'boolean' && draft.type !== 'array' && draft.enumValues.trim()) {
    prop.enum = draft.enumValues
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (draft.type === 'array') {
    prop.items = { type: draft.itemType };
  }
  return prop;
}

function propertyToDraft(key: string, prop: InputSchemaProperty, required: boolean): FieldDraft {
  return {
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
    if (!k) continue;
    properties[k] = fieldToProperty(d);
    if (d.required) required.push(k);
  }
  if (Object.keys(properties).length === 0) return null;
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

  function update(next: FieldDraft[]) {
    setFields(next);
    onChange(toSchema(next));
  }

  function addField() {
    update([
      ...fields,
      {
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
        <p className="rounded border border-dashed border-ink-600 py-4 text-center text-xs text-paper-500">
          No fields yet — add one to require structured input at run time
        </p>
      )}
      {fields.map((f, i) => (
        <div className="space-y-3 rounded border border-ink-600 bg-ink-900 p-3" key={f.id}>
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
            <Input
              hint={!f.key.trim() ? 'Key required — this field will not be saved' : undefined}
              label="Field key"
              onChange={(e) => updateField(i, { key: e.target.value })}
              placeholder="ticketId"
              value={f.key}
            />
            <Select
              id={`field-type-${i}`}
              label="Type"
              onChange={(e) => updateField(i, { type: e.target.value as InputFieldType })}
              value={f.type}
            >
              {FIELD_TYPES.map(({ label, value: v }) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
            <label className="flex flex-col items-center gap-1 pb-1 text-[10px] uppercase tracking-wider text-paper-500">
              Req.
              <input
                checked={f.required}
                onChange={(e) => updateField(i, { required: e.target.checked })}
                type="checkbox"
              />
            </label>
          </div>
          <Input
            hint="Shown to users in the run form"
            label="Description"
            onChange={(e) => updateField(i, { description: e.target.value })}
            placeholder="e.g. The Jira ticket ID to implement"
            value={f.description}
          />
          {f.type === 'string' && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                hint="Comma-separated list"
                label="Enum values (optional)"
                onChange={(e) => updateField(i, { enumValues: e.target.value })}
                placeholder="red, green, blue"
                value={f.enumValues}
              />
              <Select
                id={`field-format-${i}`}
                label="Format"
                onChange={(e) => updateField(i, { format: e.target.value as '' | 'uuid' })}
                value={f.format}
              >
                <option value="">None</option>
                <option value="uuid">UUID</option>
              </Select>
            </div>
          )}
          {f.type === 'array' && (
            <Select
              id={`item-type-${i}`}
              label="Item type"
              onChange={(e) =>
                updateField(i, {
                  itemType: e.target.value as Exclude<InputFieldType, 'array' | 'connection'>,
                })
              }
              value={f.itemType}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
            </Select>
          )}
          <div className="flex justify-end">
            <Button onClick={() => removeField(i)} size="sm" variant="ghost">
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button onClick={addField} size="sm" variant="secondary">
        + Add field
      </Button>
    </div>
  );
}
