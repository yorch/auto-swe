import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectionFindUnique = vi.fn();
const connectionFindMany = vi.fn();
const connectionUpdate = vi.fn();
const repoDependencyFindFirst = vi.fn();
const repoDependencyCreate = vi.fn();
const repoDependencyUpdate = vi.fn();
const repoDependencyDelete = vi.fn();

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findMany: (...args: unknown[]) => connectionFindMany(...args),
      findUnique: (...args: unknown[]) => connectionFindUnique(...args),
      update: (...args: unknown[]) => connectionUpdate(...args),
    },
    repoDependency: {
      create: (...args: unknown[]) => repoDependencyCreate(...args),
      delete: (...args: unknown[]) => repoDependencyDelete(...args),
      findFirst: (...args: unknown[]) => repoDependencyFindFirst(...args),
      update: (...args: unknown[]) => repoDependencyUpdate(...args),
    },
  },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

const fetchFileContent = vi.fn();
const listDirectory = vi.fn();
const listTree = vi.fn();
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    fetchFileContent: (...args: unknown[]) => fetchFileContent(...args),
    listDirectory: (...args: unknown[]) => listDirectory(...args),
    listTree: (...args: unknown[]) => listTree(...args),
  }),
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
  connectionUpdate.mockResolvedValue({});
  repoDependencyFindFirst.mockResolvedValue(null);
  repoDependencyCreate.mockResolvedValue({ id: 'edge-new' });
  repoDependencyUpdate.mockResolvedValue({ id: 'edge-existing' });
  repoDependencyDelete.mockResolvedValue({ id: 'edge-stale' });
  fetchFileContent.mockResolvedValue(null);
  listDirectory.mockResolvedValue([]);
  listTree.mockResolvedValue(null);
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

  it('persists the detected stack on the connection, manifests and lockfile probes together', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    stubFiles({
      'package.json': '{}',
      'pyproject.toml': '[project]\nname = "x"',
      'yarn.lock': '# yarn lockfile v1',
    });
    listDirectory.mockResolvedValue(['package.json', 'pyproject.toml', 'yarn.lock']);

    await detectRepoDependencies({ repoId: 'repo-self' });

    expect(connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          detectedStack: expect.objectContaining({
            primary: 'node',
            stacks: ['node', 'python'],
            suggestedDockerfile: 'node',
          }),
          detectedStackAt: expect.any(Date),
        }),
        where: { id: 'repo-self' },
      })
    );
  });

  describe('Yarn flavour from the root yarn.lock', () => {
    const yarnFetches = () => fetchFileContent.mock.calls.filter((c) => c[1] === 'yarn.lock');
    const recorded = (): Record<string, unknown> => {
      const call = connectionUpdate.mock.calls[0]?.[0] as
        | { data: { detectedStack: Record<string, unknown> } }
        | undefined;
      if (!call) {
        throw new Error('connection.update was not called');
      }
      return call.data.detectedStack;
    };

    it('reads the lockfile header once for an unpinned yarn root, and records the flavour', async () => {
      connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
      stubFiles({ 'package.json': '{}', 'yarn.lock': `# yarn lockfile v1\n${'x'.repeat(5000)}` });
      listDirectory.mockResolvedValue(['package.json', 'yarn.lock']);

      await detectRepoDependencies({ repoId: 'repo-self' });

      expect(yarnFetches()).toHaveLength(1);
      expect(recorded()).toMatchObject({ packageManager: 'yarn', yarnFlavor: 'classic' });
    });

    it('records Berry from a Berry header', async () => {
      connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
      stubFiles({ 'package.json': '{}', 'yarn.lock': '__metadata:\n  version: 8\n' });
      listDirectory.mockResolvedValue(['package.json', 'yarn.lock']);
      await detectRepoDependencies({ repoId: 'repo-self' });
      expect(recorded()).toMatchObject({ yarnFlavor: 'berry' });
    });

    it('only looks at the first 2 KB of the lockfile', async () => {
      connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
      stubFiles({
        'package.json': '{}',
        'yarn.lock': `${'#'.repeat(2048)}\n# yarn lockfile v1\n`,
      });
      listDirectory.mockResolvedValue(['package.json', 'yarn.lock']);
      await detectRepoDependencies({ repoId: 'repo-self' });
      expect(recorded().yarnFlavor).toBeUndefined();
    });

    it('does not fetch it when a pin, a .yarnrc.yml, another manager or no yarn.lock decides', async () => {
      connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
      const cases: Array<[Record<string, string>, string[]]> = [
        [{ 'package.json': '{"packageManager":"yarn@4.1.0"}' }, ['package.json', 'yarn.lock']],
        [{ 'package.json': '{}' }, ['package.json', 'yarn.lock', '.yarnrc.yml']],
        [{ 'package.json': '{}' }, ['package.json', 'package-lock.json']],
        [{ 'package.json': '{}' }, ['package.json']],
        [{ 'pyproject.toml': 'x' }, ['pyproject.toml', 'yarn.lock']],
        // A component's yarn.lock is not the root's.
        [{}, ['web/package.json', 'web/yarn.lock']],
      ];
      for (const [files, listing] of cases) {
        fetchFileContent.mockClear();
        listDirectory.mockResolvedValue(listing);
        stubFiles({ ...files, 'yarn.lock': '# yarn lockfile v1' });
        await detectRepoDependencies({ repoId: 'repo-self' });
        expect(yarnFetches(), listing.join()).toHaveLength(0);
      }
    });

    it('survives a failed or missing lockfile fetch and still records the detection', async () => {
      connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
      listDirectory.mockResolvedValue(['package.json', 'yarn.lock']);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      fetchFileContent.mockImplementation(async (_repo: unknown, path: string) => {
        if (path === 'yarn.lock') {
          throw new Error('boom');
        }
        return path === 'package.json' ? '{}' : null;
      });
      await detectRepoDependencies({ repoId: 'repo-self' });
      expect(yarnFetches()).toHaveLength(1);
      expect(recorded()).toMatchObject({ packageManager: 'yarn' });
      expect(recorded().yarnFlavor).toBeUndefined();

      connectionUpdate.mockClear();
      stubFiles({ 'package.json': '{}', 'yarn.lock': null });
      await detectRepoDependencies({ repoId: 'repo-self' });
      expect(recorded().yarnFlavor).toBeUndefined();
    });
  });

  it('records an empty detection for a repo with no manifests', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    await detectRepoDependencies({ repoId: 'repo-self' });
    expect(connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          detectedStack: expect.objectContaining({ primary: null, stacks: [] }),
        }),
      })
    );
  });

  it('leaves a previous detection alone when the root listing fails', async () => {
    connectionFindUnique.mockResolvedValue(BASE_CONNECTION);
    listDirectory.mockResolvedValue(null);
    await detectRepoDependencies({ repoId: 'repo-self' });
    expect(connectionUpdate).not.toHaveBeenCalled();
  });
});
