/**
 * Ask-and-resume through the real workflow: an agent activity returns a pause, the
 * dispatcher opens a human step, waits on its signal and runs the activity again with
 * the person's answers. Only the activity bodies are fake.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import type { WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'runnable-needs-input-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUEST = {
  budgetTier: 'STANDARD' as const,
  description: 'test',
  externalTicketId: 'T-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
} satisfies RepoWorkRequest;

const QUESTION = {
  header: 'Library',
  multiSelect: false,
  options: [
    { description: 'fast', label: 'Alpha' },
    { description: '', label: 'Beta' },
  ],
  question: 'Which library?',
};
const MULTI = {
  header: 'Targets',
  multiSelect: true,
  options: [
    { description: '', label: 'Linux' },
    { description: '', label: 'Mac' },
  ],
  question: 'Which targets?',
};
const pause = (digest: string) => ({
  needsInput: {
    questions: [QUESTION, MULTI],
    resume: {
      asked: [
        { header: 'Library', question: QUESTION.question },
        { header: 'Targets', question: MULTI.question },
      ],
      digest,
      snapshot: null,
      version: 1,
    },
  },
});
const ANSWER = { action: 'submit', value: { note: 'prefer v2', q1: 'Beta', q2: 'Linux, Mac' } };
const FINAL = { branch: 'auto/T-1', headSha: 'sha-final' };

interface ImplCall {
  args: unknown[];
}
const calls = {
  agentNode: [] as Array<Record<string, unknown>>,
  cancelled: [] as string[],
  finalize: [] as Array<{ runId: string; status: string }>,
  humanSteps: [] as Array<Record<string, unknown>>,
  impl: [] as ImplCall[],
  resolved: [] as Array<Record<string, unknown>>,
};
let currentSpec: Record<string, unknown> = {};
let pinned: Record<string, unknown> | undefined;
/** What the fake `executeImplementation` returns for its n-th call (0-based). */
let implResult: (n: number) => unknown = () => FINAL;
/** Makes the first `createHumanStep` attempt fail, as a transient database error would. */
let failFirstHumanStep = false;
let humanStepAttempts = 0;

const makeSpec = (nodes: Record<string, unknown>, entry: string) => ({
  description: '',
  entry,
  name: 'needs-input-spec',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
});

const IMPL_SPEC = () =>
  makeSpec(
    {
      done: {
        result: { branch: { from: 'nodes.impl.output.branch' } },
        status: 'SUCCESS',
        type: 'terminate',
      },
      impl: { next: 'done', step: 'executeImplementation', type: 'step' },
    },
    'impl'
  );

const fakeActivities = {
  cancelPendingHumanSteps: async (runId: string) => {
    calls.cancelled.push(runId);
  },
  createHumanStep: async (input: Record<string, unknown>) => {
    humanStepAttempts += 1;
    if (failFirstHumanStep && humanStepAttempts === 1) {
      throw new Error('transient database error');
    }
    calls.humanSteps.push(input);
  },
  createWorkflowRun: async () => ({
    pinnedSettings: pinned,
    runId: 'run-test-1',
    spec: currentSpec,
  }),
  executeImplementation: async (...args: unknown[]) => {
    calls.impl.push({ args });
    return implResult(calls.impl.length - 1);
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    calls.finalize.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async (input: Record<string, unknown>) => {
    calls.resolved.push(input);
  },
  runAgentNode: async (input: Record<string, unknown>) => {
    calls.agentNode.push(input);
    return calls.agentNode.length === 1 ? pause('agent digest') : { text: 'agent done' };
  },
  storeContextOverflowBatch: async () => [],
  updateDomainState: async () => {},
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  } catch (e) {
    if (/Failed to start ephemeral server|Forbidden|ECONNREFUSED/.test(String(e))) {
      return;
    }
    throw e;
  }
  worker = await Worker.create({
    activities: fakeActivities,
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  for (const list of Object.values(calls)) {
    list.length = 0;
  }
  pinned = undefined;
  implResult = (n) => (n === 0 ? pause('first digest') : FINAL);
  failFirstHumanStep = false;
  humanStepAttempts = 0;
  currentSpec = IMPL_SPEC();
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const start = (workflowId: string) =>
  env.client.workflow.start('RunnableWorkflow', {
    args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 hours',
    workflowId,
  });

async function waitForHumanSteps(count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (calls.humanSteps.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(calls.humanSteps.length).toBeGreaterThanOrEqual(count);
  // Let the workflow reach the wait before the signal, as a person would.
  await new Promise((r) => setTimeout(r, 300));
}

/** The ids of the `patched()` markers a history recorded. */
function markerIds(history: Awaited<ReturnType<WorkflowHandle['fetchHistory']>>): string[] {
  const ids: string[] = [];
  for (const e of history.events ?? []) {
    const data = e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
    if (data) {
      ids.push(JSON.parse(Buffer.from(data).toString()).id as string);
    }
  }
  return ids;
}

const signalOf = (n: number) => String(calls.humanSteps[n]?.signalName);

describe('ask and resume (TestWorkflowEnvironment)', () => {
  it('opens a human step for a pause, resumes the activity with the answers and completes', async () => {
    const handle = await start('wf-ask-ok');
    await waitForHumanSteps(1);

    expect(calls.humanSteps).toHaveLength(1);
    expect(calls.humanSteps[0]).toMatchObject({
      context: 'first digest',
      kind: 'INPUT',
      nodeId: 'impl:ask:1',
      runId: 'run-test-1',
      signalName: 'hitl_impl:ask:1',
      timeout: '86400s',
      title: 'implementer needs input',
    });
    const fields = calls.humanSteps[0]?.fields as Array<Record<string, unknown>>;
    expect(fields.map((f) => [f.key, f.type])).toEqual([
      ['q1', 'select'],
      ['q2', 'text'],
      ['note', 'text'],
    ]);
    expect(fields[0]?.options).toEqual(['Alpha', 'Beta']);
    expect(String(calls.humanSteps[0]?.description)).toContain('Which library?');

    await handle.signal(signalOf(0), ANSWER);
    const result = (await handle.result()) as { branch?: string; status: string };

    expect(result).toMatchObject({ branch: 'auto/T-1', status: 'SUCCESS' });
    expect(calls.impl).toHaveLength(2);
    // The pause arrives as the ninth argument, the earlier optional ones left unset.
    expect(calls.impl[0]?.args).toHaveLength(9);
    expect(calls.impl[0]?.args[8]).toEqual({ allowPause: true });
    const resumed = calls.impl[1]?.args[8] as {
      allowPause: boolean;
      resumeInput: { answers: unknown[]; resume: { digest: string }; round: number };
    };
    expect(resumed.allowPause).toBe(true);
    expect(resumed.resumeInput.round).toBe(1);
    expect(resumed.resumeInput.resume.digest).toBe('first digest');
    expect(resumed.resumeInput.answers).toEqual([
      { answer: 'Beta', question: 'Which library?' },
      { answer: ['Linux', 'Mac'], question: 'Which targets?' },
      { answer: 'prefer v2', question: 'Additional note from the person' },
    ]);
    // The answered step is the person's to close; the workflow marks only a timeout.
    expect(calls.resolved).toEqual([]);
    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'SUCCESS' });
  }, 120_000);

  it('records the needs-input-v1 marker before the first activity, which is what gates the loop', async () => {
    // An execution that started before the loop existed has no marker in its history and
    // replays down the old path; a run that does ask must record one. If the guard is
    // removed this fails, instead of the gap showing up as a stranded production workflow.
    const handle = await start('wf-ask-marker');
    await waitForHumanSteps(1);
    await handle.signal(signalOf(0), ANSWER);
    await handle.result();

    const events = (await handle.fetchHistory()).events ?? [];
    const patchId = (e: (typeof events)[number]): string | undefined => {
      const data = e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
      return data ? (JSON.parse(Buffer.from(data).toString()).id as string) : undefined;
    };
    const marker = events.findIndex((e) => patchId(e) === 'needs-input-v1');
    const firstImpl = events.findIndex(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'executeImplementation'
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(firstImpl).toBeGreaterThan(marker);
  }, 120_000);

  it('gives the workspace agent node the same loop', async () => {
    currentSpec = makeSpec(
      {
        agent: {
          agentRef: 'writer@2',
          next: 'done',
          type: 'agent',
          workspace: true,
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      'agent'
    );
    const handle = await start('wf-ask-agent-node');
    await waitForHumanSteps(1);
    expect(calls.humanSteps[0]).toMatchObject({
      nodeId: 'agent:ask:1',
      title: 'writer needs input',
    });
    await handle.signal(signalOf(0), ANSWER);
    await handle.result();
    expect(calls.agentNode).toHaveLength(2);
    expect(calls.agentNode[0]).toMatchObject({ allowPause: true });
    expect(calls.agentNode[0]).not.toHaveProperty('resumeInput');
    expect(calls.agentNode[1]).toMatchObject({ allowPause: true, resumeInput: { round: 1 } });
  }, 120_000);

  it('does not offer to pause an agent node without a workspace', async () => {
    currentSpec = makeSpec(
      {
        agent: { agentRef: 'writer', next: 'done', type: 'agent' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      'agent'
    );
    calls.agentNode.length = 0;
    const result = (await env.client.workflow.execute('RunnableWorkflow', {
      args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
      taskQueue: TASK_QUEUE,
      workflowId: 'wf-ask-no-workspace',
    })) as { status: string };
    // The fake pauses on its first call; without the loop that result is simply the output.
    expect(result.status).toBe('SUCCESS');
    expect(calls.agentNode).toHaveLength(1);
    expect(calls.agentNode[0]).not.toHaveProperty('allowPause');
    expect(calls.humanSteps).toHaveLength(0);
  }, 120_000);

  it('uses the pinned timeout, and fails NEEDS_INPUT_TIMEOUT when nobody answers', async () => {
    pinned = { 'workflow.needsInputTimeoutSeconds': 600 };
    const handle = await start('wf-ask-timeout');
    const err = await handle.result().catch((e) => e);

    expect(String(err.cause?.type ?? err.cause?.cause?.type ?? err.message)).toContain(
      'NEEDS_INPUT_TIMEOUT'
    );
    expect(calls.humanSteps[0]).toMatchObject({ timeout: '600s' });
    expect(calls.resolved).toEqual([
      { nodeId: 'impl:ask:1', runId: 'run-test-1', status: 'TIMED_OUT' },
    ]);
    expect(calls.impl).toHaveLength(1);
    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('fails NEEDS_INPUT_LIMIT when the step asks more often than the pinned rounds', async () => {
    pinned = { 'workflow.maxNeedsInputRounds': 1 };
    implResult = () => pause('again');
    const handle = await start('wf-ask-limit');
    await waitForHumanSteps(1);
    await handle.signal(signalOf(0), ANSWER);
    const err = await handle.result().catch((e) => e);

    expect(String(err.cause?.type ?? err.cause?.cause?.type ?? err.message)).toContain(
      'NEEDS_INPUT_LIMIT'
    );
    // One question was put to the person; the second pause was refused, after the one
    // last run at the limit that could not ask either.
    expect(calls.humanSteps).toHaveLength(1);
    expect(calls.impl).toHaveLength(3);
    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('asks again in a new round with its own human step', async () => {
    implResult = (n) => (n < 2 ? pause(`digest ${n}`) : FINAL);
    const handle = await start('wf-ask-two-rounds');
    await waitForHumanSteps(1);
    await handle.signal(signalOf(0), ANSWER);
    await waitForHumanSteps(2);
    expect(calls.humanSteps.map((s) => s.nodeId)).toEqual(['impl:ask:1', 'impl:ask:2']);
    await handle.signal(signalOf(1), ANSWER);
    await handle.result();
    const third = calls.impl[2]?.args[8] as { resumeInput: { round: number } } | undefined;
    expect(third?.resumeInput.round).toBe(2);
  }, 120_000);

  it('asks the same round again on a submission that fits no question, without rerunning the activity', async () => {
    const handle = await start('wf-ask-reask');
    await waitForHumanSteps(1);
    await handle.signal(signalOf(0), { action: 'submit', value: { q1: 'Gamma', q2: 'Linux' } });
    await waitForHumanSteps(2);
    expect(calls.humanSteps.map((s) => s.nodeId)).toEqual(['impl:ask:1', 'impl:ask:1.1']);
    expect(String(calls.humanSteps[1]?.description)).toContain('previous answer could not be used');
    expect(String(calls.humanSteps[1]?.description)).toContain('Which library?');
    expect(calls.impl).toHaveLength(1);
    await handle.signal(signalOf(1), ANSWER);
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('SUCCESS');
    expect(calls.impl).toHaveLength(2);
    const resumed = calls.impl[1]?.args[8] as { resumeInput: { round: number } } | undefined;
    expect(resumed?.resumeInput.round).toBe(1);
    expect(markerIds(await handle.fetchHistory())).toContain('needs-input-reask-v1');
  }, 120_000);

  it('fails NEEDS_INPUT_INVALID_ANSWER once the re-asks of a round are used up', async () => {
    const handle = await start('wf-ask-reask-limit');
    const bad = { action: 'submit', value: { q1: 'Gamma', q2: 'Linux' } };
    for (let i = 0; i < 4; i++) {
      await waitForHumanSteps(i + 1);
      await handle.signal(signalOf(i), bad);
    }
    const err = await handle.result().catch((e) => e);
    expect(String(err.cause?.type ?? err.cause?.cause?.type ?? err.message)).toContain(
      'NEEDS_INPUT_INVALID_ANSWER'
    );
    expect(calls.humanSteps.map((s) => s.nodeId)).toEqual([
      'impl:ask:1',
      'impl:ask:1.1',
      'impl:ask:1.2',
      'impl:ask:1.3',
    ]);
    expect(calls.impl).toHaveLength(1);
  }, 120_000);

  it('runs the step one last time, unable to ask, when it pauses at the round limit', async () => {
    pinned = { 'workflow.maxNeedsInputRounds': 1 };
    implResult = (n) => (n < 2 ? pause(`digest ${n}`) : FINAL);
    const handle = await start('wf-ask-final');
    await waitForHumanSteps(1);
    await handle.signal(signalOf(0), ANSWER);
    const result = (await handle.result()) as { branch?: string; status: string };
    expect(result).toMatchObject({ branch: 'auto/T-1', status: 'SUCCESS' });
    expect(calls.humanSteps).toHaveLength(1);
    expect(calls.impl).toHaveLength(3);
    expect(calls.impl[2]?.args[8]).toMatchObject({
      allowPause: false,
      resumeInput: { answers: [], final: true, resume: { digest: 'digest 1' }, round: 2 },
    });
    expect(markerIds(await handle.fetchHistory())).toContain('needs-input-final-round-v1');
  }, 120_000);

  it('closes the open question as cancelled when a fan-out sibling fails', async () => {
    currentSpec = makeSpec(
      {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          itemKey: 'subtask',
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [{ id: 'a' }, { id: 'b' }] },
          subgraph: 'impl',
          type: 'fanOut',
        },
        impl: { next: 'branchDone', step: 'executeImplementation', type: 'step' },
      },
      'fan'
    );
    // One branch asks; the other fails only once that question is open.
    implResult = async (n) => {
      if (n === 0) {
        return pause('sibling');
      }
      const deadline = Date.now() + 15_000;
      while (calls.humanSteps.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      throw ApplicationFailure.nonRetryable('sibling failed', 'SIBLING_FAILED');
    };
    const handle = await start('wf-ask-sibling');
    await handle.result().catch(() => {});

    const asked = String(calls.humanSteps[0]?.nodeId);
    expect(asked).toMatch(/:ask:1$/);
    expect(calls.resolved).toContainEqual({
      nodeId: asked,
      runId: 'run-test-1',
      status: 'CANCELLED',
    });
    expect(markerIds(await handle.fetchHistory())).toContain('needs-input-cancel-v1');
  }, 120_000);

  it('records the cancel marker when the run is cancelled while waiting', async () => {
    const handle = await start('wf-ask-cancel-marker');
    await waitForHumanSteps(1);
    await handle.cancel();
    await handle.result().catch(() => {});
    expect(calls.resolved).toContainEqual({
      nodeId: 'impl:ask:1',
      runId: 'run-test-1',
      status: 'CANCELLED',
    });
  }, 120_000);

  it('ends CANCELLED, and closes the open question, when the run is cancelled while waiting', async () => {
    const handle = await start('wf-ask-cancel');
    await waitForHumanSteps(1);
    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();

    expect(calls.finalize.at(-1)).toEqual({ runId: 'run-test-1', status: 'CANCELLED' });
    expect(calls.cancelled).toContain('run-test-1');
    expect(calls.impl).toHaveLength(1);
  }, 120_000);

  it('runs the activity once per round when creating the human step has to be retried', async () => {
    failFirstHumanStep = true;
    const handle = await start('wf-ask-retry');
    await waitForHumanSteps(1);
    // The failed attempt and its retry name the same step: nothing is created twice.
    expect(humanStepAttempts).toBe(2);
    expect(calls.humanSteps.map((s) => s.nodeId)).toEqual(['impl:ask:1']);
    await handle.signal(signalOf(0), ANSWER);
    await handle.result();
    expect(calls.impl).toHaveLength(2);
  }, 120_000);

  it('passes an activity result that is not a pause through untouched', async () => {
    implResult = () => FINAL;
    const result = (await env.client.workflow.execute('RunnableWorkflow', {
      args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
      taskQueue: TASK_QUEUE,
      workflowId: 'wf-ask-none',
    })) as { branch?: string; status: string };
    expect(result).toMatchObject({ branch: 'auto/T-1', status: 'SUCCESS' });
    expect(calls.humanSteps).toHaveLength(0);
    expect(calls.impl).toHaveLength(1);
  }, 120_000);
});
