import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock, explainMock } = vi.hoisted(() => ({
  explainMock: vi.fn(),
  searchMock: vi.fn(),
}));
vi.mock('../lib/lessonRecall.js', () => ({
  explainLesson: explainMock,
  searchLessons: searchMock,
}));

import { createLessonTools } from './lessonTools.js';

type Exec = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const exec = (tool: unknown) => (tool as { execute: Exec }).execute;

beforeEach(() => vi.clearAllMocks());

describe('createLessonTools', () => {
  it('searches only the repository it was built for', async () => {
    const lesson = {
      confidence: 0.9,
      failureType: null,
      lessonId: 'l-1',
      similarity: 0.8,
      summary: 'Seed the test database first.',
    };
    searchMock.mockResolvedValue([lesson]);
    const tracer = { addToolCall: vi.fn() };
    const { searchLessons } = createLessonTools('repo-1', tracer as never);

    await expect(exec(searchLessons)({ limit: 3, query: 'flaky test' })).resolves.toEqual({
      lessons: [lesson],
    });
    expect(searchMock).toHaveBeenCalledWith('repo-1', 'flaky test', 3);
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'searchLessons' })
    );
  });

  it('explains only within its repository, and reports an unknown id as not found', async () => {
    explainMock.mockResolvedValue(null);
    const { explainLesson } = createLessonTools('repo-1');

    await expect(
      exec(explainLesson)({ lessonId: '11111111-1111-4111-8111-111111111111' })
    ).resolves.toEqual({ found: false, lesson: null });
    expect(explainMock).toHaveBeenCalledWith('repo-1', '11111111-1111-4111-8111-111111111111');
  });

  it('answers a failed lookup as nothing found rather than failing the turn', async () => {
    searchMock.mockRejectedValue(new Error('embedding down'));
    const { searchLessons } = createLessonTools('repo-1');
    await expect(exec(searchLessons)({ query: 'x' })).resolves.toEqual({ lessons: [] });
  });
});
