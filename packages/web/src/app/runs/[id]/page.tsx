'use client';

import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HumanStepCard } from '@/components/approvals/HumanStepCard';
import { LayoutToggle } from '@/components/LayoutToggle';
import { FailureCard } from '@/components/runs/FailureCard';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { classifyTraceAsSecurityEvent } from '@/components/security/SecurityEventList';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { useApprovals } from '@/hooks/useApprovals';
import { useCancelWorkflowRun, useRetryWorkRequest, useWorkflowRun } from '@/hooks/useRuns';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { cn, formatClock, formatDuration, formatRelativeTime } from '@/lib/utils';
import { SplitRunPanel } from './SplitRunPanel';
import { TracesTab } from './TracesTab';

interface PageProps {
  params: Promise<{ id: string }>;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function getFailedStep(steps: WorkflowStepRecord[]): WorkflowStepRecord | null {
  return steps.find((s) => s.status === 'FAILED') ?? null;
}

// ── Segmented console toggle (◧ Split / ≡ Stream) ─────────────────────────────

function ConsoleModeToggle({
  value,
  onChange,
}: {
  value: 'split' | 'stream';
  onChange: (v: 'split' | 'stream') => void;
}) {
  return (
    <div className="flex items-center border border-ink-400" style={{ borderRadius: '8px' }}>
      {(
        [
          { id: 'split' as const, label: '◧ Split' },
          { id: 'stream' as const, label: '≡ Stream' },
        ] as const
      ).map((opt, i) => (
        <button
          className="px-2.5 py-1 transition-colors"
          key={opt.id}
          onClick={() => onChange(opt.id)}
          style={{
            background: value === opt.id ? 'rgba(124, 108, 255, 0.14)' : 'transparent',
            borderLeft: i > 0 ? '1px solid var(--color-ink-400)' : 'none',
            color: value === opt.id ? 'var(--color-ember-400)' : 'var(--color-paper-500)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            letterSpacing: '0.12em',
          }}
          type="button"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Direction A — Split Console ────────────────────────────────────────────────

function LayoutA({
  activityToNodeId,
  dagOverlay,
  failedStep,
  onJumpToFailure,
  onReRun,
  run,
  selectedNodeId,
  setSelectedNodeId,
  spec,
  traces,
  pendingSteps,
}: {
  activityToNodeId: Record<string, string>;
  dagOverlay: { byNodeId: Record<string, { status: string; attempt: number }> } | undefined;
  failedStep: WorkflowStepRecord | null;
  onJumpToFailure: () => void;
  onReRun: () => void;
  run: WorkflowRunDetail;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  spec: WorkflowSpec;
  traces: AgentTraceRecord[];
  pendingSteps: NonNullable<ReturnType<typeof useApprovals>['data']>;
}) {
  const [consoleMode, setConsoleMode] = useState<'split' | 'stream'>('split');
  const traceAnchorRef = useRef<HTMLDivElement>(null);

  const handleJumpToFailure = () => {
    onJumpToFailure();
    traceAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content: 1fr */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Execution graph panel */}
        <div
          className="border-b border-ink-600/40 flex flex-col"
          style={{ height: '46%', maxHeight: '380px', minHeight: '200px' }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-600/30">
            <div className="flex items-center gap-3">
              <span className="kicker">Execution graph</span>
              <span
                className="text-paper-600"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
              >
                {Object.keys(spec.nodes ?? {}).length} nodes · pan + zoom
              </span>
            </div>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex-1 min-h-0">
            <WorkflowDag
              height="100%"
              onSelect={setSelectedNodeId}
              selectedNodeId={selectedNodeId}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
        </div>

        {/* Console panel */}
        <div className="flex-1 flex flex-col overflow-hidden" ref={traceAnchorRef}>
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-ink-600/30 shrink-0">
            <div className="flex items-center gap-3">
              <h3
                className="text-paper-100"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '15px',
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                }}
              >
                Console
              </h3>
              {selectedNodeId && (
                <span
                  className="text-ember-400"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
                >
                  · {selectedNodeId}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {pendingSteps.length > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/30 text-amber-400"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    letterSpacing: '0.06em',
                  }}
                >
                  <span
                    aria-hidden
                    className="pulse-dot w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                  />
                  {pendingSteps.length} pending
                </span>
              )}
              <ConsoleModeToggle onChange={setConsoleMode} value={consoleMode} />
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {pendingSteps.length > 0 && (
              <div className="px-4 py-3 border-b border-amber-400/20 bg-amber-400/5 space-y-3">
                {pendingSteps.map((step) => (
                  <HumanStepCard key={step.id} showRunLink={false} step={step} />
                ))}
              </div>
            )}
            {consoleMode === 'split' ? (
              <SplitRunPanel
                activityToNodeId={activityToNodeId}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            ) : (
              <div className="h-full overflow-y-auto">
                <TracesTab
                  activityToNodeId={activityToNodeId}
                  filterNodeId={selectedNodeId}
                  onClearFilter={() => setSelectedNodeId(null)}
                  traces={traces}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right meta rail */}
      <RunMetaRail
        failedStep={failedStep}
        onJumpToFailure={handleJumpToFailure}
        onReRun={onReRun}
        run={run}
      />
    </div>
  );
}

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
        const statusColor =
          s.status === 'PASSED'
            ? 'var(--color-moss-400)'
            : s.status === 'FAILED'
              ? 'var(--color-brick-400)'
              : s.status === 'RUNNING'
                ? 'var(--color-dust-400)'
                : s.status === 'SKIPPED'
                  ? 'var(--color-ink-400)'
                  : 'var(--color-paper-600)';

        return (
          <button
            className="relative flex items-start gap-3 px-4 py-3 text-left w-full transition-colors hover:bg-ink-600/20"
            key={s.id}
            onClick={() => onSelect(s.nodeId)}
            style={{
              background: isSelected ? 'var(--color-ink-600)' : undefined,
              borderLeft: isSelected ? '2px solid var(--color-ember-400)' : '2px solid transparent',
            }}
            type="button"
          >
            {/* Connected dot */}
            <div className="flex flex-col items-center shrink-0 mt-0.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor }} />
              {i < steps.length - 1 && (
                <span
                  className="w-px flex-1 mt-1"
                  style={{ background: 'var(--color-ink-500)', minHeight: '20px' }}
                />
              )}
            </div>
            <div className="min-w-0">
              <div
                className={isSelected ? 'text-ember-300' : 'text-paper-400'}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 500 }}
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

function LayoutB({
  activityToNodeId,
  failedStep,
  onJumpToFailure,
  onReRun,
  run,
  traces,
}: {
  activityToNodeId: Record<string, string>;
  failedStep: WorkflowStepRecord | null;
  onJumpToFailure: () => void;
  onReRun: () => void;
  run: WorkflowRunDetail;
  traces: AgentTraceRecord[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const handleSpineSelect = (id: string) => {
    setSelectedId(id);
    stepRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Step spine: 212px */}
      <aside
        className="shrink-0 overflow-y-auto border-r border-ink-600/40"
        style={{ background: 'var(--color-ink-900)', width: '212px' }}
      >
        <div className="px-4 py-3 kicker border-b border-ink-600/30">Steps</div>
        <StepSpine onSelect={handleSpineSelect} selectedId={selectedId} steps={run.steps} />
      </aside>

      {/* Reading column: 1fr */}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        {/* Editorial intro */}
        <div className="mb-10 max-w-2xl">
          <div className="kicker mb-2">Run narrative</div>
          <h2
            className="text-paper-100 mb-3"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '24px',
              fontWeight: 500,
              letterSpacing: '-0.015em',
            }}
          >
            {run.templateName}
          </h2>
          <p className="text-paper-400 text-sm leading-relaxed">
            {run.workRequest?.description ??
              `${run.steps.length} step${run.steps.length !== 1 ? 's' : ''} · ${run.status.toLowerCase()} · v${run.templateVersion}`}
          </p>
        </div>

        {/* Steps as narrative sections */}
        {run.steps.map((step: WorkflowStepRecord, i: number) => {
          const stepTraces = traces.filter((t) => activityToNodeId[t.nodeId] === step.nodeId);
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
              <div
                className="sticky top-0 flex items-center gap-3 py-3 mb-3 border-b border-ink-600/30 z-10"
                style={{ background: 'var(--color-ink-800)' }}
              >
                <span
                  className="text-paper-600 tabular"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3
                  className="text-paper-100"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '18px',
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                  }}
                >
                  {step.nodeId}
                </h3>
                <StatusBadge status={step.status} />
                {step.startedAt && step.endedAt && (
                  <span
                    className="text-paper-600 ml-auto"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                  >
                    {formatDuration(
                      new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime()
                    )}
                  </span>
                )}
                <span
                  className="text-paper-600"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                >
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

              {/* Failure card inline */}
              {isFailedStep && (
                <div className="mb-4">
                  <FailureCard
                    onJumpToFailure={onJumpToFailure}
                    onReRun={onReRun}
                    size="inline"
                    step={step}
                  />
                </div>
              )}

              {/* Trace events panel */}
              {stepTraces.length > 0 && (
                <div
                  className="border border-ink-600/40"
                  style={{ background: 'var(--color-ink-700)', borderRadius: '4px' }}
                >
                  <TracesTab
                    activityToNodeId={activityToNodeId}
                    compact
                    filterNodeId={step.nodeId}
                    onClearFilter={() => {}}
                    traces={traces}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right meta rail */}
      <RunMetaRail
        failedStep={failedStep}
        onJumpToFailure={onJumpToFailure}
        onReRun={onReRun}
        run={run}
      />
    </div>
  );
}

/** Wall-clock seconds a 1× replay takes to scrub the whole run. */
const PLAY_DURATION_S = 11;

// ── Direction C — Flight Recorder ──────────────────────────────────────────────

function WaterfallBar({
  currentMs,
  runStartMs,
  step,
  totalMs,
}: {
  currentMs: number;
  runStartMs: number;
  step: WorkflowStepRecord;
  totalMs: number;
}) {
  if (!step.startedAt || totalMs === 0) {
    return null;
  }

  const startMs = new Date(step.startedAt).getTime();
  const endMs = step.endedAt ? new Date(step.endedAt).getTime() : startMs + totalMs * 0.1;
  const stepDurationMs = endMs - startMs;

  // Offset from the run's start — without it every bar drew flush left and the
  // panel showed durations stacked on top of each other rather than a timeline.
  const leftPct = Math.min(Math.max(((startMs - runStartMs) / totalMs) * 100, 0), 100);
  const widthPct = Math.max(2, (stepDurationMs / totalMs) * 100);
  const isFailed = step.status === 'FAILED';
  const isSkipped = step.status === 'SKIPPED';

  return (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className="text-paper-500 truncate shrink-0"
        style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', width: '120px' }}
      >
        {step.nodeId}
      </span>
      <div
        className="flex-1 relative h-4"
        style={{ background: 'var(--color-ink-600)', borderRadius: '4px' }}
      >
        <div
          className={cn(isFailed ? 'hatch-fail' : isSkipped ? 'opacity-30' : '')}
          style={{
            background: isFailed
              ? undefined
              : isSkipped
                ? 'var(--color-paper-600)'
                : 'var(--color-dust-400)',
            borderRadius: '4px',
            height: '100%',
            left: `${leftPct}%`,
            position: 'absolute',
            width: `${Math.min(widthPct, 100 - leftPct)}%`,
          }}
        />
        {/* Playhead indicator */}
        {currentMs > 0 && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-ember-400"
            style={{ left: `${Math.min((currentMs / totalMs) * 100, 100)}%` }}
          />
        )}
      </div>
      <span
        className="text-paper-600 num shrink-0"
        style={{ fontSize: '10px', textAlign: 'right', width: '40px' }}
      >
        {formatDuration(stepDurationMs)}
      </span>
    </div>
  );
}

function LayoutC({
  activityToNodeId,
  dagOverlay,
  failedStep,
  onJumpToFailure,
  onReRun,
  run,
  spec,
  traces,
}: {
  activityToNodeId: Record<string, string>;
  dagOverlay: { byNodeId: Record<string, { status: string; attempt: number }> } | undefined;
  failedStep: WorkflowStepRecord | null;
  onJumpToFailure: () => void;
  onReRun: () => void;
  run: WorkflowRunDetail;
  spec: WorkflowSpec;
  traces: AgentTraceRecord[];
}) {
  const totalMs = useMemo(() => {
    if (!run.startedAt || !run.endedAt) {
      return 0;
    }
    return new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  }, [run.startedAt, run.endedAt]);

  /** Epoch ms of the run's start — the origin every waterfall bar offsets from. */
  const runStartMs = useMemo(
    () => (run.startedAt ? new Date(run.startedAt).getTime() : 0),
    [run.startedAt]
  );

  const [playhead, setPlayhead] = useState(0); // 0–1
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 4 | 16>(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const currentMs = playhead * totalMs;

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setPlayhead((p) => {
          const next = p + (speed / PLAY_DURATION_S) * 0.1;
          if (next >= 1) {
            setPlaying(false);
            return 1;
          }
          return next;
        });
      }, 100);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [playing, speed]);

  const currentStepName = useMemo(() => {
    if (!run.startedAt || totalMs === 0) {
      return null;
    }
    const runStart = new Date(run.startedAt).getTime();
    const absMs = runStart + currentMs;
    return (
      run.steps.find((s: WorkflowStepRecord) => {
        if (!s.startedAt) {
          return false;
        }
        const start = new Date(s.startedAt).getTime();
        const end = s.endedAt ? new Date(s.endedAt).getTime() : start + totalMs;
        return absMs >= start && absMs <= end;
      })?.nodeId ?? null
    );
  }, [currentMs, run.steps, run.startedAt, totalMs]);

  const visibleTraces = useMemo(() => {
    if (!run.startedAt || totalMs === 0) {
      return traces;
    }
    const runStart = new Date(run.startedAt).getTime();
    const cutoff = runStart + currentMs;
    return traces.filter((t) => new Date(t.createdAt).getTime() <= cutoff);
  }, [traces, currentMs, run.startedAt, totalMs]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Scrubber panel */}
      <div
        className="border-b border-ink-600/40 px-6 py-4 shrink-0"
        style={{ background: 'var(--color-ink-900)' }}
      >
        <div className="flex items-center gap-5 mb-3">
          {/* Play/Pause */}
          <button
            className="flex items-center justify-center w-9 h-9 rounded-full border-2 transition-colors"
            onClick={() => {
              if (playhead >= 1) {
                setPlayhead(0);
              }
              setPlaying((p) => !p);
            }}
            style={{
              background: 'var(--color-ember-400)',
              borderColor: 'var(--color-ember-400)',
              color: 'var(--color-ink-950)',
            }}
            type="button"
          >
            {playing ? '⏸' : '▶'}
          </button>

          <div className="flex flex-col">
            <span className="kicker">replay</span>
            <div className="flex items-baseline gap-2">
              <span
                className="text-paper-100 num"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '20px' }}
              >
                {formatClock(currentMs)}
              </span>
              <span
                className="text-paper-600"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              >
                / {formatClock(totalMs)}
              </span>
              {currentStepName && (
                <span
                  className="text-ember-400"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
                >
                  · {currentStepName}
                </span>
              )}
            </div>
          </div>

          {/* Speed control */}
          <div
            className="flex items-center border border-ink-400 ml-auto"
            style={{ borderRadius: '8px' }}
          >
            {([1, 4, 16] as const).map((s, i) => (
              <button
                className="px-2.5 py-1 transition-colors"
                key={s}
                onClick={() => setSpeed(s)}
                style={{
                  background: speed === s ? 'rgba(124, 108, 255, 0.14)' : 'transparent',
                  borderLeft: i > 0 ? '1px solid var(--color-ink-400)' : 'none',
                  color: speed === s ? 'var(--color-ember-400)' : 'var(--color-paper-500)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10.5px',
                  letterSpacing: '0.1em',
                }}
                type="button"
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        {/* Timeline track */}
        <div className="relative">
          <input
            className="w-full appearance-none h-6 cursor-pointer"
            max={1000}
            min={0}
            onChange={(e) => {
              setPlaying(false);
              setPlayhead(Number(e.target.value) / 1000);
            }}
            style={{
              accentColor: 'var(--color-ember-400)',
              background: `linear-gradient(to right, var(--color-ember-400) ${playhead * 100}%, var(--color-ink-500) ${playhead * 100}%)`,
              borderRadius: '3px',
              height: '6px',
              outline: 'none',
            }}
            type="range"
            value={Math.round(playhead * 1000)}
          />
          {/* Step bands underneath */}
          {totalMs > 0 && run.startedAt && (
            <div
              className="absolute top-0 left-0 right-0 h-1.5 flex pointer-events-none"
              style={{ marginTop: '0px' }}
            >
              {run.steps.map((s: WorkflowStepRecord) => {
                if (!s.startedAt) {
                  return null;
                }
                const runStart = new Date(run.startedAt ?? '').getTime();
                const stepStart = new Date(s.startedAt).getTime() - runStart;
                const stepEnd = s.endedAt
                  ? new Date(s.endedAt).getTime() - runStart
                  : stepStart + totalMs * 0.05;
                const leftPct = (stepStart / totalMs) * 100;
                const widthPct = Math.max(1, ((stepEnd - stepStart) / totalMs) * 100);
                const isFailed = s.status === 'FAILED';

                return (
                  <div
                    key={s.id}
                    style={{
                      background: isFailed ? 'var(--color-brick-400)' : 'var(--color-dust-400)',
                      height: '3px',
                      left: `${leftPct}%`,
                      opacity: playhead * 100 >= leftPct ? 1 : 0.3,
                      position: 'absolute',
                      top: '1.5px',
                      width: `${widthPct}%`,
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Waterfall + Event feed */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-ink-600/40">
          {/* Waterfall */}
          {totalMs > 0 && (
            <div className="px-5 py-3 border-b border-ink-600/30 shrink-0">
              <div className="kicker mb-2">Step timing</div>
              {run.steps.map((s: WorkflowStepRecord) => (
                <WaterfallBar
                  currentMs={currentMs}
                  key={s.id}
                  runStartMs={runStartMs}
                  step={s}
                  totalMs={totalMs}
                />
              ))}
            </div>
          )}

          {/* Live event feed */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-ink-600/30 shrink-0">
              <span className="kicker">Event feed</span>
              {playing && (
                <span className="recording-pulse inline-block w-1.5 h-1.5 rounded-full bg-moss-400" />
              )}
              <span
                className="text-paper-600 ml-auto"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
              >
                {visibleTraces.length} / {traces.length} events
              </span>
            </div>
            <div className="flex-1 overflow-y-auto" ref={feedRef}>
              <TracesTab
                activityToNodeId={activityToNodeId}
                filterNodeId={null}
                onClearFilter={() => {}}
                traces={visibleTraces}
              />
            </div>
          </div>
        </div>

        {/* Right: Mini topology + failure card */}
        <div className="flex flex-col overflow-y-auto shrink-0" style={{ width: '280px' }}>
          <div className="shrink-0" style={{ height: '240px' }}>
            <WorkflowDag
              height="100%"
              onSelect={() => {}}
              selectedNodeId={currentStepName}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
          {failedStep && (
            <div className="px-4 py-4">
              <FailureCard
                onJumpToFailure={onJumpToFailure}
                onReRun={onReRun}
                size="inline"
                step={failedStep}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data: run, isError, isLoading, error } = useWorkflowRun(id ?? '');
  const cancelRun = useCancelWorkflowRun(id ?? '');
  const retryRun = useRetryWorkRequest();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { layout, setLayout } = useUserPreferences();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { data: approvalSteps } = useApprovals();

  const pendingSteps = useMemo(
    () => (approvalSteps ?? []).filter((s) => s.runId === id),
    [approvalSteps, id]
  );

  const dagOverlay = useMemo(() => {
    if (!run?.steps) {
      return undefined;
    }
    const byNodeId: Record<string, { status: string; attempt: number }> = {};
    for (const s of run.steps) {
      const baseId = s.nodeId.includes('/') ? (s.nodeId.split('/').pop() ?? s.nodeId) : s.nodeId;
      const existing = byNodeId[baseId];
      if (!existing || s.attempt >= existing.attempt) {
        byNodeId[baseId] = { attempt: s.attempt, status: s.status };
      }
    }
    return { byNodeId };
  }, [run?.steps]);

  const spec = useMemo<WorkflowSpec | null>(() => {
    if (!run?.specSnapshot) {
      return null;
    }
    try {
      return parseWorkflowSpec(run.specSnapshot);
    } catch {
      return null;
    }
  }, [run?.specSnapshot]);

  const activityToNodeId = useMemo<Record<string, string>>(() => {
    if (!spec?.nodes) {
      return {};
    }
    const map: Record<string, string> = {};
    for (const [nodeId, node] of Object.entries(spec.nodes)) {
      if (node.type === 'step' && node.step) {
        map[node.step] = nodeId;
      }
    }
    return map;
  }, [spec]);

  const securityEvents = useMemo<SecurityEvent[]>(
    () =>
      (run?.traces ?? []).flatMap((t: AgentTraceRecord) => {
        const eventType = classifyTraceAsSecurityEvent(t);
        if (!eventType) {
          return [];
        }
        return [
          {
            createdAt: t.createdAt,
            error: t.error,
            eventType,
            externalTicketId: run?.workRequest?.externalTicketId ?? null,
            id: t.id,
            inputJson: t.inputJson,
            nodeId: t.nodeId,
            outputJson: t.outputJson,
            runId: run?.id ?? '',
            startedAt: run?.startedAt ?? '',
            toolName: t.toolName,
            workflowId: run?.workflowId ?? '',
            workRequestId: run?.workRequest?.id ?? null,
          },
        ];
      }),
    [run?.traces, run?.id, run?.workflowId, run?.workRequest, run?.startedAt]
  );

  const traceAnchorRef = useRef<HTMLDivElement>(null);
  const handleJumpToFailure = useCallback(() => {
    traceAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);
  const handleReRun = useCallback(() => {
    if (run?.workRequest) {
      retryRun.mutate(run.workRequest.id);
    }
  }, [run?.workRequest, retryRun]);

  if (!id) {
    return (
      <div className="p-8">
        <Alert>Run not found</Alert>
      </div>
    );
  }

  if (isLoading) {
    return <LoadingState />;
  }
  // Missing/forbidden run or a run without a spec snapshot: render a real
  // error state instead of spinning forever.
  if (isError || !run || !spec) {
    return (
      <div className="p-8">
        <Alert>{errMsg(error, 'Run not found')}</Alert>
      </div>
    );
  }

  const traces = run.traces ?? [];
  const failedStep = getFailedStep(run.steps);

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-ink-800)' }}>
      {/* ── Page header band ──────────────────────────────────────────────── */}
      <div
        className="shrink-0 border-b border-ink-600/40 px-6 py-4 flex items-center gap-4"
        style={{ background: 'var(--color-ink-900)' }}
      >
        {/* Breadcrumb */}
        <div
          className="flex items-center gap-2 text-paper-600"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          <Link className="hover:text-paper-400 transition-colors" href="/runs">
            ← Runs
          </Link>
          <span>/</span>
          <span>run history</span>
        </div>

        <span className="h-4 w-px bg-ink-500" />

        {/* Title */}
        <h1
          className="text-paper-100 shrink-0"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '22px',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}
        >
          Run · {run.templateName}
        </h1>

        <StatusBadge status={run.status} />

        <span
          className="text-paper-600"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px' }}
        >
          v{run.templateVersion} · {formatRelativeTime(run.startedAt)}
        </span>

        {/* Right side: actions + layout switcher */}
        <div className="flex items-center gap-3 ml-auto">
          {securityEvents.length > 0 && (
            <span
              className="text-amber-400"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              {securityEvents.length} security event{securityEvents.length !== 1 ? 's' : ''}
            </span>
          )}
          {run.status === 'RUNNING' && (
            <Button
              disabled={cancelRun.isPending}
              onClick={() => setShowCancelConfirm(true)}
              size="sm"
              variant="danger"
            >
              {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
            </Button>
          )}
          {['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(run.status) && run.workRequest && (
            <Button
              disabled={retryRun.isPending}
              onClick={handleReRun}
              size="sm"
              variant="secondary"
            >
              {retryRun.isPending ? 'Re-running…' : 'Re-run'}
            </Button>
          )}
          {retryRun.isSuccess && (
            <span
              className="text-paper-500"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
            >
              New run started —{' '}
              <Link className="text-ember-400 hover:underline" href="/runs">
                view runs
              </Link>
            </span>
          )}
          {retryRun.isError && (
            <span
              className="text-brick-400"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
            >
              Re-run failed: {errMsg(retryRun.error, 'unknown error')}
            </span>
          )}
          <Link
            className="text-paper-500 hover:text-ember-400 transition-colors"
            href={`/workflows/library/${run.templateId}`}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            View template →
          </Link>
          <LayoutToggle onChange={setLayout} value={layout} />
        </div>
      </div>

      {/* ── Layout body ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden" ref={traceAnchorRef}>
        {layout === 'A' && (
          <LayoutA
            activityToNodeId={activityToNodeId}
            dagOverlay={dagOverlay}
            failedStep={failedStep}
            onJumpToFailure={handleJumpToFailure}
            onReRun={handleReRun}
            pendingSteps={pendingSteps}
            run={run}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            spec={spec}
            traces={traces}
          />
        )}
        {layout === 'B' && (
          <LayoutB
            activityToNodeId={activityToNodeId}
            failedStep={failedStep}
            onJumpToFailure={handleJumpToFailure}
            onReRun={handleReRun}
            run={run}
            traces={traces}
          />
        )}
        {layout === 'C' && (
          <LayoutC
            activityToNodeId={activityToNodeId}
            dagOverlay={dagOverlay}
            failedStep={failedStep}
            onJumpToFailure={handleJumpToFailure}
            onReRun={handleReRun}
            run={run}
            spec={spec}
            traces={traces}
          />
        )}
      </div>

      <ConfirmModal
        closeOnConfirm={false}
        confirmLabel="Cancel run"
        dangerous
        error={cancelRun.error ? errMsg(cancelRun.error) : undefined}
        message="Cancel this run? In-flight steps will be aborted."
        onClose={() => {
          cancelRun.reset();
          setShowCancelConfirm(false);
        }}
        onConfirm={() =>
          cancelRun.mutate(undefined, {
            onSuccess: () => setShowCancelConfirm(false),
          })
        }
        open={showCancelConfirm}
        title="Cancel run"
      />
    </div>
  );
}
