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
        'sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border bg-ink-800 px-4 py-3 sm:flex-nowrap',
        dirty ? 'border-warning-400/50' : 'border-ink-400'
      )}
    >
      <p
        aria-live="polite"
        className="min-w-0 basis-full text-sm sm:basis-auto"
        role={error ? 'alert' : 'status'}
      >
        {error ? (
          <span className="text-danger-400">{error}</span>
        ) : dirty ? (
          <span className="text-warning-400">
            {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}
          </span>
        ) : saved ? (
          <span className="text-success-400">✓ {savedMessage}</span>
        ) : (
          <span className="hidden text-paper-500 sm:inline">No unsaved changes</span>
        )}
      </p>
      <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
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
