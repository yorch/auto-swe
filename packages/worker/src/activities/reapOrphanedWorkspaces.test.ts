import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reapOrphans, workspaceBackend } = vi.hoisted(() => {
  const reapOrphans = vi.fn();
  return { reapOrphans, workspaceBackend: vi.fn(() => ({ kind: 'docker', reapOrphans })) };
});
vi.mock('../lib/workspaceBackend/index.js', () => ({ workspaceBackend }));
const logWarn = vi.fn();
vi.mock('../lib/activityLog.js', () => ({
  logWarn: (...a: unknown[]) => logWarn(...a),
}));

import { reapOrphanedWorkspaces } from './reapOrphanedWorkspaces.js';

const NOW = new Date('2026-01-10T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reapOrphanedWorkspaces', () => {
  it('sweeps the worker backend and logs each removal and each failure', async () => {
    reapOrphans.mockResolvedValue({
      failed: [{ error: 'denied', id: 'b' }],
      removed: ['a'],
      scanned: 3,
    });
    const result = await reapOrphanedWorkspaces(NOW);
    expect(reapOrphans).toHaveBeenCalledWith(NOW);
    expect(result).toEqual({ backend: 'docker', failed: 1, removed: 1, scanned: 3 });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('removed an orphaned'), {
      backend: 'docker',
      id: 'a',
    });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('could not'), {
      backend: 'docker',
      err: 'denied',
      id: 'b',
    });
  });

  it('never throws: a backend that cannot be built or swept is a logged failure', async () => {
    reapOrphans.mockRejectedValue(new Error('boom'));
    await expect(reapOrphanedWorkspaces(NOW)).resolves.toMatchObject({ failed: 1, removed: 0 });
    workspaceBackend.mockImplementationOnce(() => {
      throw new Error('bad config');
    });
    await expect(reapOrphanedWorkspaces(NOW)).resolves.toMatchObject({ failed: 1, removed: 0 });
    expect(logWarn).toHaveBeenCalledTimes(2);
  });
});
