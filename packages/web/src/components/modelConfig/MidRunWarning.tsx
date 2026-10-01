import { Alert } from '@/components/ui/Alert';

/**
 * Standing reminder that model-config edits take effect mid-run. Activities
 * re-resolve their model on each call, so an edit lands on the next activity
 * within an already-executing workflow rather than waiting for a fresh run.
 */
export function MidRunWarning() {
  return (
    <Alert title="Note" variant="warning">
      Changes here take effect on the next LLM call. Workflows already in progress will pick up the
      new model or credentials mid-run rather than waiting for a fresh start.
    </Alert>
  );
}
