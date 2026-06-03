import path from 'node:path';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { getErrorMessage } from '../lib/errors.js';
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
 *
 * If `tracer` is provided every tool execution is recorded so callers can
 * persist the full tool-call sequence to `agent_traces` after generation.
 */
export async function createImplementerAgent(
  workspace: Workspace,
  tracer?: AgentTracer
): Promise<{ agent: Agent; mastra: Mastra }> {
  // Tool: Read a file from the workspace
  const readFile = createTool({
    description: 'Read the contents of a file in the workspace',
    execute: async ({ path }) => {
      const start = Date.now();
      try {
        const p = safePath(path);
        const result = { content: workspace.exec(`cat ${shellQuote(p)}`) };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { path },
          outputJson: result,
          toolName: 'readFile',
        });
        return result;
      } catch (err: unknown) {
        const error = getErrorMessage(err);
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error,
          inputJson: { path },
          toolName: 'readFile',
        });
        return { content: `Error reading file: ${error}` };
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
      const start = Date.now();
      try {
        const p = safePath(path);
        workspace.exec(`mkdir -p "$(dirname ${shellQuote(p)})"`);
        const b64 = Buffer.from(content).toString('base64');
        workspace.exec(`echo ${shellQuote(b64)} | base64 -d > ${shellQuote(p)}`);
        const result = { result: `File written: ${p}` };
        // Only store path in inputJson — content can be very large and is already in readFile traces
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { path },
          outputJson: result,
          toolName: 'writeFile',
        });
        return result;
      } catch (err: unknown) {
        const error = getErrorMessage(err);
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error,
          inputJson: { path },
          toolName: 'writeFile',
        });
        return { result: `Error writing file: ${error}` };
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
      const start = Date.now();
      try {
        // Mastra 1.31 types Zod `.default()` fields as string|undefined in tool execute args.
        const p = safePath(path ?? '.');
        const result = { listing: workspace.exec(`ls -la ${shellQuote(p)}`) };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { path: p },
          outputJson: result,
          toolName: 'listDirectory',
        });
        return result;
      } catch (err: unknown) {
        const error = getErrorMessage(err);
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error,
          inputJson: { path },
          toolName: 'listDirectory',
        });
        return { listing: `Error listing directory: ${error}` };
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
      const start = Date.now();
      try {
        const result = { output: workspace.exec(command) };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { command },
          outputJson: result,
          toolName: 'bash',
        });
        return result;
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        const output = `Command failed (exit code ${e.status}):\n${e.stdout ?? ''}\n${e.stderr ?? getErrorMessage(err)}`;
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { command },
          outputJson: { output },
          toolName: 'bash',
        });
        return { output };
      }
    },
    id: 'bash',
    inputSchema: z.object({ command: z.string().describe('Shell command to execute') }),
    outputSchema: z.object({ output: z.string() }),
  });

  const implementerAgent = new Agent({
    id: 'implementer',
    instructions: '', // Set per-call via system message
    model: await getModel('implementer'),
    name: 'implementer',
    tools: { bash, listDirectory, readFile, writeFile },
  });

  const mastra = new Mastra({
    agents: { implementer: implementerAgent },
  });

  return { agent: mastra.getAgent('implementer'), mastra };
}
