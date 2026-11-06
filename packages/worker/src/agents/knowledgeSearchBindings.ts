import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type bindKnowledgeSearch, SEARCH_KNOWLEDGE_INPUT_SCHEMA } from './knowledgeTools.js';

export const KNOWLEDGE_MCP_SERVER = 'knowledge';
export const CLAUDE_KNOWLEDGE_TOOL = `mcp__${KNOWLEDGE_MCP_SERVER}__searchKnowledge`;

type Search = NonNullable<ReturnType<typeof bindKnowledgeSearch>>;

export function claudeKnowledgeServer(search: Search) {
  return createSdkMcpServer({
    name: KNOWLEDGE_MCP_SERVER,
    tools: [
      tool(
        'searchKnowledge',
        search.description,
        SEARCH_KNOWLEDGE_INPUT_SCHEMA.shape,
        async (input) => ({
          content: [{ text: JSON.stringify(await search.execute(input)), type: 'text' }],
        })
      ),
    ],
  });
}

export function piKnowledgeTool(search: Search): AgentTool {
  return {
    description: search.description,
    execute: async (_id, input) => ({
      content: [{ text: JSON.stringify(await search.execute(input)), type: 'text' }],
      details: undefined,
    }),
    label: 'Search knowledge',
    name: 'searchKnowledge',
    parameters: SEARCH_KNOWLEDGE_INPUT_SCHEMA.toJSONSchema() as AgentTool['parameters'],
  };
}
