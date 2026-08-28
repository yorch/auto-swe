import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspace } from './resolveWorkspace.js';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import('@auto-swe/shared/db');

describe('resolveWorkspace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves an api_only workspace without a connection', async () => {
    const result = await resolveWorkspace({ workspaceProvider: 'api_only' });
    expect(result).toEqual({ provider: 'api_only' });
  });

  it('resolves a git_repo workspace from a connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultBranch: 'main',
      githubUrl: 'https://ghe.example.com/org/repo.git',
      isActive: true,
      organizationName: 'org',
      repoName: 'repo',
      type: 'git_repo',
    });

    const result = await resolveWorkspace({
      connectionId: 'conn-1',
      workspaceProvider: 'git_repo',
    });

    expect(result).toEqual({
      branch: 'main',
      cloneUrl: 'https://ghe.example.com/org/repo.git',
      connectionId: 'conn-1',
      defaultBranch: 'main',
      provider: 'git_repo',
      repoName: 'repo',
      repoOwner: 'org',
    });
  });

  it('throws for a git_repo connection without owner/name', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultBranch: 'main',
      isActive: true,
      organizationName: null,
      repoName: null,
      type: 'git_repo',
    });

    await expect(
      resolveWorkspace({ connectionId: 'conn-1', workspaceProvider: 'git_repo' })
    ).rejects.toThrow('missing owner/name');
  });

  it('resolves a document workspace from a notion connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { sourceId: 'page-1' },
      isActive: true,
      name: 'Product Docs',
      type: 'notion',
    });

    const result = await resolveWorkspace({
      connectionId: 'conn-2',
      workspaceProvider: 'document',
    });

    expect(result).toEqual({
      connectionId: 'conn-2',
      provider: 'document',
      sourceId: 'page-1',
      workspaceName: 'Product Docs',
    });
  });

  it('throws when a document workspace has no connectionId', async () => {
    await expect(
      resolveWorkspace({ connectionId: null, workspaceProvider: 'document' })
    ).rejects.toThrow('document workspace requires a connectionId');
  });
});
