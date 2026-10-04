'use client';

import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import {
  isTerminalWorkflowRunStatus,
  WORKFLOW_RUN_FAILURE_STATUSES,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutToggle } from '@/components/LayoutToggle';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { RunSummaryBand } from '@/components/runs/RunSummaryBand';
import { classifyTraceAsSecurityEvent } from '@/components/security/SecurityEventList';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { useApprovals } from '@/hooks/useApprovals';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useRunReRun } from '@/hooks/useRunReRun';
import { useCancelWorkflowRun, useRetriedRun, useRunDetail } from '@/hooks/useRuns';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { errMsg } from '@/lib/errors';
import { validateRouteParam } from '@/lib/routeParams';
import { findFailedStep } from '@/lib/runFailure';
import {
  buildTraceLinker,
  specNodeIdOfRecording,
  type TraceLinker,
  traceBelongsToStep,
} from '@/lib/traceLinkage';
import { cn, formatClock, formatDuration, formatRelativeTime } from '@/lib/utils';
import { SplitRunPanel } from './SplitRunPanel';
import { TracesTab } from './TracesTab';

interface PageProps {
  params: Promise<{ id: string }>;
}

// ── Console mode (◧ Split / ≡ Stream) ──────────────────────────────────────────

const CONSOLE_MODE_OPTIONS: SegmentedOption<'split' | 'stream'>[] = [
  { label: '◧ Split', value: 'split' },
  { label: '≡ Stream', value: 'stream' },
];

// ── Direction A — Split Console ────────────────────────────────────────────────

function LayoutA({
  linker,
  dagOverlay,
  run,
  selectedNodeId,
  setSelectedNodeId,
  spec,
  traces,
}: {
  linker: TraceLinker;
  dagOverlay: { byNodeId: Record<string, { status: string; attempt: number }> } | undefined;
  run: WorkflowRunDetail;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  spec: WorkflowSpec;
  traces: AgentTraceRecord[];
}) {
  const [consoleMode, setConsoleMode] = useState<'split' | 'stream'>('split');

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content: 1fr */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Execution graph panel */}
        <div className="flex h-[46%] max-h-[380px] min-h-[200px] flex-col border-b border-ink-600/40">
          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-600/30">
            <div className="flex items-center gap-3">
              <span className="kicker">Execution graph</span>
              <span className="font-mono text-[10px] text-paper-600">
                {Object.keys(spec.nodes ?? {}).length} nodes · pan + zoom
              </span>
            </div>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex-1 min-h-0">
            <WorkflowDag
              height="100%"
              onSelect={setSelectedNodeId}
              outline
              selectedNodeId={selectedNodeId ? specNodeIdOfRecording(selectedNodeId, linker) : null}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
        </div>

        {/* Console panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-ink-600/30 shrink-0">
            <div className="flex items-center gap-3">
              <h3 className="font-display text-[15px] font-medium tracking-[-0.01em] text-paper-100">
                Console
              </h3>
              {selectedNodeId && (
                <span className="font-mono text-[11px] text-ember-400">· {selectedNodeId}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <SegmentedControl
                ariaLabel="Console mode"
                onChange={setConsoleMode}
                options={CONSOLE_MODE_OPTIONS}
                value={consoleMode}
              />
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {consoleMode === 'split' ? (
              <SplitRunPanel
                linker={linker}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            ) : (
              <div className="h-full overflow-y-auto">
                <TracesTab
                  filterNodeId={selectedNodeId}
                  linker={linker}
                  onClearFilter={() => setSelectedNodeId(null)}
                  traces={traces}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right meta rail */}
      <RunMetaRail run={run} />
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

function LayoutB({
  linker,
  run,
  traces,
}: {
  linker: TraceLinker;
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

/** Wall-clock seconds a 1× replay takes to scrub the whole run. */
const PLAY_DURATION_S = 11;

type SpeedValue = '1' | '4' | '16';
const SPEED_OPTIONS: SegmentedOption<SpeedValue>[] = [
  { label: '1×', value: '1' },
  { label: '4×', value: '4' },
  { label: '16×', value: '16' },
];

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
      <span className="w-[120px] shrink-0 truncate font-mono text-[10px] text-paper-500">
        {step.nodeId}
      </span>
      <div className="relative h-4 flex-1 rounded bg-ink-600">
        <div
          className={cn(
            'absolute h-full rounded',
            isFailed ? 'hatch-fail' : isSkipped ? 'bg-paper-600 opacity-30' : 'bg-dust-400'
          )}
          style={{ left: `${leftPct}%`, width: `${Math.min(widthPct, 100 - leftPct)}%` }}
        />
        {/* Playhead indicator */}
        {currentMs > 0 && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-ember-400"
            style={{ left: `${Math.min((currentMs / totalMs) * 100, 100)}%` }}
          />
        )}
      </div>
      <span className="num w-10 shrink-0 text-right text-[10px] text-paper-600">
        {formatDuration(stepDurationMs)}
      </span>
    </div>
  );
}

function LayoutC({
  linker,
  dagOverlay,
  run,
  spec,
  traces,
}: {
  linker: TraceLinker;
  dagOverlay: { byNodeId: Record<string, { status: string; attempt: number }> } | undefined;
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
      <div className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-6 py-4">
        <div className="flex items-center gap-5 mb-3">
          {/* Play/Pause */}
          <button
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ember-400 bg-ember-400 text-ink-950 transition-colors"
            onClick={() => {
              if (playhead >= 1) {
                setPlayhead(0);
              }
              setPlaying((p) => !p);
            }}
            type="button"
          >
            {playing ? '⏸' : '▶'}
          </button>

          <div className="flex flex-col">
            <span className="kicker">replay</span>
            <div className="flex items-baseline gap-2">
              <span className="num font-mono text-xl text-paper-100">{formatClock(currentMs)}</span>
              <span className="font-mono text-xs text-paper-600">/ {formatClock(totalMs)}</span>
              {currentStepName && (
                <span className="font-mono text-[11px] text-ember-400">· {currentStepName}</span>
              )}
            </div>
          </div>

          {/* Speed control */}
          <SegmentedControl
            ariaLabel="Replay speed"
            className="ml-auto"
            onChange={(v) => setSpeed(Number(v) as 1 | 4 | 16)}
            options={SPEED_OPTIONS}
            value={String(speed) as SpeedValue}
          />
        </div>

        {/* Timeline track */}
        <div className="relative">
          <input
            aria-label="Replay position"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-[3px] accent-ember-400 outline-none"
            max={1000}
            min={0}
            onChange={(e) => {
              setPlaying(false);
              setPlayhead(Number(e.target.value) / 1000);
            }}
            style={{
              background: `linear-gradient(to right, var(--color-ember-400) ${playhead * 100}%, var(--color-ink-500) ${playhead * 100}%)`,
            }}
            type="range"
            value={Math.round(playhead * 1000)}
          />
          {/* Step bands underneath */}
          {totalMs > 0 && run.startedAt && (
            <div className="pointer-events-none absolute top-0 right-0 left-0 flex h-1.5">
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
                    className={cn(
                      'absolute top-[1.5px] h-[3px]',
                      isFailed ? 'bg-brick-400' : 'bg-dust-400'
                    )}
                    key={s.id}
                    style={{
                      left: `${leftPct}%`,
                      opacity: playhead * 100 >= leftPct ? 1 : 0.3,
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
              <span className="ml-auto font-mono text-[10px] text-paper-600">
                {visibleTraces.length} / {traces.length} events
              </span>
            </div>
            <div className="flex-1 overflow-y-auto" ref={feedRef}>
              <TracesTab
                filterNodeId={null}
                linker={linker}
                onClearFilter={() => {}}
                traces={visibleTraces}
              />
            </div>
          </div>
        </div>

        {/* Right: Mini topology + failure card */}
        <div className="flex w-[280px] shrink-0 flex-col overflow-y-auto">
          <div className="h-[240px] shrink-0">
            <WorkflowDag
              height="100%"
              onSelect={() => {}}
              selectedNodeId={
                currentStepName ? specNodeIdOfRecording(currentStepName, linker) : null
              }
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const {
    data: run,
    isError,
    isLoading,
    isPlaceholderData,
    error,
    fullTraces,
    fullTracesFailed,
    toggleFullTraces,
  } = useRunDetail(id ?? '');
  useDocumentTitle(run?.templateName ? `Run · ${run.templateName}` : null);
  const cancelRun = useCancelWorkflowRun(id ?? '');
  // An agent run is re-run through its own endpoint, after a confirmation when it
  // delivers; see `useRunReRun`.
  const retryRun = useRunReRun(run);
  const isAgentRun = retryRun.isAgentRun;
  const retried = useRetriedRun(
    retryRun.data?.workRequestId ?? null,
    retryRun.data?.temporalWorkflowId ?? null
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { layout, setLayout } = useUserPreferences();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { data: approvalSteps } = useApprovals();

  const pendingSteps = useMemo(
    () => (approvalSteps ?? []).filter((s) => s.runId === id),
    [approvalSteps, id]
  );

  const dagOverlay = useMemo(
    () => (run?.steps ? buildDagOverlay(run.steps) : undefined),
    [run?.steps]
  );

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

  const linker = useMemo(() => buildTraceLinker(spec), [spec]);

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
  const reRunLocked = retryRun.locked;
  const handleReRun = retryRun.request;

  const notFound = (
    <EmptyState action={<ButtonLink href="/runs">Back to runs</ButtonLink>} title="Run not found" />
  );

  if (!id) {
    return notFound;
  }

  if (isLoading) {
    return <LoadingState />;
  }
  // A failed load, a missing run, or a run without a spec snapshot: render a
  // real state instead of spinning forever.
  if (isError) {
    return <Alert>{errMsg(error, 'Could not load run')}</Alert>;
  }
  if (!run) {
    return notFound;
  }
  if (!spec) {
    return <Alert>This run has no readable workflow spec snapshot.</Alert>;
  }

  const traces = run.traces ?? [];
  const failedStep = findFailedStep(run.status, run.steps);
  const tracesTrimmed = traces.some((t) => t.trimmed);
  // Hidden from the failure card once a re-run is in flight or started; the
  // header shows its progress.
  const failureCardReRun = reRunLocked ? undefined : handleReRun;

  return (
    <div className="flex h-full flex-col bg-ink-800">
      {/* ── Page header band ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-4 border-b border-ink-600/40 bg-ink-900 px-6 py-4">
        {/* Breadcrumb */}
        <div className="label-mono flex items-center gap-2">
          <Link className="transition-colors hover:text-paper-200" href="/runs">
            ← Runs
          </Link>
          <span>/</span>
          <span>run history</span>
        </div>

        <span className="h-4 w-px bg-ink-500" />

        {/* Title */}
        <h1 className="shrink-0 font-display text-[22px] font-medium tracking-[-0.01em] text-paper-100">
          Run · {run.templateName}
        </h1>

        <StatusBadge status={run.status} />

        <span className="font-mono text-[10.5px] text-paper-600">
          v{run.templateVersion} · {formatRelativeTime(run.startedAt)}
        </span>

        {/* Right side: actions + layout switcher */}
        <div className="flex items-center gap-3 ml-auto">
          {securityEvents.length > 0 && (
            <Badge tone="amber" uppercase>
              {securityEvents.length} security event{securityEvents.length !== 1 ? 's' : ''}
            </Badge>
          )}
          {(tracesTrimmed || fullTraces) && (
            <Button
              disabled={isPlaceholderData}
              onClick={toggleFullTraces}
              size="sm"
              title={
                fullTraces
                  ? 'Full payloads are fetched once and not refreshed; trim them to resume live updates'
                  : 'Trace payloads are trimmed to 4,000 characters per field while the page polls'
              }
              variant="secondary"
            >
              {isPlaceholderData ? 'Loading…' : fullTraces ? 'Trim payloads' : 'Load full payloads'}
            </Button>
          )}
          {fullTracesFailed && (
            <Badge tone="brick" variant="text">
              Full payloads failed to load
            </Badge>
          )}
          {!isTerminalWorkflowRunStatus(run.status) && (
            <Button
              disabled={cancelRun.isPending}
              onClick={() => setShowCancelConfirm(true)}
              size="sm"
              variant="danger"
            >
              {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
            </Button>
          )}
          {(WORKFLOW_RUN_FAILURE_STATUSES.has(run.status as WorkflowRunStatus) ||
            (isAgentRun && isTerminalWorkflowRunStatus(run.status))) &&
            run.workRequest && (
              <Button disabled={reRunLocked} onClick={handleReRun} size="sm" variant="secondary">
                {retryRun.isPending ? 'Re-running…' : 'Re-run'}
              </Button>
            )}
          {retryRun.isSuccess && (
            <Alert className="px-2 py-1 text-xs" variant="success">
              New run started —{' '}
              {retried.runId ? (
                <Link className="underline hover:text-moss-600" href={`/runs/${retried.runId}`}>
                  view run
                </Link>
              ) : retried.timedOut ? (
                <Link className="underline hover:text-moss-600" href="/runs">
                  view runs
                </Link>
              ) : (
                'locating it…'
              )}
            </Alert>
          )}
          {retryRun.errorView && (
            <Alert className="px-2 py-1 text-xs">
              Re-run failed: {retryRun.errorView.title}. {retryRun.errorView.message}
              {retryRun.errorView.hint ? ` ${retryRun.errorView.hint}` : ''}
            </Alert>
          )}
          {/* The Agent Run template is hidden: its detail route answers 404 for everyone. */}
          {!isAgentRun && (
            <Link
              className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-paper-500 transition-colors hover:text-ember-400"
              href={`/workflows/library/${run.templateId}`}
            >
              View template →
            </Link>
          )}
          <LayoutToggle onChange={setLayout} value={layout} />
        </div>
      </div>

      {/* ── Pending approvals + result or failure, whichever layout is chosen ── */}
      <RunSummaryBand
        failedStep={failedStep}
        onJumpToFailure={handleJumpToFailure}
        onReRun={failureCardReRun}
        pendingSteps={pendingSteps}
        run={run}
      />

      {/* ── Layout body ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden" ref={traceAnchorRef}>
        {layout === 'A' && (
          <LayoutA
            dagOverlay={dagOverlay}
            linker={linker}
            run={run}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            spec={spec}
            traces={traces}
          />
        )}
        {layout === 'B' && <LayoutB linker={linker} run={run} traces={traces} />}
        {layout === 'C' && (
          <LayoutC dagOverlay={dagOverlay} linker={linker} run={run} spec={spec} traces={traces} />
        )}
      </div>

      <ConfirmModal
        confirmLabel="Re-run"
        message={retryRun.confirmMessage ?? ''}
        onClose={retryRun.cancel}
        onConfirm={retryRun.confirm}
        open={retryRun.confirming}
        title="Re-run this agent run?"
      />

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
