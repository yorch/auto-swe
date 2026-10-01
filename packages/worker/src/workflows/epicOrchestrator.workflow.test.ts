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
const domainStates: string[] = [];

const fakeActivities = {
  async planEpic(): Promise<never> {
    throw new Error('planEpic should not run: the request carries its repos');
  },
  async recordChildCancelled(workflowId: string): Promise<void> {
    cancelledChildren.push(workflowId);
  },
  async resolveTemplateForRepo(repoId: string) {
    templateResolutions.push(repoId);
    return { templateId: 'tpl', templateVersion: 1 };
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
});

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
