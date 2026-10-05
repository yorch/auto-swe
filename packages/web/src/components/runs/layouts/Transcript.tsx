'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useEffect, useRef } from 'react';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { TracesTab } from '@/components/runs/TracesTab';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { specNodeIdOfRecording, traceBelongsToStep } from '@/lib/traceLinkage';
import { cn, formatDuration } from '@/lib/utils';
import type { RunLayoutProps } from './types';

// ── Direction B — Transcript ───────────────────────────────────────────────────

function StepSpine({
  selectedId,
  steps,
  onSelect,
}: {
  selectedId: string | null;
  steps: WorkflowStepRecord[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-row overflow-x-auto lg:flex-col lg:overflow-visible">
      {steps.map((s, i) => {
        const isSelected = selectedId === s.nodeId;
        const statusDot =
          s.status === 'PASSED'
            ? 'bg-moss-400'
            : s.status === 'FAILED'
              ? 'bg-brick-400'
              : s.status === 'RUNNING'
                ? 'bg-dust-400'
                : s.status === 'SKIPPED'
                  ? 'bg-ink-400'
                  : 'bg-paper-600';

        return (
          <button
            className={cn(
              'relative flex min-h-[44px] shrink-0 items-start gap-3 whitespace-nowrap border-b-2 px-4 py-3 text-left transition-colors hover:bg-ink-600/20 lg:w-full lg:whitespace-normal lg:border-b-0 lg:border-l-2',
              isSelected ? 'border-ember-400 bg-ink-600' : 'border-transparent'
            )}
            key={s.id}
            onClick={() => onSelect(s.nodeId)}
            type="button"
          >
            {/* Connected dot */}
            <div className="flex flex-col items-center shrink-0 mt-0.5">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot)} />
              {i < steps.length - 1 && (
                <span className="mt-1 hidden min-h-5 w-px flex-1 bg-ink-500 lg:block" />
              )}
            </div>
            <div className="min-w-0">
              <div
                className={cn(
                  'font-mono text-[11px] font-medium',
                  isSelected ? 'text-ember-300' : 'text-paper-400'
                )}
              >
                {s.nodeId}
              </div>
              <StatusBadge status={s.status} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function Transcript({
  jumpNonce,
  linker,
  run,
  selectedNodeId: selectedId,
  setSelectedNodeId: setSelectedId,
  traces,
}: RunLayoutProps) {
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Stacked below the breakpoint: the step spine becomes a strip across the top and the
  // details rail a collapsible section between it and the narrative.
  const narrow = useIsNarrow();
  const rail = <RunMetaRail collapsible={narrow} run={run} />;

  // Selection is the page's, so "Jump to failure" can select a step from outside
  // the layout; scrolling follows the selection rather than the click. The nonce
  // re-fires it when the same failed step is jumped to again after scrolling away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: jumpNonce is a re-fire trigger, not a value the effect reads
  useEffect(() => {
    if (selectedId) {
      stepRefs.current[selectedId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedId, jumpNonce]);

  const handleSpineSelect = (id: string) => setSelectedId(id);

  return (
    <div className="flex flex-1 flex-col max-lg:min-w-0 lg:flex-row lg:overflow-hidden">
      {/* Step spine: 212px */}
      <aside className="w-full shrink-0 border-b border-ink-600/40 bg-ink-900 lg:w-[212px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="px-4 py-3 kicker border-b border-ink-600/30">Steps</div>
        <StepSpine onSelect={handleSpineSelect} selectedId={selectedId} steps={run.steps} />
      </aside>

      {narrow && rail}

      {/* Reading column: 1fr */}
      <div className="flex-1 px-4 py-5 max-lg:min-w-0 lg:overflow-y-auto lg:px-8 lg:py-7">
        {/* Editorial intro */}
        <div className="mb-10 max-w-2xl">
          <div className="kicker mb-2">Run narrative</div>
          <h2 className="mb-3 font-display text-2xl font-medium tracking-[-0.015em] text-paper-100">
            {run.templateName}
          </h2>
          <p className="text-paper-400 text-sm leading-relaxed">
            {run.workRequest?.description ??
              `${run.steps.length} step${run.steps.length !== 1 ? 's' : ''} · ${run.status.toLowerCase()} · v${run.templateVersion}`}
          </p>
        </div>

        {/* Steps as narrative sections */}
        {run.steps.map((step: WorkflowStepRecord, i: number) => {
          const stepTraces = traces.filter((t) => traceBelongsToStep(t, step, linker));
          const isFailedStep = step.status === 'FAILED';

          return (
            <div
              className="mb-12"
              id={`step-${step.nodeId}`}
              key={step.id}
              ref={(el) => {
                stepRefs.current[step.nodeId] = el;
              }}
            >
              {/* Sticky step header */}
              <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 border-b border-ink-600/30 bg-ink-800 py-3 max-lg:gap-y-1 lg:flex-nowrap">
                <span className="tabular font-mono text-xs text-paper-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="font-display text-lg max-lg:min-w-0 max-lg:break-all font-medium tracking-[-0.01em] text-paper-100">
                  {step.nodeId}
                </h3>
                <StatusBadge status={step.status} />
                {step.startedAt && step.endedAt && (
                  <span className="ml-auto font-mono text-[10px] text-paper-600">
                    {formatDuration(
                      new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime()
                    )}
                  </span>
                )}
                <span className="font-mono text-[10px] text-paper-600">
                  {stepTraces.length} event{stepTraces.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Step summary */}
              <p className="mb-4 break-words text-sm italic text-paper-500">
                {isFailedStep
                  ? step.error
                    ? `Failed: ${step.error.slice(0, 120)}`
                    : 'This step failed.'
                  : step.status === 'SKIPPED'
                    ? 'This step was skipped.'
                    : step.status === 'PASSED'
                      ? 'Step completed successfully.'
                      : `Step is ${step.status.toLowerCase()}.`}
              </p>

              {/* Trace events panel */}
              {stepTraces.length > 0 && (
                <div className="rounded border border-ink-600/40 bg-ink-700">
                  <TracesTab
                    compact
                    filterNodeId={null}
                    linker={linker}
                    onClearFilter={() => {}}
                    traces={stepTraces}
                    untaggedAmbiguous={step.nodeId !== specNodeIdOfRecording(step.nodeId, linker)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right meta rail */}
      {!narrow && rail}
    </div>
  );
}
