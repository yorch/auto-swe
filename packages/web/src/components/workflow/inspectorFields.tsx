'use client';

/**
 * Shared field editors used by the NodeInspector sections: the schema-aware
 * config form, the onFail policy editor, and the inputs-bindings editor.
 * Extracted from TemplateEditor.tsx — pure presentation + callbacks, no
 * spec-level state.
 */

import type { StepFieldDef } from '@auto-swe/shared/workflow';
import { Select } from '@/components/ui/Select';

export type OnFailValue = 'block' | 'warn' | { retry: number };
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
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">Config</div>
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
  const baseInput =
    'h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400';

  return (
    <div className="space-y-1">
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
        htmlFor={id}
      >
        <span className="text-paper-200">{field.key}</span>
        {field.required && <span className="text-brick-400"> *</span>}
        <span className="ml-2 text-paper-500">— {field.label}</span>
      </label>
      {field.type === 'boolean' ? (
        <label className="inline-flex items-center gap-2 text-xs text-paper-200" htmlFor={id}>
          <input
            checked={Boolean(value)}
            className="h-4 w-4 accent-ember-400"
            id={id}
            onChange={(e) => onChange(e.target.checked)}
            type="checkbox"
          />
          enabled
        </label>
      ) : field.type === 'number' ? (
        <input
          className={baseInput}
          id={id}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? undefined : Number(v));
          }}
          type="number"
          value={typeof value === 'number' ? value : ''}
        />
      ) : field.type === 'enum' ? (
        <Select
          className={baseInput}
          id={id}
          onChange={(e) => onChange(e.target.value || undefined)}
          value={typeof value === 'string' ? value : ''}
        >
          <option value="">— none —</option>
          {(field.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      ) : field.type === 'json' ? (
        <textarea
          className="h-20 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 py-1 font-mono text-[11px] text-paper-100 outline-none focus:border-ember-400"
          id={id}
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
          spellCheck={false}
          value={
            value === undefined || value === null
              ? ''
              : typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2)
          }
        />
      ) : (
        <input
          className={baseInput}
          id={id}
          onChange={(e) => onChange(e.target.value || undefined)}
          type="text"
          value={typeof value === 'string' ? value : ''}
        />
      )}
      {field.description && (
        <p className="text-[10px] leading-snug text-paper-500">{field.description}</p>
      )}
    </div>
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
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
        On fail
      </div>
      <Select
        className="h-9 px-2 font-mono text-xs"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'block') {
            onChange(undefined);
          } else if (v === 'warn') {
            onChange('warn');
          } else {
            onChange({ retry: retryCount });
          }
        }}
        value={mode}
      >
        <option value="block">Block (default) — abort run on failure</option>
        <option value="warn">Warn — record failure and continue</option>
        <option value="retry">Retry</option>
      </Select>
      {mode === 'retry' && (
        <div className="space-y-1">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
            htmlFor="onfail-retry-count"
          >
            Retry attempts (max 10)
          </label>
          <input
            className="h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
            id="onfail-retry-count"
            max={10}
            min={1}
            onChange={(e) => onChange({ retry: Math.max(1, Math.min(10, Number(e.target.value))) })}
            type="number"
            value={retryCount}
          />
        </div>
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
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          Input bindings
        </div>
        <button
          className="font-mono text-[10px] uppercase tracking-wider text-ember-400 hover:text-ember-300"
          onClick={addEntry}
          type="button"
        >
          + add
        </button>
      </div>
      {entries.length === 0 && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper-600">— none —</p>
      )}
      {entries.map(([key, val]) => {
        const isFrom = typeof val === 'object' && val !== null && 'from' in val;
        const displayVal = isFrom ? (val as { from: string }).from : String(val ?? '');

        return (
          <div className="space-y-1" key={key}>
            <div className="flex items-center gap-1">
              <input
                className="h-7 min-w-0 flex-1 rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-[11px] text-paper-100 outline-none focus:border-ember-400"
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
              <Select
                className="h-7 w-auto px-1 font-mono text-[10px]"
                onChange={(e) => {
                  if (e.target.value === 'from') {
                    setEntry(key, { from: displayVal });
                  } else {
                    setEntry(key, displayVal);
                  }
                }}
                value={isFrom ? 'from' : 'literal'}
              >
                <option value="from">path</option>
                <option value="literal">literal</option>
              </Select>
              <button
                className="font-mono text-[10px] text-brick-400 hover:text-brick-300"
                onClick={() => removeEntry(key)}
                type="button"
              >
                ×
              </button>
            </div>
            <input
              className="h-7 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-[11px] text-paper-100 outline-none focus:border-ember-400"
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
