/**
 * Records `RunnableWorkflow` execution histories to JSON fixtures, which
 * `runnable.replay.test.ts` then replays against current workflow code.
 *
 * One fixture per control-flow *shape*, because replay only guards the paths a
 * recorded history actually walked. A linear run says nothing about whether a
 * change broke fan-out branch scheduling or the order of signal registration.
 *
 * Run this **only** when a recorded history is genuinely stale — i.e. the
 * workflow's own structure changed intentionally. Regenerating a fixture to
 * make a failing replay pass defeats the entire point of the test: a
 * determinism violation is exactly what it is meant to catch.
 *
 *   yarn workspace @auto-swe/worker exec tsx scripts/recordReplayHistory.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import proto from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = path.resolve(__dirname, '../src/workflows/index.ts');
const OUT_DIR = path.resolve(__dirname, '../src/workflows/__fixtures__');

const spec = (nodes: Record<string, unknown>, entry: string) => ({
  description: 'Replay fixture — do not edit by hand.',
  entry,
  name: 'replay-fixture-spec',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
});

interface Scenario {
  /** Fixture filename stem. */
  name: string;
  spec: ReturnType<typeof spec>;
  /**
   * Drives a workflow that parks. Receives a handle and the domain-state log,
   * and must unblock the run — a signal sent before the interpreter reaches
   * the wait node is deliberately dropped, so this has to observe first.
   */
  drive?: (handle: DriveHandle, states: string[]) => Promise<void>;
}

interface DriveHandle {
  signal(name: string, arg?: unknown): Promise<void>;
}

/** Parks the run at a marker step so a signal can be timed against it. */
const marker = (status: string, next: string) => ({
  config: { status },
  next,
  step: 'updateDomainState',
  type: 'step',
});

async function waitForState(states: string[], want: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!states.includes(want) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!states.includes(want)) {
    throw new Error(`timed out waiting for domain state '${want}'`);
  }
  // Give the worker a beat to park on the condition after the marker returns.
  await new Promise((r) => setTimeout(r, 750));
}

const SCENARIOS: Scenario[] = [
  {
    // Step dispatch, a branch on its output, and an explicit terminate.
    name: 'linear',
    spec: spec(
      {
        check: {
          expr: '$.nodes.implement.output.ok',
          onFalse: 'failed',
          onTrue: 'done',
          type: 'cond',
        },
        done: { result: { value: 'ok' }, status: 'SUCCESS', type: 'terminate' },
        failed: { status: 'FAILED', type: 'terminate' },
        implement: { next: 'check', step: 'executeImplementation', type: 'step' },
      },
      'implement'
    ),
  },
  {
    // Bounded-concurrency branch scheduling and the join. The interpreter's
    // worker pool is where a reordering change would surface.
    name: 'fan-out',
    spec: spec(
      {
        // Each branch carries its item, so the recorded activity inputs differ
        // per branch and the fixture reads as a real fan-out.
        //
        // Note what replay does *not* catch: Temporal compares command type and
        // sequence, not activity arguments, so permuting same-type branch
        // activities replays clean either way — verified by reversing the worker
        // pool's iteration order, which passes. What this fixture does catch is
        // a change to the *shape* of the branch path: adding an activity inside
        // runFanOut fails this fixture and no other.
        branch: {
          inputs: { item: { from: 'subtask' }, position: { from: 'subtaskIndex' } },
          step: 'executeImplementation',
          type: 'step',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
          subgraph: 'branch',
          type: 'fanOut',
        },
        seed: { next: 'fan', type: 'set', values: { 'context.ready': { literal: true } } },
      },
      'seed'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForState(states, 'AWAITING_SIGNAL');
      await handle.signal('humanMergeSignal', true);
    },
    // Signal-handler registration and the park/resume boundary.
    name: 'signal',
    spec: spec(
      {
        failed: { status: 'TIMED_OUT', type: 'terminate' },
        mark: marker('AWAITING_SIGNAL', 'wait'),
        merged: { status: 'SUCCESS', type: 'terminate' },
        wait: {
          name: 'humanMergeSignal',
          onReceive: 'merged',
          onTimeout: 'failed',
          timeout: '1h',
          type: 'signal',
        },
      },
      'mark'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForState(states, 'AWAITING_HUMAN');
      await handle.signal('hitl_gate', { action: 'approve' });
    },
    // HITL parks on `hitl_<nodeId>` and routes on the payload's action.
    name: 'human-approval',
    spec: spec(
      {
        approved: { status: 'SUCCESS', type: 'terminate' },
        gate: {
          onApprove: 'approved',
          onReject: 'rejected',
          onTimeout: 'rejected',
          timeout: '24h',
          title: 'Approve the fixture run',
          type: 'humanApproval',
        },
        mark: marker('AWAITING_HUMAN', 'gate'),
        rejected: { status: 'FAILED', type: 'terminate' },
      },
      'mark'
    ),
  },
];

async function record(scenario: Scenario, env: TestWorkflowEnvironment): Promise<number> {
  const states: string[] = [];
  const taskQueue = `replay-recorder-${scenario.name}`;
  const worker = await Worker.create({
    activities: {
      cancelPendingHumanSteps: async () => {},
      createHumanStep: async () => {},
      createWorkflowRun: async () => ({ runId: `replay-${scenario.name}`, spec: scenario.spec }),
      executeImplementation: async () => ({ ok: true, summary: 'fixture' }),
      finalizeWorkflowRun: async () => {},
      recordWorkflowStep: async () => {},
      resolveHumanStep: async () => {},
      storeContextOverflow: async () => null,
      updateDomainState: async (_wf: string, status: string) => {
        states.push(status);
      },
    },
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: WORKFLOWS_PATH,
  });

  // Everything must happen inside runUntil: the worker stops as soon as the
  // promise settles, and `start()` settles the moment the workflow is queued —
  // leaving nothing to poll it to completion.
  const history = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('RunnableWorkflow', {
      args: [
        {
          request: {
            budgetTier: 'STANDARD',
            description: 'replay fixture',
            externalTicketId: 'REPLAY-1',
            repoId: '00000000-0000-4000-8000-000000000001',
            requestPayload: '{}',
            workRequestId: '00000000-0000-4000-8000-000000000002',
          },
          templateId: 'tpl-replay',
          templateVersion: 1,
        },
      ],
      taskQueue,
      workflowExecutionTimeout: '2 hours',
      workflowId: `replay-fixture-${scenario.name}`,
    });
    await scenario.drive?.(handle, states);
    await handle.result().catch(() => undefined);
    return handle.fetchHistory();
  });

  // Binary protobuf rather than JSON. The proto3-JSON converters round-trip
  // Timestamps and Payload metadata badly in both directions; the wire format
  // is exact and is what the replayer consumes anyway.
  const out = path.join(OUT_DIR, `${scenario.name}.bin`);
  writeFileSync(out, proto.temporal.api.history.v1.History.encode(history).finish());
  return history.events?.length ?? 0;
}

async function main(): Promise<void> {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  mkdirSync(OUT_DIR, { recursive: true });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    for (const scenario of SCENARIOS) {
      const events = await record(scenario, env);
      console.log(`${scenario.name.padEnd(16)} ${events} events`);
    }
  } finally {
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
