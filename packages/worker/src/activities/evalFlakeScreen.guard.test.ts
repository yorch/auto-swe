import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMany } = vi.hoisted(() => ({
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { evalCase: { updateMany } } }));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));

import { _defaults, type ScreenCaseRow } from './evalFlakeScreen.js';

const row = (stack: string | null | undefined): ScreenCaseRow => ({
  baselineSha: 'sha',
  goldenTest: 'go test ./...',
  id: 'case-1',
  infraErrors: 0,
  input: null,
  repoUrl: 'https://x/y',
  stack,
  tags: [],
});

beforeEach(() => updateMany.mockClear());

// A screen runs a case's reference in the image of the stack the case had when it loaded it. If an
// admin moves the case to another stack meanwhile, the PATCH resets it, but the screen in flight
// still passes the write's old checks (the reference is unchanged and `flakeRuns` was already 0)
// unless the write also names the stack — and would mark the case screened for an environment it no
// longer runs in.
describe('a screen in flight cannot record into a case that has moved to another stack', () => {
  it('records a verdict only where the case still has the stack it ran in', async () => {
    await _defaults.defaultRecordScreen(row('python'), true, 3);
    expect(updateMany).toHaveBeenCalledWith({
      data: { flakeRuns: 3, flakeScreened: true },
      where: {
        baselineSha: 'sha',
        flakeRuns: 0,
        goldenTest: 'go test ./...',
        id: 'case-1',
        repoUrl: 'https://x/y',
        stack: 'python',
      },
    });
  });

  it('treats a case with no stack as node: the guard is `stack IS NULL`, not no guard', async () => {
    await _defaults.defaultRecordScreen(row(null), false, 3);
    await _defaults.defaultRecordScreen(row(undefined), false, 3);
    for (const call of updateMany.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toHaveProperty('stack', null);
    }
  });

  it('guards both writes of an infrastructure failure the same way', async () => {
    await _defaults.defaultRecordInfraError(row('jvm'), 3);
    expect(updateMany).toHaveBeenCalledTimes(2);
    for (const call of updateMany.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({
        id: 'case-1',
        stack: 'jvm',
      });
    }
  });
});
