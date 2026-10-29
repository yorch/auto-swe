import { describe, expect, it, vi } from 'vitest';

const executeImplementation = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    agentActivities: { ...actual.agentActivities, executeImplementation },
  };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');

const request = { description: 'do it' } as never;

describe('the executeImplementation step and the success criteria', () => {
  it('hands the criteria it was given to the activity as the eighth argument', async () => {
    const ctx = { context: { ticket: '[TICKET]' } } as never;
    await dispatchStepImpl(
      'executeImplementation',
      ctx,
      request,
      {},
      { successCriteria: ['GET /health returns 200', 'AMBIGUOUS: auth?'] },
      'do'
    );
    const args = executeImplementation.mock.calls.at(-1) ?? [];
    expect(args[6]).toBe('[TICKET]');
    expect(args[7]).toEqual(['GET /health returns 200', 'AMBIGUOUS: auth?']);
  });

  it('ignores context.successCriteria: only a template that binds the input opts in', async () => {
    const ctx = { context: { successCriteria: ['GET /health returns 200'] } } as never;
    await dispatchStepImpl('executeImplementation', ctx, request, {}, {}, 'do');
    expect((executeImplementation.mock.calls.at(-1) ?? []).length).toBe(4);
  });

  it('ignores an input that is not a list of strings', async () => {
    await dispatchStepImpl(
      'executeImplementation',
      {} as never,
      request,
      {},
      { successCriteria: 'one string' },
      'do'
    );
    expect((executeImplementation.mock.calls.at(-1) ?? []).length).toBe(4);
  });
});
