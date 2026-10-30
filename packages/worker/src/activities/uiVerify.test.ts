import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUniqueOrThrow: vi.fn() } },
}));
vi.mock('../lib/requireRepoId.js', () => ({ requireRepoId: () => 'repo-1' }));

import { prisma } from '@auto-swe/shared/db';
import { runUiVerify } from './uiVerify.js';

const findRepo = prisma.connection.findUniqueOrThrow as unknown as ReturnType<typeof vi.fn>;

describe('runUiVerify', () => {
  it('returns the exact successful skip result when no preview is configured', async () => {
    findRepo.mockResolvedValue({ previewConfig: null });

    await expect(
      runUiVerify({ request: { workRequestId: 'work-1' } as RepoWorkRequest })
    ).resolves.toEqual({
      exitCode: 0,
      passed: true,
      skipped: true,
      summary: 'UI verification skipped: the repository has no app preview configured',
    });
  });
});
