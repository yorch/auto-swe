import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import type { TestResult } from '@/hooks/useIntegrationConfigForm';
import { cn } from '@/lib/utils';

/** Outcome of a tab's "Test connection" button, shown under that button. */
export function TestResultAlert({ result }: { result: TestResult | null }) {
  if (!result) {
    return null;
  }
  return (
    <Alert className="mt-3" variant={result.ok ? 'success' : 'error'}>
      {result.detail}
      {result.unsaved && <span className="mt-1 block text-xs">Tested with unsaved values.</span>}
    </Alert>
  );
}

/**
 * The end of every integration tab's form: the saved / error outcome and the
 * submit button, kept in view at the bottom of the screen while the form is.
 * Render it as the last child of the tab's `<form>`.
 */
export function IntegrationFormFooter({
  dirtyCount,
  error,
  isPending,
  saved,
}: {
  /** How many fields differ from what is saved; Save is disabled at zero. */
  dirtyCount: number;
  error: string | null;
  isPending: boolean;
  saved: boolean;
}) {
  const dirty = dirtyCount > 0;
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div
        className={cn(
          'sticky bottom-0 z-10 flex flex-nowrap items-center justify-between gap-3 rounded-lg border bg-ink-800/95 px-4 py-3 backdrop-blur',
          dirty ? 'border-amber-400/50' : 'border-ink-400'
        )}
      >
        <p aria-live="polite" className="min-w-0 text-[13px]" role="status">
          {saved && !dirty && <span className="mr-1 text-moss-400">Settings saved.</span>}
          <span className={dirty ? 'text-amber-400' : 'text-paper-500'}>
            {dirty
              ? `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`
              : 'No unsaved changes'}
            .
          </span>{' '}
          <span className="hidden text-paper-500 sm:inline">
            Blank secret fields keep their current value.
          </span>
        </p>
        <Button disabled={isPending || !dirty} type="submit" variant="primary">
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}
