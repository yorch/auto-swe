import { Alert } from '@/components/ui/Alert';

/**
 * Standing reminder that model-config edits take effect mid-run. Activities
 * re-resolve their model on each call, so an edit lands on the next activity
 * within an already-executing workflow rather than waiting for a fresh run.
 */
export function MidRunWarning() {
  return (
    <Alert variant="info">
      Changes here take effect on the next LLM call: workflows already in progress pick up the new
      model or credentials mid-run.
    </Alert>
  );
}
