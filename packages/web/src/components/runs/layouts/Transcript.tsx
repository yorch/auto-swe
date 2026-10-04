'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useRef, useState } from 'react';
import { TracesTab } from '@/app/runs/[id]/TracesTab';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { StatusBadge } from '@/components/ui/StatusBadge';
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
    <div className="flex flex-col gap-0">
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
              'relative flex w-full items-start gap-3 border-l-2 px-4 py-3 text-left transition-colors hover:bg-ink-600/20',
              isSelected ? 'border-ember-400 bg-ink-600' : 'border-transparent'
            )}
            key={s.id}
            onClick={() => onSelect(s.nodeId)}
            type="button"
          >
            {/* Connected dot */}
            <div className="flex flex-col items-center shrink-0 mt-0.5">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot)} />
              {i < steps.length - 1 && <span className="mt-1 min-h-5 w-px flex-1 bg-ink-500" />}
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

export function Transcript({ linker, run, traces }: RunLayoutProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const handleSpineSelect = (id: string) => {
    setSelectedId(id);
    stepRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Step spine: 212px */}
      <aside className="w-[212px] shrink-0 overflow-y-auto border-r border-ink-600/40 bg-ink-900">
        <div className="px-4 py-3 kicker border-b border-ink-600/30">Steps</div>
        <StepSpine onSelect={handleSpineSelect} selectedId={selectedId} steps={run.steps} />
      </aside>

      {/* Reading column: 1fr */}
      <div className="flex-1 overflow-y-auto px-8 py-7">
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
              <div className="sticky top-0 z-10 mb-3 flex items-center gap-3 border-b border-ink-600/30 bg-ink-800 py-3">
                <span className="tabular font-mono text-xs text-paper-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="font-display text-lg font-medium tracking-[-0.01em] text-paper-100">
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
              <p className="italic text-paper-500 text-sm mb-4">
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
      <RunMetaRail run={run} />
    </div>
  );
}
