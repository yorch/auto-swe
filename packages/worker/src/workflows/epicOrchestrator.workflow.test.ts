/**
 * Workflow-level test for the epic orchestrator's cancel signal, run in
 * Temporal's time-skipping test server. The children are a stand-in
 * `RunnableWorkflow` (see `testing/epicCancelWorkflows.ts`) that blocks until
 * cancelled, so the test observes whether the signal reaches them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EpicRequest } from '@auto-swe/shared/types/workflow';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The orchestrator starts its children on this queue by name.
const TASK_QUEUE = 'engineering-workflow';

const templateResolutions: string[] = [];
const cancelledChildren: string[] = [];
const finishedChildren: string[] = [];
const domainStates: string[] = [];
/**
 * repoId → the stand-in child's script (`sleep:<ms>:<status>`, see
 * `testing/epicCancelWorkflows.ts`). A repo with no entry blocks until cancelled.
 */
const childScripts = new Map<string, string>();

const fakeActivities = {
  async planEpic(): Promise<never> {
    throw new Error('planEpic should not run: the request carries its repos');
  },
  async recordChildCancelled(workflowId: string): Promise<void> {
    cancelledChildren.push(workflowId);
  },
  async recordChildFinished(workflowId: string): Promise<void> {
    finishedChildren.push(workflowId);
  },
  async resolveTemplateForRepo(repoId: string) {
    templateResolutions.push(repoId);
    return { templateId: childScripts.get(repoId) ?? 'tpl', templateVersion: 1 };
  },
  async updateDomainState(_workflowId: string, status: string): Promise<void> {
    domainStates.push(status);
  },
};

let env: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;

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
    workflowsPath: path.resolve(__dirname, './testing/epicCancelWorkflows.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  templateResolutions.length = 0;
  cancelledChildren.length = 0;
  finishedChildren.length = 0;
  domainStates.length = 0;
  childScripts.clear();
});

function epicRequest(id: string, repos: EpicRequest['repos']): EpicRequest {
  return {
    description: 'epic',
    epicWorkflowId: id,
    externalTicketId: id,
    repos,
    workRequestId: '00000000-0000-0000-0000-000000000001',
  } as EpicRequest;
}

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

describe('EpicOrchestratorWorkflow — epicCancelSignal', () => {
  it('cancels the in-flight child workflows, not just the loop that would start more', async () => {
    if (!env) {
      return;
    }
    const epicWorkflowId = 'epic-CANCEL-1';
    const request: EpicRequest = {
      description: 'epic',
      epicWorkflowId,
      externalTicketId: 'CANCEL-1',
      repos: [
        { dependsOn: [], repoId: 'repo-a' },
        { dependsOn: [], repoId: 'repo-b' },
        // Blocked behind repo-a: must never start.
        { dependsOn: ['repo-a'], repoId: 'repo-c' },
      ],
      workRequestId: '00000000-0000-0000-0000-000000000001',
    } as EpicRequest;

    const handle = await env.client.workflow.start('EpicOrchestratorWorkflow', {
      args: [request],
      taskQueue: TASK_QUEUE,
      workflowId: epicWorkflowId,
    });

    // Wait until both independent children are running.
    for (let i = 0; i < 200 && templateResolutions.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const children = ['repo-a', 'repo-b'].map((r) =>
      env?.client.workflow.getHandle(`${epicWorkflowId}-${r}`)
    );
    for (const child of children) {
      for (let i = 0; i < 200; i++) {
        try {
          const d = await child?.describe();
          if (d?.status.name === 'RUNNING') {
            break;
          }
        } catch {
          /* not started yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    await handle.signal('epicCancelSignal');
    const result = await handle.result();

    expect(result.status).toBe('CANCELLED');
    expect(cancelledChildren.sort()).toEqual([
      `${epicWorkflowId}-repo-a`,
      `${epicWorkflowId}-repo-b`,
    ]);
    expect(templateResolutions).not.toContain('repo-c');
    expect(domainStates.at(-1)).toBe('CANCELLED');
    for (const child of children) {
      expect((await child?.describe())?.status.name).toBe('CANCELLED');
    }
  }, 60_000);
});

describe('EpicOrchestratorWorkflow — scheduling', () => {
  it('starts a repo as soon as its own deps succeed, not when its wave finishes', async () => {
    if (!env) {
      return;
    }
    const id = 'epic-EVENT-1';
    // slow is unrelated to fast → next. Under wave scheduling next waits for
    // slow (one hour); event-driven, it starts the moment fast succeeds.
    childScripts.set('slow', 'sleep:3600000:SUCCESS');
    childScripts.set('fast', 'sleep:60000:SUCCESS');
    childScripts.set('next', 'sleep:60000:SUCCESS');
    const result = await env.client.workflow.execute('EpicOrchestratorWorkflow', {
      args: [
        epicRequest(id, [
          { dependsOn: [], repoId: 'slow' },
          { dependsOn: [], repoId: 'fast' },
          { dependsOn: ['fast'], repoId: 'next' },
        ]),
      ],
      taskQueue: TASK_QUEUE,
      workflowId: id,
    });

    expect(result.status).toBe('SUCCESS');
    expect(finishedChildren).toEqual([`${id}-fast`, `${id}-next`, `${id}-slow`]);
    expect(domainStates.at(-1)).toBe('COMPLETED');
  }, 60_000);

  it('skips the dependents of a failed repo and reports the epic FAILED', async () => {
    if (!env) {
      return;
    }
    const id = 'epic-FAIL-1';
    childScripts.set('a', 'sleep:1000:SUCCESS');
    childScripts.set('b', 'sleep:1000:FAILED');
    childScripts.set('c', 'sleep:1000:SUCCESS');
    const result = await env.client.workflow.execute('EpicOrchestratorWorkflow', {
      args: [
        epicRequest(id, [
          { dependsOn: [], repoId: 'a' },
          { dependsOn: [], repoId: 'b' },
          { dependsOn: ['b'], repoId: 'c' },
        ]),
      ],
      taskQueue: TASK_QUEUE,
      workflowId: id,
    });

    expect(result.status).toBe('FAILED');
    expect(result.childResults.a?.status).toBe('SUCCESS');
    expect(result.childResults.b?.status).toBe('FAILED');
    expect(result.childResults.c).toMatchObject({
      skippedReason: 'upstream b failed',
      status: 'SKIPPED',
    });
    expect(templateResolutions).not.toContain('c');
  }, 60_000);

  it('reports an epic with no repos FAILED, never vacuously SUCCESS', async () => {
    if (!env) {
      return;
    }
    const id = 'epic-EMPTY-1';
    const result = await env.client.workflow.execute('EpicOrchestratorWorkflow', {
      args: [epicRequest(id, [])],
      taskQueue: TASK_QUEUE,
      workflowId: id,
    });

    expect(result.status).toBe('FAILED');
    expect(domainStates.at(-1)).toBe('FAILED');
  }, 60_000);
});
