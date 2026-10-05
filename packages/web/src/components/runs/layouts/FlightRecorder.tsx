'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TracesTab } from '@/components/runs/TracesTab';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { stepBand } from '@/lib/runTimeline';
import { specNodeIdOfRecording } from '@/lib/traceLinkage';
import { cn, formatClock, formatDuration } from '@/lib/utils';
import type { RunLayoutProps } from './types';

/** Wall-clock seconds a 1× replay takes to scrub the whole run. */
const PLAY_DURATION_S = 11;

type SpeedValue = '1' | '4' | '16';
const SPEED_OPTIONS: SegmentedOption<SpeedValue>[] = [
  { label: '1×', value: '1' },
  { label: '4×', value: '4' },
  { label: '16×', value: '16' },
];

/** A box that scrolls sideways has to be reachable by keyboard, and named, to be usable without a pointer. */
const SCROLL_REGION = {
  'aria-label': 'Step timing, scrolls sideways',
  role: 'region',
  tabIndex: 0,
} as const;

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
      <span className="w-[120px] shrink-0 truncate font-mono text-[10px] text-paper-500 max-lg:sticky max-lg:left-0 max-lg:z-[1] max-lg:bg-ink-800 max-lg:shadow-[0.75rem_0_0_0_var(--color-ink-800)]">
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

export function FlightRecorder({
  jumpNonce,
  linker,
  dagOverlay,
  run,
  selectedNodeId,
  spec,
  traces,
}: RunLayoutProps) {
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

  // A step selected from outside (the failure card's "Jump to failure") moves the
  // playhead to the end of that step, so the feed shows what the step produced.
  // Only the selection (or a repeat jump) triggers it: the run is read through a ref so a poll
  // refreshing `run` does not snap the playhead back.
  const runRef = useRef({ run, totalMs });
  runRef.current = { run, totalMs };
  // biome-ignore lint/correctness/useExhaustiveDependencies: jumpNonce is a re-fire trigger, not a value the effect reads
  useEffect(() => {
    const { run: current, totalMs: total } = runRef.current;
    if (!selectedNodeId || !current.startedAt || total === 0) {
      return;
    }
    const step = current.steps.find((candidate) => candidate.nodeId === selectedNodeId);
    const at = step?.endedAt ?? step?.startedAt;
    if (!at) {
      return;
    }
    const fraction = (new Date(at).getTime() - new Date(current.startedAt).getTime()) / total;
    setPlaying(false);
    setPlayhead(Math.min(Math.max(fraction, 0), 1));
  }, [selectedNodeId, jumpNonce]);

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

  // Below the breakpoint the page scrolls as one column: scrubber, step timing, the topology
  // and then the event feed. At desktop width the timing and feed share the left column and
  // the topology sits to their right.
  const narrow = useIsNarrow();

  const waterfall = totalMs > 0 && (
    <div className="px-4 py-3 border-b border-ink-600/30 shrink-0 max-lg:order-1 lg:px-5">
      <div className="kicker mb-2">Step timing</div>
      {/* Narrow: the bars keep a readable width and scroll sideways inside this box, the
          step name staying pinned at the left edge. */}
      <div className="overflow-x-auto lg:overflow-visible" {...(narrow ? SCROLL_REGION : {})}>
        <div className="min-w-[520px] lg:min-w-0">
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
      </div>
    </div>
  );

  const eventFeed = (
    <div className="flex flex-1 flex-col max-lg:order-3 lg:overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-ink-600/30 shrink-0 lg:px-5">
        <span className="kicker">Event feed</span>
        {playing && (
          <span className="recording-pulse inline-block w-1.5 h-1.5 rounded-full bg-moss-400" />
        )}
        <span className="ml-auto font-mono text-[10px] text-paper-600">
          {visibleTraces.length} / {traces.length} events
        </span>
      </div>
      <div className="flex-1 max-lg:min-w-0 lg:overflow-y-auto" ref={feedRef}>
        <TracesTab
          filterNodeId={null}
          linker={linker}
          onClearFilter={() => {}}
          traces={visibleTraces}
        />
      </div>
    </div>
  );

  const topology = (
    <div className="h-[min(240px,50dvh)] shrink-0 border-b border-ink-600/40 max-lg:order-2 lg:h-[240px] lg:border-b-0">
      <WorkflowDag
        height="100%"
        narrowScrollSafe
        onSelect={() => {}}
        selectedNodeId={currentStepName ? specNodeIdOfRecording(currentStepName, linker) : null}
        spec={spec}
        statuses={dagOverlay}
      />
    </div>
  );

  return (
    <div className="flex flex-1 flex-col max-lg:min-w-0 lg:overflow-hidden">
      {/* Scrubber panel */}
      <div className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 py-4 lg:px-6">
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          {/* Play/Pause */}
          <button
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            className="flex h-[44px] w-[44px] items-center justify-center rounded-full lg:h-9 lg:w-9 border-2 border-ember-400 bg-ember-400 text-ink-950 transition-colors"
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
            optionClassName="min-h-[40px] lg:min-h-0"
            options={SPEED_OPTIONS}
            value={String(speed) as SpeedValue}
          />
        </div>

        {/* Timeline track */}
        <div className="relative">
          <input
            aria-label="Replay position"
            className="block h-[40px] w-full cursor-pointer appearance-none rounded-xs accent-ember-400 outline-none max-lg:bg-[length:100%_0.375rem] max-lg:bg-center max-lg:bg-no-repeat lg:inline-block lg:h-1.5"
            max={1000}
            min={0}
            onChange={(e) => {
              setPlaying(false);
              setPlayhead(Number(e.target.value) / 1000);
            }}
            style={{
              backgroundImage: `linear-gradient(to right, var(--color-ember-400) ${playhead * 100}%, var(--color-ink-500) ${playhead * 100}%)`,
            }}
            type="range"
            value={Math.round(playhead * 1000)}
          />
          {/* Step bands underneath */}
          {totalMs > 0 && run.startedAt && (
            <div className="pointer-events-none absolute top-0 right-0 left-0 flex h-1.5 max-lg:top-1/2 max-lg:-translate-y-1/2">
              {run.steps.map((s: WorkflowStepRecord) => {
                if (!s.startedAt) {
                  return null;
                }
                const { leftPct, widthPct } = stepBand(
                  { endedAt: s.endedAt, startedAt: s.startedAt },
                  runStartMs,
                  totalMs,
                  // Desktop keeps the geometry it always had (a late band overhangs the track
                  // and is clipped by the viewport); only a page that scrolls needs the clamp.
                  narrow
                );
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

      {/* Body. The wrappers are the same elements at every width (below lg the two columns are
          `display: contents` and the children are ordered with CSS), so crossing the breakpoint
          keeps the graph's pan and zoom, the expanded traces and the feed's scroll. */}
      <div className="flex flex-1 flex-col lg:flex-row lg:overflow-hidden">
        {/* Left: Waterfall + Event feed */}
        <div className="contents lg:flex lg:flex-1 lg:flex-col lg:overflow-hidden lg:border-r lg:border-ink-600/40">
          {waterfall}
          {/* Live event feed */}
          {eventFeed}
        </div>

        {/* Right: Mini topology */}
        <div className="contents lg:flex lg:w-[280px] lg:shrink-0 lg:flex-col lg:overflow-y-auto">
          {topology}
        </div>
      </div>
    </div>
  );
}
