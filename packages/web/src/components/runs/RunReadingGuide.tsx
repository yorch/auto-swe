import { PageHelp } from '@/components/help/PageHelp';

export function RunReadingGuide() {
  return (
    <PageHelp>
      <section aria-labelledby="run-reading-guide-title" className="space-y-3">
        <h3 className="text-sm font-semibold text-paper-100" id="run-reading-guide-title">
          How to read this page
        </h3>
        <p>
          The outcome stays above one linked investigation workspace. Select a recorded execution in
          the left outline, including its branch and attempt, then switch between Events, Graph,
          Timing and Transcript without losing that selection.
        </p>
        <p>
          Events shows the selected execution’s trace and inputs/outputs. Graph selects all
          executions of a node; use the execution selector to narrow to a branch and attempt. Timing
          shows recorded duration and open live bars.
        </p>
        <p>
          Review history rewinds trace events and execution states. Return to live follows current
          execution again. Outcome, cost, approval controls, and supporting panels always show
          latest/final information.
        </p>
        <p>
          Overview contains approvals, results and reviews. Evidence contains artifacts and model
          transcripts. Activity contains recorded actions and effects. Details contains times, cost,
          tokens, callbacks and lessons.
        </p>
        <p>
          Trace payloads are trimmed while polling. Load full payloads fetches a non-refreshing
          snapshot; trim them again to resume live updates.
        </p>
      </section>
    </PageHelp>
  );
}
