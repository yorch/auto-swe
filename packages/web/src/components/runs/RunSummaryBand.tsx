'use client';

import { hasRunResult, RunSummary, type RunSummaryProps } from './RunSummary';

type RunSummaryBandProps = Omit<RunSummaryProps, 'variant'>;

/**
 * The run page's strip above whichever layout is chosen: the shared summary, capped in height
 * so the layout below keeps room, scrolling inside itself when it is taller. Below the
 * breakpoint the page itself scrolls, so the band takes the height it needs.
 */
export function RunSummaryBand(props: RunSummaryBandProps) {
  const { run, failedStep, pendingSteps, answeredSteps = [] } = props;
  if (
    pendingSteps.length === 0 &&
    answeredSteps.length === 0 &&
    !hasRunResult(run.result) &&
    !failedStep
  ) {
    return null;
  }
  return (
    <div className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 py-3 md:px-6 lg:max-h-[45vh] lg:overflow-y-auto">
      <RunSummary {...props} variant="full" />
    </div>
  );
}
