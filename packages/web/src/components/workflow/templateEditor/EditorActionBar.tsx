import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn, formatCost, plural } from '@/lib/utils';

interface EditorActionBarProps {
  spec: WorkflowSpec;
  costEstimateUsd?: number | null;
  observedCostUsd?: number | null;
  paletteOpen: boolean;
  showOutline: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShowOutline: Dispatch<SetStateAction<boolean>>;
  /** True while the server half of "Check workflow" is in flight. */
  checkPending: boolean;
  onCheck: () => void;
  /** Parent-supplied Save/Cancel CTAs. */
  actions?: ReactNode;
}

/** The strip above the canvas: graph summary on the left, editor controls on the right. */
export function EditorActionBar({
  spec,
  costEstimateUsd,
  observedCostUsd,
  paletteOpen,
  showOutline,
  setPaletteOpen,
  setShowOutline,
  checkPending,
  onCheck,
  actions,
}: EditorActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-ink-600 bg-ink-950/60 px-4 py-2">
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Nodes</dt>
          <dd className="text-paper-200 tabular-nums">
            {plural(Object.keys(spec.nodes).length, 'node')}
          </dd>
        </div>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-paper-500">Starts at</dt>
          <dd className="truncate font-mono text-xs text-ember-300">{spec.entry}</dd>
        </div>
        {costEstimateUsd != null && costEstimateUsd > 0 && (
          <div
            className="flex items-baseline gap-1.5"
            title="Estimated from each agent's model price"
          >
            <dt className="text-paper-500">Est.</dt>
            <dd className="text-paper-200 tabular-nums">{formatCost(costEstimateUsd)}/run</dd>
          </div>
        )}
        {observedCostUsd != null && (
          <div className="flex items-baseline gap-1.5" title="Average over the last 30 days">
            <dt className="text-paper-500">Observed</dt>
            <dd className="text-paper-200 tabular-nums">{formatCost(observedCostUsd)}/run</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-expanded={paletteOpen}
          className="lg:hidden"
          onClick={() => {
            setPaletteOpen((v) => !v);
            // One overlay at a time below lg.
            setShowOutline(false);
          }}
          size="sm"
          variant="secondary"
        >
          <Icon name="plus" size={13} />
          Add node
        </Button>
        <Button
          aria-busy={checkPending}
          data-check-workflow=""
          onClick={onCheck}
          size="sm"
          variant="secondary"
        >
          <Icon name="checkCircle" size={13} />
          Check workflow
        </Button>
        <Button
          aria-pressed={showOutline}
          className={cn(showOutline && 'border-ember-400/50 bg-ember-400/10 text-ember-300')}
          onClick={() => {
            setShowOutline((v) => !v);
            setPaletteOpen(false);
          }}
          size="sm"
          variant="ghost"
        >
          <Icon name="list" size={13} />
          Outline
        </Button>
        {actions}
      </div>
    </div>
  );
}
