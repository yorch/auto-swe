/**
 * `consensus-review` and `four-eyes` fix and retry on a CI failure like their siblings
 * (default-engineering, agent-reviewed-pr, code-and-ci). These run the REAL seeded specs
 * through the real RunnableWorkflow in Temporal's time-skipping test server, with every
 * activity replaced by a recording fake.
 *
 * What is pinned here, beyond "it retries":
 * - the fix is pushed only AFTER the review gate (both reviewers / both sign-offs) has run
 *   again on the fixed code, so an approval never covers code it did not see;
 * - three CI failures end the run FAILED (two fixes), the same limit as the siblings.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { CONSENSUS_REVIEW_SPEC, FOUR_EYES_SPEC } from '@auto-swe/shared/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const TASK_QUEUE = 'ci-fix-loop-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Everything the fakes saw, in order. */
let events: string[] = [];
let finalized: Array<{ runId: string; status: string }> = [];
let currentSpec: Record<string, unknown> = {};

const fakeActivities = {
  cancelPendingHumanSteps: async () => {},
  createHumanStep: async (input: { nodeId?: string }) => {
    events.push(`humanStep:${input.nodeId ?? '?'}`);
  },
  createOrUpdatePullRequest: async () => {
    events.push('pushPr');
    return { prNumber: 42, prUrl: 'https://example.test/pr/42' };
  },
  createWorkflowRun: async () => ({
    pinnedSettings: undefined,
    runId: 'run-test-1',
    spec: currentSpec,
  }),
  executeCIFixImplementation: async () => {
    events.push('ciFix');
    return { branch: 'auto/T-1', headSha: 'sha-ci-fix' };
  },
  executeImplementation: async () => {
    events.push('implement');
    return { branch: 'auto/T-1', headSha: 'sha' };
  },
  executeReviewFixImplementation: async () => {
    events.push('reviewFix');
    return { branch: 'auto/T-1', headSha: 'sha-review-fix' };
  },
  fetchCILogs: async () => {
    events.push('fetchLogs');
    return 'lint failed';
  },
  finalizeWorkflowRun: async (runId: string, status: string) => {
    finalized.push({ runId, status });
  },
  recordWorkflowStep: async () => {},
  resolveHumanStep: async () => {},
  runReviewNetwork: async () => {
    events.push('review');
    return { approved: true, rejectionSummary: '', verdicts: [] };
  },
  storeContextOverflowBatch: async () => [],
  updateDomainState: async () => {},
  validateContext: async () => ({ contextSnapshotId: 'cs-1', successCriteria: ['builds'] }),
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
  events = [];
  finalized = [];
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

const REQUEST = {
  budgetTier: 'STANDARD' as const,
  description: 'test',
  externalTicketId: 'T-1',
  repoId: '00000000-0000-4000-8000-000000000001',
  requestPayload: '{}',
  workRequestId: '00000000-0000-4000-8000-000000000002',
} satisfies RepoWorkRequest;

function start(workflowId: string) {
  return env.client.workflow.start('RunnableWorkflow', {
    args: [{ request: REQUEST, templateId: 'tpl-1', templateVersion: 1 }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '2 hours',
    workflowId,
  });
}

async function until(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(cond(), `timed out waiting for ${label}; saw ${events.join(',')}`).toBe(true);
}

const count = (name: string) => events.filter((e) => e === name).length;

/** Park a run until `pushPr` has run `n` times, then deliver a CI result. */
async function ciResult(
  handle: Awaited<ReturnType<typeof start>>,
  afterPushes: number,
  passed: boolean
) {
  await until(`push #${afterPushes}`, () => count('pushPr') >= afterPushes);
  // Let the interpreter reach the wait node; a signal that lands early is kept anyway.
  await env.sleep('1 second');
  await handle.signal('ciPipelineSignal', { logsUrl: 'https://ci.test/logs/1', passed });
}

function useTemplate(name: string) {
  const spec = name === 'four-eyes' ? FOUR_EYES_SPEC : CONSENSUS_REVIEW_SPEC;
  currentSpec = spec as unknown as Record<string, unknown>;
}

/** The gate each template puts between a code change and the pull request. */
const GATES = {
  'consensus-review': {
    // Two reviewer slots per round.
    perPass: ['review', 'review'],
    signOff: async () => {},
  },
  'four-eyes': {
    perPass: ['review', 'humanStep:firstSignoff', 'humanStep:secondSignoff'],
    signOff: async (handle: Awaited<ReturnType<typeof start>>, pass: number) => {
      await until(`first sign-off #${pass}`, () => count('humanStep:firstSignoff') >= pass);
      await env.sleep('1 second');
      await handle.signal('hitl_firstSignoff', { action: 'approve' });
      await until(`second sign-off #${pass}`, () => count('humanStep:secondSignoff') >= pass);
      await env.sleep('1 second');
      await handle.signal('hitl_secondSignoff', { action: 'approve' });
    },
  },
} as const;

describe.each(
  Object.keys(GATES) as Array<keyof typeof GATES>
)('%s fixes and retries on a CI failure', (name) => {
  const gate = GATES[name];

  it('runs the CI fixer, re-reviews the fix, re-pushes, and succeeds once CI passes', async () => {
    useTemplate(name);
    const handle = await start(`wf-ci-fix-once-${name}`);
    await gate.signOff(handle, 1);
    await ciResult(handle, 1, false);
    // The fixed code goes back through the gate before it is pushed again.
    await gate.signOff(handle, 2);
    await ciResult(handle, 2, true);
    const result = (await handle.result()) as { prNumber?: number; status: string };

    expect(result.status).toBe('SUCCESS');
    expect(result.prNumber).toBe(42);
    expect(events).toEqual([
      'implement',
      ...gate.perPass,
      'pushPr',
      'fetchLogs',
      'ciFix',
      ...gate.perPass,
      'pushPr',
    ]);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'SUCCESS' });
  }, 120_000);

  it('fails the run after the same limit as the siblings when CI keeps failing', async () => {
    useTemplate(name);
    const handle = await start(`wf-ci-fix-limit-${name}`);
    await gate.signOff(handle, 1);
    await ciResult(handle, 1, false);
    await gate.signOff(handle, 2);
    await ciResult(handle, 2, false);
    await gate.signOff(handle, 3);
    await ciResult(handle, 3, false);
    const result = (await handle.result()) as { prNumber?: number; status: string };

    // Three CI failures: two fix attempts, then the third failure is terminal.
    expect(result.status).toBe('FAILED');
    expect(result.prNumber).toBe(42);
    expect(count('ciFix')).toBe(2);
    expect(count('pushPr')).toBe(3);
    expect(finalized.at(-1)).toEqual({ runId: 'run-test-1', status: 'FAILED' });
  }, 120_000);

  it('does not fix anything when CI passes the first time', async () => {
    useTemplate(name);
    const handle = await start(`wf-ci-pass-${name}`);
    await gate.signOff(handle, 1);
    await ciResult(handle, 1, true);
    const result = (await handle.result()) as { status: string };

    expect(result.status).toBe('SUCCESS');
    expect(events).toEqual(['implement', ...gate.perPass, 'pushPr']);
  }, 120_000);
});
