import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { formatCost, plural } from '@/lib/utils';

interface EditorStatusBarProps {
  spec: WorkflowSpec;
  costEstimateUsd?: number | null;
  /** What the estimate excludes; becomes the estimate's tooltip. */
  costEstimateExclusions?: string | null;
  observedCostUsd?: number | null;
}

/** The slim footer under the canvas: read-only facts about the graph, no controls. */
export function EditorStatusBar({
  spec,
  costEstimateUsd,
  costEstimateExclusions,
  observedCostUsd,
}: EditorStatusBarProps) {
  return (
    <div className="shrink-0 border-t border-ink-600 bg-ink-950/60 px-4 py-1.5">
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-paper-400">
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Nodes</dt>
          <dd className="tabular-nums">{plural(Object.keys(spec.nodes).length, 'node')}</dd>
        </div>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-paper-500">Starts at</dt>
          <dd className="truncate font-mono text-ember-300">{spec.entry}</dd>
        </div>
        {costEstimateUsd != null && (costEstimateUsd > 0 || costEstimateExclusions) && (
          <div
            className="flex items-baseline gap-1.5"
            title={
              // The estimate is per model call priced from step and agent
              // metadata; it is not the agent's own model price (an `agent`
              // node is priced from a proxy role) and it omits anything without
              // a token cost. Say so rather than implying precision.
              costEstimateExclusions
                ? `Rough estimate from step and agent metadata. ${costEstimateExclusions}`
                : 'Rough estimate from step and agent metadata'
            }
          >
            <dt className="text-paper-500">Est.</dt>
            <dd className="tabular-nums">{formatCost(costEstimateUsd)}/run</dd>
          </div>
        )}
        {observedCostUsd != null && (
          <div className="flex items-baseline gap-1.5" title="Average over the last 30 days">
            <dt className="text-paper-500">Observed</dt>
            <dd className="tabular-nums">{formatCost(observedCostUsd)}/run</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
