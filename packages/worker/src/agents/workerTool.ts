import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { z } from 'zod';

/**
 * One tool the worker runs on the platform's side of a run, independent of the
 * loop that calls it.
 *
 * The body — the lookup, the scan, the trace, the refusal messages — is written
 * once here, and each runtime wraps it in its own tool type: `toPiTool` below,
 * and `toMastraTool` (`mastraTool.ts`). New worker tools are therefore bound by
 * every loop that can call them, rather than by whichever one was edited. This
 * module imports nothing from Mastra: the Pi loop binds these bodies without
 * pulling the other loop's tool framework into its path.
 */
export interface WorkerTool {
  /** The name the model calls it by, and the name the policy allows it under. */
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodType;
  call: (args: unknown) => Promise<unknown>;
  /**
   * How Pi renders the result into the tool message (a worker-side tool returns
   * text there, not an object). Defaults to JSON, which is what a result shaped
   * as data needs; a tool whose result is prose returns the prose itself.
   */
  toText?: (result: unknown) => string;
}

/** The worker tools among `tools`, by name — what a harness allows by name. */
export function workerToolNames(tools: readonly WorkerTool[] | undefined): string[] {
  return (tools ?? []).map((tool) => tool.name);
}

/** A {@link WorkerTool} as Pi's loop calls it: the result becomes the tool message. */
export function toPiTool(tool: WorkerTool): AgentTool {
  return {
    description: tool.description,
    execute: async (_id: string, args: unknown) => ({
      content: [{ text: await renderResult(tool, args), type: 'text' as const }],
      details: undefined,
    }),
    label: tool.name,
    name: tool.name,
    parameters: tool.inputSchema.toJSONSchema() as AgentTool['parameters'],
  };
}

async function renderResult(tool: WorkerTool, args: unknown): Promise<string> {
  const result = await tool.call(args);
  try {
    return tool.toText ? tool.toText(result) : JSON.stringify(result);
  } catch {
    // The body already recorded its row; a result that cannot be rendered must not throw the call
    // and have it recorded a second time as a failure.
    return '[the result could not be rendered as text]';
  }
}
