import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspace } from './resolveWorkspace.js';

vi.mock('@auto-swe/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@auto-swe/shared')>();
  return {
    ...mod,
    decryptConnectionApiToken: () => 'test-token',
  };
});

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: vi.fn() },
  },
}));

vi.mock('../connectors/notion.js', () => ({
  readNotionPage: vi.fn(),
}));

const { prisma } = await import('@auto-swe/shared/db');
const { readNotionPage } = await import('../connectors/notion.js');

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
      config: { sourcePageId: 'page-1' },
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

  it('validates the source page when a token is present', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiKeyAuthTag: Buffer.from('tag'),
      apiKeyCiphertext: Buffer.from('cipher'),
      apiKeyNonce: Buffer.from('nonce'),
      apiKeyVersion: 1,
      config: {},
      isActive: true,
      name: 'Product Docs',
      type: 'notion',
    });
    (readNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      blocks: [],
      page: { id: 'page-1', object: 'page', properties: {}, url: 'https://notion.so/page-1' },
    });

    const result = await resolveWorkspace({
      connectionId: 'conn-2',
      payload: { pageId: 'page-1' },
      workspaceProvider: 'document',
    });

    expect(result).toEqual({
      connectionId: 'conn-2',
      provider: 'document',
      sourceId: 'page-1',
      workspaceName: 'Product Docs',
    });
    expect(readNotionPage).toHaveBeenCalledWith({ apiToken: 'test-token' }, 'page-1');
  });

  it('throws when a document workspace has no connectionId', async () => {
    await expect(
      resolveWorkspace({ connectionId: null, workspaceProvider: 'document' })
    ).rejects.toThrow('document workspace requires a connectionId');
  });
});
