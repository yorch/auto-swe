import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock, explainMock, armMock } = vi.hoisted(() => ({
  armMock: vi.fn(),
  explainMock: vi.fn(),
  searchMock: vi.fn(),
}));
vi.mock('../lib/lessonRecall.js', () => ({
  explainLesson: explainMock,
  searchLessons: searchMock,
}));
vi.mock('../lib/lessonRecallArm.js', () => ({ currentLessonRecallArm: armMock }));

import { createLessonTools } from './lessonTools.js';

type Exec = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const exec = (tool: unknown) => (tool as { execute: Exec }).execute;

beforeEach(() => {
  vi.clearAllMocks();
  armMock.mockResolvedValue('ON');
});

describe('createLessonTools', () => {
  it.each(['SHADOW', 'OFF'])(
    'refuses both tools in %s without passing the model any lessons',
    async (arm) => {
      armMock.mockResolvedValue(arm);
      const tools = createLessonTools('repo-1');
      await expect(exec(tools.searchLessons)({ arm: 'ON', query: 'test' })).resolves.toMatchObject({
        lessons: [],
        unavailable: expect.stringContaining(arm.toLowerCase()),
      });
      await expect(
        exec(tools.explainLesson)({ arm: 'ON', lessonId: '11111111-1111-4111-8111-111111111111' })
      ).resolves.toMatchObject({
        found: false,
        lesson: null,
        unavailable: expect.stringContaining(arm.toLowerCase()),
      });
      expect(searchMock).not.toHaveBeenCalled();
      expect(explainMock).not.toHaveBeenCalled();
    }
  );
  it('never reads lessons if the arm lookup fails', async () => {
    armMock.mockRejectedValue(new Error('db unavailable'));
    const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
    const tools = createLessonTools('repo-1', tracer as never);
    await expect(exec(tools.searchLessons)({ query: 'test' })).rejects.toThrow('db unavailable');
    await expect(
      exec(tools.explainLesson)({ lessonId: '11111111-1111-4111-8111-111111111111' })
    ).rejects.toThrow('db unavailable');
    expect(searchMock).not.toHaveBeenCalled();
    expect(explainMock).not.toHaveBeenCalled();
    expect(tracer.addActivityEvent).toHaveBeenCalledTimes(2);
    expect(tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'lessons.recall_error',
      outputJson: { reason: 'run_context_unavailable', recalledFor: 'lesson_tools' },
    });
  });
  it('searches only the repository it was built for', async () => {
    const lesson = {
      confidence: 0.9,
      failureType: null,
      lessonId: 'l-1',
      similarity: 0.8,
      summary: 'Seed the test database first.',
    };
    searchMock.mockResolvedValue([lesson]);
    const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
    const { searchLessons } = createLessonTools('repo-1', tracer as never);

    await expect(exec(searchLessons)({ limit: 3, query: 'flaky test' })).resolves.toEqual({
      lessons: [lesson],
    });
    expect(searchMock).toHaveBeenCalledWith('repo-1', 'flaky test', 3);
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'lessons.retrieved',
        outputJson: expect.objectContaining({
          lessons: [{ lessonId: 'l-1', similarity: 0.8 }],
          recalledFor: 'searchLessons',
        }),
      })
    );
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
