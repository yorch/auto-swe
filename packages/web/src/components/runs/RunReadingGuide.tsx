import { cn } from '@/lib/utils';

/**
 * A collapsed guide to the run page's panels. It names the controls as the page labels them
 * (the layout switcher reads Split, Transcript and Timeline), and says which panels only some
 * layouts carry. The request-to-merge lifecycle is `HowItWorks`; this is about reading this page.
 */
export function RunReadingGuide({ className }: { className?: string }) {
  return (
    <details className={cn('group rounded-lg border border-ink-500/70 bg-ink-800/60', className)}>
      <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-sm font-medium text-paper-100 outline-none focus-visible:ring-2 focus-visible:ring-ember-400">
        How to read this page
      </summary>
      <div className="space-y-3 border-t border-ink-600 px-4 py-4 text-sm leading-relaxed text-paper-400">
        <p>
          <span className="font-semibold text-paper-100">Status and summary.</span> The badge by the
          title and the notice under the header give the run's state in plain words. The cards
          beneath it show what needs a person (open gates), the answers already given, the result,
          or the failed step.
        </p>
        <div>
          <p className="font-semibold text-paper-100">Three layouts</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              <span className="text-paper-200">Split</span>: the execution graph above a console of
              events. The console shows steps beside the events of the selected one (By step) or
              every event in one stream (Stream). Selecting a graph node filters the console.
            </li>
            <li>
              <span className="text-paper-200">Transcript</span>: every step in order, as a reading
              column with a step list beside it.
            </li>
            <li>
              <span className="text-paper-200">Timeline</span>: step timing along the run's
              duration, an event feed, and a play control and scrubber that replay the events in the
              order they were recorded.
            </li>
          </ul>
        </div>
        <p>
          <span className="font-semibold text-paper-100">Traces.</span> The events are what the
          agents did: tool calls, model responses, and activity events. Payloads are trimmed to
          4,000 characters per field while the page polls; when any are, a Load full payloads button
          appears in the header.
        </p>
        <p>
          <span className="font-semibold text-paper-100">Run details rail.</span> In Split and
          Transcript, the rail carries times, cost, tokens, the template and the request. It also
          lists <span className="text-paper-200">Eval signals</span> (recorded quality signals:
          gate, review and merge outcomes, and the scorers of any eval node) and{' '}
          <span className="text-paper-200">Autonomy decisions</span> (the publish and approval
          decisions recorded for this run), each only when the run has some. Timeline has no rail.
          On a narrow screen the rail sits behind a Run details toggle.
        </p>
      </div>
    </details>
  );
}
