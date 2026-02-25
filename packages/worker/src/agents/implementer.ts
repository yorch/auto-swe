import { Mastra, Agent, createTool } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';

/**
 * Creates a Mastra Implementer agent with MCP-style tools bound to a specific workspace container.
 * Each tool call is translated to a `docker exec` command inside the workspace.
 */
export function createImplementerAgent(workspace: Workspace): { agent: Agent; mastra: Mastra } {
  // Tool: Read a file from the workspace
  const readFile = createTool({
    id: 'readFile',
    description: 'Read the contents of a file in the workspace',
    inputSchema: z.object({ path: z.string().describe('Relative path from repo root') }),
    outputSchema: z.object({ content: z.string() }),
    execute: async ({ context }) => {
      try {
        return { content: workspace.exec(`cat '${context.path}'`) };
      } catch (err: any) {
        return { content: `Error reading file: ${err.message}` };
      }
    },
  });

  // Tool: Write/overwrite a file in the workspace
  const writeFile = createTool({
    id: 'writeFile',
    description: 'Create or overwrite a file in the workspace',
    inputSchema: z.object({
      path: z.string().describe('Relative path from repo root'),
      content: z.string().describe('Full file content'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      workspace.exec(`mkdir -p "$(dirname '${context.path}')"`);
      // Write via base64 to avoid shell escaping issues
      const b64 = Buffer.from(context.content).toString('base64');
      workspace.exec(`echo '${b64}' | base64 -d > '${context.path}'`);
      return { result: `File written: ${context.path}` };
    },
  });

  // Tool: List directory contents
  const listDirectory = createTool({
    id: 'listDirectory',
    description: 'List files and directories at a given path',
    inputSchema: z.object({ path: z.string().default('.').describe('Relative path from repo root') }),
    outputSchema: z.object({ listing: z.string() }),
    execute: async ({ context }) => {
      try {
        return { listing: workspace.exec(`ls -la '${context.path}'`) };
      } catch (err: any) {
        return { listing: `Error listing directory: ${err.message}` };
      }
    },
  });

  // Tool: Run a shell command in the workspace (e.g., run tests, install deps).
  // Commands run inside an isolated Docker container — not on the host.
  const bash = createTool({
    id: 'bash',
    description: 'Execute a shell command in the workspace (e.g., run tests, install deps)',
    inputSchema: z.object({ command: z.string().describe('Shell command to execute') }),
    outputSchema: z.object({ output: z.string() }),
    execute: async ({ context }) => {
      try {
        return { output: workspace.exec(context.command) };
      } catch (err: any) {
        return { output: `Command failed (exit code ${err.status}):\n${err.stdout ?? ''}\n${err.stderr ?? err.message}` };
      }
    },
  });

  const implementerAgent = new Agent({
    id: 'implementer',
    name: 'implementer',
    model: anthropic('claude-opus-4-6'),
    instructions: '', // Set per-call via system message
    tools: { readFile, writeFile, listDirectory, bash },
  });

  const mastra = new Mastra({
    agents: { implementer: implementerAgent },
  });

  return { agent: mastra.getAgent('implementer'), mastra };
}
