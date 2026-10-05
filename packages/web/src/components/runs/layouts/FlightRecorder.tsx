'use client';

import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TracesTab } from '@/components/runs/TracesTab';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
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
