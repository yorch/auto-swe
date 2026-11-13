import { evalCorpusHash } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ embed: vi.fn(), event: vi.fn(), query: vi.fn() }));
vi.mock('./embeddings.js', () => ({ generateEmbeddingWithSpec: h.embed }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { $queryRaw: h.query } }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ lessonRetrievalLimit: 2, lessonRetrievalThreshold: 0.7 }),
}));
vi.mock('./memoryGuard.js', () => ({
  fenceRecalledMemory: (heading: string, bullets: string[]) =>
    `${heading}\n<recalled-memory>\n${bullets.join('\n')}\n</recalled-memory>`,
  withoutFlaggedMemory: async <T extends { content: string }>(items: T[]) =>
    items.filter((l) => l.content !== 'unsafe'),
}));

import type { AgentTracer } from './agentTracer.js';
import { cosine, evalLessonRecall, loadEvalCorpus, verifyEvalCorpus } from './evalLessonRecall.js';

const lesson = {
  content: 'Use transactions.',
  embedding: [1, 0],
  embeddingModel: 'test',
  failureType: 'TEST',
  id: '11111111-1111-4111-8111-111111111111',
};
const tracer = { addActivityEvent: h.event } as unknown as AgentTracer;
beforeEach(() => {
  vi.clearAllMocks();
  h.embed.mockResolvedValue({ embedding: [1, 0], spec: 'test' });
});

describe('isolated eval recall', () => {
  it('ON injects a fenced block and offers dataset-only search and explain', async () => {
    const recall = evalLessonRecall({ corpus: [lesson], mode: 'ON' }, 'case', 'ref', tracer);
    expect(await recall.prompt('task')).toContain('<recalled-memory>');
    expect(recall.tools.map((t) => t.name)).toEqual(['searchLessons', 'explainLesson']);
    expect(await recall.tools[0].call({ query: 'task' })).toMatchObject({
      lessons: [{ lessonId: lesson.id, similarity: 1 }],
    });
    expect(await recall.tools[1].call({ lessonId: lesson.id })).toMatchObject({ found: true });
    expect(
      await recall.tools[1].call({ lessonId: '22222222-2222-4222-8222-222222222222' })
    ).toMatchObject({ found: false });
    expect(recall.exposed).toBe(true);
    expect(h.event).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'lessons.retrieved',
        outputJson: expect.objectContaining({
          arm: 'ON',
          caseId: 'case',
          lessonIds: [lesson.id],
          ref: 'ref',
          result: 'matched',
        }),
      })
    );
    expect(h.query).not.toHaveBeenCalled();
  });
  it('SHADOW retrieves identically but exposes neither a block nor tools', async () => {
    const recall = evalLessonRecall({ corpus: [lesson], mode: 'SHADOW' }, 'case', 'ref', tracer);
    expect(await recall.prompt('task')).toBe('');
    expect(recall.tools).toEqual([]);
    expect(h.embed).toHaveBeenCalledOnce();
    expect(h.event).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'lessons.shadow_retrieved',
        outputJson: expect.objectContaining({ promptInjected: false, result: 'matched' }),
      })
    );
  });
  it('OFF does nothing', async () => {
    const recall = evalLessonRecall({ corpus: [lesson], mode: 'OFF' }, 'case', 'ref', tracer);
    expect(await recall.prompt('task')).toBe('');
    expect(recall.tools).toEqual([]);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  });
  it.each(['ON', 'SHADOW'] as const)(
    '%s distinguishes no match, applies thresholds and scans unsafe text',
    async (mode) => {
      const recall = evalLessonRecall(
        {
          corpus: [
            { ...lesson, embedding: [0, 1] },
            { ...lesson, content: 'unsafe' },
          ],
          mode,
        },
        'case',
        'ref',
        tracer
      );
      expect(await recall.prompt('task')).toBe('');
      expect(recall.exposed).toBe(false);
      expect(h.event).toHaveBeenCalledWith(
        expect.objectContaining({
          outputJson: expect.objectContaining({ lessonIds: [], result: 'no_match' }),
        })
      );
    }
  );
  it('fails on embedding model drift and embedding errors', async () => {
    const recall = evalLessonRecall({ corpus: [lesson], mode: 'ON' }, 'case', 'ref', tracer);
    h.embed.mockResolvedValueOnce({ embedding: [1, 0], spec: 'changed' });
    await expect(recall.prompt('task')).rejects.toThrow('embedding model changed');
    h.embed.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(recall.prompt('task')).rejects.toThrow('provider unavailable');
  });
  it('verifies deterministic hashes and refuses changed/empty/unpinned corpora', () => {
    expect(evalCorpusHash([lesson, { content: 'Other' }])).toBe(
      evalCorpusHash([{ content: 'Other' }, lesson])
    );
    expect(evalCorpusHash([lesson])).not.toBe(
      evalCorpusHash([{ ...lesson, failureType: 'OTHER' }])
    );
    expect(() => verifyEvalCorpus([lesson], evalCorpusHash([lesson]), ['ON', 'OFF'])).not.toThrow();
    expect(() => verifyEvalCorpus([lesson], 'changed', ['ON'])).toThrow('changed since launch');
    expect(() => verifyEvalCorpus([], evalCorpusHash([]), ['SHADOW'])).toThrow('nonempty');
    expect(() => verifyEvalCorpus([lesson], null, ['ON'])).toThrow('pinned');
    expect(() => verifyEvalCorpus([], null, ['OFF'])).not.toThrow();
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
  it('loads only eval_lessons and rejects oversized corpora', async () => {
    h.query.mockResolvedValueOnce([{ ...lesson, vector: '[1,0]' }]);
    expect(await loadEvalCorpus('dataset')).toMatchObject([{ embedding: [1, 0] }]);
    expect(h.query.mock.calls[0][0].join('')).toContain('FROM eval_lessons');
    expect(h.query.mock.calls[0][0].join('')).not.toContain('memory_items');
    h.query.mockResolvedValueOnce(Array.from({ length: 51 }, () => lesson));
    await expect(loadEvalCorpus('dataset')).rejects.toThrow('50 lessons');
  });
});
