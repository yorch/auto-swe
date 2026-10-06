'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useEffect, useRef } from 'react';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { TracesTab } from '@/components/runs/TracesTab';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { specNodeIdOfRecording, traceBelongsToStep } from '@/lib/traceLinkage';
import { cn, FOCUS_RING, formatDuration } from '@/lib/utils';
import { PANEL_BAR, PANEL_META, PANEL_TITLE } from './panel';
import type { RunLayoutProps } from './types';

// ── Direction B — Transcript ───────────────────────────────────────────────────

const STEP_DOT: Record<string, string> = {
  FAILED: 'bg-brick-400',
  PASSED: 'bg-moss-400',
  RUNNING: 'bg-dust-400 pulse-dot',
  SKIPPED: 'bg-ink-400',
};

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
        return (
          <button
            aria-current={isSelected ? 'step' : undefined}
            className={cn(
              'relative flex min-h-[44px] shrink-0 items-start gap-3 whitespace-nowrap border-b-2 px-4 py-2.5 text-left transition-colors hover:bg-ink-600/30 lg:w-full lg:whitespace-normal lg:border-b-0 lg:border-l-2',
              FOCUS_RING,
              isSelected ? 'border-ember-400 bg-ink-700' : 'border-transparent'
            )}
            key={s.id}
            onClick={() => onSelect(s.nodeId)}
            type="button"
          >
            {/* Connected dot */}
            <div className="mt-1.5 flex shrink-0 flex-col items-center self-stretch">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  STEP_DOT[s.status] ?? 'bg-paper-600'
                )}
              />
              {i < steps.length - 1 && (
                <span className="mt-1 hidden min-h-5 w-px flex-1 bg-ink-500 lg:block" />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div
                className={cn(
                  'break-all font-mono text-xs font-medium',
                  isSelected ? 'text-ember-300' : 'text-paper-200'
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

function stepSummary(step: WorkflowStepRecord): string {
  if (step.status === 'FAILED') {
    return step.error ? `Failed: ${step.error.slice(0, 120)}` : 'This step failed.';
  }
  if (step.status === 'SKIPPED') {
    return 'This step was skipped.';
  }
  if (step.status === 'PASSED') {
    return 'Step completed successfully.';
  }
  return `Step is ${step.status.toLowerCase()}.`;
}

export function Transcript({
  jumpNonce,
  linker,
  run,
  selectedNodeId: selectedId,
  setSelectedNodeId: setSelectedId,
  traces,
}: RunLayoutProps) {
  const stepRefs = useRef<Record<string, HTMLElement | null>>({});
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
        <div className={PANEL_BAR}>
          <h2 className={PANEL_TITLE}>Steps</h2>
          <span className={PANEL_META}>{run.steps.length}</span>
        </div>
        <StepSpine onSelect={handleSpineSelect} selectedId={selectedId} steps={run.steps} />
      </aside>

      {narrow && rail}

      {/* Reading column: 1fr */}
      <div className="flex-1 px-4 py-5 max-lg:min-w-0 lg:overflow-y-auto lg:px-8 lg:py-7">
        {/* Editorial intro */}
        <div className="mb-8 max-w-2xl">
          <div className="kicker mb-2">Run narrative</div>
          <h2 className="mb-2 text-xl font-semibold tracking-[-0.01em] text-paper-50">
            {run.templateName}
          </h2>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-paper-400">
            {run.workRequest?.description ??
              `${run.steps.length} step${run.steps.length !== 1 ? 's' : ''} · ${run.status.toLowerCase()} · v${run.templateVersion}`}
          </p>
        </div>

        {/* Steps as narrative sections */}
        {run.steps.length === 0 && (
          <EmptyState
            bordered
            hint="Steps appear here as the workflow reaches them."
            icon="workflows"
            title="No steps recorded yet"
          />
        )}

        {run.steps.map((step: WorkflowStepRecord, i: number) => {
          const stepTraces = traces.filter((t) => traceBelongsToStep(t, step, linker));
          const isFailedStep = step.status === 'FAILED';

          return (
            <section
              aria-label={`Step ${step.nodeId}`}
              className="mb-10"
              id={`step-${step.nodeId}`}
              key={step.id}
              ref={(el) => {
                stepRefs.current[step.nodeId] = el;
              }}
            >
              {/* Sticky step header */}
              <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600/40 bg-ink-800 py-3 lg:flex-nowrap">
                <span className="tabular w-6 shrink-0 text-xs text-paper-500">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="font-mono text-sm font-medium text-paper-50 max-lg:min-w-0 max-lg:break-all">
                  {step.nodeId}
                </h3>
                <StatusBadge status={step.status} />
                <span className="ml-auto flex items-center gap-3 text-xs text-paper-500">
                  {step.startedAt && step.endedAt && (
                    <span className="tabular">
                      {formatDuration(
                        new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime()
                      )}
                    </span>
                  )}
                  <span className="tabular">
                    {stepTraces.length} event{stepTraces.length !== 1 ? 's' : ''}
                  </span>
                </span>
              </div>

              {/* Step summary */}
              <p
                className={cn(
                  'mb-4 break-words text-[13px] leading-relaxed',
                  isFailedStep ? 'text-brick-400' : 'text-paper-400'
                )}
              >
                {stepSummary(step)}
              </p>

              {/* Trace events panel */}
              {stepTraces.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-ink-600/60 bg-ink-700/60">
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
            </section>
          );
        })}
      </div>

      {/* Right meta rail */}
      {!narrow && rail}
    </div>
  );
}
