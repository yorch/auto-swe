import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ runEvidence: { findMany: vi.fn() } }));
const deleteArtifact = vi.hoisted(() => vi.fn());
const resolveSetting = vi.hoisted(() => vi.fn());

vi.mock('@auto-swe/shared/db', () => ({ prisma }));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({ deleteArtifact }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting }));

import { pruneUiEvidence } from './pruneUiEvidence.js';

describe('pruneUiEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSetting.mockResolvedValue(90);
    prisma.runEvidence.findMany.mockResolvedValue([]);
    deleteArtifact.mockResolvedValue(undefined);
  });

  it('deletes expired evidence through the artifact deletion path', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    prisma.runEvidence.findMany.mockResolvedValueOnce([{ artifactId: 'artifact-1' }]);

    await expect(pruneUiEvidence(now)).resolves.toEqual({
      deleted: 1,
      more: false,
      retentionDays: 90,
    });
    expect(prisma.runEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lt: new Date('2025-10-03T00:00:00.000Z') } },
      })
    );
    expect(deleteArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('leaves evidence available for a retry if artifact deletion fails', async () => {
    prisma.runEvidence.findMany.mockResolvedValueOnce([{ artifactId: 'artifact-1' }]);
    deleteArtifact.mockRejectedValueOnce(new Error('object store unavailable'));
    await expect(pruneUiEvidence()).rejects.toThrow('object store unavailable');
  });
});
