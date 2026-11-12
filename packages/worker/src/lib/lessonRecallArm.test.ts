import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findRun, temporalRunId } = vi.hoisted(() => ({ findRun: vi.fn(), temporalRunId: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findUnique: findRun } } }));
vi.mock('./activityContext.js', () => ({
  currentTemporalRunId: temporalRunId,
  currentWorkflowId: () => 'trusted-workflow',
}));

import { currentLessonRecallArm } from './lessonRecallArm.js';

beforeEach(() => {
  vi.clearAllMocks();
  temporalRunId.mockReturnValue('execution');
});
describe('trusted lesson recall arm', () => {
  it.each(['ON', 'SHADOW', 'OFF'])(
    'reads the persisted %s arm by Temporal identity',
    async (arm) => {
      findRun.mockResolvedValue({ lessonRecallArm: arm });
      expect(await currentLessonRecallArm()).toBe(arm);
      expect(findRun).toHaveBeenCalledWith({
        select: { lessonRecallArm: true },
        where: { workflowId: 'trusted-workflow' },
      });
    }
  );
  it('defaults runless and nullable legacy rows to ON', async () => {
    temporalRunId.mockReturnValue(null);
    expect(await currentLessonRecallArm()).toBe('ON');
    expect(findRun).not.toHaveBeenCalled();
    temporalRunId.mockReturnValue('execution');
    for (const row of [null, { lessonRecallArm: null }]) {
      findRun.mockResolvedValue(row);
      expect(await currentLessonRecallArm()).toBe('ON');
    }
  });
  it('propagates a read failure instead of falling back to ON', async () => {
    findRun.mockRejectedValue(new Error('database unavailable'));
    await expect(currentLessonRecallArm()).rejects.toThrow('database unavailable');
  });
});
