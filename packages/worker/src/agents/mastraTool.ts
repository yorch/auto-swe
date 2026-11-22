import { createTool } from '@mastra/core/tools';
import type { AgentTracer } from '../lib/agentTracer.js';
import { getErrorMessage } from '../lib/errors.js';
import type { WorkerTool } from './workerTool.js';

/**
 * A {@link WorkerTool} as the Mastra loop calls it.
 *
 * The Mastra half of the bridge lives in its own module so nothing on the other
 * loop's path imports `@mastra/core`: Pi binds the same tool bodies through
 * `toPiTool` (`workerTool.ts`) and builds no Mastra agent to do it.
 */
export function toMastraTool(tool: WorkerTool, tracer?: AgentTracer) {
  return createTool({
    description: tool.description,
    execute: async (args: unknown) => {
      const started = Date.now();
      try {
        return await tool.call(args);
      } catch (err) {
        // The body traces what it returns; a throw is this binding's to record, so a call that ran
        // and failed leaves one row — Pi records the same throw through `turn.failed`. (A call
        // whose arguments fail schema validation never reaches a body on either loop, and is not
        // traced by either.)
        tracer?.addToolCall({
          durationMs: Date.now() - started,
          error: getErrorMessage(err),
          inputJson: args,
          toolName: tool.name,
        });
        throw err;
      }
    },
    id: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  });
}

/** Every {@link WorkerTool} as a record keyed by name, the shape Mastra binds. */
export function toMastraTools(tools: readonly WorkerTool[], tracer?: AgentTracer) {
  return Object.fromEntries(tools.map((tool) => [tool.name, toMastraTool(tool, tracer)]));
}
