import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const update = vi.fn();
let exists = false;

const { ScheduleNotFoundError } = vi.hoisted(() => ({
  ScheduleNotFoundError: class extends Error {},
}));

vi.mock('@temporalio/client', () => ({
  Client: class {},
  Connection: { connect: vi.fn(async () => ({})) },
  ScheduleClient: class {
    create = create;
    getHandle() {
      return {
        describe: async () => {
          if (!exists) {
            throw new ScheduleNotFoundError('not found');
          }
          return {};
        },
        update,
      };
    }
  },
  ScheduleNotFoundError,
  ScheduleOverlapPolicy: { SKIP: 'SKIP' },
  WorkflowIdReusePolicy: {},
  WorkflowNotFoundError: class extends Error {},
}));

import temporalPlugin, { RUN_REAPER_SCHEDULE_ID } from './temporal.js';

describe('syncRunReaperSchedule', () => {
  async function build() {
    const app = Fastify();
    await app.register(temporalPlugin);
    await app.ready();
    return app;
  }

  it('creates the system-wide schedule, no arguments, paused when disabled', async () => {
    exists = false;
    const app = await build();
    await app.temporal.syncRunReaperSchedule({ cronExpression: '*/15 * * * *', enabled: false });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          args: [],
          taskQueue: 'engineering-workflow',
          workflowType: 'ScheduledRunReaperWorkflow',
        }),
        scheduleId: RUN_REAPER_SCHEDULE_ID,
        state: { paused: true },
      })
    );
    expect(RUN_REAPER_SCHEDULE_ID).toBe('auto-swe-run-reaper');
  });

  it('updates an existing schedule in place instead of creating a second', async () => {
    exists = true;
    create.mockClear();
    const app = await build();
    await app.temporal.syncRunReaperSchedule({ cronExpression: '*/15 * * * 1', enabled: true });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
