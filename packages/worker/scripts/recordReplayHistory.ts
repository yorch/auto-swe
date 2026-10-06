/**
 * Records workflow execution histories to binary fixtures, which
 * `runnable.replay.test.ts` (RunnableWorkflow) and `orchestration.replay.test.ts`
 * (the epic orchestrator and the channel workflows) replay against current
 * workflow code.
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

type Spec = ReturnType<typeof spec>;

interface Scenario {
  /** Fixture filename stem. */
  name: string;
  /**
   * The RunnableWorkflow's spec. For a scenario that records another workflow
   * type, the spec any RunnableWorkflow child it starts runs (see `childSpecs`).
   */
  spec?: Spec;
  /**
   * Specs for RunnableWorkflow children, keyed by the `templateId` they are
   * started with — an epic's children each resolve their own template.
   */
  childSpecs?: Record<string, Spec>;
  /**
   * Records a workflow other than RunnableWorkflow. Such a scenario runs its
   * worker on `engineering-workflow`, the queue every child is started on, and
   * its drive must see any abandoned child to completion so the next scenario's
   * worker on that queue does not inherit it.
   */
  workflow?: {
    type: string;
    args: unknown[] | ((env: TestWorkflowEnvironment) => Promise<unknown[]>);
  };
  /**
   * Drives a workflow that parks. Receives a handle, the domain-state log and
   * the test environment, and must unblock the run — a signal sent before the
   * interpreter reaches the wait node is deliberately dropped, so this has to
   * observe first.
   */
  drive?: (handle: DriveHandle, states: string[], env: TestWorkflowEnvironment) => Promise<void>;
  /**
   * Activity overrides for this scenario, built fresh per recording so a closure
   * (an attempt counter, say) cannot leak between scenarios.
   */
  activities?: () => Record<string, (...args: never[]) => unknown>;
}

interface DriveHandle {
  workflowId: string;
  signal(name: string, arg?: unknown): Promise<void>;
  cancel(): Promise<unknown>;
  result(): Promise<unknown>;
  fetchHistory(): Promise<proto.temporal.api.history.v1.IHistory>;
}

/** The queue every child workflow is started on (epic children, channel tasks). */
const CHILD_TASK_QUEUE = 'engineering-workflow';

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

/** Like {@link waitForState}, for a state several parallel branches each reach. */
async function waitForStateCount(states: string[], want: string, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  const seen = () => states.filter((s) => s === want).length;
  while (seen() < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (seen() < count) {
    throw new Error(`timed out waiting for ${count}× domain state '${want}' (saw ${seen()})`);
  }
  await new Promise((r) => setTimeout(r, 750));
}

const EventType = proto.temporal.api.enums.v1.EventType;

/** Waits until the run's history holds an event of `type` — a timer started, say. */
async function waitForEvent(
  handle: Pick<DriveHandle, 'fetchHistory'>,
  type: proto.temporal.api.enums.v1.EventType
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const history = await handle.fetchHistory();
    if ((history.events ?? []).some((e) => e.eventType === type)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for history event ${EventType[type]}`);
}

/** A RunnableWorkflow request, for scenarios that start one as a child. */
const childRequest = (description: string) => ({
  budgetTier: 'STANDARD',
  description,
  externalTicketId: 'REPLAY-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
});

const EPIC_REQUEST = {
  description: 'replay fixture epic',
  externalTicketId: 'REPLAY-EPIC-1',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000003',
};

/** A child spec that succeeds without parking. */
const CHILD_OK = spec({ done: { status: 'SUCCESS', type: 'terminate' } }, 'done');
/** A child spec whose run ends FAILED, so its epic dependents are skipped. */
const CHILD_FAIL = spec({ failed: { status: 'FAILED', type: 'terminate' } }, 'failed');

const CHANNEL_TURN_INPUT = {
  channelId: 'chan-replay',
  orgId: 'org-replay',
  slackChannelId: 'C0REPLAY',
  teamId: 'team-replay',
  threadTs: '1700000000.000100',
  userSlackId: 'U0REPLAY',
  userText: 'replay fixture',
};

/**
 * Channel assistant turn activities. `turn` is what `runChannelAssistantTurn`
 * returns (or throws) — the field the workflow branches on.
 */
const channelActivities = (turn: () => Promise<unknown>) => ({
  createChannelTaskRun: async () => ({
    request: childRequest('channel task'),
    templateId: 'tpl-task',
    templateVersion: 1,
    workflowId: 'replay-fixture-channel-assistant-delegate-task',
  }),
  createChannelWorkflowDraft: async () => ({ name: 'Fixture flow', summary: 'two steps' }),
  finalizeChannelRun: async () => {},
  isChannelOverBudgetForTask: async () => false,
  postChannelPlaceholder: async () => ({ ts: '1700000000.000200' }),
  postChannelReply: async () => {},
  refineChannelWorkflowDraft: async () => ({
    name: 'Fixture flow',
    status: 'refined',
    summary: 'added a step',
    version: 2,
  }),
  runChannelAssistantTurn: turn,
  startChannelRun: async () => {},
  touchChannelThreadSession: async () => {},
  updateChannelReply: async () => {},
});

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
  {
    // A signal node nobody signals: the wait's timer fires and the run takes
    // `onTimeout`. Every other signal fixture resumes on a payload, so the
    // timeout branch of the wait was unguarded.
    name: 'signal-timeout',
    spec: spec(
      {
        merged: { status: 'SUCCESS', type: 'terminate' },
        seed: { next: 'wait', type: 'set', values: { 'context.ready': { literal: true } } },
        timedOut: { status: 'TIMED_OUT', type: 'terminate' },
        wait: {
          name: 'humanMergeSignal',
          onReceive: 'merged',
          onTimeout: 'timedOut',
          timeout: '1h',
          type: 'signal',
        },
      },
      'seed'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForStateCount(states, 'AWAITING_HUMAN', 2);
      await handle.signal('hitl_fan[0]/gate', { action: 'approve' });
      await handle.signal('hitl_fan[1]/gate', { action: 'approve' });
    },
    // A HITL gate inside a fan-out branch waits on a branch-unique signal
    // (`hitl_fan[0]/gate`) whose handler is registered lazily, on first wait —
    // not at startup like a top-level gate. Both branches park, then resume.
    name: 'fan-out-human-gate',
    spec: spec(
      {
        branchDone: { type: 'set', values: { 'context.branch': { literal: true } } },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }] },
          subgraph: 'mark',
          type: 'fanOut',
        },
        gate: {
          onApprove: 'branchDone',
          onReject: 'branchDone',
          onTimeout: 'branchDone',
          timeout: '24h',
          title: 'Approve this branch',
          type: 'humanApproval',
        },
        mark: marker('AWAITING_HUMAN', 'gate'),
      },
      'fan'
    ),
  },
  {
    drive: async (handle, states) => {
      await waitForStateCount(states, 'AWAITING_HUMAN', 2);
      await handle.cancel();
    },
    // A workflow cancel (the run-cancel route) while every fan-out branch is
    // parked: the branches' waits unwind as a cancellation and finalization
    // still runs, in a non-cancellable scope, recording CANCELLED.
    name: 'fan-out-cancel',
    spec: spec(
      {
        branchDone: { type: 'set', values: { 'context.branch': { literal: true } } },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }] },
          subgraph: 'mark',
          type: 'fanOut',
        },
        gate: {
          onApprove: 'branchDone',
          onReject: 'branchDone',
          onTimeout: 'branchDone',
          timeout: '24h',
          title: 'Hold this branch open',
          type: 'humanApproval',
        },
        mark: marker('AWAITING_HUMAN', 'gate'),
      },
      'fan'
    ),
  },
  {
    // Event-driven DAG scheduling (`epic-event-driven-scheduling`): a and b
    // start together, c starts the moment a succeeds, and d — downstream of
    // the failed b — is skipped without ever starting.
    activities: () => ({
      planEpic: async () => {
        throw new Error('planEpic must not run: the request carries its repos');
      },
      resolveTemplateForRepo: async (repoId: string) => ({
        templateId: repoId === 'b' ? 'tpl-fail' : 'tpl-ok',
        templateVersion: 1,
      }),
    }),
    childSpecs: { 'tpl-fail': CHILD_FAIL, 'tpl-ok': CHILD_OK },
    name: 'epic-dag',
    workflow: {
      args: [
        {
          ...EPIC_REQUEST,
          epicWorkflowId: 'replay-fixture-epic-dag',
          repos: [
            { dependsOn: [], repoId: 'a' },
            { dependsOn: [], repoId: 'b' },
            { dependsOn: ['a'], repoId: 'c' },
            { dependsOn: ['b'], repoId: 'd' },
          ],
        },
      ],
      type: 'EpicOrchestratorWorkflow',
    },
  },
  {
    // No pre-decomposed repos: the planner activity runs first, and its plan
    // (p2 behind p1) is what the scheduler walks.
    activities: () => ({
      planEpic: async () => [
        { dependsOn: [], repoId: 'p1' },
        { dependsOn: ['p1'], repoId: 'p2' },
      ],
      resolveTemplateForRepo: async () => ({ templateId: 'tpl-ok', templateVersion: 1 }),
    }),
    childSpecs: { 'tpl-ok': CHILD_OK },
    name: 'epic-planned',
    workflow: {
      args: [
        {
          ...EPIC_REQUEST,
          epicWorkflowId: 'replay-fixture-epic-planned',
          repoIds: ['p1', 'p2'],
          repos: [],
        },
      ],
      type: 'EpicOrchestratorWorkflow',
    },
  },
  {
    activities: () => ({
      resolveTemplateForRepo: async () => ({ templateId: 'tpl-park', templateVersion: 1 }),
    }),
    childSpecs: {
      'tpl-park': spec(
        {
          approved: { status: 'SUCCESS', type: 'terminate' },
          gate: {
            onApprove: 'approved',
            onReject: 'approved',
            onTimeout: 'approved',
            timeout: '24h',
            title: 'Hold the child open',
            type: 'humanApproval',
          },
          mark: marker('AWAITING_HUMAN', 'gate'),
        },
        'mark'
      ),
    },
    drive: async (handle, states) => {
      await waitForStateCount(states, 'AWAITING_HUMAN', 2);
      await handle.signal('epicCancelSignal');
    },
    // `epicCancelSignal` while two children are parked (`epic-cancel-children`):
    // the child scope is cancelled, both children are cancelled with it, and
    // z — behind x — never starts.
    name: 'epic-cancel',
    workflow: {
      args: [
        {
          ...EPIC_REQUEST,
          epicWorkflowId: 'replay-fixture-epic-cancel',
          repos: [
            { dependsOn: [], repoId: 'x' },
            { dependsOn: [], repoId: 'y' },
            { dependsOn: ['x'], repoId: 'z' },
          ],
        },
      ],
      type: 'EpicOrchestratorWorkflow',
    },
  },
  {
    // The plain @mention turn: placeholder, LLM turn, edit the placeholder in
    // place, mark the thread session live, finalize.
    activities: () => channelActivities(async () => ({ reply: 'here you go' })),
    name: 'channel-assistant-reply',
    workflow: { args: [CHANNEL_TURN_INPUT], type: 'ChannelAssistantWorkflow' },
  },
  {
    // A follow-up (no re-@mention) the agent decided was not for it: no
    // placeholder up front, and nothing posted after.
    activities: () => channelActivities(async () => ({ reply: 'SKIP', suppressed: true })),
    name: 'channel-assistant-followup-skip',
    workflow: {
      args: [{ ...CHANNEL_TURN_INPUT, followup: true }],
      type: 'ChannelAssistantWorkflow',
    },
  },
  {
    // The LLM turn fails: the placeholder is edited with the fallback text and
    // the run is finalized FAILED, without the thread-session touch.
    activities: () =>
      channelActivities(async () => {
        throw ApplicationFailure.nonRetryable('fixture turn failure');
      }),
    name: 'channel-assistant-error',
    workflow: { args: [CHANNEL_TURN_INPUT], type: 'ChannelAssistantWorkflow' },
  },
  {
    // A delegate intent: budget gate, prepare the run, start the thread-bound
    // RunnableWorkflow child (ABANDON, REJECT_DUPLICATE), then post the ack.
    activities: () =>
      channelActivities(async () => ({
        delegate: { description: 'do the thing', route: 'general', title: 'Thing' },
        reply: 'on it',
      })),
    childSpecs: { 'tpl-task': CHILD_OK },
    drive: async (handle, _states, env) => {
      // The child is abandoned, so it outlives the turn: see it finish here
      // rather than leave it for the next scenario's worker on the queue.
      await handle.result();
      await env.client.workflow
        .getHandle('replay-fixture-channel-assistant-delegate-task')
        .result();
    },
    name: 'channel-assistant-delegate',
    workflow: { args: [CHANNEL_TURN_INPUT], type: 'ChannelAssistantWorkflow' },
  },
  {
    // A generateWorkflow intent: budget gate, draft generation, reply.
    activities: () =>
      channelActivities(async () => ({
        generate: { description: 'lint then test', name: 'Fixture flow' },
        reply: '',
      })),
    name: 'channel-assistant-generate',
    workflow: { args: [CHANNEL_TURN_INPUT], type: 'ChannelAssistantWorkflow' },
  },
  {
    // A refineWorkflow intent: budget gate, draft refinement, reply.
    activities: () =>
      channelActivities(async () => ({ refine: { instruction: 'add a step' }, reply: '' })),
    name: 'channel-assistant-refine',
    workflow: { args: [CHANNEL_TURN_INPUT], type: 'ChannelAssistantWorkflow' },
  },
  {
    childSpecs: {
      'tpl-deferred': spec(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          mark: marker('AWAITING_SIGNAL', 'wait'),
          wait: {
            name: 'humanMergeSignal',
            onReceive: 'done',
            onTimeout: 'done',
            // Well past the 15m the drive skips, so the skip cannot time the wait out.
            timeout: '24h',
            type: 'signal',
          },
        },
        'mark'
      ),
    },
    drive: async (handle, states, env) => {
      // Steer while the wrapper sleeps (folded into the description), then
      // skip past runAt (inside the recorder's 2h execution timeout) so it
      // launches the run, then steer again (forwarded to
      // the running child as an external signal), then let the child finish.
      await waitForEvent(handle, EventType.EVENT_TYPE_TIMER_STARTED);
      await handle.signal('steer', 'pre-launch guidance');
      await env.sleep('15m');
      await waitForState(states, 'AWAITING_SIGNAL');
      await handle.signal('steer', 'post-launch guidance');
      await waitForEvent(handle, EventType.EVENT_TYPE_EXTERNAL_WORKFLOW_EXECUTION_SIGNALED);
      await env.client.workflow
        .getHandle(`${handle.workflowId}-run`)
        .signal('humanMergeSignal', true);
    },
    // The deferred-task wrapper: sleep until runAt, start the run as a child,
    // forward later steering to it, and stay alive until it closes.
    name: 'channel-scheduled-task',
    workflow: {
      args: async (env) => [
        {
          request: childRequest('deferred task'),
          runAt: new Date((await env.currentTimeMs()) + 10 * 60_000).toISOString(),
          templateId: 'tpl-deferred',
          templateVersion: 1,
        },
      ],
      type: 'ChannelScheduledTaskWorkflow',
    },
  },
  {
    // The ambient schedule's five best-effort passes, in order. The digest
    // fails, so the run is finalized FAILED while the other passes still run.
    activities: () => ({
      consolidateChannelMemory: async () => ({}),
      finalizeChannelRun: async () => {},
      flagOrgSignals: async () => ({}),
      passiveIngestChannelMemory: async () => ({}),
      runChannelAmbientDigest: async () => {
        throw ApplicationFailure.nonRetryable('fixture digest failure');
      },
      startChannelRun: async () => {},
      sweepChannelOpenItems: async () => ({}),
    }),
    name: 'channel-ambient',
    workflow: { args: [{ channelId: 'chan-replay' }], type: 'ChannelAmbientWorkflow' },
  },
  {
    // The reactive schedule: one interjection check between the run record's
    // start and finalize.
    activities: () => ({
      evaluateReactiveInterjection: async () => ({ outcome: 'skipped' }),
      finalizeChannelRun: async () => {},
      startChannelRun: async () => {},
    }),
    name: 'channel-reactive',
    workflow: { args: [{ channelId: 'chan-replay' }], type: 'ChannelReactiveWorkflow' },
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
  const taskQueue = scenario.workflow ? CHILD_TASK_QUEUE : `replay-recorder-${scenario.name}`;
  const worker = await Worker.create({
    activities: {
      cancelPendingHumanSteps: async () => {},
      createHumanStep: async () => {},
      createWorkflowRun: async (input: { templateId: string; workflowId: string }) => {
        if (!scenario.workflow) {
          return { runId: `replay-${scenario.name}`, spec: scenario.spec };
        }
        const childSpec = scenario.childSpecs?.[input.templateId];
        return childSpec
          ? { runId: `replay-${input.workflowId}`, spec: childSpec }
          : { error: `no child spec for template '${input.templateId}'` };
      },
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
    const wf = scenario.workflow;
    const args = wf
      ? typeof wf.args === 'function'
        ? await wf.args(env)
        : wf.args
      : [{ request: childRequest('replay fixture'), templateId: 'tpl-replay', templateVersion: 1 }];
    const handle = await env.client.workflow.start(wf?.type ?? 'RunnableWorkflow', {
      args,
      taskQueue,
      workflowExecutionTimeout: '2 hours',
      // The replay tests replay each fixture under this same id: a workflow that
      // derives a child's id from its own would diverge under any other.
      workflowId: `replay-fixture-${scenario.name}`,
    });
    await scenario.drive?.(handle, states, env);
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
      console.log(`${scenario.name.padEnd(32)} ${events} events`);
    }
  } finally {
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
