import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue({ agentKey: 'channelAssistant' }),
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { planChannelTask, runChannelSubtasks } from './channelTaskPlan.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);

beforeEach(() => {
  mockedRunAgent.mockReset();
});

describe('planChannelTask', () => {
  it('returns the structured subtasks the planner produced', async () => {
    mockedRunAgent.mockResolvedValue({
      object: {
        subtasks: [
          { description: 'a', title: 'A' },
          { description: 'b', title: 'B' },
        ],
      },
    } as never);
    const result = await planChannelTask({ task: 'compare A and B' });
    expect(result.subtaskCount).toBe(2);
    expect(result.subtasks.map((s) => s.description)).toEqual(['a', 'b']);
  });

  it('caps the subtask count at the fan-out limit (4)', async () => {
    mockedRunAgent.mockResolvedValue({
      object: {
        subtasks: Array.from({ length: 9 }, (_, i) => ({ description: `d${i}`, title: `T${i}` })),
      },
    } as never);
    const result = await planChannelTask({ task: 'big' });
    expect(result.subtaskCount).toBe(4);
  });

  it('falls back to a single subtask (the whole task) when the planner returns nothing', async () => {
    mockedRunAgent.mockResolvedValue({ object: { subtasks: [] } } as never);
    const result = await planChannelTask({ task: 'do the thing' });
    expect(result.subtaskCount).toBe(1);
    expect(result.subtasks[0]?.description).toBe('do the thing');
  });

  it('never throws — an LLM error degrades to the single-subtask path', async () => {
    mockedRunAgent.mockRejectedValue(new Error('model down'));
    const result = await planChannelTask({ task: 'do the thing' });
    expect(result).toEqual({
      subtaskCount: 1,
      subtasks: [{ description: 'do the thing', title: 'Task' }],
    });
  });
});

describe('runChannelSubtasks', () => {
  // Branch calls echo their description; the synthesis call (distinct span) folds them.
  const echoThenSynth = () =>
    mockedRunAgent.mockImplementation((async (
      _spec: unknown,
      message: string,
      opts?: { spanName?: string }
    ) => {
      if (opts?.spanName === 'llm.channel_task.synthesize') {
        return { text: `SYNTH(${message})` };
      }
      return { text: `ANSWER(${message})` };
    }) as never);

  it('runs each subtask then synthesizes, passing parts + task to the synthesizer', async () => {
    echoThenSynth();
    const result = await runChannelSubtasks({
      subtasks: [
        { description: 'part A', title: 'A' },
        { description: 'part B', title: 'B' },
      ],
      task: 'the whole task',
    });
    // 2 branch calls + 1 synthesis call.
    expect(mockedRunAgent).toHaveBeenCalledTimes(3);
    const synthCall = mockedRunAgent.mock.calls.find(
      (c) => (c[2] as { spanName?: string } | undefined)?.spanName === 'llm.channel_task.synthesize'
    );
    expect(synthCall?.[1]).toContain('the whole task');
    expect(synthCall?.[1]).toContain('ANSWER(part A)');
    expect(synthCall?.[1]).toContain('ANSWER(part B)');
    expect(result.text).toBe(
      'SYNTH({"parts":["ANSWER(part A)","ANSWER(part B)"],"task":"the whole task"})'
    );
  });

  it('skips synthesis when only one subtask produces an answer', async () => {
    echoThenSynth();
    const result = await runChannelSubtasks({
      subtasks: [{ description: 'only', title: 'X' }],
      task: 't',
    });
    // 1 branch call, no synthesis.
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('ANSWER(only)');
  });

  it('drops a failed subtask rather than failing the whole task', async () => {
    mockedRunAgent.mockImplementation((async (
      _spec: unknown,
      message: string,
      opts?: { spanName?: string }
    ) => {
      if (opts?.spanName === 'llm.channel_task.synthesize') {
        return { text: `SYNTH(${message})` };
      }
      if (message === 'boom') {
        throw new Error('branch failed');
      }
      return { text: `ANSWER(${message})` };
    }) as never);
    const result = await runChannelSubtasks({
      subtasks: [
        { description: 'ok1', title: '1' },
        { description: 'boom', title: '2' },
        { description: 'ok2', title: '3' },
      ],
      task: 't',
    });
    // Two surviving parts → synthesized; the failed one contributes nothing.
    const synthCall = mockedRunAgent.mock.calls.find(
      (c) => (c[2] as { spanName?: string } | undefined)?.spanName === 'llm.channel_task.synthesize'
    );
    expect(synthCall?.[1]).toContain('ANSWER(ok1)');
    expect(synthCall?.[1]).toContain('ANSWER(ok2)');
    expect(synthCall?.[1]).not.toContain('boom');
    expect(result.text).toContain('SYNTH(');
  });

  it('falls back to joined parts when synthesis itself fails', async () => {
    mockedRunAgent.mockImplementation((async (
      _spec: unknown,
      message: string,
      opts?: { spanName?: string }
    ) => {
      if (opts?.spanName === 'llm.channel_task.synthesize') {
        throw new Error('synth down');
      }
      return { text: `ANSWER(${message})` };
    }) as never);
    const result = await runChannelSubtasks({
      subtasks: [
        { description: 'a', title: 'A' },
        { description: 'b', title: 'B' },
      ],
      task: 't',
    });
    expect(result.text).toBe('ANSWER(a)\n\nANSWER(b)');
  });
});
