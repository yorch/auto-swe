import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ find: vi.fn(), remove: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: async () => 90 }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowHttpCall: { deleteMany: h.remove, findMany: h.find } },
}));

import { pruneWorkflowHttpCalls } from './pruneWorkflowHttpCalls.js';

beforeEach(() => {
  vi.resetAllMocks();
});
it('deletes expired rows in bounded batches', async () => {
  h.find
    .mockResolvedValueOnce(Array.from({ length: 2000 }, (_, i) => ({ id: String(i) })))
    .mockResolvedValueOnce([{ id: 'last' }]);
  h.remove.mockResolvedValueOnce({ count: 2000 }).mockResolvedValueOnce({ count: 1 });
  expect(await pruneWorkflowHttpCalls(new Date('2026-10-30T00:00:00Z'))).toBe(2001);
  expect(h.find.mock.calls[0][0].where.createdAt.lt).toEqual(new Date('2026-08-01T00:00:00Z'));
});
it('does not delete anything when empty', async () => {
  h.find.mockResolvedValue([]);
  expect(await pruneWorkflowHttpCalls(new Date())).toBe(0);
  expect(h.remove).not.toHaveBeenCalled();
});
it('surfaces database failures to retry the sweep', async () => {
  h.find.mockRejectedValue(new Error('unavailable'));
  await expect(pruneWorkflowHttpCalls(new Date())).rejects.toThrow('unavailable');
});
