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
      <div className="flex justify-end">
        <Button disabled={isPending} type="submit" variant="primary">
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}
