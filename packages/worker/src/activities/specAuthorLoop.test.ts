import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancel } = vi.hoisted(() => ({ cancel: { after: Number.POSITIVE_INFINITY, calls: 0 } }));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('../lib/cancellation.js', () => ({
  throwIfActivityCancelled: () => {
    cancel.calls += 1;
    if (cancel.calls > cancel.after) {
      throw new Error('activity cancelled');
    }
  },
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { runAgent } from './runAgent.js';
import { runAuthorLoop } from './specAuthorLoop.js';

const mockedRunAgent = vi.mocked(runAgent);

const args = {
  accept: () => ({ errors: ['always wrong'], ok: false as const }),
  agentSpec: {} as never,
  buildRepair: () => 'repair',
  heartbeatLabel: 'test',
  initialMessage: 'go',
  maxAttempts: 5,
  spanName: 'llm.test',
};

beforeEach(() => {
  vi.resetAllMocks();
  cancel.calls = 0;
  cancel.after = Number.POSITIVE_INFINITY;
  mockedRunAgent.mockResolvedValue({
    object: {
      specJson: JSON.stringify({
        entry: 'a',
        name: 'n',
        nodes: { a: { status: 'SUCCESS', type: 'terminate' } },
        schemaVersion: 1,
      }),
    },
  } as never);
});

describe('runAuthorLoop cancellation', () => {
  it('checks for cancellation before every round and stops paying once cancelled', async () => {
    cancel.after = 2;
    await expect(runAuthorLoop(args)).rejects.toThrow('activity cancelled');
    // Two rounds ran; the third was refused before its model call.
    expect(mockedRunAgent).toHaveBeenCalledTimes(2);
  });

  it('runs every round when nothing cancels it', async () => {
    const result = await runAuthorLoop(args);
    expect(result).toMatchObject({ attempts: 5, ok: false });
    expect(mockedRunAgent).toHaveBeenCalledTimes(5);
  });
});

describe('runAuthorLoop macro uses', () => {
  const accept = (parsed: unknown) => ({ ok: true as const, value: parsed });

  it('materializes a model spec that carries uses and no generated nodes', async () => {
    mockedRunAgent.mockResolvedValue({
      object: {
        specJson: JSON.stringify({
          entry: 'waitForCI',
          name: 'n',
          nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
          schemaVersion: 1,
          uses: { ci: { args: { fix: false, passed: 'done' }, macro: 'ciLoop@2' } },
        }),
      },
    } as never);
    const result = await runAuthorLoop({ ...args, accept: accept as never, maxAttempts: 1 });
    expect(result.ok).toBe(true);
    const nodes = (result as { value: { nodes: Record<string, { use?: string }>; uses: object } })
      .value;
    expect(nodes.nodes.checkCI?.use).toBe('ci');
    expect(nodes.nodes.done?.use).toBeUndefined();
    expect(Object.keys(nodes.uses)).toEqual(['ci']);
  });

  it('feeds a bad use back as a repair finding', async () => {
    mockedRunAgent.mockResolvedValue({
      object: {
        specJson: JSON.stringify({
          entry: 'done',
          name: 'n',
          nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
          schemaVersion: 1,
          uses: { ci: { args: { fix: false }, macro: 'ciLoop@2' } },
        }),
      },
    } as never);
    const result = await runAuthorLoop({ ...args, accept: accept as never, maxAttempts: 1 });
    expect(result).toMatchObject({ ok: false });
    expect((result as { errors: string[] }).errors.join(' ')).toMatch(/ciLoop@2/);
  });
});
