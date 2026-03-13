import { Mastra, Agent, createTool } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import path from 'node:path';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
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
  if (/['\\\x00]/.test(normalized)) {
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
    id: 'readFile',
    description: 'Read the contents of a file in the workspace',
    inputSchema: z.object({ path: z.string().describe('Relative path from repo root') }),
    outputSchema: z.object({ content: z.string() }),
    execute: async ({ context }) => {
      try {
        const p = safePath(context.path);
        return { content: workspace.exec(`cat ${shellQuote(p)}`) };
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
    execute: wrapWriteToolWithSecurityCheck(async ({ context }) => {
      try {
        const p = safePath(context.path);
        workspace.exec(`mkdir -p "$(dirname ${shellQuote(p)})"`);
        const b64 = Buffer.from(context.content).toString('base64');
        workspace.exec(`echo ${shellQuote(b64)} | base64 -d > ${shellQuote(p)}`);
        return { result: `File written: ${p}` };
      } catch (err: any) {
        return { result: `Error writing file: ${err.message}` };
      }
    }),
  });

  // Tool: List directory contents
  const listDirectory = createTool({
    id: 'listDirectory',
    description: 'List files and directories at a given path',
    inputSchema: z.object({ path: z.string().default('.').describe('Relative path from repo root') }),
    outputSchema: z.object({ listing: z.string() }),
    execute: async ({ context }) => {
      try {
        const p = safePath(context.path);
        return { listing: workspace.exec(`ls -la ${shellQuote(p)}`) };
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
