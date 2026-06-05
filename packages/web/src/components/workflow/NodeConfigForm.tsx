'use client';

import type { StepFieldDef } from '@auto-swe/shared/workflow';
import { Select } from '@/components/ui/Select';

interface Props {
  fields: ReadonlyArray<StepFieldDef>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Hand-typing JSON is error-prone — return the raw string so the field
    // value persists and the parent's spec re-validation can surface the
    // shape error rather than us swallowing it silently.
    return text;
  }
}

export function NodeConfigForm({ fields, values, onChange }: Props) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 pt-2">
      <div className="text-xs font-medium">Config</div>
      {fields.map((f) => {
        const current = values[f.key];
        const id = `cfg-${f.key}`;
        return (
          <div className="text-xs space-y-1" key={f.key}>
            <label className="block text-[var(--muted-foreground)]" htmlFor={id}>
              <span className="font-mono">{f.key}</span>
              {f.required && <span className="text-red-600"> *</span>}
              <span className="ml-1 opacity-70">— {f.label}</span>
            </label>
            {f.type === 'boolean' ? (
              <input
                checked={Boolean(current)}
                className="ml-1"
                id={id}
                onChange={(e) => onChange(f.key, e.target.checked)}
                type="checkbox"
              />
            ) : f.type === 'number' ? (
              <input
                className="w-full px-2 py-1 font-mono border border-[var(--border)] rounded"
                id={id}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange(f.key, v === '' ? undefined : Number(v));
                }}
                type="number"
                value={typeof current === 'number' ? current : ''}
              />
            ) : f.type === 'enum' ? (
              <Select
                className="h-auto bg-transparent border-[var(--border)] rounded px-2 py-1 font-mono"
                id={id}
                onChange={(e) => onChange(f.key, e.target.value || undefined)}
                value={typeof current === 'string' ? current : ''}
              >
                <option value="">—</option>
                {(f.enumValues ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : f.type === 'stringArray' ? (
              <div className="space-y-1">
                {(f.enumValues ?? []).map((v) => {
                  const all = (f.enumValues ?? []) as readonly string[];
                  // undefined means "all enabled" — initialize selected to the full list
                  // so unchecking any item correctly produces a restricted subset.
                  const selected = Array.isArray(current) ? (current as string[]) : [...all];
                  const checked = selected.includes(v);
                  return (
                    <label className="flex items-center gap-2 cursor-pointer" key={v}>
                      <input
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selected.filter((x) => x !== v), v]
                            : selected.filter((x) => x !== v);
                          // Store undefined when all (or none) selected — both
                          // mean "all enabled" (undefined = no restriction).
                          // This prevents [] from being persisted, which would
                          // render all boxes checked on reload but mean "no tools"
                          // to the worker on any code path that doesn't guard it.
                          onChange(
                            f.key,
                            next.length === 0 || next.length === all.length ? undefined : next
                          );
                        }}
                        type="checkbox"
                      />
                      <span className="font-mono">{v}</span>
                    </label>
                  );
                })}
              </div>
            ) : f.type === 'json' ? (
              <textarea
                className="w-full px-2 py-1 font-mono border border-[var(--border)] rounded"
                id={id}
                onChange={(e) =>
                  onChange(
                    f.key,
                    e.target.value === '' ? undefined : parseJsonLoose(e.target.value)
                  )
                }
                rows={3}
                value={
                  current === undefined || current === null
                    ? ''
                    : typeof current === 'string'
                      ? current
                      : JSON.stringify(current, null, 2)
                }
              />
            ) : f.type === 'string' && f.multiline ? (
              <textarea
                className="w-full px-2 py-1 font-mono border border-[var(--border)] rounded resize-y"
                id={id}
                onChange={(e) => onChange(f.key, e.target.value || undefined)}
                placeholder="Leave empty to use team/global default"
                rows={6}
                value={typeof current === 'string' ? current : ''}
              />
            ) : (
              <input
                className="w-full px-2 py-1 font-mono border border-[var(--border)] rounded"
                id={id}
                onChange={(e) => onChange(f.key, e.target.value || undefined)}
                type="text"
                value={typeof current === 'string' ? current : ''}
              />
            )}
            {f.description && (
              <div className="text-[var(--muted-foreground)] opacity-80">{f.description}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
