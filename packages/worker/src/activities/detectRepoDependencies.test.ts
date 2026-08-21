import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectionFindUnique = vi.fn();
const connectionFindMany = vi.fn();
const repoDependencyFindFirst = vi.fn();
const repoDependencyCreate = vi.fn();
const repoDependencyUpdate = vi.fn();
const repoDependencyDelete = vi.fn();

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findMany: (...args: unknown[]) => connectionFindMany(...args),
      findUnique: (...args: unknown[]) => connectionFindUnique(...args),
    },
    repoDependency: {
      create: (...args: unknown[]) => repoDependencyCreate(...args),
      delete: (...args: unknown[]) => repoDependencyDelete(...args),
      findFirst: (...args: unknown[]) => repoDependencyFindFirst(...args),
      update: (...args: unknown[]) => repoDependencyUpdate(...args),
    },
  },
}));

const fetchFileContent = vi.fn();
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ fetchFileContent: (...args: unknown[]) => fetchFileContent(...args) }),
  toRepoRef: (repo: { organizationName: string; repoName: string }) => ({
    apiUrl: null,
    baseUrl: null,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  }),
}));

const { detectRepoDependencies } = await import('./detectRepoDependencies.js');

const BASE_CONNECTION = {
  githubApiUrl: null,
  githubUrl: null,
  id: 'repo-self',
  isActive: true,
  organizationName: 'acme',
  repoName: 'payments-api',
  team: { orgId: 'org-1' },
  type: 'git_repo',
};

/** Every fetch returns null (missing) unless overridden per test. */
function stubFiles(overrides: Record<string, string | null>) {
  fetchFileContent.mockImplementation(async (_repo: unknown, path: string) =>
    path in overrides ? overrides[path] : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionFindMany.mockResolvedValue([]);
  repoDependencyFindFirst.mockResolvedValue(null);
  repoDependencyCreate.mockResolvedValue({ id: 'edge-new' });
  repoDependencyUpdate.mockResolvedValue({ id: 'edge-existing' });
  repoDependencyDelete.mockResolvedValue({ id: 'edge-stale' });
  fetchFileContent.mockResolvedValue(null);
});

describe('detectRepoDependencies', () => {
  it('skips gracefully when the connection is not found', async () => {
    connectionFindUnique.mockResolvedValue(null);
    const result = await detectRepoDependencies({ repoId: 'missing' });
    expect(result).toEqual({ edgesUpserted: 0, scanned: [], suggestions: 0 });
    expect(fetchFileContent).not.toHaveBeenCalled();
  });

  it('skips gracefully for a non-git_repo connection', async () => {
    connectionFindUnique.mockResolvedValue({ ...BASE_CONNECTION, type: 'mcp' });
    const result = await detectRepoDependencies({ repoId: 'repo-self' });
    expect(result).toEqual({ edgesUpserted: 0, scanned: [], suggestions: 0 });
  });

  it('skips gracefully for an inactive connection', async () => {
    connectionFindUnique.mockResolvedValue({ ...BASE_CONNECTION, isActive: false });
    const result = await detectRepoDependencies({ repoId: 'repo-self' });
    expect(result).toEqual({ edgesUpserted: 0, scanned: [], suggestions: 0 });
  });

  it('returns scanned:[] and no edges when no manifest files exist', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    const result = await detectRepoDependencies({ repoId: 'repo-self' });
    expect(result).toEqual({ edgesUpserted: 0, scanned: [], suggestions: 0 });
    expect(connectionFindMany).not.toHaveBeenCalled();
  });

  it('creates a resolved edge for a manifest dependency that matches a candidate repo', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-shared',
        organizationName: 'acme',
        packageNames: ['@acme/shared-lib'],
        repoName: 'shared-lib',
      },
    ]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(1);
    expect(result.suggestions).toBe(0);
    expect(result.scanned).toEqual(['package.json']);
    expect(repoDependencyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromRepoId: 'repo-self',
          kind: 'code',
          source: 'manifest',
          status: 'active',
          toRepoId: 'repo-shared',
        }),
      })
    );
  });

  it('creates an unresolved suggestion for a dependency with no matching candidate', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { 'left-pad': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(0);
    expect(result.suggestions).toBe(1);
    expect(repoDependencyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromRepoId: 'repo-self',
          status: 'unresolved',
          toRef: 'left-pad',
          toRepoId: null,
        }),
      })
    );
  });

  it('skips a self-edge when the raw dependency resolves to the scanned repo itself', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { 'self-pkg': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-self',
        organizationName: 'acme',
        packageNames: ['self-pkg'],
        repoName: 'payments-api',
      },
    ]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(0);
    expect(result.suggestions).toBe(0);
    expect(repoDependencyCreate).not.toHaveBeenCalled();
  });

  it('is idempotent: re-running with an existing active edge updates instead of duplicating', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-shared',
        organizationName: 'acme',
        packageNames: ['@acme/shared-lib'],
        repoName: 'shared-lib',
      },
    ]);
    repoDependencyFindFirst.mockResolvedValue({ id: 'edge-1', status: 'active' });

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(1);
    expect(repoDependencyCreate).not.toHaveBeenCalled();
    expect(repoDependencyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'edge-1' } })
    );
  });

  it('respects the dismiss veto: never resurrects a dismissed edge', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-shared',
        organizationName: 'acme',
        packageNames: ['@acme/shared-lib'],
        repoName: 'shared-lib',
      },
    ]);
    repoDependencyFindFirst.mockResolvedValue({ id: 'edge-1', status: 'dismissed' });

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(0);
    expect(repoDependencyCreate).not.toHaveBeenCalled();
    expect(repoDependencyUpdate).not.toHaveBeenCalled();
  });

  it('scopes candidate lookup to the same tenant org', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([]);

    await detectRepoDependencies({ repoId: 'repo-self' });

    expect(connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ team: { orgId: 'org-1' } }),
      })
    );
  });

  it('tolerates an individual file-fetch failure and continues scanning others', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    fetchFileContent.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === 'package.json') {
        throw new Error('network blip');
      }
      if (path === 'go.mod') {
        return 'module acme.com/payments\n\nrequire github.com/acme/shared-lib v1.0.0\n';
      }
      return null;
    });
    connectionFindMany.mockResolvedValue([
      { id: 'repo-shared', organizationName: 'acme', packageNames: [], repoName: 'shared-lib' },
    ]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.scanned).toEqual(['go.mod']);
    expect(result.edgesUpserted).toBe(1);
  });

  it('picks up .gitmodules and CODEOWNERS as git_signal-sourced dependencies', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      '.gitmodules':
        '[submodule "vendor/shared"]\n\turl = https://github.com/acme/shared-lib.git\n',
      CODEOWNERS: '* @acme/shared-lib\n',
    });
    connectionFindMany.mockResolvedValue([
      { id: 'repo-shared', organizationName: 'acme', packageNames: [], repoName: 'shared-lib' },
    ]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.scanned).toEqual(['.gitmodules', 'CODEOWNERS']);
    expect(repoDependencyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'git_signal' }) })
    );
  });

  it('only tries one CODEOWNERS location — the first one found', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      '.github/CODEOWNERS': '* @acme/shared-lib\n',
      CODEOWNERS: '* @acme/shared-lib\n',
    });
    connectionFindMany.mockResolvedValue([]);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.scanned).toEqual(['CODEOWNERS']);
  });
  it('closes out an unresolved suggestion once its repo is onboarded', async () => {
    // First sweep recorded `@acme/shared-lib` as unresolved. The repo has since
    // been onboarded, so this sweep resolves it — the suggestion must not be
    // left stranded in the onboarding list alongside the new edge.
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-shared',
        organizationName: 'acme',
        packageNames: ['@acme/shared-lib'],
        repoName: 'shared-lib',
      },
    ]);
    repoDependencyFindFirst
      // the stale-suggestion lookup
      .mockResolvedValueOnce({ id: 'edge-stale', status: 'unresolved', toRef: '@acme/shared-lib' })
      // the resolved-edge lookup inside upsertEdge
      .mockResolvedValueOnce(null);

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(1);
    expect(repoDependencyDelete).toHaveBeenCalledWith({ where: { id: 'edge-stale' } });
  });

  it('carries a dismissed suggestion forward instead of resurrecting it as an edge', async () => {
    // The team already said no to `@acme/shared-lib`; onboarding the repo must
    // not quietly convert that rejection into an active dependency.
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': JSON.stringify({ dependencies: { '@acme/shared-lib': '1.0.0' } }),
    });
    connectionFindMany.mockResolvedValue([
      {
        id: 'repo-shared',
        organizationName: 'acme',
        packageNames: ['@acme/shared-lib'],
        repoName: 'shared-lib',
      },
    ]);
    repoDependencyFindFirst.mockResolvedValueOnce({
      id: 'edge-stale',
      status: 'dismissed',
      toRef: '@acme/shared-lib',
    });

    const result = await detectRepoDependencies({ repoId: 'repo-self' });

    expect(result.edgesUpserted).toBe(0);
    expect(repoDependencyCreate).not.toHaveBeenCalled();
    expect(repoDependencyDelete).not.toHaveBeenCalled();
  });
});
