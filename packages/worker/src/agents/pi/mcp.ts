import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Workspace } from '../../activities/workspace.js';
import type { McpRelay } from '../harness/mcpRelay.js';
import type { McpTracer } from '../mcpTools.js';
import { offloadIfLarge } from '../toolOutputOffload.js';
import { PROVIDER_TOOL_NAME, piMcpToolName } from './policy.js';

/** One part of an MCP result as text: text as it is, anything else as JSON. */
export function mcpResultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((part) =>
    part.type === 'text' ? part.text : JSON.stringify(part)
  );
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n').trim();
}

/**
 * The Agent's MCP connection as Pi tools, one per remote tool, named
 * {@link piMcpToolName}. Each call goes through the relay, which runs it in the
 * worker against the remote server (the connection's credential never enters
 * the container) and audit-logs it; the policy decides it before that, and the
 * trace records it, like any of Pi's tools. A result over
 * `workspace.maxToolOutputChars` is offloaded beside the checkout, where `read`
 * can reach it. A remote tool whose name a model provider would refuse is
 * skipped, and the trace says which (`mcp.tools_skipped`).
 */
export function piMcpTools(options: {
  relay: McpRelay;
  maxToolOutputChars: number;
  workspace: Workspace;
  tracer?: McpTracer;
}): AgentTool[] {
  const { maxToolOutputChars, relay, tracer, workspace } = options;
  const skipped: string[] = [];
  const tools: AgentTool[] = [];
  for (const remote of relay.tools) {
    const name = piMcpToolName(remote.name);
    if (!PROVIDER_TOOL_NAME.test(name)) {
      skipped.push(remote.name);
      continue;
    }
    tools.push({
      description: remote.description ?? `The ${remote.name} tool of the agent's MCP connection.`,
      async execute(_id, params): Promise<AgentToolResult<undefined>> {
        const result = await relay.callTool(remote.name, params as Record<string, unknown>);
        const output = mcpResultText(result);
        if (result.isError) {
          throw new Error(output || `The MCP tool ${remote.name} failed.`);
        }
        const { text } = await offloadIfLarge({
          maxChars: maxToolOutputChars,
          output: output || '(no output)',
          toolName: name,
          workspace,
        });
        return { content: [{ text, type: 'text' }], details: undefined };
      },
      label: remote.title ?? remote.name,
      name,
      parameters: remote.inputSchema as unknown as AgentTool['parameters'],
    });
  }
  if (skipped.length > 0) {
    tracer?.addActivityEvent({
      error: 'A relayed MCP tool name is not one a model provider accepts.',
      name: 'mcp.tools_skipped',
      outputJson: { tools: skipped },
    });
  }
  return tools;
}
