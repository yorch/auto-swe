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
 *   yarn workspace @auto-swe/worker exec tsx scripts/recordReplayHistory.ts [scenario ...]
 *
 * With no arguments every scenario is re-recorded; name scenarios to record only
 * those (a new shape should never rewrite the fixtures that already pass).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_RUN_SPEC } from '@auto-swe/shared/lib/agentRun';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { ApplicationFailure } from '@temporalio/activity';
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
  /**
   * Activity overrides for this scenario, built fresh per recording so a closure
   * (an attempt counter, say) cannot leak between scenarios.
   */
  activities?: () => Record<string, (...args: never[]) => unknown>;
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
  {
    // Declarative `agent` node → runAgentNode.
    name: 'agent-node',
    spec: spec(
      {
        ask: { agentRef: 'implementer', next: 'done', type: 'agent', userMessage: 'hi' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      'ask'
    ),
  },
  {
    // The Agent Run system template's own graph: the internal `runAgentTask`
    // step (single attempt, long timeout, its own activity proxy) feeding a
    // terminate whose result binds the step's output.
    activities: () => ({
      runAgentTask: async () => ({
        agent: 'contentWriter',
        baseSha: 'a'.repeat(40),
        branch: 'auto/agent-0a1b2c3d',
        deliver: 'branch',
        diff: 'diff --git a/x b/x',
        diffTruncated: false,
        diffVerified: true,
        filesChanged: [],
        gate: 'passed',
        headSha: 'b'.repeat(40),
        text: 'fixture',
      }),
    }),
    name: 'agent-run',
    spec: spec(AGENT_RUN_SPEC.nodes as unknown as Record<string, unknown>, AGENT_RUN_SPEC.entry),
  },
  {
    // Container-contract coded capability.
    name: 'container-step',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        run: { image: 'node:24-alpine', next: 'done', type: 'containerStep' },
      },
      'run'
    ),
  },
  {
    // User-authored shell command in an ephemeral container.
    name: 'shell',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        run: {
          command: 'echo fixture',
          image: 'node:24-alpine',
          next: 'done',
          type: 'shell',
        },
      },
      'run'
    ),
  },
  {
    // Eval node — scorers plus the judge threshold.
    name: 'eval',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        score: {
          next: 'done',
          // `assert` keeps the fixture self-contained — a `judge` scorer would
          // pull in a rubric and an LLM call for no extra control-flow shape.
          scorers: [{ expr: '$.context.ready', kind: 'assert' }],
          target: { literal: 'fixture' },
          type: 'eval',
        },
        seed: { next: 'score', type: 'set', values: { 'context.ready': { literal: true } } },
      },
      'seed'
    ),
  },
  {
    // MCP tool call.
    name: 'mcp',
    spec: spec(
      {
        call: { connectionRef: 'fixture-mcp', next: 'done', tool: 'echo', type: 'mcp' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      'call'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForState(states, 'AWAITING_HUMAN');
      await handle.signal('hitl_pick', { action: 'ship' });
    },
    // humanDecision routes on which option came back, not approve/reject.
    name: 'human-decision',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        hold: { status: 'FAILED', type: 'terminate' },
        mark: marker('AWAITING_HUMAN', 'pick'),
        pick: {
          onTimeout: 'hold',
          options: [
            { next: 'done', value: 'ship' },
            { next: 'hold', value: 'hold' },
          ],
          timeout: '24h',
          title: 'Ship it?',
          type: 'humanDecision',
        },
      },
      'mark'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForState(states, 'AWAITING_HUMAN');
      await handle.signal('hitl_form', { action: 'submit', values: { note: 'ok' } });
    },
    // humanInput folds a structured payload back into context.
    name: 'human-input',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        form: {
          fields: [{ key: 'note', label: 'Note', type: 'text' }],
          next: 'done',
          onTimeout: 'done',
          timeout: '24h',
          title: 'Add a note',
          type: 'humanInput',
        },
        mark: marker('AWAITING_HUMAN', 'form'),
      },
      'mark'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForState(states, 'AWAITING_HUMAN');
      await handle.signal('hitl_look', { action: 'submit', annotations: [] });
    },
    // humanReview — annotated review of a value already in context. Unlike the
    // other three it routes on `onSubmit`, not approve/reject.
    name: 'human-review',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        look: {
          contentFrom: '$.context.diff',
          onSubmit: 'done',
          onTimeout: 'timedOut',
          storeAs: 'reviewNotes',
          timeout: '24h',
          title: 'Review the diff',
          type: 'humanReview',
        },
        mark: marker('AWAITING_HUMAN', 'look'),
        seed: { next: 'mark', type: 'set', values: { 'context.diff': { literal: 'a diff' } } },
        timedOut: { status: 'FAILED', type: 'terminate' },
      },
      'seed'
    ),
  },
  {
    // A `cond` that points back at an earlier node: the loop shape every
    // review/CI retry in the seeded templates is built from. Walks the same
    // nodes three times, so a change to how revisits are recorded surfaces here.
    name: 'cond-loop',
    spec: spec(
      {
        check: {
          expr: 'context.n >= 2',
          onFalse: 'work',
          onTrue: 'done',
          type: 'cond',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        inc: { next: 'check', type: 'set', values: { 'context.n': { expr: 'context.n + 1' } } },
        init: { next: 'work', type: 'set', values: { 'context.n': { literal: 0 } } },
        work: { next: 'inc', step: 'executeImplementation', type: 'step' },
      },
      'init'
    ),
  },
  {
    // onFail: { retry } — a gate that fails once, is re-run by the interpreter
    // (not Temporal), and passes. Records the failed attempt and the pass.
    activities: () => {
      let calls = 0;
      return {
        runLint: async () => {
          calls += 1;
          return calls === 1
            ? { passed: false, summary: 'lint failed on the first attempt' }
            : { passed: true, summary: 'ok' };
        },
      };
    },
    name: 'on-fail-retry',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        lint: { next: 'done', onFail: { retry: 2 }, step: 'runLint', type: 'step' },
      },
      'lint'
    ),
  },
  {
    // onError: 'continue' — a step that throws is recorded SKIPPED and the run
    // moves on. It bypasses retry and onFail, so it is its own path.
    activities: () => ({
      executeImplementation: async () => {
        throw ApplicationFailure.nonRetryable('fixture failure');
      },
    }),
    name: 'on-error-continue',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        work: { next: 'done', onError: 'continue', step: 'executeImplementation', type: 'step' },
      },
      'work'
    ),
  },
  {
    // A fan-out whose branches each run a fan-out. The inner pool shares the
    // run-wide transition cap and branch-index allocation with the outer one.
    name: 'nested-fan-out',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        inner: {
          concurrency: 2,
          itemKey: 'leafItem',
          join: 'innerDone',
          over: { literal: [{ id: 'x' }, { id: 'y' }] },
          subgraph: 'leaf',
          type: 'fanOut',
        },
        innerDone: { next: undefined, type: 'set', values: { 'context.inner': { literal: true } } },
        leaf: { step: 'executeImplementation', type: 'step' },
        outer: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }] },
          subgraph: 'inner',
          type: 'fanOut',
        },
      },
      'outer'
    ),
  },
  {
    // Block-mode fan-out cancellation: one branch fails while its sibling is
    // parked on a human approval. The sibling's wait must be interrupted rather
    // than held for the 24h timeout, and the run fails.
    activities: () => ({
      executeImplementation: async () => {
        throw ApplicationFailure.nonRetryable('fixture branch failure');
      },
    }),
    name: 'fan-out-block-cancel',
    spec: spec(
      {
        branchDone: { type: 'set', values: { 'context.branch': { literal: true } } },
        branchFail: { next: 'branchDone', step: 'executeImplementation', type: 'step' },
        branchGate: {
          onApprove: 'branchDone',
          onReject: 'branchDone',
          onTimeout: 'branchDone',
          timeout: '24h',
          title: 'Hold this branch open',
          type: 'humanApproval',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [{ bad: true }, { bad: false }] },
          subgraph: 'route',
          type: 'fanOut',
        },
        route: {
          expr: 'subtask.bad == true',
          onFalse: 'branchGate',
          onTrue: 'branchFail',
          type: 'cond',
        },
      },
      'fan'
    ),
  },
  {
    // Finalization spills oversized context to artifacts. No other fixture
    // walks that path, so a change to the spill batching replays clean
    // everywhere else — which is exactly how the batching change slipped past
    // the suite when it landed.
    name: 'context-spill',
    spec: spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        seed: {
          next: 'done',
          type: 'set',
          values: { 'context.big': { literal: 'x'.repeat(9000) } },
        },
      },
      'seed'
    ),
  },
];

/**
 * A scenario whose spec fails validation parks on an activity Temporal keeps
 * retrying, so the recorder used to hang with no clue which scenario was at
 * fault. Bound each one and name it in the error instead.
 */
const SCENARIO_TIMEOUT_MS = 90_000;

function withTimeout<T>(name: string, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `scenario '${name}' did not finish in ${SCENARIO_TIMEOUT_MS / 1000}s — ` +
                'usually an invalid spec, which the run retries rather than failing'
            )
          ),
        SCENARIO_TIMEOUT_MS
      ).unref()
    ),
  ]);
}

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
      mcpCallTool: async () => ({ ok: true, result: 'fixture' }),
      recordWorkflowStep: async () => {},
      resolveHumanStep: async () => {},
      runAgentNode: async () => ({ output: 'fixture', text: 'fixture' }),
      runContainerStep: async () => ({ passed: true, result: { ok: true } }),
      runEvalNode: async () => ({ passed: true, scores: [{ name: 'judge', value: 1 }] }),
      runShellStep: async () => ({ exitCode: 0, passed: true, summary: 'fixture' }),
      storeContextOverflowBatch: async (input: { values: unknown[] }) =>
        input.values.map((_, i) => ({ artifactId: `art-${i}`, sizeBytes: 1 })),
      updateDomainState: async (_wf: string, status: string) => {
        states.push(status);
      },
      ...scenario.activities?.(),
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
    // Name scenarios on the command line to record only those. Re-recording a
    // fixture that still replays defeats it, so adding a scenario must not touch
    // the existing ones.
    const only = process.argv.slice(2);
    const unknown = only.filter((n) => !SCENARIOS.some((sc) => sc.name === n));
    if (unknown.length) {
      throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
    }
    for (const scenario of SCENARIOS.filter((sc) => only.length === 0 || only.includes(sc.name))) {
      const events = await withTimeout(scenario.name, record(scenario, env));
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
