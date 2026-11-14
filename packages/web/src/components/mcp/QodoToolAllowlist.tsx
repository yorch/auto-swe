'use client';

import { QODO_READ_TOOLS } from '@auto-swe/shared/lib/qodoConnection';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';

/**
 * The tools a marked connection binds now: its stored list narrowed to the read tools, or the
 * whole read list when nothing is stored. An empty stored list is not "no list": it binds nothing.
 */
export function effectiveQodoTools(stored: readonly string[] | undefined): string[] {
  if (stored === undefined) {
    return [...QODO_READ_TOOLS];
  }
  return QODO_READ_TOOLS.filter((name) => stored.includes(name));
}

/**
 * The `allowedTools` to send for a selection, or `undefined` to leave the stored value alone.
 * Selecting every read tool is the default, so it clears a stored list (`null`) instead of storing
 * a copy of the read list that would not follow the platform's list when it grows.
 */
export function allowlistChange(
  stored: readonly string[] | undefined,
  selected: readonly string[]
): string[] | null | undefined {
  const next = QODO_READ_TOOLS.filter((name) => selected.includes(name));
  const current = effectiveQodoTools(stored);
  const same = next.length === current.length && next.every((name, i) => name === current[i]);
  if (same) {
    return undefined;
  }
  return next.length === QODO_READ_TOOLS.length ? null : next;
}

/**
 * Check or uncheck the read tools a Qodo connection may bind. The list can only narrow: the
 * gateway refuses a write tool, and the worker intersects a stored list with the read list.
 * `advertised` is the tool list from the last connection test, when there is one.
 */
export function QodoToolAllowlist({
  advertised,
  idPrefix,
  onChange,
  selected,
  stored,
}: {
  idPrefix: string;
  /** What the stored `config.allowedTools` holds, or undefined when none is stored. */
  stored: readonly string[] | undefined;
  selected: readonly string[];
  /** Tool names the server advertised when last tested; undefined before a test. */
  advertised?: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  const chosen = new Set(selected);
  const offered = advertised ? new Set(advertised) : null;
  const unreadable = offered ? [...offered].filter((n) => !QODO_READ_TOOLS.includes(n)) : [];
  const dropped = (stored ?? []).filter((n) => !QODO_READ_TOOLS.includes(n));
  const atDefault = selected.length === QODO_READ_TOOLS.length;
  return (
    <fieldset className="space-y-2" data-testid={`${idPrefix}-allowlist`}>
      <legend className="text-sm text-paper-300">Allowed tools</legend>
      <p className="text-xs text-paper-500">
        Only Qodo&apos;s read tools can be allowed. With no stored list, every read tool applies
        (the read-only default); a stored list narrows it, and an empty stored list would bind no
        tool at all, so the page never saves one. Untick tools to narrow the list.
      </p>
      <p className="text-xs text-paper-400" role="status">
        {stored === undefined
          ? `No list stored: the read-only default applies (${QODO_READ_TOOLS.length} tools).`
          : `Stored list: ${effectiveQodoTools(stored).length} of ${QODO_READ_TOOLS.length} read tools.`}
      </p>
      {dropped.length > 0 && (
        <p className="text-xs text-warning-400">
          {`The stored list names tools outside the read list (${dropped.join(', ')}). They never bind, and saving the list removes them.`}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={atDefault}
          onClick={() => onChange([...QODO_READ_TOOLS])}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reset to the read-only default
        </Button>
      </div>
      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {QODO_READ_TOOLS.map((name) => (
          <Checkbox
            checked={chosen.has(name)}
            hint={offered ? (offered.has(name) ? 'Advertised' : 'Not advertised') : undefined}
            id={`${idPrefix}-tool-${name}`}
            key={name}
            label={<span className="font-mono text-xs">{name}</span>}
            onChange={(e) =>
              onChange(
                QODO_READ_TOOLS.filter((n) => (n === name ? e.target.checked : chosen.has(n)))
              )
            }
          />
        ))}
      </div>
      {selected.length === 0 && (
        <p className="text-xs text-danger-400" role="alert">
          No tool is ticked, so nothing would bind. Tick at least one, or reset to the default.
        </p>
      )}
      {unreadable.length > 0 && (
        <p className="text-xs text-paper-500">
          {`Advertised but not on the read list, so they cannot be allowed: ${unreadable.join(', ')}.`}
        </p>
      )}
      {!offered && (
        <p className="text-xs text-paper-500">
          Run Test on the connection to see which of these tools the server advertises.
        </p>
      )}
    </fieldset>
  );
}
