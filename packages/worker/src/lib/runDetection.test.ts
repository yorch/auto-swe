import { beforeEach, describe, expect, it, vi } from 'vitest';

const DB_NULL = vi.hoisted(() => ({ __sentinel: 'Prisma.DbNull' }));
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: DB_NULL } }));

const findMany = vi.fn();
const findUnique = vi.fn();
const updateMany = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findMany: (...a: unknown[]) => findMany(...a) },
    workflowRun: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));

const currentRunningWorkflowRunId = vi.fn();
vi.mock('./activityContext.js', () => ({
  currentRunningWorkflowRunId: () => currentRunningWorkflowRunId(),
}));

const { detectedStackForRun, pinDetectionsOnRun, snapshotDetections, withRunDetection } =
  await import('./runDetection.js');

const PINNED = { stacks: ['python'] };
const LIVE = { stacks: ['node'] };

beforeEach(() => {
  vi.clearAllMocks();
  currentRunningWorkflowRunId.mockResolvedValue('run-1');
  findUnique.mockResolvedValue({ pinnedDetections: {} });
});

describe('detectedStackForRun', () => {
  it('returns the pinned detection over a different live one', async () => {
    findUnique.mockResolvedValue({ pinnedDetections: { 'repo-1': PINNED } });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toEqual(
      PINNED
    );
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      select: { pinnedDetections: true },
      where: { id: 'run-1' },
    });
  });

  it('keeps a pinned null as "no detection" over a live non-null', async () => {
    findUnique.mockResolvedValue({ pinnedDetections: { 'repo-1': null } });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBeNull();
  });

  it('falls back to the live value for an absent key', async () => {
    findUnique.mockResolvedValue({ pinnedDetections: { 'repo-2': PINNED } });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBe(LIVE);
  });

  it('falls back to the live value for a null column or a missing row', async () => {
    findUnique.mockResolvedValue({ pinnedDetections: null });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBe(LIVE);
    findUnique.mockResolvedValue(null);
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBe(LIVE);
  });

  it('falls back to the live value with no running run, without reading the column', async () => {
    currentRunningWorkflowRunId.mockResolvedValue(undefined);
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBe(LIVE);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('never throws: every failure returns the live value', async () => {
    const repo = { detectedStack: LIVE, id: 'repo-1' };

    findUnique.mockRejectedValue(new Error('db down'));
    await expect(detectedStackForRun(repo)).resolves.toBe(LIVE);

    findUnique.mockResolvedValue({ pinnedDetections: {} });
    currentRunningWorkflowRunId.mockRejectedValue(new Error('no activity context'));
    await expect(detectedStackForRun(repo)).resolves.toBe(LIVE);
  });

  it.each([
    ['a string', 'repo-1'],
    ['an array', [PINNED]],
    ['a number', 7],
    ['a boolean', true],
  ])('ignores a column holding %s', async (_label, pinnedDetections) => {
    findUnique.mockResolvedValue({ pinnedDetections });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: 'repo-1' })).resolves.toBe(LIVE);
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not read an inherited property for repo id %s',
    async (id) => {
      findUnique.mockResolvedValue({ pinnedDetections: {} });
      await expect(detectedStackForRun({ detectedStack: LIVE, id })).resolves.toBe(LIVE);
    }
  );

  it('reads an own key named __proto__', async () => {
    // JSON.parse creates `__proto__` as an own property, which is what a stored column yields.
    findUnique.mockResolvedValue({ pinnedDetections: JSON.parse('{"__proto__": null}') });
    await expect(detectedStackForRun({ detectedStack: LIVE, id: '__proto__' })).resolves.toBeNull();
  });
});

describe('withRunDetection', () => {
  it('returns the repo with the pinned detection, leaving its other fields alone', async () => {
    findUnique.mockResolvedValue({ pinnedDetections: { 'repo-1': PINNED } });
    const repo = { detectedStack: LIVE, gateCommands: { lint: 'x' }, id: 'repo-1' };
    await expect(withRunDetection(repo)).resolves.toEqual({ ...repo, detectedStack: PINNED });
    expect(repo.detectedStack).toBe(LIVE);
  });

  it('returns an equal repo when nothing is pinned', async () => {
    const repo = { detectedStack: LIVE, id: 'repo-1' };
    await expect(withRunDetection(repo)).resolves.toEqual(repo);
  });
});

describe('snapshotDetections', () => {
  it('maps every found connection to its detection, null when it has none', async () => {
    findMany.mockResolvedValue([
      { detectedStack: PINNED, id: 'a' },
      { detectedStack: null, id: 'b' },
    ]);
    await expect(snapshotDetections(['a', 'b', 'gone'])).resolves.toEqual({ a: PINNED, b: null });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      select: { detectedStack: true, id: true },
      where: { id: { in: ['a', 'b', 'gone'] } },
    });
  });

  it('does no query for no connections', async () => {
    await expect(snapshotDetections([])).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('pinDetectionsOnRun', () => {
  it('writes the snapshot only where the column is still unset', async () => {
    findMany.mockResolvedValue([{ detectedStack: PINNED, id: 'a' }]);
    await pinDetectionsOnRun('run-1', ['a']);
    expect(updateMany).toHaveBeenCalledWith({
      data: { pinnedDetections: { a: PINNED } },
      where: { id: 'run-1', pinnedDetections: { equals: DB_NULL } },
    });
  });

  it('pins an empty set rather than leaving the column to be filled later', async () => {
    await pinDetectionsOnRun('run-1', []);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pinnedDetections: {} } })
    );
  });

  it('propagates a database failure to its caller', async () => {
    findMany.mockResolvedValue([]);
    updateMany.mockRejectedValue(new Error('db down'));
    await expect(pinDetectionsOnRun('run-1', ['a'])).rejects.toThrow('db down');
  });
});
