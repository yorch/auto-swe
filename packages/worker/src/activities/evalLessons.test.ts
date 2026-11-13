import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  embed: vi.fn(),
  execute: vi.fn(),
  remove: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { $transaction: h.transaction } }));
vi.mock('../lib/embeddings.js', () => ({ generateEmbeddingWithSpec: h.embed }));
vi.mock('../lib/spendOwner.js', () => ({
  ownerOfDataset: () => ({}),
  withSpendOwner: async (_owner: unknown, fn: () => unknown) => fn(),
}));

import { replaceEvalLessons } from './evalLessons.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.embed.mockResolvedValue({ embedding: [1, 0], spec: 'test' });
  h.transaction.mockImplementation(async (fn) =>
    fn({ $executeRaw: h.execute, evalLesson: { deleteMany: h.remove } })
  );
});
describe('eval corpus authoring', () => {
  it('embeds all rows before atomically replacing the dataset corpus', async () => {
    expect(
      await replaceEvalLessons({ datasetId: 'dataset', lessons: [{ content: 'Use transactions' }] })
    ).toBe(1);
    expect(h.embed).toHaveBeenCalledWith('Use transactions');
    expect(h.remove).toHaveBeenCalledWith({ where: { datasetId: 'dataset' } });
    expect(h.execute.mock.calls[1][0].join('')).toContain('INSERT INTO eval_lessons');
  });
  it('clears an empty corpus without embedding', async () => {
    expect(await replaceEvalLessons({ datasetId: 'dataset', lessons: [] })).toBe(0);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledOnce();
  });
  it('leaves existing rows intact when embedding fails', async () => {
    h.embed.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(
      replaceEvalLessons({ datasetId: 'dataset', lessons: [{ content: 'one' }] })
    ).rejects.toThrow('provider unavailable');
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it('enforces caps before spending', async () => {
    await expect(
      replaceEvalLessons({
        datasetId: 'dataset',
        lessons: Array.from({ length: 51 }, () => ({ content: 'one' })),
      })
    ).rejects.toThrow('50 lessons');
    expect(h.embed).not.toHaveBeenCalled();
  });
});
