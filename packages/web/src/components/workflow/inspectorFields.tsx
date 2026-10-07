'use client';

/**
 * Shared field editors used by the NodeInspector sections: the schema-aware
 * config form, the onFail policy editor, and the inputs-bindings editor.
 * Extracted from TemplateEditor.tsx — pure presentation + callbacks, no
 * spec-level state.
 */

import type { OnFailMode, StepFieldDef } from '@auto-swe/shared/workflow';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils';

export type OnFailValue = OnFailMode;
export type Binding = { from: string } | string | number | boolean | null;

/**
 * One titled block of the inspector rail ("Details", "Configuration", "Outgoing
 * edges"…), divided from the block above it. Every block in the rail goes
 * through here so the headings and spacing stay identical.
 */
export function InspectorSection({
  action,
  children,
  className,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section className={cn('space-y-3 border-t border-ink-600 px-4 py-4', className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-paper-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A labelled group inside an `InspectorSection` — lighter, with no divider. */
export function InspectorSubsection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="space-y-3 pt-2">
      <h4 className="text-xs font-medium text-paper-400">{title}</h4>
      {children}
    </div>
  );
}

/** A one-line note in the rail where a list or form would otherwise be. */
export function InspectorNote({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-paper-500">{children}</p>;
}

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
    <InspectorSubsection title="Step settings">
      {fields.map((f) => {
        const current = values[f.key];
        return (
          <SchemaField field={f} key={f.key} onChange={(v) => onChange(f.key, v)} value={current} />
        );
      })}
    </InspectorSubsection>
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
  // The label reads as prose; the config key is in the raw JSON below.
  const label = field.label || field.key;
  const required = field.required;
  const hint = field.description;

  if (field.type === 'boolean') {
    return (
      <Checkbox
        checked={Boolean(value)}
        className="text-[13px]"
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
          { label: 'Not set', value: '' },
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
        className="h-20 font-mono text-xs"
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
    <InspectorSubsection title="On failure">
      <Select
        compact
        id="onfail-mode"
        label="When this node fails"
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
          { label: 'Stop the run (default)', value: 'block' },
          { label: 'Record it and continue', value: 'warn' },
          { label: 'Retry', value: 'retry' },
        ]}
        value={mode}
      />
      {mode === 'retry' && (
        <Input
          compact
          hint="Up to 10"
          id="onfail-retry-count"
          label="Retry attempts"
          max={10}
          min={1}
          onChange={(e) => onChange({ retry: Math.max(1, Math.min(10, Number(e.target.value))) })}
          type="number"
          value={retryCount}
        />
      )}
    </InspectorSubsection>
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
    <InspectorSection
      action={
        <Button onClick={addEntry} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add
        </Button>
      }
      title="Input bindings"
    >
      {entries.length === 0 && (
        <InspectorNote>
          No bindings. Add one to pass a context path or a literal value into this node.
        </InspectorNote>
      )}
      {entries.map(([key, val]) => {
        const isFrom = typeof val === 'object' && val !== null && 'from' in val;
        const displayVal = isFrom ? (val as { from: string }).from : String(val ?? '');

        return (
          <div className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2" key={key}>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label="Binding key"
                  className="font-mono text-xs"
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
                  { label: 'Path', value: 'from' },
                  { label: 'Literal', value: 'literal' },
                ]}
                value={isFrom ? 'from' : 'literal'}
              />
              <Button
                aria-label={`Remove binding ${key}`}
                className="px-2 hover:text-brick-400"
                onClick={() => removeEntry(key)}
                size="sm"
                title="Remove binding"
                variant="ghost"
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
            <Input
              aria-label="Binding value"
              className={isFrom ? 'font-mono text-xs' : undefined}
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
    </InspectorSection>
  );
}
