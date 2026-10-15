import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  fetchFileContent: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  loadPriceList: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUniqueOrThrow: m.findUniqueOrThrow } },
}));
vi.mock('@auto-swe/shared/lib/modelPriceList', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/modelPriceList')>()),
  loadPriceList: m.loadPriceList,
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ fetchFileContent: m.fetchFileContent }),
  toRepoRef: () => ({ organizationName: 'me', repoName: 'auto-swe' }),
}));

import { BUILTIN_MODELS_PATH } from '@auto-swe/shared/lib/builtinModels';
import { checkPriceListNotes } from './checkPriceListNotes.js';

const request = { externalTicketId: 'T', repoId: 'repo-1' } as RepoWorkRequest;
const codeResult = { baseSha: 'base1', headSha: 'head1', repoId: 'repo-1' } as CodeResult;
const row = (input: number) =>
  `export const BUILTIN_MODELS = [\n  { inputUsdPerMTok: ${input}, modelId: 'gpt-a', outputUsdPerMTok: 8, provider: 'openai' },\n];`;
const TABLE = {
  'gpt-a': {
    input_cost_per_token: 2e-6,
    litellm_provider: 'openai',
    mode: 'chat',
    output_cost_per_token: 8e-6,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.findUniqueOrThrow.mockResolvedValue({ defaultBranch: 'main', id: 'repo-1' });
  m.loadPriceList.mockResolvedValue({ ok: true, table: TABLE, url: 'https://p.example/l.json' });
});

describe('checkPriceListNotes', () => {
  it('compares the catalog at the base and pushed commits', async () => {
    m.fetchFileContent.mockImplementation(async (_r: unknown, _p: string, ref: string) =>
      ref === 'base1' ? row(2) : row(3)
    );
    const result = await checkPriceListNotes({ codeResult, request });
    expect(m.fetchFileContent).toHaveBeenCalledWith(
      expect.anything(),
      BUILTIN_MODELS_PATH,
      'base1'
    );
    expect(m.fetchFileContent).toHaveBeenCalledWith(
      expect.anything(),
      BUILTIN_MODELS_PATH,
      'head1'
    );
    expect(result.ok).toBe(false);
    expect(result.unnoted.map((r) => r.spec)).toEqual(['openai/gpt-a']);
    expect(result.summary).toContain('the change sets $3 / $8; the price list says $2 / $8');
  });

  it('passes a change whose prices match the list', async () => {
    m.fetchFileContent.mockImplementation(async (_r: unknown, _p: string, ref: string) =>
      ref === 'base1' ? row(1) : row(2)
    );
    expect(await checkPriceListNotes({ codeResult, request })).toMatchObject({ ok: true });
  });

  it('falls back to the base branch when the base sha was not captured', async () => {
    m.fetchFileContent.mockResolvedValue(row(2));
    await checkPriceListNotes({
      codeResult: { ...codeResult, baseBranch: 'release', baseSha: '' },
      request,
    });
    expect(m.fetchFileContent).toHaveBeenCalledWith(
      expect.anything(),
      BUILTIN_MODELS_PATH,
      'release'
    );
  });

  it('passes, saying why, without reading the repository, when the list is off or unreadable', async () => {
    m.loadPriceList.mockResolvedValueOnce(null);
    expect((await checkPriceListNotes({ codeResult, request })).summary).toMatch(/turned off/);
    m.loadPriceList.mockResolvedValueOnce({ error: 'HTTP 503', ok: false });
    const unreadable = await checkPriceListNotes({ codeResult, request });
    expect(unreadable).toMatchObject({ ok: true, unnoted: [] });
    expect(unreadable.summary).toMatch(/could not be read/);
    expect(unreadable.summary).not.toContain('503');
    expect(m.fetchFileContent).not.toHaveBeenCalled();
  });

  it('fails non-retryably, rather than passing, when the file cannot be read', async () => {
    m.fetchFileContent.mockResolvedValue(null);
    await expect(checkPriceListNotes({ codeResult, request })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'CATALOG_FILE_MISSING',
    });
  });
});
