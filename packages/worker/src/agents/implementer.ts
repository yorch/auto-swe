import path from 'node:path';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { getModel } from '../lib/models.js';
import { wrapWriteToolWithSecurityCheck } from './preWriteSecurityCheck.js';

/**
 * Validates that a relative file path stays within the workspace root.
 * Prevents path traversal attacks (e.g., '../../etc/passwd').
 */
function safePath(relPath: string): string {
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  if (normalized.includes('\0') || /['\\]/.test(normalized)) {
    throw new Error(`Invalid characters in path: ${relPath}`);
  }
  return normalized;
}

/**
 * Creates a Mastra Implementer agent with MCP-style tools bound to a specific workspace container.
 * Each tool call is translated to a `docker exec` command inside the workspace.
 */
export function createImplementerAgent(workspace: Workspace): { agent: Agent; mastra: Mastra } {
  // Tool: Read a file from the workspace
  const readFile = createTool({
    description: 'Read the contents of a file in the workspace',
    execute: async ({ path }) => {
      try {
        const p = safePath(path);
        return { content: workspace.exec(`cat ${shellQuote(p)}`) };
      } catch (err: any) {
        return { content: `Error reading file: ${err.message}` };
      }
    },
    id: 'readFile',
    inputSchema: z.object({ path: z.string().describe('Relative path from repo root') }),
    outputSchema: z.object({ content: z.string() }),
  });

  // Tool: Write/overwrite a file in the workspace
  const writeFile = createTool({
    description: 'Create or overwrite a file in the workspace',
    execute: wrapWriteToolWithSecurityCheck(async ({ path, content }) => {
      try {
        const p = safePath(path);
        workspace.exec(`mkdir -p "$(dirname ${shellQuote(p)})"`);
        const b64 = Buffer.from(content).toString('base64');
        workspace.exec(`echo ${shellQuote(b64)} | base64 -d > ${shellQuote(p)}`);
        return { result: `File written: ${p}` };
      } catch (err: any) {
        return { result: `Error writing file: ${err.message}` };
      }
    }),
    id: 'writeFile',
    inputSchema: z.object({
      content: z.string().describe('Full file content'),
      path: z.string().describe('Relative path from repo root'),
    }),
    outputSchema: z.object({ result: z.string() }),
  });

  // Tool: List directory contents
  const listDirectory = createTool({
    description: 'List files and directories at a given path',
    execute: async ({ path }) => {
      try {
        // Mastra 1.31 types Zod `.default()` fields as string|undefined in tool execute args.
        const p = safePath(path ?? '.');
        return { listing: workspace.exec(`ls -la ${shellQuote(p)}`) };
      } catch (err: any) {
        return { listing: `Error listing directory: ${err.message}` };
      }
    },
    id: 'listDirectory',
    inputSchema: z.object({
      path: z.string().default('.').describe('Relative path from repo root'),
    }),
    outputSchema: z.object({ listing: z.string() }),
  });

  // Tool: Run a shell command in the workspace (e.g., run tests, install deps).
  // Commands run inside an isolated Docker container — not on the host.
  // Every agent-issued command is logged for audit purposes.
  const bash = createTool({
    description: 'Execute a shell command in the workspace (e.g., run tests, install deps)',
    execute: async ({ command }) => {
      // Audit log — provides visibility into LLM-generated shell commands.
      // The container is isolated from the host, but logging helps detect
      // unexpected behaviour (e.g., exfiltration attempts via curl/wget).
      console.log(`[bash:audit] container=${workspace.containerId} cmd=${JSON.stringify(command)}`);
      try {
        return { output: workspace.exec(command) };
      } catch (err: any) {
        return {
          output: `Command failed (exit code ${err.status}):\n${err.stdout ?? ''}\n${err.stderr ?? err.message}`,
        };
      }
    },
    id: 'bash',
    inputSchema: z.object({ command: z.string().describe('Shell command to execute') }),
    outputSchema: z.object({ output: z.string() }),
  });

  const implementerAgent = new Agent({
    id: 'implementer',
    instructions: '', // Set per-call via system message
    model: getModel('implementer'),
    name: 'implementer',
    tools: { bash, listDirectory, readFile, writeFile },
  });

  const mastra = new Mastra({
    agents: { implementer: implementerAgent },
  });

  return { agent: mastra.getAgent('implementer'), mastra };
}
