import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { runTimeWindow, stepsAtTime } from './runPlayback';

const start = Date.parse('2026-11-01T12:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const step: WorkflowStepRecord = {
  attempt: 2,
  endedAt: at(30),
  error: 'test failed',
  id: 's1',
  inputs: { request: 'x' },
  nodeId: 'fan[0]/verify',
  outputs: { secretResult: 'later' },
  startedAt: at(10),
  status: 'FAILED',
};
const run = {
  endedAt: null,
  startedAt: at(0),
  status: 'RUNNING',
  steps: [step],
  traces: [],
} as unknown as WorkflowRunDetail;

describe('run playback', () => {
  it('uses elapsed time for running and waiting runs without endedAt', () => {
    expect(runTimeWindow(run, start + 60_000)).toMatchObject({
      duration: 60_000,
      live: true,
      start,
    });
    expect(runTimeWindow({ ...run, status: 'RUNNING' }, start + 90_000).duration).toBe(90_000);
  });
  it('keeps completed duration stable when wall time advances', () => {
    expect(runTimeWindow({ ...run, endedAt: at(40), status: 'FAILED' }, start + 900_000)).toEqual({
      duration: 40_000,
      live: false,
      start,
    });
  });
  it('uses only recorded bounds when full payloads pause the live snapshot', () => {
    expect(runTimeWindow(run, start + 900_000, false)).toMatchObject({
      duration: 30_000,
      live: false,
    });
  });
  it('falls back to recorded timestamps for incomplete legacy metadata', () => {
    expect(
      runTimeWindow({ ...run, startedAt: null, status: 'FAILED' }, start + 900_000)
    ).toMatchObject({ duration: 20_000, start: start + 10_000 });
  });
  it('does not leak inputs, failures, or outputs before a step begins', () => {
    expect(stepsAtTime([step], start + 5_000)[0]).toMatchObject({
      endedAt: null,
      error: null,
      inputs: null,
      outputs: null,
      startedAt: null,
      status: 'PENDING',
    });
  });
  it('shows an in-flight attempt without its future result', () => {
    expect(stepsAtTime([step], start + 20_000)[0]).toMatchObject({
      attempt: 2,
      endedAt: null,
      error: null,
      inputs: { request: 'x' },
      nodeId: 'fan[0]/verify',
      outputs: null,
      status: 'RUNNING',
    });
  });
  it('reveals the result only after its completion timestamp', () => {
    expect(stepsAtTime([step], start + 30_000)[0]).toEqual(step);
  });
  it('does not mutate the original recorded row', () => {
    stepsAtTime([step], start + 5_000);
    expect(step.status).toBe('FAILED');
    expect(step.outputs).toEqual({ secretResult: 'later' });
  });
});
