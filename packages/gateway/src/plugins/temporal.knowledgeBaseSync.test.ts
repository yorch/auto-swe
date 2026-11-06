import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const update = vi.fn();
let exists = false;
const { ScheduleNotFoundError } = vi.hoisted(() => ({
  ScheduleNotFoundError: class extends Error {},
}));
vi.mock('@temporalio/client', () => ({
  Client: class {},
  Connection: { connect: vi.fn(async () => ({ close: async () => {} })) },
  ScheduleClient: class {
    create = create;
    getHandle() {
      return {
        describe: async () => {
          if (!exists) {
            throw new ScheduleNotFoundError('missing');
          }
          return {};
        },
        update,
      };
    }
  },
  ScheduleNotFoundError,
  ScheduleOverlapPolicy: { SKIP: 'SKIP' },
  WorkflowIdConflictPolicy: {},
  WorkflowIdReusePolicy: {},
  WorkflowNotFoundError: class extends Error {},
}));

import temporalPlugin, { KNOWLEDGE_BASE_SYNC_SCHEDULE_ID } from './temporal.js';

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  create.mockReset();
  update.mockReset();
  exists = false;
  app = Fastify();
  await app.register(temporalPlugin);
  await app.ready();
  await app.temporalConnection.whenConnected();
});
afterEach(async () => {
  await app.close();
});

describe('knowledge base sync schedule', () => {
  it('creates the named sweep on its configured cron and pauses when disabled', async () => {
    await app.temporal.syncKnowledgeBaseSyncSchedule({
      cronExpression: '*/30 * * * *',
      enabled: false,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: {
          args: [],
          taskQueue: 'engineering-workflow',
          type: 'startWorkflow',
          workflowType: 'ScheduledKnowledgeBaseSyncWorkflow',
        },
        scheduleId: KNOWLEDGE_BASE_SYNC_SCHEDULE_ID,
        spec: { cronExpressions: ['*/30 * * * *'] },
        state: { paused: true },
      })
    );
    expect(KNOWLEDGE_BASE_SYNC_SCHEDULE_ID).toBe('auto-swe-knowledge-base-sync');
  });
  it('updates an existing schedule in place and unpauses when enabled', async () => {
    exists = true;
    await app.temporal.syncKnowledgeBaseSyncSchedule({
      cronExpression: '0 * * * *',
      enabled: true,
    });
    expect(create).not.toHaveBeenCalled();
    const replacement = await update.mock.calls[0][0]({ action: {} });
    expect(replacement).toMatchObject({
      spec: { cronExpressions: ['0 * * * *'] },
      state: { paused: false },
    });
  });
});
