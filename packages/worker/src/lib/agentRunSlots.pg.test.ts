import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `loadLiveAgentRunSlots` against real Postgres: the ledger read (`ActiveWorkflow` rows of the
 * template that are not terminal). A run stopped at a question keeps its slot for the wait, like
 * every other in-flight run. Temporal is stubbed to report every workflow running.
 *
 * Opt in with `AGENT_RUN_SLOTS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.AGENT_RUN_SLOTS_PG_TEST === '1';

vi.mock('./temporalClient.js', () => ({
  getTemporalClient: () => ({
    workflow: { getHandle: () => ({ describe: async () => ({ status: { name: 'RUNNING' } }) }) },
  }),
}));

describe.skipIf(!enabled)('agent run slots against Postgres', () => {
  let prisma: typeof import('@auto-swe/shared/db').prisma;
  let loadLiveAgentRunSlots: typeof import('./agentRunSlots.js').loadLiveAgentRunSlots;
  const marker = `slots-${randomUUID()}`;
  let templateId = '';
  const runIds: string[] = [];
  const requestIds: string[] = [];

  /** An in-flight agent run: request + ledger row + workflow run, with an optional human step. */
  async function agentRun(
    name: string,
    step?: { kind: 'INPUT' | 'APPROVAL'; nodeId: string; status: 'PENDING' | 'RESOLVED' }
  ) {
    const workflowId = `${marker}-${name}`;
    const request = await prisma.runInput.create({
      data: {
        createdAt: new Date(Date.now() - 3_600_000),
        externalTicketId: workflowId,
        requestPayload: '{}',
        templateId,
      },
    });
    requestIds.push(request.id);
    await prisma.activeWorkflow.create({
      data: {
        currentStatus: 'RUNNING',
        temporalWorkflowId: workflowId,
        workRequestId: request.id,
      },
    });
    const run = await prisma.workflowRun.create({
      data: { specSnapshot: {}, templateId, templateVersion: 1, workflowId },
    });
    runIds.push(run.id);
    if (step) {
      await prisma.workflowHumanStep.create({
        data: {
          kind: step.kind,
          nodeId: step.nodeId,
          runId: run.id,
          signalName: 'sig',
          status: step.status,
          title: 't',
        },
      });
    }
    return workflowId;
  }

  beforeAll(async () => {
    ({ prisma } = await import('@auto-swe/shared/db'));
    ({ loadLiveAgentRunSlots } = await import('./agentRunSlots.js'));
    templateId = (await prisma.workflowTemplate.create({ data: { name: marker } })).id;
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.workflowHumanStep.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.activeWorkflow.deleteMany({ where: { workRequestId: { in: requestIds } } });
    await runUnscoped('remove the slot test requests', ['RunInput'], () =>
      prisma.runInput.deleteMany({ where: { id: { in: requestIds } } })
    );
    await runUnscoped('remove the slot test template', ['WorkflowTemplate'], () =>
      prisma.workflowTemplate.deleteMany({ where: { id: templateId } })
    );
    await prisma.$disconnect();
  });

  it('counts every in-flight run, including one stopped at a pending ask step', async () => {
    const plain = await agentRun('plain');
    const asking = await agentRun('asking', {
      kind: 'INPUT',
      nodeId: 'implement:ask:1',
      status: 'PENDING',
    });
    const answered = await agentRun('answered', {
      kind: 'INPUT',
      nodeId: 'implement:ask:1',
      status: 'RESOLVED',
    });
    const approval = await agentRun('approval', {
      kind: 'APPROVAL',
      nodeId: 'gate:ask:1',
      status: 'PENDING',
    });
    const otherInput = await agentRun('other-input', {
      kind: 'INPUT',
      nodeId: 'form',
      status: 'PENDING',
    });

    const slots = await loadLiveAgentRunSlots(templateId, `${marker}-someone-else`);
    const held = slots.map((s) => s.workflowId).sort();

    expect(held).toEqual([plain, asking, answered, approval, otherInput].sort());
  });

  it('keeps the caller itself while it waits for input', async () => {
    const self = await agentRun('self', {
      kind: 'INPUT',
      nodeId: 'implement:ask:2',
      status: 'PENDING',
    });
    const slots = await loadLiveAgentRunSlots(templateId, self);
    expect(slots.map((s) => s.workflowId)).toContain(self);
  });
});
