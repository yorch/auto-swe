import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { loadSkillWorkerTool } from '../skillDisclosure.js';
import type { WorkerTool } from '../workerTool.js';
import { WORKER_MCP_SERVER, workerToolName } from './policy.js';

/**
 * The worker-side tools this harness is given, in the shape its in-process MCP server wants.
 *
 * Claude Code runs its own tool framework in the container, so the platform's tools — the
 * repository's lessons, learning submission, the catalog installer and the `loadSkill` the
 * other two loops bind — reach it as MCP tools, named `mcp__worker__<tool>`. Each call is a
 * worker tool call: same body, same trace row, same refusals, and the policy allows exactly
 * the names this bound.
 */
export function claudeWorkerTools(options: {
  skills?: Parameters<typeof loadSkillWorkerTool>[0];
  tracer?: Parameters<typeof loadSkillWorkerTool>[1];
  workerTools?: readonly WorkerTool[];
}): WorkerTool[] {
  const skills = options.skills ?? [];
  return [
    ...(skills.length > 0 ? [loadSkillWorkerTool(skills, options.tracer)] : []),
    ...(options.workerTools ?? []),
  ];
}

/** The in-process server those tools are served from, or undefined when there are none. */
export function claudeWorkerServer(tools: readonly WorkerTool[], timeoutMs = 600_000) {
  if (tools.length === 0) {
    return undefined;
  }
  return createSdkMcpServer({
    name: WORKER_MCP_SERVER,
    timeout: timeoutMs,
    tools: tools.map((entry) =>
      tool(entry.name, entry.description, entry.inputSchema.shape, async (args) => {
        // The result becomes the tool message: prose stays prose (a skill's guidance), data is
        // JSON. A throw is the harness's failed call, as it is on the other two loops.
        const result = await entry.call(args);
        return {
          content: [
            { text: entry.toText ? entry.toText(result) : JSON.stringify(result), type: 'text' },
          ],
        };
      })
    ),
  });
}

/** The names this harness calls those tools by, for the policy's allowlist. */
export function claudeWorkerToolNames(tools: readonly WorkerTool[]): string[] {
  return tools.map((entry) => workerToolName(entry.name));
}
