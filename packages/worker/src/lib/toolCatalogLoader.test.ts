import { ToolInstallError } from '@auto-swe/shared/lib/toolCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import {
  loadToolCatalog,
  resetToolCatalogCache,
  TOOL_CATALOG_CACHE_MS,
} from './toolCatalogLoader.js';

const sha256 = 'a'.repeat(64);
const row = (over: Record<string, unknown> = {}) => ({
  archs: { amd64: { sha256, url: 'https://example.test/just.tar.gz' } },
  key: 'just',
  libc: 'any',
  member: 'just',
  status: 'ACTIVE',
  version: '1.40.0',
  ...over,
});

type Row = ReturnType<typeof row>;
const clientOf = (findMany: () => Promise<Row[]>) => ({ toolCatalogEntry: { findMany } });

describe('loadToolCatalog', () => {
  beforeEach(() => resetToolCatalogCache());

  it('maps rows to entries', async () => {
    const entries = await loadToolCatalog(clientOf(async () => [row()]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'just', status: 'ACTIVE', version: '1.40.0' });
  });

  it('memoises a success for the cache window, then re-reads', async () => {
    const findMany = vi.fn(async () => [row()]);
    const client = clientOf(findMany);
    await loadToolCatalog(client, 1_000);
    await loadToolCatalog(client, 1_000 + TOOL_CATALOG_CACHE_MS - 1);
    expect(findMany).toHaveBeenCalledTimes(1);
    await loadToolCatalog(client, 1_000 + TOOL_CATALOG_CACHE_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('turns a database error into a retryable error and never caches it', async () => {
    const findMany = vi
      .fn<() => Promise<Row[]>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce([row()]);
    const client = clientOf(findMany);
    const failure = await loadToolCatalog(client).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ToolInstallError);
    expect((failure as ToolInstallError).retryable).toBe(true);
    expect((failure as ToolInstallError).message).toMatch(/tool catalog is unreadable.*refused/);
    await expect(loadToolCatalog(client)).resolves.toHaveLength(1);
  });

  it('fails an invalid row non-retryably, naming it, and does not cache', async () => {
    const findMany = vi
      .fn<() => Promise<Row[]>>()
      .mockResolvedValueOnce([row({ member: '../evil' })])
      .mockResolvedValueOnce([row()]);
    const client = clientOf(findMany);
    const failure = await loadToolCatalog(client).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ToolInstallError);
    expect((failure as ToolInstallError).retryable).toBe(false);
    expect((failure as ToolInstallError).message).toContain('just@1.40.0');
    await expect(loadToolCatalog(client)).resolves.toHaveLength(1);
  });
});
