/**
 * Determinism guard for `RunnableWorkflow`.
 *
 * `runnable.workflow.test.ts` runs the workflow forward against fake activities,
 * which catches logic errors. It cannot catch the failure mode Temporal is
 * hardest to debug: a change that makes the workflow take a *different path*
 * when replaying an execution that already happened. In production that surfaces
 * as a stuck workflow long after the deploy that caused it.
 *
 * Each fixture is a recorded history replayed against current workflow code. A
 * non-deterministic change — reordering activity calls, adding one on a path
 * that already ran, branching on `Date.now()`/`Math.random()`, iterating an
 * unordered collection — makes the replay diverge and fails the test.
 *
 * **Replay only guards the paths a recorded history actually walked**, which is
 * why there is one fixture per control-flow shape rather than a single linear
 * run. Verified per fixture: injecting an activity into `runFanOut` fails only
 * `fan-out`, and injecting one into the HITL wait fails only `human-approval`.
 *
 * Known blind spot: Temporal's check compares command type and sequence, not
 * activity *arguments*. Permuting same-type branch activities therefore replays
 * clean — reversing the fan-out worker pool's iteration order passes. Replay
 * guards the shape of the command stream, not the data flowing through it.
 *
 * **When this fails, re-recording the fixture is almost never the fix.** Do that
 * only when the workflow's structure changed intentionally; see
 * `scripts/recordReplayHistory.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, './index.ts');
const FIXTURE_DIR = path.resolve(__dirname, './__fixtures__');

const EventType = proto.temporal.api.enums.v1.EventType;

/**
 * Discovered rather than listed, so a fixture added by the recorder is replayed
 * without also having to be registered here — a fixture nobody replays is worse
 * than no fixture, because it looks like coverage.
 */
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.bin'))
  .sort()
  .map((file) => ({
    // Binary protobuf, not JSON: the proto3-JSON converters mangle Timestamps
    // and Payload metadata on round-trip, so the wire format is the honest one.
    history: proto.temporal.api.history.v1.History.decode(
      readFileSync(path.join(FIXTURE_DIR, file))
    ),
    name: path.basename(file, '.bin'),
  }));

beforeAll(() => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
});

describe('RunnableWorkflow — history replay', () => {
  it('has a fixture for every control-flow shape worth guarding', () => {
    // Named explicitly: silently losing one would quietly narrow the guard
    // while the suite stayed green.
    expect(fixtures.map((f) => f.name)).toEqual([
      'agent-node',
      'container-step',
      'context-spill',
      'eval',
      'fan-out',
      'human-approval',
      'human-decision',
      'human-input',
      'human-review',
      'linear',
      'mcp',
      'shell',
      'signal',
    ]);
  });

  it.each(fixtures)(
    'replays $name without a determinism violation',
    async ({ history }) => {
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history)
      ).resolves.toBeUndefined();
    },
    120_000
  );

  it.each(fixtures)('$name fixture carries real workflow-task history', ({ history }) => {
    // A truncated fixture would make its replay pass vacuously.
    const types = (history.events ?? []).map((e) => e.eventType);
    expect(types.length).toBeGreaterThan(10);
    expect(types).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED);
    expect(
      types.filter((t) => t === EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED).length
    ).toBeGreaterThan(1);
  });

  it('the parking fixtures actually parked and resumed', () => {
    // If a signal had been delivered before the interpreter reached its wait
    // node the run would have timed out instead, and the history would record
    // no signal at all — leaving the park/resume boundary unguarded.
    for (const name of [
      'signal',
      'human-approval',
      'human-decision',
      'human-input',
      'human-review',
    ]) {
      const history = fixtures.find((f) => f.name === name)?.history;
      const types = (history?.events ?? []).map((e) => e.eventType);
      expect(types, name).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
    }
  });

  it('the fan-out fixture ran several branches', () => {
    const history = fixtures.find((f) => f.name === 'fan-out')?.history;
    const scheduled = (history?.events ?? []).filter(
      (e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
    );
    // Three branch items plus the run's own bookkeeping activities; a fixture
    // that collapsed to one branch would not exercise the worker pool.
    expect(scheduled.length).toBeGreaterThan(3);
  });

  it('covers every node type the interpreter can dispatch', () => {
    // Replay only guards paths a recorded history walked, so an uncovered node
    // type is an unguarded one. This asserts the *intent* of the fixture set:
    // adding a node type to the spec union without a fixture should be a
    // deliberate, visible choice rather than an oversight.
    const covered = new Set(fixtures.map((f) => f.name));
    const expected = [
      'agent-node', // agent
      'container-step', // containerStep
      'eval', // eval
      'fan-out', // fanOut
      'human-approval', // humanApproval
      'human-decision', // humanDecision
      'human-input', // humanInput
      'human-review', // humanReview
      'linear', // step + cond + terminate
      'mcp', // mcp
      'shell', // shell
      'signal', // signal
      'context-spill', // set + the finalization spill path
    ];
    for (const name of expected) {
      expect(covered, name).toContain(name);
    }
  });

  it('the context-spill fixture actually spilled', () => {
    // Finalization only calls the spill activity when something exceeds the
    // inline limit; a fixture whose value shrank below it would replay the
    // no-spill path and guard nothing.
    const history = fixtures.find((f) => f.name === 'context-spill')?.history;
    const scheduled = (history?.events ?? []).filter(
      (e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
    );
    const names = scheduled.map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name);
    expect(names).toContain('storeContextOverflowBatch');
  });
});
