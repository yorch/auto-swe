'use client';

import { isTerminalWorkflowRunStatus } from '@auto-swe/shared/types/api';
import { Activity, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { nodeDisplayName, nodeGroupOf } from '@/components/workflow/nodeDisplay';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { phasesOf } from '@/components/workflow/workflowPhases';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { findFailedStep } from '@/lib/runFailure';
import { runTimeWindow, stepsAtTime } from '@/lib/runPlayback';
import { stepBand } from '@/lib/runTimeline';
import {
  recordingMatchesSelection,
  specNodeIdOfRecording,
  traceBelongsToStep,
} from '@/lib/traceLinkage';
import { cn, FOCUS_RING, formatClock, formatDate, formatDuration } from '@/lib/utils';
import type { TranscriptProps } from './layouts/Transcript';
import { TracesTab } from './TracesTab';

type View =
  | 'Events'
  | 'Graph'
  | 'Timing'
  | 'Transcript'
  | 'Overview'
  | 'Evidence'
  | 'Activity'
  | 'Details';
const VIEWS: View[] = [
  'Events',
  'Graph',
  'Timing',
  'Transcript',
  'Overview',
  'Evidence',
  'Activity',
  'Details',
];

export function RunWorkspace({
  run,
  spec,
  linker,
  traces,
  selectedNodeId,
  setSelectedNodeId,
  jumpNonce,
  overview,
  evidence,
  activity,
  details,
  needsDecision,
  monitoringPaused = false,
  overviewNonce = 0,
}: TranscriptProps & {
  overview: ReactNode;
  evidence: ReactNode;
  activity: ReactNode;
  details: ReactNode;
  needsDecision: boolean;
  monitoringPaused?: boolean;
  overviewNonce?: number;
}) {
  const [view, setView] = useState<View>(needsDecision ? 'Overview' : 'Events');
  const userViewed = useRef(false);
  useEffect(() => {
    if (needsDecision && !userViewed.current) {
      setView('Overview');
    }
  }, [needsDecision]);
  const [stepId, setStepId] = useState<string | null>(null);
  const [transcriptVisited, setTranscriptVisited] = useState(false);
  const [mobileSteps, setMobileSteps] = useState(false);
  const [replayMs, setReplayMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('4');
  const [now, setNow] = useState(() => Date.now());
  const pane = useRef<HTMLDivElement>(null);
  const executionChooser = useRef<HTMLElement>(null);
  const stepsTrigger = useRef<HTMLButtonElement>(null);
  const wasChoosingSteps = useRef(false);
  useEffect(() => {
    if (mobileSteps) {
      executionChooser.current?.focus({ preventScroll: true });
    } else if (wasChoosingSteps.current) {
      stepsTrigger.current?.focus({ preventScroll: true });
    }
    wasChoosingSteps.current = mobileSteps;
  }, [mobileSteps]);
  const initialized = useRef(false);
  const latestRun = useRef(run);
  latestRun.current = run;
  const time = runTimeWindow(run, now, !monitoringPaused);
  const snapshot = monitoringPaused && !isTerminalWorkflowRunStatus(run.status);
  const currentMs = Math.min(replayMs ?? time.duration, time.duration);
  const cutoff = replayMs === null ? null : time.start + currentMs;
  const steps = useMemo(
    () => (cutoff === null ? run.steps : stepsAtTime(run.steps, cutoff)),
    [run.steps, cutoff]
  );
  const visibleTraces = useMemo(
    () => (cutoff === null ? traces : traces.filter((t) => Date.parse(t.createdAt) <= cutoff)),
    [traces, cutoff]
  );
  const overlay = useMemo(() => buildDagOverlay(steps), [steps]);
  const matching = selectedNodeId
    ? steps.filter((s) => recordingMatchesSelection(s.nodeId, selectedNodeId, linker))
    : [];
  const selectedStep = matching.find((s) => s.id === stepId) ?? null;
  const selectedRows = new Set(selectedStep ? [selectedStep.id] : matching.map((step) => step.id));
  const selectedSpecId = selectedNodeId ? specNodeIdOfRecording(selectedNodeId, linker) : null;
  const selectedNode = selectedSpecId ? spec?.nodes[selectedSpecId] : null;
  const eventTraces = selectedStep
    ? visibleTraces.filter((t) => traceBelongsToStep(t, selectedStep, linker))
    : visibleTraces;
  const phases = useMemo(() => (spec ? phasesOf(spec) : []), [spec]);
  const activeSteps =
    cutoff === null
      ? []
      : steps.filter(
          (step) => step.startedAt && (!step.endedAt || Date.parse(step.endedAt) > cutoff)
        );

  useEffect(() => {
    if (!time.live) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [time.live]);
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(
      () =>
        setReplayMs((old) => {
          const next = Math.min(time.duration, (old ?? 0) + 100 * Number(speed));
          if (next >= time.duration) {
            setPlaying(false);
          }
          return next;
        }),
      100
    );
    return () => clearInterval(timer);
  }, [playing, speed, time.duration]);
  useEffect(() => {
    if (initialized.current || run.steps.length === 0) {
      return;
    }
    initialized.current = true;
    if (!isTerminalWorkflowRunStatus(run.status)) {
      return;
    }
    const initial =
      findFailedStep(run.status, run.steps) ??
      run.steps.find((s) => s.status === 'RUNNING' || s.status === 'PENDING') ??
      run.steps.at(-1);
    if (!selectedNodeId && initial) {
      setSelectedNodeId(initial.nodeId);
      setStepId(initial.id);
    }
  }, [run.status, run.steps, selectedNodeId, setSelectedNodeId]);
  // A repeated failure jump resets only the evidence pane, never the application shell.
  useEffect(() => {
    if (!jumpNonce) {
      return;
    }
    setView('Events');
    setReplayMs(null);
    setPlaying(false);
    setMobileSteps(false);
    const failed = findFailedStep(latestRun.current.status, latestRun.current.steps);
    setStepId(failed?.id ?? null);
    if (pane.current) {
      pane.current.scrollTop = 0;
    }
  }, [jumpNonce]);
  useEffect(() => {
    if (!overviewNonce) {
      return;
    }
    setView('Overview');
    setReplayMs(null);
    setPlaying(false);
    setMobileSteps(false);
    if (pane.current) {
      pane.current.scrollTop = 0;
    }
  }, [overviewNonce]);
  function select(id: string | null, execution: string | null = null) {
    setSelectedNodeId(id);
    setStepId(execution);
    setMobileSteps(false);
    if (pane.current) {
      pane.current.scrollTop = 0;
    }
  }
  const events = (
    <TracesTab
      filterNodeId={selectedNodeId}
      linker={linker}
      onClearFilter={() => select(null)}
      runStartedAt={run.startedAt}
      traces={eventTraces}
      windowed={run.tracesTruncated === true}
    />
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden [@media(max-height:500px)]:min-h-[480px] [@media(max-height:500px)]:shrink-0"
      data-tour="run:trace"
    >
      <aside
        aria-label="Execution steps"
        className={cn(
          'min-h-0 w-full shrink-0 overflow-y-auto border-r border-ink-600 bg-ink-900 lg:w-56',
          mobileSteps ? 'block' : 'hidden lg:block'
        )}
        id={`run-${run.id}-steps`}
        onKeyDown={(event) => {
          if (mobileSteps && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMobileSteps(false);
          }
        }}
        ref={executionChooser}
        tabIndex={-1}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-600 bg-ink-950 px-4 py-3">
          <h2 className="text-sm font-semibold text-paper-100">Execution</h2>
          <Button
            className="lg:hidden"
            onClick={() => setMobileSteps(false)}
            size="sm"
            variant="ghost"
          >
            Back to evidence
          </Button>
          <Button onClick={() => select(null)} size="sm" variant="ghost">
            All events
          </Button>
        </div>
        {steps.length === 0 && (
          <EmptyState
            hint={
              time.live
                ? 'The worker is preparing this run. Its current step appears when execution begins.'
                : 'No step transitions were recorded for this run.'
            }
            icon="workflows"
            title={time.live ? 'Preparing run' : 'No steps recorded yet'}
          />
        )}
        {steps.map((step) => (
          <button
            aria-pressed={selectedRows.has(step.id)}
            className={cn(
              'flex w-full flex-col items-start gap-1 border-b border-l-2 border-b-ink-600/40 px-4 py-3 text-left hover:bg-ink-700',
              FOCUS_RING,
              selectedRows.has(step.id) ? 'border-l-accent-400 bg-ink-700' : 'border-l-transparent'
            )}
            key={step.id}
            onClick={() => select(step.nodeId, step.id)}
            type="button"
          >
            <span className="break-words text-sm font-medium text-paper-200">
              {spec?.nodes[specNodeIdOfRecording(step.nodeId, linker)]
                ? nodeDisplayName(
                    spec.nodes[specNodeIdOfRecording(step.nodeId, linker)],
                    step.nodeId
                  )
                : step.nodeId}
            </span>
            <StatusBadge status={step.status} />
            <span className="break-all font-mono text-xs text-paper-500">
              {step.nodeId} · attempt {step.attempt}
            </span>
          </button>
        ))}
        {spec &&
          Object.entries(spec.nodes)
            .filter(([id]) => !steps.some((s) => specNodeIdOfRecording(s.nodeId, linker) === id))
            .map(([id, node]) => (
              <button
                className={cn(
                  'flex w-full flex-col border-b border-ink-600/40 px-4 text-left hover:bg-ink-700',
                  steps.length ? 'gap-1 py-3' : 'py-2',
                  FOCUS_RING
                )}
                key={id}
                onClick={() => select(id)}
                type="button"
              >
                <span className="text-sm text-paper-400">{nodeDisplayName(node, id)}</span>
                {steps.length > 0 && (
                  <span className="text-xs text-paper-500">No step recording</span>
                )}
              </button>
            ))}
      </aside>
      <section
        aria-label="Run evidence workspace"
        className={cn('flex min-h-0 min-w-0 flex-1 flex-col', mobileSteps && 'max-lg:hidden')}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-600 bg-ink-900 px-4 py-2">
          <Button
            aria-controls={`run-${run.id}-steps`}
            aria-expanded={mobileSteps}
            className="lg:hidden"
            onClick={(event) => {
              stepsTrigger.current = event.currentTarget;
              setMobileSteps(true);
            }}
            size="sm"
            variant="ghost"
          >
            <Icon name="list" size={13} />
            Steps
          </Button>
          <h2
            className="min-w-0 flex-1 truncate text-sm font-semibold text-paper-100"
            title={selectedNodeId ?? 'All executions'}
          >
            {selectedNode && selectedNodeId
              ? nodeDisplayName(selectedNode, selectedNodeId)
              : (selectedNodeId ?? 'All executions')}
          </h2>
          {selectedStep && <StatusBadge status={selectedStep.status} />}
          {matching.length > 0 && (
            <div className="w-full max-w-full lg:ml-auto lg:w-auto">
              <Select
                aria-label="Execution attempt"
                compact
                onChange={(value) => setStepId(value || null)}
                options={[
                  { label: 'All matching executions', value: '' },
                  ...matching.map((s) => ({
                    label: `${s.nodeId} · attempt ${s.attempt}`,
                    value: s.id,
                  })),
                ]}
                value={selectedStep?.id ?? ''}
              />
            </div>
          )}
        </div>
        <nav
          aria-label="Run investigation views"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink-600 px-3 py-2"
          data-tour="run:layout"
        >
          {VIEWS.filter((v) => v !== 'Graph' || spec).map((v) => (
            <Button
              aria-pressed={view === v}
              key={v}
              onClick={() => {
                userViewed.current = true;
                if (v === 'Transcript') {
                  setTranscriptVisited(true);
                }
                setView(v);
                if (pane.current) {
                  pane.current.scrollTop = 0;
                }
              }}
              size="sm"
              variant={view === v ? 'secondary' : 'ghost'}
            >
              {v === 'Overview' && needsDecision ? 'Approval / result' : v}
            </Button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" ref={pane}>
          {replayMs !== null && !['Events', 'Graph', 'Timing', 'Transcript'].includes(view) && (
            <p className="border-b border-ink-600 bg-ink-900 px-4 py-2 text-xs text-warning-400">
              This panel shows latest/final information, not historical playback.
            </p>
          )}
          {/* Activity replays effects and resets React Flow's viewport and group defaults. */}
          <div hidden={view !== 'Graph'}>
            {spec && (
              <div className="h-[clamp(280px,48dvh,480px)]">
                <WorkflowDag
                  height="100%"
                  narrowScrollSafe
                  onSelect={(id) => select(id)}
                  selectedNodeId={selectedSpecId}
                  spec={spec}
                  statuses={overlay}
                  toggleSelection={false}
                />
              </div>
            )}
          </div>
          <Activity mode={view === 'Events' || view === 'Graph' ? 'visible' : 'hidden'}>
            <div hidden={view !== 'Events'}>
              {selectedStep && (
                <div className="space-y-3 border-b border-ink-600 p-4">
                  <div className="font-mono text-xs text-paper-400">
                    {selectedStep.nodeId} · attempt {selectedStep.attempt}
                  </div>
                  <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-paper-400">
                    <div>
                      <dt>Started</dt>
                      <dd>
                        {selectedStep.startedAt ? (
                          <time dateTime={selectedStep.startedAt} title={selectedStep.startedAt}>
                            {formatDate(selectedStep.startedAt, { showSeconds: true })}
                          </time>
                        ) : (
                          'Not started'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Ended</dt>
                      <dd>
                        {selectedStep.endedAt ? (
                          <time dateTime={selectedStep.endedAt} title={selectedStep.endedAt}>
                            {formatDate(selectedStep.endedAt, { showSeconds: true })}
                          </time>
                        ) : (
                          'Not ended'
                        )}
                      </dd>
                    </div>
                  </dl>
                  {selectedStep.error && (
                    <pre className="whitespace-pre-wrap break-words text-xs text-danger-400">
                      {selectedStep.error}
                    </pre>
                  )}
                  <details>
                    <summary className={cn('cursor-pointer text-xs text-paper-400', FOCUS_RING)}>
                      Inputs and outputs
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-paper-300">
                      {JSON.stringify(
                        { inputs: selectedStep.inputs, outputs: selectedStep.outputs },
                        null,
                        2
                      )}
                    </pre>
                  </details>
                </div>
              )}
            </div>
            <div className={cn(view === 'Graph' && 'border-t border-ink-600')}>{events}</div>
          </Activity>
          {view === 'Timing' && (
            <div className="p-4">
              <h3 className="mb-2 text-sm font-semibold text-paper-100">Step timing</h3>
              <p className="mb-4 text-xs text-paper-500">
                {replayMs !== null
                  ? `As of ${formatClock(currentMs)}`
                  : time.live
                    ? 'Open bars extend to the current elapsed time.'
                    : snapshot
                      ? 'Recorded timing in this paused snapshot. Open steps may still be running.'
                      : 'Final recorded durations.'}
              </p>
              {steps.map((step) => {
                if (!step.startedAt) {
                  return (
                    <p className="py-2 font-mono text-xs text-paper-500" key={step.id}>
                      {step.nodeId} · not started at this point
                    </p>
                  );
                }
                const start = Math.max(0, Date.parse(step.startedAt) - time.start);
                const end = Math.min(
                  currentMs,
                  step.endedAt ? Date.parse(step.endedAt) - time.start : currentMs
                );
                const scale = Math.max(1, time.duration);
                const left = Math.min(100, (start / scale) * 100);
                return (
                  <div
                    className="grid grid-cols-[minmax(100px,180px)_minmax(40px,1fr)_56px] items-center gap-3 border-b border-ink-600/40 py-3"
                    key={step.id}
                  >
                    <Button
                      className="h-auto justify-start break-all whitespace-normal text-left"
                      onClick={() => select(step.nodeId, step.id)}
                      size="sm"
                      variant="ghost"
                    >
                      {step.nodeId} ×{step.attempt}
                    </Button>
                    <div className="relative h-3 rounded bg-ink-600">
                      <div
                        className={cn(
                          'absolute h-full rounded',
                          step.status === 'FAILED'
                            ? 'bg-danger-400'
                            : step.endedAt
                              ? 'bg-success-400'
                              : 'bg-info-400'
                        )}
                        style={{
                          left: `${left}%`,
                          width: `${Math.min(100 - left, Math.max(1, ((end - start) / scale) * 100))}%`,
                        }}
                      />
                    </div>
                    <span className="text-right text-xs text-paper-400">
                      {formatDuration(Math.max(0, end - start))}
                      {step.status === 'RUNNING' && ' · running'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {transcriptVisited && (
            <Activity mode={view === 'Transcript' ? 'visible' : 'hidden'}>
              <div className="space-y-5 p-4">
                {(selectedStep ? [selectedStep] : selectedNodeId ? matching : steps)
                  .filter((s) => s.startedAt || replayMs === null)
                  .map((step) => (
                    <section className="border-b border-ink-600 pb-4" key={step.id}>
                      <Button
                        onClick={() => select(step.nodeId, step.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {step.nodeId} · attempt {step.attempt}
                      </Button>
                      <div className="my-2">
                        <StatusBadge status={step.status} />
                      </div>
                      {step.error && <p className="mb-3 text-xs text-danger-400">{step.error}</p>}
                      <TracesTab
                        filterNodeId={step.nodeId}
                        linker={linker}
                        onClearFilter={() => select(null)}
                        runStartedAt={run.startedAt}
                        traces={visibleTraces.filter((t) => traceBelongsToStep(t, step, linker))}
                        windowed={run.tracesTruncated === true}
                      />
                    </section>
                  ))}
              </div>
            </Activity>
          )}
          {view === 'Overview' && overview}
          {view === 'Evidence' && evidence}
          {view === 'Activity' && activity}
          {view === 'Details' && details}
        </div>
        <footer className="shrink-0 space-y-2 border-t border-ink-600 bg-ink-900 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={time.live && replayMs === null ? 'text-info-400' : 'text-paper-300'}>
              {replayMs === null
                ? time.live
                  ? 'Live edge'
                  : snapshot
                    ? 'Paused snapshot'
                    : 'Final state'
                : 'Reviewing history'}
            </span>
            <span className="font-mono text-paper-400">
              {formatClock(currentMs)} / {formatClock(time.duration)}
            </span>
            <Button
              className="ml-auto"
              onClick={() => {
                setReplayMs(replayMs === null ? 0 : null);
                setPlaying(false);
              }}
              size="sm"
              variant="ghost"
            >
              {replayMs === null
                ? 'Review history'
                : time.live
                  ? 'Return to live'
                  : snapshot
                    ? 'Return to snapshot'
                    : 'Return to final state'}
            </Button>
          </div>
          {replayMs !== null && (
            <>
              <section
                aria-label="Replay context"
                className="max-h-10 overflow-y-auto break-words text-xs text-paper-400 sm:max-h-12"
              >
                {activeSteps.length === 0 ? (
                  <p>No step active at this point</p>
                ) : (
                  activeSteps.map((step) => {
                    const node = spec?.nodes[specNodeIdOfRecording(step.nodeId, linker)];
                    const phase = nodeGroupOf(node);
                    return (
                      <p key={step.id}>
                        {nodeDisplayName(node, specNodeIdOfRecording(step.nodeId, linker))} ·{' '}
                        {step.nodeId} · attempt {step.attempt}
                        {phase &&
                          ` · ${phase} · phase ${phases.indexOf(phase) + 1} of ${phases.length}`}
                      </p>
                    );
                  })
                )}
              </section>
              <div className="flex items-center gap-3">
                <Button
                  aria-label={playing ? 'Pause replay' : 'Play replay'}
                  onClick={() => {
                    if (currentMs >= time.duration) {
                      setReplayMs(0);
                    }
                    setPlaying((v) => !v);
                  }}
                  size="sm"
                  variant="secondary"
                >
                  <Icon name={playing ? 'pause' : 'play'} size={13} />
                </Button>
                <div className="min-w-0 flex-1">
                  <input
                    aria-label="Replay position"
                    className="block w-full accent-accent-400"
                    max={time.duration}
                    min={0}
                    onChange={(e) => {
                      setReplayMs(Number(e.target.value));
                      setPlaying(false);
                    }}
                    type="range"
                    value={currentMs}
                  />
                  <div
                    aria-label="Recorded step bands"
                    className="relative mt-1 h-1 overflow-hidden rounded bg-ink-600"
                    role="img"
                  >
                    {steps.map((step) => {
                      if (!step.startedAt) {
                        return null;
                      }
                      const { leftPct, widthPct } = stepBand(
                        {
                          endedAt: step.endedAt ?? new Date(time.start + currentMs).toISOString(),
                          startedAt: step.startedAt,
                        },
                        time.start,
                        Math.max(1, time.duration)
                      );
                      return (
                        <span
                          className={cn(
                            'absolute h-full',
                            step.status === 'FAILED' ? 'bg-danger-400' : 'bg-info-400'
                          )}
                          key={step.id}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          title={`${step.nodeId} · attempt ${step.attempt}`}
                        />
                      );
                    })}
                  </div>
                </div>
                <Select
                  aria-label="Replay speed"
                  compact
                  onChange={setSpeed}
                  options={['1', '4', '16'].map((v) => ({ label: `${v}×`, value: v }))}
                  value={speed}
                />
              </div>
              <p className="hidden text-xs text-paper-500 sm:block">
                Events and execution states follow the playhead. Outcome, approval actions, cost and
                supporting panels remain latest/final.
              </p>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
