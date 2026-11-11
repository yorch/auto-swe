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
import { SIGNAL_REWAIT_PATCH } from '@auto-swe/shared/workflow/signalSlots';
import proto from '@temporalio/proto';
import {
  bundleWorkflowCode,
  DefaultLogger,
  Runtime,
  Worker,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, './index.ts');
const FIXTURE_DIR = path.resolve(__dirname, './__fixtures__');

const EventType = proto.temporal.api.enums.v1.EventType;

/**
 * Discovered rather than listed, so a fixture added by the recorder is replayed
 * without also having to be registered here — a fixture nobody replays is worse
 * than no fixture, because it looks like coverage. The directory also holds the
 * epic and channel workflows' fixtures; `orchestration.replay.test.ts` owns those.
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
  }))
  .filter(
    ({ history }) =>
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name ===
      'RunnableWorkflow'
  );

const eventsOf = (name: string) => fixtures.find((f) => f.name === name)?.history.events ?? [];

// Every replay used to run its own webpack bundle of the workflows (~1.2s each alone, 20+ fixtures,
// and webpack is CPU-bound, so ~800s and failures on a loaded machine). Bundle once; the bundle is
// the same code `workflowsPath` would have compiled, so the replay still runs the real workflows.
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  const logger = new DefaultLogger('WARN');
  Runtime.install({ logger });
  workflowBundle = await bundleWorkflowCode({ logger, workflowsPath: WORKFLOWS_PATH });
}, 600_000);

describe('RunnableWorkflow — history replay', () => {
  it('has a fixture for every control-flow shape worth guarding', () => {
    // Named explicitly: silently losing one would quietly narrow the guard
    // while the suite stayed green.
    expect(fixtures.map((f) => f.name)).toEqual([
      'agent-node',
      'agent-run',
      'cond-loop',
      'container-step',
      'context-spill',
      'eval',
      'fail-edge-terminal',
      'fail-edge',
      'fan-out-block-cancel',
      'fan-out-cancel',
      'fan-out-human-gate',
      'fan-out-shared-signal-timeout',
      'fan-out-shared-signal',
      'fan-out',
      'human-approval',
      'human-decision',
      'human-input',
      'human-review',
      'linear',
      'mcp',
      'needs-input-cancel',
      'needs-input-final',
      'needs-input-reask',
      'needs-input',
      'nested-fan-out',
      'on-error-continue',
      'on-fail-retry',
      'shell',
      'signal-timeout',
      'signal',
      'status-field',
      'store-as',
      'visit-limit',
    ]);
  });

  it.each(fixtures)(
    'replays $name without a determinism violation',
    async ({ history, name }) => {
      // Under the id the recorder started the run with, not the replayer's
      // default, so nothing that reads its own workflow id can diverge on it.
      await expect(
        Worker.runReplayHistory({ workflowBundle }, history, `replay-fixture-${name}`)
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
      'agent-run', // the Agent Run system template: step -> terminate on its own proxy
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

  it('the store-as fixture completed through the branch its stored value selected', () => {
    // The cond reads `context.verdict`, not the node's output. A cond that could not
    // read the stored path would fail the run instead of completing it.
    const types = eventsOf('store-as').map((e) => e.eventType);
    expect(types.at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
    expect(types).not.toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED);
  });

  it('the fail-edge fixture failed its step and routed to the handler', () => {
    // The activity failed for good (non-retryable), so the failure is on the
    // history, and the run still completed rather than failing.
    const types = eventsOf('fail-edge').map((e) => e.eventType);
    expect(types).toContain(EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED);
    expect(types.at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
  });

  it('the fail-edge-terminal fixture ended the run at the onFailure shorthand', () => {
    const types = eventsOf('fail-edge-terminal').map((e) => e.eventType);
    expect(types).toContain(EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED);
    expect(types.at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
  });

  it('the status-field fixture set the domain status on every visited node', () => {
    // Init (set), build and review (steps): three entries, each a status write.
    const scheduled = eventsOf('status-field').filter(
      (e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
    );
    const names = scheduled.map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name);
    expect(names.filter((n) => n === 'updateDomainState')).toHaveLength(3);
  });

  it('the visit-limit fixture walked the loop body to its bound and no further', () => {
    // maxVisits: 2 — the body runs twice; the third entry routes to onExhausted,
    // so exactly two executeImplementation activities were scheduled.
    const scheduled = eventsOf('visit-limit').filter(
      (e) => e.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
    );
    const names = scheduled.map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name);
    expect(names.filter((n) => n === 'executeImplementation')).toHaveLength(2);
  });

  it('the needs-input fixture paused, asked a person and resumed the activity', () => {
    // Replay guards the commands a pause walks: the patch marker, the human step, the wait
    // on its signal and the second activity call. A fixture recorded without the marker, or
    // that timed out instead of being answered, would leave that path unguarded.
    const events = eventsOf('needs-input');
    expect(patchIdsOf('needs-input')).toContain('needs-input-v1');
    const scheduled = events
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter(Boolean);
    expect(scheduled.filter((n) => n === 'executeImplementation')).toHaveLength(2);
    expect(scheduled).toContain('createHumanStep');
    const signals = events
      .map((e) => e.workflowExecutionSignaledEventAttributes?.signalName)
      .filter(Boolean);
    expect(signals).toEqual(['hitl_impl:ask:1']);
    expect(events.map((e) => e.eventType)).not.toContain(EventType.EVENT_TYPE_TIMER_FIRED);
  });

  it('the needs-input-reask fixture repeated the round under its own step', () => {
    const events = eventsOf('needs-input-reask');
    expect(patchIdsOf('needs-input-reask')).toContain('needs-input-reask-v1');
    const signals = events
      .map((e) => e.workflowExecutionSignaledEventAttributes?.signalName)
      .filter(Boolean);
    expect(signals).toEqual(['hitl_impl:ask:1', 'hitl_impl:ask:1.1']);
    const scheduled = events
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter(Boolean);
    // The re-ask does not run the activity again: one pause, one resume.
    expect(scheduled.filter((n) => n === 'executeImplementation')).toHaveLength(2);
  });

  it('the needs-input-final fixture ran the activity once more at the round limit', () => {
    const events = eventsOf('needs-input-final');
    expect(patchIdsOf('needs-input-final')).toContain('needs-input-final-round-v1');
    const scheduled = events
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter(Boolean);
    // First run, the resume with the answer, and the final unattended run.
    expect(scheduled.filter((n) => n === 'executeImplementation')).toHaveLength(3);
    const failed = events.some(
      (e) => e.eventType === EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED
    );
    expect(failed).toBe(false);
  });

  it('the needs-input-cancel fixture was cancelled while waiting and closed its question', () => {
    const types = eventsOf('needs-input-cancel').map((e) => e.eventType);
    expect(patchIdsOf('needs-input-cancel')).toContain('needs-input-cancel-v1');
    expect(types).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED);
    const scheduled = eventsOf('needs-input-cancel')
      .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
      .filter(Boolean);
    expect(scheduled).toContain('resolveHumanStep');
  });

  it('the signal-timeout fixture timed out rather than resumed', () => {
    // A payload arriving before the timer would walk `onReceive` instead,
    // leaving the timeout branch of the wait unguarded again.
    const types = eventsOf('signal-timeout').map((e) => e.eventType);
    expect(types).toContain(EventType.EVENT_TYPE_TIMER_FIRED);
    expect(types).not.toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
  });

  it('the fan-out-human-gate fixture parked and resumed every branch', () => {
    // One branch-unique `hitl_fan[i]/gate` signal per branch; with only one
    // the other branch would have timed out and the lazy registration of the
    // second name would be unguarded.
    const signals = eventsOf('fan-out-human-gate')
      .map((e) => e.workflowExecutionSignaledEventAttributes?.signalName)
      .filter(Boolean);
    expect(signals).toEqual(['hitl_fan[0]/gate', 'hitl_fan[1]/gate']);
  });

  const patchIdsOf = (name: string) =>
    eventsOf(name)
      .filter((e) => e.eventType === EventType.EVENT_TYPE_MARKER_RECORDED)
      .map((e) => {
        const payload = e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0];
        return payload?.data ? (JSON.parse(Buffer.from(payload.data).toString()).id as string) : '';
      });
  const indexesOf = (name: string, type: proto.temporal.api.enums.v1.EventType) =>
    eventsOf(name).flatMap((e, i) => (e.eventType === type ? [i] : []));
  /** The index of the re-wait's TIMER_STARTED, after both branches parked on theirs. */
  const rewaitTimerOf = (name: string) => {
    // The re-wait is patched; without its marker the fixture guards the old path.
    expect(patchIdsOf(name)).toContain(SIGNAL_REWAIT_PATCH);
    const signalled = indexesOf(name, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
    const timers = indexesOf(name, EventType.EVENT_TYPE_TIMER_STARTED);
    // Both branches were parked on their own timer when the first delivery came,
    // so it woke both of them rather than one.
    expect(timers.filter((i) => i < (signalled[0] as number))).toHaveLength(2);
    const rewait = timers.filter((i) => i > (signalled[0] as number));
    expect(rewait).toHaveLength(1);
    return { rewait: rewait[0] as number, signalled };
  };

  it('the fan-out-shared-signal fixture resumed the re-waiting branch on a second delivery', () => {
    const { rewait, signalled } = rewaitTimerOf('fan-out-shared-signal');
    // Two deliveries in separate workflow tasks, the re-wait's timer between them.
    expect(signalled).toHaveLength(2);
    expect(rewait).toBeLessThan(signalled[1] as number);
    expect(indexesOf('fan-out-shared-signal', EventType.EVENT_TYPE_TIMER_FIRED)).toHaveLength(0);
  });

  it('the fan-out-shared-signal-timeout fixture timed the re-waiting branch out', () => {
    const name = 'fan-out-shared-signal-timeout';
    const { rewait, signalled } = rewaitTimerOf(name);
    expect(signalled).toHaveLength(1);
    const fired = indexesOf(name, EventType.EVENT_TYPE_TIMER_FIRED);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThan(rewait);
  });

  it('the fan-out-cancel fixture was cancelled while its branches were parked', () => {
    const events = eventsOf('fan-out-cancel');
    const types = events.map((e) => e.eventType);
    expect(types).toContain(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED);
    expect(types.at(-1)).toBe(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED);
    // Both branches were waiting on their gate when the cancel landed, and
    // finalization still ran from the non-cancellable scope.
    expect(types.filter((t) => t === EventType.EVENT_TYPE_TIMER_CANCELED)).toHaveLength(2);
    const activities = events.map(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name
    );
    expect(activities).toContain('finalizeWorkflowRun');
  });
});
