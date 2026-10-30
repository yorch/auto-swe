import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ runEvidence: { findMany: vi.fn() } }));
const deleteArtifact = vi.hoisted(() => vi.fn());
const deleteObjectFromBucket = vi.hoisted(() => vi.fn());
const resolveSetting = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@auto-swe/shared/db', () => ({ prisma }));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact,
  deleteObjectFromBucket,
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting }));
vi.mock('../lib/activityLog.js', () => ({ logWarn }));

import { pruneUiEvidence, publicEvidenceKey } from './pruneUiEvidence.js';

describe('pruneUiEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.UI_EVIDENCE_PUBLIC_BUCKET;
    resolveSetting.mockResolvedValue(90);
    prisma.runEvidence.findMany.mockResolvedValue([]);
    deleteArtifact.mockResolvedValue(undefined);
    deleteObjectFromBucket.mockResolvedValue(undefined);
  });

  it('deletes expired evidence through the artifact deletion path', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    prisma.runEvidence.findMany.mockResolvedValueOnce([
      { artifactId: 'artifact-1', id: 'evidence-1', kind: 'screenshot', runId: 'run-1' },
    ]);

    await expect(pruneUiEvidence(now)).resolves.toEqual({
      deleted: 1,
      more: false,
      publicCopiesDeleted: 0,
      retentionDays: 90,
    });
    expect(prisma.runEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lt: new Date('2025-10-03T00:00:00.000Z') } },
      })
    );
    expect(deleteArtifact).toHaveBeenCalledWith('artifact-1');
    expect(deleteObjectFromBucket).not.toHaveBeenCalled();
  });

  it('deletes the public copy a pull request published for a screenshot', async () => {
    process.env.UI_EVIDENCE_PUBLIC_BUCKET = 'ui-evidence-bucket';
    prisma.runEvidence.findMany.mockResolvedValueOnce([
      { artifactId: 'artifact-1', id: 'evidence-1', kind: 'screenshot', runId: 'run-1' },
      { artifactId: 'artifact-2', id: 'evidence-2', kind: 'video', runId: 'run-1' },
    ]);

    await expect(pruneUiEvidence()).resolves.toMatchObject({ publicCopiesDeleted: 1 });
    expect(deleteObjectFromBucket).toHaveBeenCalledTimes(1);
    expect(deleteObjectFromBucket).toHaveBeenCalledWith(
      'ui-evidence-bucket',
      publicEvidenceKey('run-1', 'evidence-1')
    );
    expect(deleteObjectFromBucket).toHaveBeenCalledWith(
      'ui-evidence-bucket',
      'ui-evidence/run-1/evidence-1.png'
    );
  });

  it('keeps pruning when a public copy cannot be deleted', async () => {
    process.env.UI_EVIDENCE_PUBLIC_BUCKET = 'ui-evidence-bucket';
    prisma.runEvidence.findMany.mockResolvedValueOnce([
      { artifactId: 'artifact-1', id: 'evidence-1', kind: 'screenshot', runId: 'run-1' },
      { artifactId: 'artifact-2', id: 'evidence-2', kind: 'screenshot', runId: 'run-1' },
    ]);
    deleteObjectFromBucket.mockRejectedValueOnce(new Error('bucket policy'));

    await expect(pruneUiEvidence()).resolves.toMatchObject({
      deleted: 2,
      publicCopiesDeleted: 1,
    });
    expect(logWarn).toHaveBeenCalled();
  });

  it('leaves evidence available for a retry if artifact deletion fails', async () => {
    prisma.runEvidence.findMany.mockResolvedValueOnce([
      { artifactId: 'artifact-1', id: 'evidence-1', kind: 'screenshot', runId: 'run-1' },
    ]);
    deleteArtifact.mockRejectedValueOnce(new Error('object store unavailable'));
    await expect(pruneUiEvidence()).rejects.toThrow('object store unavailable');
  });
});
