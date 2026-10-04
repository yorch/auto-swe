import path from 'node:path';
import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { auditLog } from '../lib/activityLog.js';
import { type AgentTracer, redactString } from '../lib/agentTracer.js';
import { getErrorMessage } from '../lib/errors.js';
import { checkSensitiveFilePath } from '../lib/sensitiveFileScanner.js';
import { scanShellCommand } from '../lib/shellCommandScanner.js';
import {
  SECURITY_CHECK_FAILED_PREFIX,
  SECURITY_WARNINGS_PREFIX,
  wrapWriteToolWithSecurityCheck,
} from './preWriteSecurityCheck.js';
import { offloadIfLarge, packOffload } from './toolOutputOffload.js';

/**
 * Validates that a relative file path stays within the workspace root.
 * Prevents path traversal attacks (e.g., '../../etc/passwd').
 */
export function safePath(relPath: string): string {
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
 * The four workspace tools, bound to one container.
 *
 * Shared by the implementer and by agent runs, so the tool-level scanners
 * (`checkSensitiveFilePath` on every write, the pre-write content check, the
 * shell-command scanner on every `bash` call) are part of the tool body and
 * cannot be skipped by a caller that builds its own tool set. Which of the four
 * an agent actually receives is the caller's decision — this builds all of them.
 *
 * `maxToolOutputChars` is `workspace.maxToolOutputChars`, resolved once by the
 * caller rather than per tool call.
 */
export function buildWorkspaceTools(
  workspace: Workspace,
  tracer: AgentTracer | undefined,
  maxToolOutputChars: number
) {
  // Tool: Read a file from the workspace
  const readFile = createTool({
    description: 'Read the contents of a file in the workspace',
    execute: async ({ path }) => {
      const start = Date.now();
      try {
        const p = safePath(path);
        const raw = await workspace.exec(`cat ${shellQuote(p)}`);
        const offloaded = await offloadIfLarge({
          maxChars: maxToolOutputChars,
          output: raw,
          toolName: 'readFile',
          workspace,
        });
        const { result, outputJson } = packOffload('content', offloaded);
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { path },
          outputJson,
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

  // Tool: Write/overwrite a file in the workspace.
  // The security-checked executor is constructed once at tool-definition time.
  // Tracing happens in the outer execute so blocked writes are still recorded —
  // the security wrapper returns early without calling the inner function.
  const writeExecute = wrapWriteToolWithSecurityCheck(async ({ path, content }) => {
    const safep = safePath(path);
    await workspace.exec(`mkdir -p "$(dirname ${shellQuote(safep)})"`);
    // Stream the content over stdin rather than as a base64 argument: a
    // single argv value is capped by the kernel (E2BIG at roughly 128 KiB),
    // which silently made any larger file — lockfiles, fixtures, generated
    // code — impossible to write.
    await workspace.execStdin(`cat > ${shellQuote(safep)}`, content);
    return { result: `File written: ${safep}` };
  });

  const writeFile = createTool({
    description: 'Create or overwrite a file in the workspace',
    execute: async ({ path, content }) => {
      const start = Date.now();
      try {
        // Scan the same normalised path the write will use, so `./x/../.env`
        // and `.env` are the same file to the policy as they are to the shell.
        const sensitiveBlock = await checkSensitiveFilePath(safePath(path));
        if (sensitiveBlock) {
          tracer?.addToolCall({
            durationMs: Date.now() - start,
            error: SECURITY_TRACE_ERRORS.FILE_BLOCK,
            inputJson: { path },
            outputJson: { result: sensitiveBlock },
            toolName: 'writeFile',
          });
          return { result: sensitiveBlock };
        }
        const result = await writeExecute({ content, path });
        // Tag security violations explicitly so the gateway can query them without raw SQL.
        const resultText = result.result;
        const securityError = resultText.startsWith(SECURITY_CHECK_FAILED_PREFIX)
          ? SECURITY_TRACE_ERRORS.CONTENT_BLOCK
          : resultText.startsWith(SECURITY_WARNINGS_PREFIX)
            ? SECURITY_TRACE_ERRORS.CONTENT_WARN
            : undefined;
        // Only store path in inputJson — content can be large and is in readFile traces
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error: securityError,
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
    },
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
        const raw = await workspace.exec(`ls -la ${shellQuote(p)}`);
        const offloaded = await offloadIfLarge({
          maxChars: maxToolOutputChars,
          output: raw,
          toolName: 'listDirectory',
          workspace,
        });
        const { result, outputJson } = packOffload('listing', offloaded);
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { path: p },
          outputJson,
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
  // Every agent-issued command is logged for audit purposes; dangerous patterns
  // are soft-blocked so the agent can self-correct.
  const bash = createTool({
    description: 'Execute a shell command in the workspace (e.g., run tests, install deps)',
    execute: async ({ command }) => {
      // Redact likely tokens/secrets before they reach stdout/logs.
      const auditCommand = redactString(command);
      auditLog(
        `[bash:audit] container=${workspace.containerId} cmd=${JSON.stringify(auditCommand)}`
      );
      const start = Date.now();

      const blocked = await scanShellCommand(command);
      if (blocked) {
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error: SECURITY_TRACE_ERRORS.SHELL_BLOCK,
          inputJson: { command: auditCommand },
          outputJson: { output: blocked },
          toolName: 'bash',
        });
        return { output: blocked };
      }

      try {
        const { exitCode, stderr, stdout } = await workspace.execCapture(command, {
          timeoutMs: 600_000,
        });
        // A non-zero exit comes back here rather than throwing, so the failure
        // path — a full test/build log — goes through the same offload as the
        // success path, which is where the bulk of oversized output appears.
        const raw = `Command finished (exit code ${exitCode}):\n${stdout}\n${stderr}`.trim();
        const offloaded = await offloadIfLarge({
          maxChars: maxToolOutputChars,
          output: raw,
          toolName: 'bash',
          workspace,
        });
        const { result, outputJson } = packOffload('output', offloaded);
        const error = exitCode === 0 ? undefined : `exit code ${exitCode}`;
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error,
          inputJson: { command: auditCommand },
          outputJson,
          toolName: 'bash',
        });
        return result;
      } catch (err: unknown) {
        const error = getErrorMessage(err);
        const output = `Command failed: ${error}`;
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error,
          inputJson: { command: auditCommand },
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

  return { bash, listDirectory, readFile, writeFile };
}
