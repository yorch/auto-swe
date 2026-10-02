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

import temporalPlugin, {
  MODEL_DISCOVERY_SCHEDULE_ID,
  modelDiscoveryScheduleConfig,
} from './temporal.js';

describe('modelDiscoveryScheduleConfig', () => {
  it('maps each interval to a cron, and off to a paused schedule', () => {
    expect(modelDiscoveryScheduleConfig('daily')).toEqual({
      cronExpression: '17 3 * * *',
      enabled: true,
    });
    expect(modelDiscoveryScheduleConfig('weekly')).toMatchObject({ enabled: true });
    expect(modelDiscoveryScheduleConfig('off').enabled).toBe(false);
  });
});

describe('syncModelDiscoverySchedule', () => {
  async function build() {
    const app = Fastify();
    await app.register(temporalPlugin);
    await app.ready();
    return app;
  }

  it('creates the system-wide schedule, no arguments, paused when off', async () => {
    exists = false;
    const app = await build();
    await app.temporal.syncModelDiscoverySchedule(modelDiscoveryScheduleConfig('off'));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          args: [],
          taskQueue: 'engineering-workflow',
          workflowType: 'ScheduledModelDiscoveryWorkflow',
        }),
        scheduleId: MODEL_DISCOVERY_SCHEDULE_ID,
        state: { paused: true },
      })
    );
    expect(MODEL_DISCOVERY_SCHEDULE_ID).toBe('auto-swe-model-discovery');
  });

  it('updates an existing schedule in place instead of creating a second', async () => {
    exists = true;
    create.mockClear();
    const app = await build();
    await app.temporal.syncModelDiscoverySchedule(modelDiscoveryScheduleConfig('weekly'));
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
