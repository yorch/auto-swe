import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentTracer } from '../lib/agentTracer.js';
import { toMastraTool, toMastraTools } from './mastraTool.js';
import { toPiTool, type WorkerTool, workerToolNames } from './workerTool.js';

function tool(overrides: Partial<WorkerTool> = {}): WorkerTool {
  return {
    call: async (args) => ({ echo: args }),
    description: 'Echo the arguments back.',
    inputSchema: z.object({ text: z.string() }),
    name: 'echo',
    outputSchema: z.object({ echo: z.unknown() }),
    ...overrides,
  };
}

describe('workerToolNames', () => {
  it('names the tools a harness allows by name, and nothing for none', () => {
    expect(workerToolNames([tool(), tool({ name: 'second' })])).toEqual(['echo', 'second']);
    expect(workerToolNames(undefined)).toEqual([]);
  });
});

describe('toMastraTool', () => {
  it('keeps the tool name, description and both schemas, and calls the shared body', async () => {
    const call = vi.fn(async (args) => ({ echo: args }));
    const bound = toMastraTool(tool({ call }));

    expect(bound.id).toBe('echo');
    expect(bound.description).toBe('Echo the arguments back.');
    await expect(
      (bound as unknown as { execute: (a: unknown) => Promise<unknown> }).execute({ text: 'hi' })
    ).resolves.toEqual({ echo: { text: 'hi' } });
    expect(call).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('passes no output schema for a tool that has none', () => {
    const bound = toMastraTool(tool({ name: 'noOutput', outputSchema: undefined }));
    // `createTool` always defines the property; what matters is that nothing is bound to it.
    expect(bound.outputSchema).toBeUndefined();
  });

  it('keys a record by name, the shape the Mastra agent binds', () => {
    expect(Object.keys(toMastraTools([tool(), tool({ name: 'other' })]))).toEqual([
      'echo',
      'other',
    ]);
  });

  it('records one row when the body throws, and rethrows so the tool call fails', async () => {
    const addToolCall = vi.fn();
    const bound = toMastraTool(
      tool({
        call: async () => {
          throw new Error('learning refused by the content policy');
        },
      }),
      { addToolCall } as unknown as AgentTracer
    );

    await expect(
      (bound as unknown as { execute: (a: unknown) => Promise<unknown> }).execute({ text: 'hi' })
    ).rejects.toThrow('learning refused by the content policy');
    expect(addToolCall).toHaveBeenCalledTimes(1);
    expect(addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'learning refused by the content policy',
        toolName: 'echo',
      })
    );
  });

  it('records nothing itself when the body answers, so a success is traced once', async () => {
    const addToolCall = vi.fn();
    const bound = toMastraTool(tool(), { addToolCall } as unknown as AgentTracer);
    await (bound as unknown as { execute: (a: unknown) => Promise<unknown> }).execute({
      text: 'hi',
    });
    // The body traced its own call; this binding adds no second row.
    expect(addToolCall).not.toHaveBeenCalled();
  });
});

describe('toPiTool', () => {
  it('takes the tool name, its description and its JSON schema', () => {
    const bound = toPiTool(tool());
    expect(bound.name).toBe('echo');
    expect(bound.description).toBe('Echo the arguments back.');
    expect(bound.parameters).toMatchObject({
      properties: { text: { type: 'string' } },
      type: 'object',
    });
  });

  it('answers as tool-message text, JSON for a data result', async () => {
    const out = await bound0();
    expect(out.content).toEqual([{ text: '{"echo":{"text":"hi"}}', type: 'text' }]);
  });

  it('renders a prose result as prose when the tool says how', async () => {
    const out = await bound0(
      tool({
        call: async () => ({ promptText: '# Skill\ndo the thing' }),
        toText: (result) => (result as { promptText: string }).promptText,
      })
    );
    expect(out.content).toEqual([{ text: '# Skill\ndo the thing', type: 'text' }]);
  });

  it('surfaces a refusal as a rejection, so the loop reports a failed call', async () => {
    const bound = toPiTool(
      tool({
        call: async () => {
          throw new Error('learning refused by the content policy');
        },
      })
    );
    await expect(
      (
        bound as unknown as {
          execute: (id: string, args: unknown) => Promise<unknown>;
        }
      ).execute('call-1', { text: 'hi' })
    ).rejects.toThrow('learning refused by the content policy');
  });
});

/** The result of running a Pi-bound tool, reduced to its content. */
function bound0(overrides: Partial<WorkerTool> = {}): Promise<{
  content: { text: string; type: string }[];
}> {
  const bound = toPiTool(tool(overrides));
  return (
    bound as unknown as {
      execute: (
        id: string,
        args: unknown
      ) => Promise<{
        content: { text: string; type: string }[];
      }>;
    }
  ).execute('call-1', { text: 'hi' });
}
