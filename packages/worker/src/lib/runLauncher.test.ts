import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowRun: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const activityInfo = vi.fn();
vi.mock('@temporalio/activity', () => ({
  activityInfo: () => activityInfo(),
}));

const { currentRunLauncherId, currentRunLaunchContext } = await import('./runLauncher.js');

const EXECUTION = { runId: 'run-B', workflowId: 'eng-acme-api-T-1' };

beforeEach(() => {
  vi.clearAllMocks();
  activityInfo.mockReturnValue({ workflowExecution: EXECUTION });
});

describe('currentRunLauncherId', () => {
  it("returns the launcher recorded by this execution's own run row", async () => {
    findUnique.mockResolvedValue({ launchedById: 'user-1', temporalRunId: 'run-B' });
    await expect(currentRunLauncherId()).resolves.toBe('user-1');
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workflowId: 'eng-acme-api-T-1' } })
    );
  });

  it('ignores a row left by an earlier execution of the same workflow id', async () => {
    // The row is upserted by workflow id and never rewritten, so a reused id
    // finds the previous execution's row — and its launcher is not ours.
    findUnique.mockResolvedValue({ launchedById: 'user-A', temporalRunId: 'run-A' });
    await expect(currentRunLauncherId()).resolves.toBeNull();
  });

  it('treats a row with no recorded run id as having no launcher', async () => {
    findUnique.mockResolvedValue({ launchedById: 'user-1', temporalRunId: null });
    await expect(currentRunLauncherId()).resolves.toBeNull();
  });

  it('returns null with no run row, and outside an activity', async () => {
    findUnique.mockResolvedValue(null);
    await expect(currentRunLauncherId()).resolves.toBeNull();

    activityInfo.mockImplementation(() => {
      throw new Error('not in activity context');
    });
    await expect(currentRunLauncherId()).resolves.toBeNull();
  });

  it('lets a database failure throw rather than act as the platform', async () => {
    findUnique.mockRejectedValue(new Error('connection reset'));
    await expect(currentRunLauncherId()).rejects.toThrow('connection reset');
  });
});

describe('currentRunLaunchContext', () => {
  it("returns the template and launcher recorded by this execution's own run row", async () => {
    findUnique.mockResolvedValue({
      launchedById: 'user-1',
      templateId: 'tpl-1',
      temporalRunId: 'run-B',
    });
    await expect(currentRunLaunchContext()).resolves.toEqual({
      launchedById: 'user-1',
      workflowTemplateId: 'tpl-1',
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workflowId: 'eng-acme-api-T-1' } })
    );
  });

  it('keeps the template but reports no launcher for a webhook or schedule run', async () => {
    findUnique.mockResolvedValue({
      launchedById: null,
      templateId: 'tpl-1',
      temporalRunId: 'run-B',
    });
    await expect(currentRunLaunchContext()).resolves.toEqual({
      launchedById: null,
      workflowTemplateId: 'tpl-1',
    });
  });

  it('ignores a row left by an earlier execution of the same workflow id', async () => {
    findUnique.mockResolvedValue({
      launchedById: 'user-A',
      templateId: 'tpl-old',
      temporalRunId: 'run-A',
    });
    await expect(currentRunLaunchContext()).resolves.toBeNull();
  });

  it('returns null with no run row, no recorded run id, and outside an activity', async () => {
    findUnique.mockResolvedValue(null);
    await expect(currentRunLaunchContext()).resolves.toBeNull();

    findUnique.mockResolvedValue({ launchedById: 'u', templateId: 't', temporalRunId: null });
    await expect(currentRunLaunchContext()).resolves.toBeNull();

    activityInfo.mockImplementation(() => {
      throw new Error('not in activity context');
    });
    await expect(currentRunLaunchContext()).resolves.toBeNull();
  });

  it('lets a database failure throw', async () => {
    findUnique.mockRejectedValue(new Error('connection reset'));
    await expect(currentRunLaunchContext()).rejects.toThrow('connection reset');
  });
});
