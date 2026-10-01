/**
 * Standing reminder that model-config edits take effect mid-run. Activities
 * re-resolve their model on each call, so an edit lands on the next activity
 * within an already-executing workflow rather than waiting for a fresh run.
 */
export function MidRunWarning() {
  return (
    <div className="rounded-sm border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs text-paper-300">
      <strong className="font-semibold text-amber-400">Note:</strong> Changes here take effect on
      the next LLM call. Workflows already in progress will pick up the new model or credentials
      mid-run rather than waiting for a fresh start.
    </div>
  );
}
