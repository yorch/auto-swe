import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ where: null as unknown }));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _tables: string[], callback: () => unknown) => callback(),
}));

import {
  coveredWorkflowRunRollupDays,
  workflowRunRollupHorizonMs,
} from './workflowRunRollupWindows.js';

describe('workflowRunRollupHorizonMs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the shared scheduled-sweep recompute-days setting', () => {
    vi.stubEnv('WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS', '10');
    const now = Date.UTC(2026, 9, 20, 14);
    expect(workflowRunRollupHorizonMs(now)).toBe(Date.UTC(2026, 9, 10));
  });

  it('treats rollup rows from other bucket versions as uncovered', async () => {
    vi.stubEnv('WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS', '10');
    const day = new Date(Date.UTC(2026, 9, 1));
    const prisma = {
      workflowRunDailyRollup: {
        groupBy: async ({ where }: { where: unknown }) => {
          mocks.where = where;
          return [{ day }];
        },
      },
    };
    const covered = await coveredWorkflowRunRollupDays(
      prisma as never,
      day.getTime(),
      day.getTime() + 86_400_000,
      Date.UTC(2026, 9, 20)
    );
    expect(covered).toEqual(new Set([day.getTime()]));
    expect(mocks.where).toMatchObject({ bucketVersion: 2 });
  });
});
