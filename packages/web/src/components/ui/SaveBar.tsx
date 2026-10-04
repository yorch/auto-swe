import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './Button';

/**
 * The save row of an edit form, kept in view while the form is on screen: how
 * many edits are unsaved, what happened to the last save, and the Save and
 * Discard actions. `children` carries a section's extra action (Run now).
 * Render it inside the `<form>` — Save is the submit button.
 */
export function SaveBar({
  children,
  dirtyCount,
  error,
  onDiscard,
  pending,
  saved,
  savedMessage = 'Changes saved.',
}: {
  children?: ReactNode;
  dirtyCount: number;
  error: string | null;
  onDiscard: () => void;
  pending: boolean;
  saved: boolean;
  savedMessage?: string;
}) {
  const dirty = dirtyCount > 0;
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border bg-ink-800/95 px-4 py-3 backdrop-blur',
        dirty ? 'border-amber-400/50' : 'border-ink-400'
      )}
    >
      <p aria-live="polite" className="min-w-0 text-sm" role={error ? 'alert' : 'status'}>
        {error ? (
          <span className="text-brick-400">{error}</span>
        ) : dirty ? (
          <span className="text-amber-400">
            {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}
          </span>
        ) : saved ? (
          <span className="text-moss-400">✓ {savedMessage}</span>
        ) : (
          <span className="text-paper-500">No unsaved changes</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button disabled={!dirty || pending} onClick={onDiscard} type="button" variant="ghost">
          Discard
        </Button>
        <Button disabled={!dirty || pending} type="submit" variant="primary">
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
