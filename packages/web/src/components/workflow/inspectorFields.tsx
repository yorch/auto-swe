'use client';

/**
 * Shared field editors used by the NodeInspector sections: the schema-aware
 * config form, the onFail policy editor, and the inputs-bindings editor.
 * Extracted from TemplateEditor.tsx — pure presentation + callbacks, no
 * spec-level state.
 */

import type { OnFailMode, Binding as SpecBinding, StepFieldDef } from '@auto-swe/shared/workflow';
import { type ReactNode, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils';

export type OnFailValue = OnFailMode;
/**
 * A spec binding, re-exported so the inspector's casts name the real shape.
 *
 * It is a union of `{ from }` (a context path), `{ literal }` and `{ expr }`.
 * A bare value is NOT one of them: `InputMapSchema` is a record of this union,
 * so writing `inputs.x = 'hi'` produces a spec the parser refuses. The editor
 * used to do exactly that in literal mode, which is why the conversion lives in
 * {@link setBindingText} rather than at each call site.
 */
export type Binding = SpecBinding;

export type BindingMode = 'from' | 'expr' | 'literal';

/** Which union member a binding is, defaulting to a context path. */
export function bindingMode(binding: Binding | undefined): BindingMode {
  if (binding && typeof binding === 'object' && 'expr' in binding) {
    return 'expr';
  }
  if (binding && typeof binding === 'object' && 'literal' in binding) {
    return 'literal';
  }
  return 'from';
}

/** The binding's editable text: the path, the expression, or the literal as written. */
export function bindingText(binding: Binding | undefined): string {
  if (!binding || typeof binding !== 'object') {
    return '';
  }
  if ('expr' in binding) {
    return binding.expr;
  }
  if ('literal' in binding) {
    const literal = binding.literal;
    if (typeof literal === 'string') {
      return literal;
    }
    return literal === undefined ? '' : (JSON.stringify(literal) ?? '');
  }
  return 'from' in binding ? binding.from : '';
}

/** Rewrite a binding as `mode` holding `text`, keeping it schema-valid. */
export function setBindingText(mode: BindingMode, text: string): Binding {
  if (mode === 'expr') {
    return { expr: text };
  }
  if (mode === 'literal') {
    return { literal: parseLiteralText(text) };
  }
  return { from: text };
}

/**
 * A literal as typed. `true`, `false`, `null` and numbers become those values
 * (a literal `false` must stay a boolean, and `"1"` vs `1` differ downstream);
 * anything else stays the string the author typed, and text that parses as a
 * JSON object or array becomes one, so a multi-line payload is writable.
 */
export function parseLiteralText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

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

/**
 * Stable keys for the rows of an editable list.
 *
 * An index key is wrong when a row can be removed (every later row remounts, and
 * any state or focus in it is lost), and a content key is worse for a list the
 * user types into (the row remounts on each keystroke). These lists hold no id of
 * their own, so one is minted per position and kept until the list shrinks.
 */
export function useListKeys(length: number): string[] {
  const counter = useRef(0);
  const keys = useRef<string[]>([]);
  while (keys.current.length < length) {
    keys.current.push(`row-${counter.current++}`);
  }
  if (keys.current.length > length) {
    keys.current = keys.current.slice(0, length);
  }
  return keys.current;
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
  title = 'Input bindings',
  note = 'No bindings. Add one to pass a context path or a literal value into this node.',
}: {
  inputs: Record<string, Binding> | undefined;
  onChange: (v: Record<string, Binding> | undefined) => void;
  title?: string;
  note?: string;
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
    // A path by default, which is a valid Binding; a bare `''` is not.
    onChange({ ...existing, [k]: { from: '' } });
  };

  return (
    <InspectorSection
      action={
        <Button onClick={addEntry} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add
        </Button>
      }
      title={title}
    >
      {entries.length === 0 && <InspectorNote>{note}</InspectorNote>}
      {entries.map(([key, val]) => (
        <BindingRow
          binding={val}
          key={key}
          keyControl={
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
          }
          onChange={(next) => setEntry(key, next)}
          onRemove={() => removeEntry(key)}
          removeLabel={`Remove binding ${key}`}
        />
      ))}
    </InspectorSection>
  );
}

/**
 * One `label → value` pair of a bindings map, with the mode picker. The mode
 * selects a union member of `BindingSchema`: a context path (`from`), an
 * expression (`expr`), or a literal. Everything that edits a `Binding` goes
 * through here so the shape cannot be got wrong in one place and right in
 * another.
 */
function BindingRow({
  binding,
  onChange,
  onRemove,
  removeLabel,
  keyControl,
  allowExpr = true,
}: {
  binding: Binding | undefined;
  onChange: (next: Binding) => void;
  onRemove?: () => void;
  removeLabel?: string;
  /** Replacement for the key editor; absent for a standalone binding. */
  keyControl?: ReactNode;
  allowExpr?: boolean;
}) {
  const mode = bindingMode(binding);
  const value = bindingText(binding);
  return (
    <div className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2">
      <div className="flex items-center gap-1.5">
        {keyControl ? <div className="min-w-0 flex-1">{keyControl}</div> : null}
        <Select
          aria-label={keyControl ? 'Binding type' : undefined}
          className="w-auto"
          compact
          onChange={(v) => onChange(setBindingText(v as BindingMode, value))}
          options={[
            { label: 'Path', value: 'from' },
            ...(allowExpr ? [{ label: 'Expression', value: 'expr' }] : []),
            { label: 'Literal', value: 'literal' },
          ]}
          value={mode}
        />
        {onRemove ? (
          <Button
            aria-label={removeLabel ?? 'Remove binding'}
            className="px-2 hover:text-brick-400"
            onClick={onRemove}
            size="sm"
            title="Remove binding"
            variant="ghost"
          >
            <Icon name="close" size={14} />
          </Button>
        ) : null}
      </div>
      <Input
        aria-label="Binding value"
        className={mode === 'from' || mode === 'expr' ? 'font-mono text-xs' : undefined}
        compact
        onChange={(e) => onChange(setBindingText(mode, e.target.value))}
        placeholder={
          mode === 'from'
            ? 'ctx.nodes.step.output.value'
            : mode === 'expr'
              ? 'context.a ?? context.b'
              : 'literal value'
        }
        value={value}
      />
    </div>
  );
}

/**
 * A single named `Binding` — an `eval` node's `target`/`candidateRef`, a
 * `humanApproval`'s `approverCount`. Renders as a labelled block rather than a
 * map entry.
 */
export function BindingField({
  label,
  hint,
  binding,
  onChange,
  allowExpr = true,
  placeholder,
}: {
  label: string;
  hint?: string;
  binding: Binding | undefined;
  onChange: (next: Binding) => void;
  allowExpr?: boolean;
  placeholder?: string;
}) {
  const id = `binding-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="space-y-1.5" data-binding-field={id}>
      <span className="block text-xs font-medium text-paper-400">{label}</span>
      {hint ? <p className="text-xs leading-relaxed text-paper-500">{hint}</p> : null}
      <BindingRow allowExpr={allowExpr} binding={binding} onChange={onChange} />
      {placeholder ? <InspectorNote>{placeholder}</InspectorNote> : null}
    </div>
  );
}
