'use client';

import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Icon } from '@/components/ui/Icon';
import { visibleText } from '@/lib/visibleText';

/** A plugin that may be bound. A disabled one is offered only while it is already on the list. */
export interface PluginOption {
  name: string;
  status: 'OK' | 'DISABLED';
}

/**
 * An agent's ordered plugin list: add, remove, reorder. Instructions are appended in list order
 * and tool grants are the union, so the order is meaningful. Without `options` the list is
 * read-only (the caller may not change it). Names are plugin names from the platform, shown
 * through `visibleText`.
 */
export function PluginListEditor({
  onChange,
  options,
  value,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** The plugins this caller may add; undefined makes the list read-only. */
  options?: PluginOption[];
}) {
  const editable = options !== undefined;
  const status = (name: string) => options?.find((o) => o.name === name)?.status;
  const available = (options ?? []).filter((o) => o.status === 'OK' && !value.includes(o.name));

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) {
      return;
    }
    const next = [...value];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    onChange(next);
  }

  if (!editable) {
    return value.length === 0 ? null : (
      <p className="text-xs text-paper-500">
        Plugins: <code>{value.map((n) => visibleText(n)).join(', ')}</code> (changed by a platform
        admin, or by a team admin on a team override)
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="plugin-list">
      {value.length > 0 && (
        <ol className="space-y-1">
          {value.map((name, i) => {
            const label = visibleText(name);
            return (
              <li
                className="flex items-center gap-1 rounded-md border border-ink-400 bg-ink-900/40 py-1 pr-1 pl-3 text-sm"
                key={name}
              >
                <span className="w-5 shrink-0 text-xs text-paper-500 tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-paper-200">
                  {label}
                  {status(name) === 'DISABLED' && (
                    <span className="ml-2 text-xs text-warning-400">disabled</span>
                  )}
                  {status(name) === undefined && (
                    <span className="ml-2 text-xs text-paper-500">not offered to you</span>
                  )}
                </span>
                <Button
                  aria-label={`Move ${label} up`}
                  className="w-7 px-0"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  size="sm"
                  variant="ghost"
                >
                  <Icon name="arrowUp" size={14} />
                </Button>
                <Button
                  aria-label={`Move ${label} down`}
                  className="w-7 px-0"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, 1)}
                  size="sm"
                  variant="ghost"
                >
                  <Icon name="arrowDown" size={14} />
                </Button>
                <Button
                  aria-label={`Remove ${label}`}
                  className="w-7 px-0 text-danger-400 hover:text-danger-400"
                  onClick={() => onChange(value.filter((n) => n !== name))}
                  size="sm"
                  variant="ghost"
                >
                  <Icon name="close" size={14} />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {available.length > 0 ? (
        <Combobox
          aria-label="Add plugin"
          // Remount after each add so the typed filter text does not linger.
          key={value.length}
          onChange={(v) => {
            if (v) {
              onChange([...value, v]);
            }
          }}
          options={available.map((o) => ({ label: visibleText(o.name), value: o.name }))}
          placeholder="Add a plugin…"
          value=""
        />
      ) : (
        value.length === 0 && (
          <p className="text-xs text-paper-500">No plugin is available to bind.</p>
        )
      )}
    </div>
  );
}
