import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  decrypt: vi.fn(),
  fetchFileContent: vi.fn(),
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
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  log: { info: vi.fn(), warn: m.logWarn },
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ fetchFileContent: m.fetchFileContent }),
  toRepoRef: () => ({ organizationName: 'me', repoName: 'auto-swe' }),
}));

import { listProviderModels } from './listProviderModels.js';

const request = { repoId: 'repo-1' } as RepoWorkRequest;
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
    id: 'repo-1',
    organizationName: 'me',
    repoName: 'auto-swe',
  });
  m.fetchFileContent.mockResolvedValue(CATALOG);
  m.decrypt.mockReturnValue(SECRET);
  m.prisma.providerCredential.findMany.mockResolvedValue([cred('anthropic'), cred('openai')]);
  m.list.mockImplementation(async ({ provider }: { provider: string }) => ({
    complete: true,
    listedIds: new Set(),
    models: [
      { displayName: null, kind: 'CHAT', modelId: `${provider}-z` },
      { displayName: null, kind: 'CHAT', modelId: `${provider}-a` },
    ],
    ok: true,
  }));
});

describe('listProviderModels step', () => {
  it('returns only a markdown list of ids per provider, with no key anywhere in the output', async () => {
    const out = await listProviderModels({ request });
    expect(Object.keys(out)).toEqual(['guidance']);
    expect(out.guidance).toContain('Catalog file: `packages/shared/src/lib/builtinModels.ts`.');
    expect(out.guidance).toContain('### anthropic\n\n- anthropic-a\n- anthropic-z');
    expect(out.guidance).toContain('### openai\n\n- openai-a\n- openai-z');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // The key reached the provider call and nothing else.
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ apiKey: SECRET }));
  });

  it('reports a failed provider in fixed words and never repeats its error, in output or logs', async () => {
    const leaked = `fetch failed: Authorization: Bearer ${SECRET} https://user:${SECRET}@host`;
    m.list.mockImplementation(async ({ provider }: { provider: string }) =>
      provider === 'anthropic'
        ? { error: leaked, ok: false }
        : { complete: true, listedIds: new Set(), models: [{ modelId: 'gpt-x' }], ok: true }
    );
    const out = await listProviderModels({ request });
    expect(out.guidance).toContain(
      "### anthropic\n\nListing failed. Leave this provider's model ids as they are."
    );
    // One provider failing does not stop the next.
    expect(out.guidance).toContain('### openai\n\n- gpt-x');
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
    expect((await listProviderModels({ request })).guidance).toContain('may be incomplete');
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

    it('reads the configured catalogPath', async () => {
      await listProviderModels({ catalogPath: 'lib/models.ts', request });
      expect(m.fetchFileContent).toHaveBeenCalledWith(expect.anything(), 'lib/models.ts');
    });

    it.each(['/etc/passwd', '../x.ts', 'a/../../x.ts', ''])('rejects the path %j', async (p) => {
      await expect(listProviderModels({ catalogPath: p, request })).rejects.toMatchObject({
        nonRetryable: true,
        type: 'CATALOG_PATH_INVALID',
      });
      expect(m.fetchFileContent).not.toHaveBeenCalled();
    });
  });
});
