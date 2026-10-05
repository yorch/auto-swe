import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import type { TestResult } from '@/hooks/useIntegrationConfigForm';

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
 * submit button. Render it as the last child of the tab's `<form>`.
 */
export function IntegrationFormFooter({
  error,
  isPending,
  saved,
}: {
  error: string | null;
  isPending: boolean;
  saved: boolean;
}) {
  return (
    <>
      {saved && <Alert variant="success">Settings saved.</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-400 bg-ink-800/95 px-4 py-3">
        <p className="min-w-0 text-xs text-paper-500">
          Saves the settings on this tab. Blank secret fields keep their current value.
        </p>
        <Button disabled={isPending} type="submit" variant="primary">
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}
