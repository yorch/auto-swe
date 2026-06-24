import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  evalDataset: { findFirst: vi.fn() },
  evalRun: { create: vi.fn() },
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: prismaMock }));

import { prepareScheduledEvalRun } from './prepareScheduledEvalRun.js';

const INPUT = { baselineRef: 'last-release', candidateRef: 'main', datasetSlug: 'golden' };

beforeEach(() => vi.clearAllMocks());

describe('prepareScheduledEvalRun', () => {
  it('resolves the dataset by slug and creates a fresh EvalRun row', async () => {
    prismaMock.evalDataset.findFirst.mockResolvedValue({ id: 'ds-1' });
    prismaMock.evalRun.create.mockResolvedValue({ id: 'run-1' });

    const out = await prepareScheduledEvalRun(INPUT);

    expect(prismaMock.evalDataset.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { slug: 'golden' },
    });
    expect(prismaMock.evalRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ datasetId: 'ds-1', status: 'RUNNING' }),
      })
    );
    expect(out).toEqual({
      baselineRef: 'last-release',
      candidateRef: 'main',
      datasetId: 'ds-1',
      evalRunId: 'run-1',
    });
  });

  it('returns null (no-op) when the dataset slug does not exist', async () => {
    prismaMock.evalDataset.findFirst.mockResolvedValue(null);

    const out = await prepareScheduledEvalRun(INPUT);

    expect(out).toBeNull();
    expect(prismaMock.evalRun.create).not.toHaveBeenCalled();
  });
});
