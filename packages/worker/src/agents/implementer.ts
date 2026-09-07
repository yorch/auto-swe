import path from 'node:path';
import { getSettingDefinition, resolveSettings } from '@auto-swe/shared/config';
import { IMPLEMENTER_TOOL_IDS } from '@auto-swe/shared/workflow/stepRegistry';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { type AgentTracer, redactString } from '../lib/agentTracer.js';
import {
  loadAgentSkills,
  loadAgentToolConfig,
  type ResolvedSkill,
} from '../lib/config/agentSkills.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { getErrorMessage } from '../lib/errors.js';
import { getModel, type LanguageModel } from '../lib/models.js';
import { checkSensitiveFilePath } from '../lib/sensitiveFileScanner.js';
import { scanShellCommand } from '../lib/shellCommandScanner.js';
import { isMcpToolEnabled, loadMcpTools, type McpToolRecord } from './mcpTools.js';
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
 *
 * `tools`: string[] of enabled tool keys (from AgentToolConfig). null = all 4 tools.
 * `skills`: prompt-fragment skills to inject into the system prompt (in sortOrder).
 */
export type ImplementerToolId = (typeof IMPLEMENTER_TOOL_IDS)[number];
export { IMPLEMENTER_TOOL_IDS };

export interface ImplementerAgentOptions {
  /**
   * `Repository.mcpServerRef` for the repo being worked on — an http(s) URL
   * of a streamable-HTTP/SSE MCP server whose tools are added alongside the
   * built-in workspace tools. Defaults to disabled (callers must opt in).
   * Loading is additionally gated by the `'mcp'` pseudo-key in the effective
   * `AgentToolConfig` (see `isMcpToolEnabled`) and is failure-isolated: an
   * unreachable server logs `mcp.connect_failed` and the agent proceeds with
   * built-in tools only.
   */
  mcpServerRef?: string | null;
  /** Optional per-connection override of `loadMcpTools`'s list-timeout (default 15 s). */
  mcpListTimeoutMs?: number;
  /** Optional per-connection override of `loadMcpTools`'s per-call timeout (default 60 s). */
  mcpCallTimeoutMs?: number;
  /**
   * `workspace.maxToolOutputChars` (default 20,000), pre-resolved by the
   * caller. Threaded in rather than resolved here so it's a single settings
   * read per agent construction, not one per `bash`/`readFile`/`listDirectory`
   * call — `buildImplementerForActivity` resolves it alongside the tool/skill
   * config it already loads, and `evalHarness` resolves it for the same reason
   * an eval resolves the model. Omitting it falls back to the registry default,
   * which is only right for a caller with no scope to resolve against.
   */
  maxToolOutputChars?: number;
}

export async function createImplementerAgent(
  workspace: Workspace,
  tracer?: AgentTracer,
  tools?: string[] | null,
  skills?: ResolvedSkill[],
  options?: ImplementerAgentOptions,
  modelOverride?: LanguageModel
): Promise<{
  agent: Agent;
  mastra: Mastra;
  promptSuffix: string;
  /**
   * Present whenever an MCP server was contacted (including a connect that
   * returned zero tools) — callers MUST invoke it in a `finally` block to avoid
   * leaking the client connection.
   */
  closeMcp?: () => Promise<void>;
}> {
  // Resolved once, here, rather than inside a tool's `execute` — every
  // bash/readFile/listDirectory call in the session shares this value instead
  // of re-hitting the (cached, but non-zero-cost) settings resolver per call.
  const maxToolOutputChars =
    options?.maxToolOutputChars ??
    getSettingDefinition('workspace.maxToolOutputChars').defaultValue;

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
            error: 'blocked by sensitive file scanner',
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
          ? 'blocked by content security check'
          : resultText.startsWith(SECURITY_WARNINGS_PREFIX)
            ? 'content security warning'
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
      console.log(
        `[bash:audit] container=${workspace.containerId} cmd=${JSON.stringify(auditCommand)}`
      );
      const start = Date.now();

      const blocked = await scanShellCommand(command);
      if (blocked) {
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          error: 'blocked by shell command scanner',
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

  // Build a name→skill index for the load_skill tool to look up full promptText.
  const resolvedSkills = skills ?? [];
  const skillsByName = new Map(resolvedSkills.map((s) => [s.name, s]));

  // Tool: Load the full prompt text for a skill on demand (progressive disclosure).
  // The agent sees a compact L1 menu (name + description) in the system prompt and
  // calls this tool to fetch the full reasoning guidance only when it decides to
  // engage that skill — avoiding token bloat from skills that aren't needed.
  const loadSkill = createTool({
    description:
      'Load the full guidance text for an available skill by name. ' +
      'Call this when you want to apply a specific skill from the skills menu.',
    execute: async ({ name }) => {
      const start = Date.now();
      const skill = skillsByName.get(name);
      if (!skill) {
        const result = {
          promptText: `Unknown skill: ${name}. Available: ${[...skillsByName.keys()].join(', ')}`,
        };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { name },
          outputJson: result,
          toolName: 'loadSkill',
        });
        return result;
      }
      const result = { promptText: skill.promptText };
      tracer?.addToolCall({
        durationMs: Date.now() - start,
        inputJson: { name },
        outputJson: result,
        toolName: 'loadSkill',
      });
      return result;
    },
    id: 'loadSkill',
    inputSchema: z.object({ name: z.string().describe('Skill name from the skills menu') }),
    outputSchema: z.object({ promptText: z.string() }),
  });

  // All available workspace tools keyed by toolKey.
  const workspaceTools = { bash, listDirectory, readFile, writeFile };

  // Filter workspace tools by the enabled tool keys when provided; null → use all 4 tools.
  const activeWorkspaceTools =
    tools && tools.length > 0
      ? Object.fromEntries(
          tools
            .filter((key) => key in workspaceTools)
            .map((key) => [key, workspaceTools[key as keyof typeof workspaceTools]])
        )
      : workspaceTools;

  // If every provided key was unrecognised, fall back to allTools to avoid
  // instantiating an agent with no tools.
  const resolvedWorkspaceTools =
    Object.keys(activeWorkspaceTools).length > 0 ? activeWorkspaceTools : workspaceTools;

  const hasSkills = resolvedSkills.length > 0;

  // Always include loadSkill when there are skills to load; this lets the agent
  // fetch full skill guidance on demand without pre-injecting all promptTexts.
  const resolvedActiveTools = hasSkills
    ? { ...resolvedWorkspaceTools, loadSkill }
    : resolvedWorkspaceTools;

  // MCP tools (Repository.mcpServerRef): opt-in via options, gated by the 'mcp'
  // pseudo-key in AgentToolConfig (a non-empty tool config must explicitly
  // include 'mcp'; no config = all tools = MCP allowed). loadMcpTools never
  // throws — connection failures leave the agent with built-in tools only.
  let mcpTools: McpToolRecord = {};
  let closeMcp: (() => Promise<void>) | undefined;
  if (options?.mcpServerRef && isMcpToolEnabled(tools)) {
    const loaded = await loadMcpTools(options.mcpServerRef, tracer, {
      callTimeoutMs: options.mcpCallTimeoutMs,
      listTimeoutMs: options.mcpListTimeoutMs,
    });
    // Always adopt the returned close — it is NOOP on failure/empty paths and
    // safe to call repeatedly. Capturing it only when tools>0 would leak the
    // live MCP client connection when a server connects but exposes zero tools.
    closeMcp = loaded.close;
    mcpTools = loaded.tools;
  }

  // L1 skill menu: compact name + description list injected into system prompt.
  // Agent calls load_skill(name) to get the full promptText when needed.
  const promptSuffix = hasSkills
    ? [
        '## Available Skills',
        'Use the `loadSkill` tool to load the full guidance for any skill before applying it.',
        '',
        ...resolvedSkills.map((s) => `- **${s.name}**: ${s.description || s.name}`),
      ].join('\n')
    : '';

  const implementerAgent = new Agent({
    id: 'implementer',
    // instructions is overridden per-call via system message; set to empty string
    // so the constructor does not inject stale static content.
    instructions: '',
    model: modelOverride ?? (await getModel('implementer')),
    name: 'implementer',
    // Built-in tool keys always win over MCP tool keys on collision —
    // a remote server must not be able to shadow bash/readFile/writeFile.
    tools: { ...mcpTools, ...resolvedActiveTools },
  });

  const mastra = new Mastra({
    agents: { implementer: implementerAgent },
  });

  return { agent: mastra.getAgent('implementer'), closeMcp, mastra, promptSuffix };
}

/**
 * Shared implementer setup for activities: loads the implementer's tool config +
 * skills at the current scope (WORKFLOW_TEMPLATE → TEAM → GLOBAL), resolves its
 * optional MCP server URL, and builds the agent. Used by every implementer
 * activity so the load + MCP-binding lifecycle lives in one place. The caller
 * MUST invoke the returned `closeMcp` in a `finally` block.
 */
export async function buildImplementerForActivity(
  workspace: Workspace,
  tracer: AgentTracer,
  ctx?: ResolveCtx
): Promise<{
  agent: Agent;
  promptSuffix: string;
  closeMcp?: () => Promise<void>;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
}> {
  const [toolKeys, skills, toolOutputSettings] = await Promise.all([
    loadAgentToolConfig('implementer', ctx),
    loadAgentSkills('implementer', ctx),
    resolveSettings(['workspace.maxToolOutputChars'], ctx),
  ]);
  const mcpTarget = await resolveAgentMcpUrl('implementer', ctx);
  const { agent, promptSuffix, closeMcp } = await createImplementerAgent(
    workspace,
    tracer,
    toolKeys,
    skills,
    {
      maxToolOutputChars: toolOutputSettings['workspace.maxToolOutputChars'],
      mcpCallTimeoutMs: mcpTarget?.callTimeoutMs,
      mcpListTimeoutMs: mcpTarget?.listTimeoutMs,
      mcpServerRef: mcpTarget?.url,
    }
  );
  return { agent, closeMcp, promptSuffix, skills, toolKeys };
}
