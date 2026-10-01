'use client';

/**
 * Shared field editors used by the NodeInspector sections: the schema-aware
 * config form, the onFail policy editor, and the inputs-bindings editor.
 * Extracted from TemplateEditor.tsx — pure presentation + callbacks, no
 * spec-level state.
 */

import type { OnFailMode, StepFieldDef } from '@auto-swe/shared/workflow';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';

export type OnFailValue = OnFailMode;
export type Binding = { from: string } | string | number | boolean | null;

export function SchemaAwareForm({
  fields,
  values,
  onChange,
}: {
  fields: ReadonlyArray<StepFieldDef>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-3 border-t border-ink-600 pt-4">
      <div className="label-mono">Config</div>
      {fields.map((f) => {
        const current = values[f.key];
        return (
          <SchemaField field={f} key={f.key} onChange={(v) => onChange(f.key, v)} value={current} />
        );
      })}
    </div>
  );
}

function SchemaField({
  field,
  value,
  onChange,
}: {
  field: StepFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `cfg-${field.key}`;
  const label = `${field.key} — ${field.label}`;
  const required = field.required;
  const hint = field.description;

  if (field.type === 'boolean') {
    return (
      <Checkbox
        checked={Boolean(value)}
        className="text-xs"
        hint={hint}
        id={id}
        label={label}
        marked={required}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.type === 'number') {
    return (
      <Input
        compact
        hint={hint}
        id={id}
        label={label}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? undefined : Number(v));
        }}
        required={required}
        type="number"
        value={typeof value === 'number' ? value : ''}
      />
    );
  }
  if (field.type === 'enum') {
    return (
      <Select
        compact
        hint={hint}
        id={id}
        label={label}
        onChange={(v) => onChange(v || undefined)}
        options={[
          { label: '— none —', value: '' },
          ...(field.enumValues ?? []).map((v) => ({ label: v, value: v })),
        ]}
        required={required}
        value={typeof value === 'string' ? value : ''}
      />
    );
  }
  if (field.type === 'json') {
    return (
      <Textarea
        className="h-20"
        compact
        hint={hint}
        id={id}
        label={label}
        onChange={(e) => {
          const t = e.target.value;
          if (t === '') {
            return onChange(undefined);
          }
          try {
            onChange(JSON.parse(t));
          } catch {
            onChange(t);
          }
        }}
        required={required}
        spellCheck={false}
        value={
          value === undefined || value === null
            ? ''
            : typeof value === 'string'
              ? value
              : JSON.stringify(value, null, 2)
        }
      />
    );
  }
  return (
    <Input
      compact
      hint={hint}
      id={id}
      label={label}
      onChange={(e) => onChange(e.target.value || undefined)}
      required={required}
      type="text"
      value={typeof value === 'string' ? value : ''}
    />
  );
}

/* ─── onFail policy editor ───────────────────────────────────────────────── */

export function OnFailSection({
  value,
  onChange,
}: {
  value: OnFailValue | undefined;
  onChange: (v: OnFailValue | undefined) => void;
}) {
  const mode =
    value === undefined || value === 'block' ? 'block' : value === 'warn' ? 'warn' : 'retry';
  const retryCount = typeof value === 'object' ? value.retry : 1;

  return (
    <div className="mt-4 space-y-2 border-t border-ink-600 pt-4">
      <Select
        compact
        id="onfail-mode"
        label="On fail"
        onChange={(v) => {
          if (v === 'block') {
            onChange(undefined);
          } else if (v === 'warn') {
            onChange('warn');
          } else {
            onChange({ retry: retryCount });
          }
        }}
        options={[
          { label: 'Block (default) — abort run on failure', value: 'block' },
          { label: 'Warn — record failure and continue', value: 'warn' },
          { label: 'Retry', value: 'retry' },
        ]}
        value={mode}
      />
      {mode === 'retry' && (
        <Input
          compact
          id="onfail-retry-count"
          label="Retry attempts (max 10)"
          max={10}
          min={1}
          onChange={(e) => onChange({ retry: Math.max(1, Math.min(10, Number(e.target.value))) })}
          type="number"
          value={retryCount}
        />
      )}
    </div>
  );
}

/* ─── Inputs bindings editor ─────────────────────────────────────────────── */

export function InputsBindingsSection({
  inputs,
  onChange,
}: {
  inputs: Record<string, Binding> | undefined;
  onChange: (v: Record<string, Binding> | undefined) => void;
}) {
  const entries = Object.entries(inputs ?? {});

  const setEntry = (key: string, val: Binding) => onChange({ ...(inputs ?? {}), [key]: val });
  const removeEntry = (key: string) => {
    const next = { ...(inputs ?? {}) };
    delete next[key];
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };
  const addEntry = () => {
    let k = 'input';
    let n = 2;
    const existing = inputs ?? {};
    while (existing[k] !== undefined) {
      k = `input_${n++}`;
    }
    onChange({ ...existing, [k]: '' });
  };

  return (
    <div className="mt-4 space-y-3 border-t border-ink-600 pt-4">
      <div className="flex items-center justify-between">
        <div className="label-mono">Input bindings</div>
        <Button onClick={addEntry} size="sm" variant="ghost">
          Add binding
        </Button>
      </div>
      {entries.length === 0 && (
        <EmptyState className="py-0 text-left text-xs" title="No input bindings." />
      )}
      {entries.map(([key, val]) => {
        const isFrom = typeof val === 'object' && val !== null && 'from' in val;
        const displayVal = isFrom ? (val as { from: string }).from : String(val ?? '');

        return (
          <div className="space-y-1" key={key}>
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label="Binding key"
                  compact
                  defaultValue={key}
                  onBlur={(e) => {
                    const newKey = e.target.value.trim();
                    if (!newKey || newKey === key) {
                      return;
                    }
                    const next = { ...(inputs ?? {}) };
                    delete next[key];
                    next[newKey] = val;
                    onChange(next);
                  }}
                  placeholder="key"
                />
              </div>
              <Select
                aria-label="Binding type"
                className="w-auto"
                compact
                onChange={(v) => {
                  if (v === 'from') {
                    setEntry(key, { from: displayVal });
                  } else {
                    setEntry(key, displayVal);
                  }
                }}
                options={[
                  { label: 'path', value: 'from' },
                  { label: 'literal', value: 'literal' },
                ]}
                value={isFrom ? 'from' : 'literal'}
              />
              <Button
                aria-label="Remove binding"
                className="px-2"
                onClick={() => removeEntry(key)}
                size="sm"
                variant="danger"
              >
                ×
              </Button>
            </div>
            <Input
              aria-label="Binding value"
              compact
              onChange={(e) => {
                const v = e.target.value;
                setEntry(key, isFrom ? { from: v } : v);
              }}
              placeholder={isFrom ? 'ctx.nodes.step.output.value' : 'literal value'}
              value={displayVal}
            />
          </div>
        );
      })}
    </div>
  );
}
