import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findRun, activityInfo, retrieveMock } = vi.hoisted(() => ({
  activityInfo: vi.fn(),
  findRun: vi.fn(),
  retrieveMock: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findUnique: findRun } } }));
vi.mock('@temporalio/activity', async (original) => ({
  ...(await original<typeof import('@temporalio/activity')>()),
  activityInfo,
}));
vi.mock('./lessonRetrieval.js', () => ({ retrieveSimilarLessons: retrieveMock }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    lessonRetrievalLimit: 5,
    lessonRetrievalThreshold: 0.7,
  })),
}));

import { createLessonTools } from '../agents/lessonTools.js';
import { recallLessonsBlock } from './lessonRecall.js';
import { currentLessonRecallArm } from './lessonRecallArm.js';

beforeEach(() => {
  vi.clearAllMocks();
  activityInfo.mockReturnValue({
    workflowExecution: { runId: 'execution', workflowId: 'trusted-workflow' },
  });
});
describe('trusted lesson recall arm', () => {
  it.each(['ON', 'SHADOW', 'OFF'])(
    'reads the persisted %s arm by Temporal identity',
    async (arm) => {
      findRun.mockResolvedValue({ lessonRecallArm: arm });
      expect(await currentLessonRecallArm()).toBe(arm);
      expect(findRun).toHaveBeenCalledWith({
        select: { lessonRecallArm: true },
        where: { workflowId: 'trusted-workflow' },
      });
    }
  );
  it('defaults genuinely runless activities and nullable legacy rows to ON', async () => {
    activityInfo.mockReturnValue({});
    expect(await currentLessonRecallArm()).toBe('ON');
    expect(findRun).not.toHaveBeenCalled();
    activityInfo.mockReturnValue({ workflowExecution: { workflowId: 'trusted-workflow' } });
    findRun.mockResolvedValue({ lessonRecallArm: null });
    expect(await currentLessonRecallArm()).toBe('ON');
  });
  it('allows calls outside an activity but does not swallow unexpected identity failures', async () => {
    activityInfo.mockImplementation(() => {
      throw new Error('Activity context not initialized');
    });
    expect(await currentLessonRecallArm()).toBe('ON');
    expect(findRun).not.toHaveBeenCalled();
    activityInfo.mockImplementation(() => {
      throw new Error('Unexpected SDK failure');
    });
    await expect(currentLessonRecallArm()).rejects.toThrow('Unexpected SDK failure');
    activityInfo.mockReturnValue({ workflowExecution: { workflowId: '' } });
    await expect(currentLessonRecallArm()).rejects.toThrow(
      'Activity workflow identity is unavailable'
    );
  });
  it('rejects a workflow whose owning run is missing even without a Temporal run id', async () => {
    activityInfo.mockReturnValue({ workflowExecution: { workflowId: 'trusted-workflow' } });
    findRun.mockResolvedValue(null);
    await expect(currentLessonRecallArm()).rejects.toThrow('Owning workflow run is unavailable');
  });
  it.each(['SHADOW', 'OFF'])(
    'uses a child RunnableWorkflow’s own %s assignment, not its parent’s ON assignment',
    async (arm) => {
      const childId = 'chantask-channel-thread-run';
      activityInfo.mockReturnValue({
        workflowExecution: { runId: 'child-execution', workflowId: childId },
      });
      findRun.mockImplementation(async ({ where }) => ({
        lessonRecallArm: where.workflowId === childId ? arm : 'ON',
      }));
      const lesson = {
        confidence: 1,
        failureType: 'CI_FAILURE',
        lessonId: '11111111-1111-4111-8111-111111111111',
        similarity: 0.9,
        summary: 'Private lesson',
      };
      retrieveMock.mockResolvedValue([lesson]);
      const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
      expect(
        await recallLessonsBlock({
          query: 'failure',
          recalledFor: 'ciFixer',
          repoId: 'repo',
          tracer: tracer as never,
        })
      ).toBe('');
      if (arm === 'SHADOW') {
        expect(retrieveMock).toHaveBeenCalledWith('failure', 'repo', 5, 0.7);
        expect(tracer.addActivityEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'lessons.shadow_retrieved',
            outputJson: expect.objectContaining({
              lessons: [{ failureType: 'CI_FAILURE', lessonId: lesson.lessonId, similarity: 0.9 }],
              promptInjected: false,
            }),
          })
        );
      } else {
        expect(retrieveMock).not.toHaveBeenCalled();
      }
      const tools = createLessonTools('repo', tracer as never);
      type Execute = (args: Record<string, unknown>) => Promise<unknown>;
      const search = tools.searchLessons.execute as Execute;
      const explain = tools.explainLesson.execute as Execute;
      await expect(search({ query: 'failure' })).resolves.toMatchObject({
        lessons: [],
        unavailable: expect.any(String),
      });
      await expect(explain({ lessonId: lesson.lessonId })).resolves.toMatchObject({
        found: false,
        lesson: null,
        unavailable: expect.any(String),
      });
      expect(findRun.mock.calls.every(([args]) => args.where.workflowId === childId)).toBe(true);
    }
  );
  it('emits an error and retrieves nothing for an unresolvable child, rather than inheriting/defaulting to ON', async () => {
    activityInfo.mockReturnValue({
      workflowExecution: { runId: 'execution', workflowId: 'missing-child' },
    });
    findRun.mockImplementation(async ({ where }) =>
      where.workflowId === 'parent' ? { lessonRecallArm: 'SHADOW' } : null
    );
    const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
    expect(
      await recallLessonsBlock({
        query: 'failure',
        recalledFor: 'gateFixer',
        repoId: 'repo',
        tracer: tracer as never,
      })
    ).toBe('');
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'lessons.recall_error' })
    );
    const tools = createLessonTools('repo', tracer as never);
    const search = tools.searchLessons.execute as (args: { query: string }) => Promise<unknown>;
    await expect(search({ query: 'failure' })).rejects.toThrow(
      'Owning workflow run is unavailable'
    );
    expect(tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'lessons.recall_error',
      outputJson: { reason: 'run_context_unavailable', recalledFor: 'lesson_tools' },
    });
    expect(retrieveMock).not.toHaveBeenCalled();
  });
  it('propagates a read failure instead of falling back to ON', async () => {
    findRun.mockRejectedValue(new Error('database unavailable'));
    await expect(currentLessonRecallArm()).rejects.toThrow('database unavailable');
  });
});
