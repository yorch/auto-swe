import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  decrypt: vi.fn(),
  fetchFileContent: vi.fn(),
  findBranchWork: vi.fn(),
  list: vi.fn(),
  logWarn: vi.fn(),
  prisma: {
    connection: { findUniqueOrThrow: vi.fn() },
    providerCredential: { findMany: vi.fn() },
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: m.prisma }));
vi.mock('@auto-swe/shared/lib/crypto', () => ({ decryptSecret: m.decrypt }));
vi.mock('@auto-swe/shared/lib/modelDiscovery', () => ({ listProviderModels: m.list }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  log: { info: vi.fn(), warn: m.logWarn },
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    fetchFileContent: m.fetchFileContent,
    findBranchWork: m.findBranchWork,
  }),
  toRepoRef: () => ({ organizationName: 'me', repoName: 'auto-swe' }),
}));

import { listProviderModels } from './listProviderModels.js';

const request = { externalTicketId: 'CATALOG-SCHED-abc12345', repoId: 'repo-1' } as RepoWorkRequest;
const CATALOG = `export const BUILTIN_MODELS = [
  { provider: 'anthropic', modelId: 'a' },
  { provider: 'openai', modelId: 'b' },
];`;
const SECRET = 'sk-live-THE-DECRYPTED-KEY';

const cred = (provider: string) => ({
  apiBase: null,
  apiKeyAuthTag: 't',
  apiKeyCiphertext: `ct-${provider}`,
  apiKeyNonce: 'n',
  keyVersion: 1,
  provider,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.connection.findUniqueOrThrow.mockResolvedValue({
    defaultBranch: 'main',
    id: 'repo-1',
    organizationName: 'me',
    repoName: 'auto-swe',
  });
  m.fetchFileContent.mockResolvedValue(CATALOG);
  m.findBranchWork.mockResolvedValue({ aheadBy: null, branchExists: false, openPr: null });
  m.decrypt.mockReturnValue(SECRET);
  m.prisma.providerCredential.findMany.mockResolvedValue([cred('anthropic'), cred('openai')]);
  m.list.mockImplementation(async ({ provider }: { provider: string }) => ({
    complete: true,
    // `whisper-1` is listed but filtered out of `models`, as the real listing does.
    listedIds: new Set([`${provider}-z`, `${provider}-a`, 'whisper-1']),
    models: [
      { displayName: null, kind: 'CHAT', modelId: `${provider}-z` },
      { displayName: null, kind: 'CHAT', modelId: `${provider}-a` },
    ],
    ok: true,
  }));
});

describe('listProviderModels step', () => {
  it("loads the installation's host, so the token mint can refuse an installation recorded for another host", async () => {
    await listProviderModels({ request });
    expect(m.prisma.connection.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { installation: { select: { host: true, installationId: true } } },
      })
    );
  });

  it('returns only a markdown list of ids per provider, with no key anywhere in the output', async () => {
    const out = await listProviderModels({ request });
    expect(Object.keys(out).sort()).toEqual(['guidance', 'previousRefreshOpen']);
    expect(out.previousRefreshOpen).toBe(false);
    expect(out.guidance).toContain('Catalog file: `packages/shared/src/lib/builtinModels.ts`.');
    expect(out.guidance).toContain('### anthropic\n\nText and embedding models');
    expect(out.guidance).toContain('- anthropic-a\n- anthropic-z');
    expect(out.guidance).toContain('### openai');
    expect(out.guidance).toContain('- openai-a\n- openai-z');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // The key reached the provider call and nothing else.
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ apiKey: SECRET }));
  });

  it("lists through each credential's private-network opt-in", async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([
      { ...cred('anthropic'), allowPrivateNetwork: true },
      { ...cred('openai'), allowPrivateNetwork: false },
    ]);
    await listProviderModels({ request });
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateNetwork: true, provider: 'anthropic' })
    );
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateNetwork: false, provider: 'openai' })
    );
  });

  it('reports a failed provider in fixed words and never repeats its error, in output or logs', async () => {
    const leaked = `fetch failed: Authorization: Bearer ${SECRET} https://user:${SECRET}@host`;
    m.list.mockImplementation(async ({ provider }: { provider: string }) =>
      provider === 'anthropic'
        ? { error: leaked, ok: false }
        : {
            complete: true,
            listedIds: new Set(['gpt-x']),
            models: [{ modelId: 'gpt-x' }],
            ok: true,
          }
    );
    const out = await listProviderModels({ request });
    expect(out.guidance).toContain(
      "### anthropic\n\nListing failed. Leave this provider's model ids as they are."
    );
    // One provider failing does not stop the next.
    expect(out.guidance).toContain('### openai');
    expect(out.guidance).toContain('- gpt-x');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('fetch failed');
    expect(JSON.stringify(m.logWarn.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(m.logWarn.mock.calls)).not.toContain('fetch failed');
  });

  it('treats a provider that throws, or whose key cannot be decrypted, as a failed listing', async () => {
    m.decrypt.mockImplementationOnce(() => {
      throw new Error(`bad envelope ${SECRET}`);
    });
    m.list.mockRejectedValueOnce(new Error(`socket hang up ${SECRET}`));
    const out = await listProviderModels({ request });
    expect(out.guidance.match(/Listing failed/g)).toHaveLength(2);
    expect(out.guidance).not.toContain(SECRET);
    expect(out.guidance).not.toContain('socket');
  });

  it('flags a listing that may be incomplete so the agent does not retire on absence', async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([cred('openai')]);
    m.list.mockResolvedValue({ complete: false, listedIds: new Set(), models: [], ok: true });
    const { guidance } = await listProviderModels({ request });
    expect(guidance).toContain('may be incomplete: do not mark any model RETIRED');
    expect(guidance).not.toContain('Retire a catalog row only if');
  });

  it('judges retirement against every listed id, including ones the name filter drops', async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([cred('openai')]);
    const { guidance } = await listProviderModels({ request });
    const [candidates, retirement] = guidance.split('Every id the provider still lists');
    // `whisper-1` is not offered as a model to add, but it is still listed, so a row for it stays.
    expect(candidates).not.toContain('whisper-1');
    expect(retirement).toContain('- whisper-1');
  });

  it('drops ids with a colon (fine-tunes and organization-owned models) from both lists', async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([cred('openai')]);
    m.list.mockResolvedValue({
      complete: true,
      listedIds: new Set(['gpt-x', 'ft:gpt-x:acme:secret-project:abc123']),
      models: [{ modelId: 'gpt-x' }, { modelId: 'ft:gpt-x:acme:secret-project:abc123' }],
      ok: true,
    });
    const { guidance } = await listProviderModels({ request });
    expect(guidance).toContain('- gpt-x');
    expect(guidance).not.toContain('ft:');
    expect(guidance).not.toContain('acme');
    expect(guidance).not.toContain('secret-project');
  });

  it('skips credentials for providers the catalog file does not already contain', async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([cred('anthropic'), cred('groq')]);
    const out = await listProviderModels({ request });
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(out.guidance).not.toContain('groq');
  });

  it('says so when no credential matches, rather than inviting the agent to guess', async () => {
    m.prisma.providerCredential.findMany.mockResolvedValue([]);
    expect((await listProviderModels({ request })).guidance).toContain('no live model ids');
  });

  describe('precondition', () => {
    it('fails non-retryably when the file is missing, before any credential is read', async () => {
      m.fetchFileContent.mockResolvedValue(null);
      await expect(listProviderModels({ request })).rejects.toMatchObject({
        message: expect.stringContaining('packages/shared/src/lib/builtinModels.ts'),
        nonRetryable: true,
        type: 'CATALOG_FILE_MISSING',
      });
      expect(m.prisma.providerCredential.findMany).not.toHaveBeenCalled();
      expect(m.decrypt).not.toHaveBeenCalled();
    });

    it('fails non-retryably when the file has no BUILTIN_MODELS', async () => {
      m.fetchFileContent.mockResolvedValue('export const SOMETHING_ELSE = [];');
      await expect(listProviderModels({ request })).rejects.toMatchObject({
        message: expect.stringContaining('export const BUILTIN_MODELS'),
        nonRetryable: true,
        type: 'CATALOG_FILE_INVALID',
      });
      expect(m.prisma.providerCredential.findMany).not.toHaveBeenCalled();
    });

    it('reads the one fixed catalog path', async () => {
      await listProviderModels({ request });
      expect(m.fetchFileContent).toHaveBeenCalledWith(
        expect.anything(),
        'packages/shared/src/lib/builtinModels.ts'
      );
    });
  });

  describe('a previous refresh', () => {
    it.each([
      ['its branch still has commits', { aheadBy: 2, branchExists: true, openPr: null }],
      [
        'its pull request is still open',
        { aheadBy: null, branchExists: false, openPr: { prNumber: 4, prUrl: 'u' } },
      ],
      ['both are there', { aheadBy: 1, branchExists: true, openPr: { prNumber: 4, prUrl: 'u' } }],
    ])('ends the run with a note when %s, before any credential is read', async (_n, work) => {
      m.findBranchWork.mockResolvedValue(work);
      const out = await listProviderModels({ request });
      expect(out).toEqual({
        guidance: '',
        note: 'A previous catalog refresh is still open; merge or close it and delete its branch.',
        previousRefreshOpen: true,
      });
      expect(m.prisma.providerCredential.findMany).not.toHaveBeenCalled();
      expect(m.decrypt).not.toHaveBeenCalled();
      expect(m.list).not.toHaveBeenCalled();
    });

    it("looks for the run's own branch, from the configured prefix and the ticket id", async () => {
      await listProviderModels({ request });
      expect(m.findBranchWork).toHaveBeenCalledWith(
        expect.anything(),
        'auto/CATALOG-SCHED-abc12345',
        'main'
      );
    });

    it('proceeds when the branch exists with nothing ahead of the default branch and no PR', async () => {
      // A run that changed nothing still pushes its branch; it must not stop the schedule.
      m.findBranchWork.mockResolvedValue({ aheadBy: 0, branchExists: true, openPr: null });
      const out = await listProviderModels({ request });
      expect(out.previousRefreshOpen).toBe(false);
      expect(m.list).toHaveBeenCalled();
    });

    it('still stops for an open PR even when the branch shows nothing ahead', async () => {
      m.findBranchWork.mockResolvedValue({
        aheadBy: 0,
        branchExists: true,
        openPr: { prNumber: 4, prUrl: 'u' },
      });
      expect((await listProviderModels({ request })).previousRefreshOpen).toBe(true);
    });

    it('fails, rather than proceeding, when the comparison itself fails', async () => {
      m.findBranchWork.mockRejectedValue(new Error('compare down'));
      await expect(listProviderModels({ request })).rejects.toThrow('compare down');
      expect(m.prisma.providerCredential.findMany).not.toHaveBeenCalled();
    });

    it('checks the catalog file first, so a wrong repository still fails loudly', async () => {
      m.fetchFileContent.mockResolvedValue(null);
      await expect(listProviderModels({ request })).rejects.toMatchObject({
        type: 'CATALOG_FILE_MISSING',
      });
      expect(m.findBranchWork).not.toHaveBeenCalled();
    });
  });
});
