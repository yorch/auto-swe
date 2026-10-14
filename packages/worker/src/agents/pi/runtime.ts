import { getSettingDefinition } from '@auto-swe/shared/config';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Message, ToolResultMessage } from '@mariozechner/pi-ai';
import type { LanguageModel } from 'ai';
import { resolveModel } from '../../lib/models.js';
import {
  type HarnessAdapter,
  type HarnessRuntimeOptions,
  type HarnessTurn,
  type HarnessTurnResult,
  WORKSPACE_DIR,
  withUsageReport,
} from '../harness/adapter.js';
import { type McpRelay, openMcpRelay } from '../harness/mcpRelay.js';
import { type HarnessRuntime, harnessRuntime } from '../harness/runtime.js';
import { summedCallsUsage, type UsageTotals } from '../harness/usage.js';
import { type CompactionResult, compactMessages, toolDefinitionChars } from './compaction.js';
import { piMcpTools } from './mcp.js';
import { aiSdkStreamFn, piModelDescriptor } from './model.js';
import {
  canonicalisePiArgs,
  decidePiToolCall,
  PI_CAPABILITIES,
  type PiPolicyContext,
  type PiTool,
  piToolsFor,
} from './policy.js';
import { buildPiTools, type TurnHolder } from './tools.js';

/** The most of the repository's context file the system prompt carries. */
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

/** The Agent's resolved model, as the worker's own model binding takes it. */
export interface PiAccess {
  apiBase?: string | null;
  apiKey: string;
  /** `<provider>/<model>`, as the Agent resolved it. */
  spec: string;
}

export interface PiRuntimeOptions extends Omit<HarnessRuntimeOptions<PiAccess>, 'exactToolKeys'> {
  /**
   * The exact Pi tools to grant, in place of reading `toolKeys`: for a caller
   * whose tool rule is not the implementer's (an agent run grants only what the
   * Agent names). An empty list is no tools, never all of them.
   */
  tools?: readonly PiTool[];
  /** The bound model, in place of resolving `access` (tests). */
  languageModel?: LanguageModel;
}

/** What one turn spent: each model call it made, by the spec it was priced at. */
interface PiUsageReport {
  calls: { model: string; usage: UsageTotals }[];
}

/** One-line descriptions of Pi's tools, as Pi's own system prompt lists them. */
const TOOL_SNIPPETS: Record<PiTool, string> = {
  bash: 'Execute shell commands (tests, builds, git)',
  edit: 'Make precise edits to files by replacing exact text',
  find: 'Find files by glob pattern',
  grep: 'Search file contents for patterns',
  ls: 'List directory contents',
  read: 'Read file contents',
  write: 'Create or overwrite files',
};

/**
 * Pi's system prompt for a workspace turn: Pi's own opening and guidelines,
 * without the part that points the model at Pi's documentation (on the worker,
 * where no tool can read it), then the caller's prompt, then the repository's
 * context file as Pi's "Project Context".
 */
export function piSystemPrompt(input: {
  system: string;
  tools: readonly PiTool[];
  /** Tools beyond Pi's own (the Agent's MCP connection), by name and description. */
  extraTools?: readonly { name: string; description: string }[];
  projectContext?: { path: string; content: string } | null;
  date?: Date;
}): string {
  const listed = [
    ...input.tools.map((t) => `- ${t}: ${TOOL_SNIPPETS[t]}`),
    ...(input.extraTools ?? []).map(
      (t) => `- ${t.name}: ${t.description.split('\n')[0]?.trim() || 'MCP tool'}`
    ),
  ];
  const toolList = listed.length ? listed.join('\n') : '(none)';
  const explores = input.tools.some((t) => t === 'grep' || t === 'find' || t === 'ls');
  const guidelines = [
    ...(input.tools.includes('bash')
      ? [
          explores
            ? 'Prefer grep/find/ls tools over bash for file exploration'
            : 'Use bash for file operations like ls, rg, find',
        ]
      : []),
    'Be concise in your responses',
    'Show file paths clearly when working with files',
  ];
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolList}

Guidelines:
${guidelines.map((g) => `- ${g}`).join('\n')}`;
  if (input.system) {
    prompt += `\n\n${input.system}`;
  }
  if (input.projectContext) {
    prompt += `\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## ${input.projectContext.path}\n\n${input.projectContext.content}\n\n`;
  }
  return `${prompt}\nCurrent date: ${date}\nCurrent working directory: ${WORKSPACE_DIR}`;
}

/**
 * The repository's root `AGENTS.md`, else its `CLAUDE.md` — the context file Pi
 * reads — or null. Read once per session, as text, and capped.
 */
async function readProjectContext(
  turn: HarnessTurn
): Promise<{ path: string; content: string } | null> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const out = await turn.exec({
      args: [name],
      script: `test -f "$1" && head -c ${MAX_CONTEXT_FILE_BYTES} -- "$1"`,
      timeoutMs: 30_000,
    });
    if (out.exitCode === 0) {
      return { content: out.stdout.toString('utf8'), path: `${WORKSPACE_DIR}/${name}` };
    }
  }
  return null;
}

function textOfResult(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/** What the trace records of a call's input: a write's path, not its content. */
function traceInput(toolName: string, args: Record<string, unknown>): unknown {
  return toolName === 'write' || toolName === 'edit' ? { path: args.path } : args;
}

/**
 * Pi as a harness adapter, run in the worker.
 *
 * Pi's agent loop (`pi-agent-core`) runs here, not in the container. Its
 * `beforeToolCall` hook, which the loop awaits before every tool call, is
 * `turn.decide`: the call runs only if the worker allows it, and a hook that
 * throws blocks it. Pi's own `read`, `write`, `edit`, `ls` and `find` act on
 * the container through `turn.exec`; its `bash` and `grep` are the worker's
 * (`tools.ts`). The Agent's MCP connection is relayed from the worker
 * (`mcp.ts`). Model calls go through the worker's own model binding
 * (`model.ts`). Nothing from the repository is loaded but its context file,
 * read as text.
 *
 * The conversation is kept across turns, so a TDD loop keeps its context.
 */
export function piAdapter(options: PiRuntimeOptions): HarnessAdapter<PiUsageReport> {
  const { access, loadProjectSettings, maxTurns, workspace } = options;
  const tools = options.tools ? [...options.tools] : piToolsFor(options.toolKeys);
  const policy: PiPolicyContext = {
    containerId: workspace.containerId,
    projectContextLoaded: loadProjectSettings,
    tools,
  };
  const holder: TurnHolder = {};
  let session:
    | {
        agentTools: AgentTool[];
        /** The relayed MCP tools among `agentTools`. */
        mcpTools: AgentTool[];
        messages: AgentMessage[];
        projectContext: { path: string; content: string } | null;
      }
    | undefined;
  let model: LanguageModel | undefined;
  // The Agent's MCP connection, opened once from the worker for the session;
  // null when it has none or it could not be reached (the agent then works
  // without it, as on the Mastra loop).
  let relay: McpRelay | null = null;

  async function openSession(turn: HarnessTurn) {
    if (!session) {
      const maxToolOutputChars =
        options.maxToolOutputChars ??
        getSettingDefinition('workspace.maxToolOutputChars').defaultValue;
      relay = options.mcp ? await openMcpRelay(options.mcp, options.tracer) : null;
      const mcpTools = relay
        ? piMcpTools({ maxToolOutputChars, relay, tracer: options.tracer, workspace })
        : [];
      policy.mcpTools = mcpTools.map((t) => t.name);
      const own = await buildPiTools({ granted: tools, holder, maxToolOutputChars, workspace });
      session = {
        agentTools: [...own, ...mcpTools],
        mcpTools,
        messages: [],
        projectContext: loadProjectSettings ? await readProjectContext(turn) : null,
      };
    }
    return session;
  }

  async function runTurn(
    turn: HarnessTurn,
    { system, user }: { system: string; user: string }
  ): Promise<HarnessTurnResult<PiUsageReport>> {
    holder.current = turn;
    const report: PiUsageReport = { calls: [] };
    let steps = 0;
    let toolCalls = 0;
    let atTurnCap = false;
    let modelError: { error: unknown } | undefined;
    // What the turn's compactions came to: how many model calls were compacted,
    // and the figures of the last one. Traced once, when the turn ends.
    let compaction:
      | { budgetTokens: number; calls: number; last: Omit<CompactionResult, 'messages'> }
      | undefined;
    try {
      const open = await openSession(turn);
      model ??=
        options.languageModel ??
        resolveModel(access.spec, access.apiKey, access.apiBase ?? undefined);
      const { runAgentLoop } = await import('@mariozechner/pi-agent-core');
      const streamFn = aiSdkStreamFn(
        {
          heartbeat: () => turn.heartbeat(),
          model,
          onCall: ({ id, usage }) => {
            report.calls.push({ model: access.spec, usage });
            turn.callSpent(id, access.spec, usage);
          },
          onError: (error) => {
            modelError = { error };
          },
          spec: access.spec,
        },
        () => open.agentTools
      );
      const prompt: AgentMessage = { content: user, role: 'user', timestamp: Date.now() };
      const systemPrompt = piSystemPrompt({
        extraTools: open.mcpTools,
        projectContext: open.projectContext,
        system,
        tools,
      });
      const budgetTokens =
        options.harnessContextTokens ??
        getSettingDefinition('workspace.harnessContextTokens').defaultValue;
      const overheadChars = toolDefinitionChars(open.agentTools);
      // Fit a conversation to the budget, noting it when that changed anything.
      const compact = (messages: AgentMessage[], sentToModel: boolean) => {
        const { messages: fitted, ...figures } = compactMessages({
          budgetTokens,
          messages,
          overheadChars,
          systemPrompt,
        });
        if (fitted !== messages) {
          compaction = {
            budgetTokens,
            calls: (compaction?.calls ?? 0) + (sentToModel ? 1 : 0),
            last: figures,
          };
        }
        return fitted;
      };
      const added = await runAgentLoop(
        [prompt],
        {
          messages: open.messages,
          systemPrompt,
          tools: open.agentTools,
        },
        {
          afterToolCall: async ({ args, isError, result, toolCall }) => {
            const inputJson = traceInput(toolCall.name, args as Record<string, unknown>);
            if (isError) {
              turn.failed(toolCall.id, {
                error: textOfResult(result),
                inputJson,
                toolName: toolCall.name,
              });
              return undefined;
            }
            const { warning } = turn.completed(toolCall.id, {
              inputJson,
              output: textOfResult(result),
              toolName: toolCall.name,
            });
            return warning
              ? { content: [...result.content, { text: `\n\n${warning}`, type: 'text' }] }
              : undefined;
          },
          // Awaited before every tool call. The decision rewrites the call's path
          // to the absolute one it decided, in place, and Pi runs the call on the
          // same object.
          beforeToolCall: async ({ args, toolCall }) => {
            toolCalls += 1;
            const verdict = await turn.decide(
              toolCall.id,
              toolCall.name,
              args as Record<string, unknown>,
              WORKSPACE_DIR
            );
            return verdict.allow ? undefined : { block: true, reason: verdict.reason };
          },
          convertToLlm: (messages) => messages as Message[],
          model: piModelDescriptor(access.spec),
          shouldStopAfterTurn: ({ message }) => {
            steps += 1;
            const wantsMore = (message as AssistantMessage).content.some(
              (c) => c.type === 'toolCall'
            );
            atTurnCap = wantsMore && steps >= maxTurns;
            return atTurnCap;
          },
          // One call at a time, as the Mastra loop and the trace order them.
          toolExecution: 'sequential',
          // Runs before every model call and receives the loop's live message
          // array, not a copy. Returning a different array shapes what is sent;
          // it is safe only because `compactMessages` never mutates its input.
          transformContext: async (messages) => compact(messages, true),
        },
        () => turn.heartbeat(),
        turn.abort.signal,
        streamFn
      );

      const last = added.at(-1) as AssistantMessage | ToolResultMessage | undefined;
      const ended = last?.role === 'assistant' ? last : undefined;
      // A failed or aborted call leaves an empty message the next turn must not replay.
      open.messages.push(
        ...added.filter(
          (m) =>
            !(
              (m as AssistantMessage).role === 'assistant' &&
              ['error', 'aborted'].includes((m as AssistantMessage).stopReason)
            )
        )
      );
      // The session keeps what the next turn would send, so a long session does
      // not carry history it would only elide or drop again.
      const kept = compact(open.messages, false);
      if (kept !== open.messages) {
        open.messages.splice(0, open.messages.length, ...kept);
      }

      if (ended?.stopReason === 'aborted' || turn.abort.signal.aborted) {
        turn.throwIfCancelled();
        if (turn.deadlineReached()) {
          return { stoppedReason: 'wall_clock', toolCallCount: toolCalls, usage: report };
        }
        throw withUsageReport(new Error('The Pi turn was aborted.'), report);
      }
      if (ended?.stopReason === 'error') {
        throw withUsageReport(
          modelError?.error ?? new Error(`Pi ended with an error: ${ended.errorMessage ?? ''}`),
          report
        );
      }
      const text = ended?.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim();
      return {
        steps,
        stoppedReason: atTurnCap ? 'max_steps' : undefined,
        text: text || undefined,
        toolCallCount: toolCalls,
        usage: report,
      };
    } finally {
      holder.current = undefined;
      if (compaction) {
        options.tracer.addActivityEvent({
          name: 'pi.context_compacted',
          outputJson: {
            ...compaction.last,
            budgetTokens: compaction.budgetTokens,
            compactingCalls: compaction.calls,
          },
        });
      }
    }
  }

  return {
    capabilities: PI_CAPABILITIES,
    async close() {
      await relay?.close();
    },
    decide: async (toolName, input) => {
      const refused = canonicalisePiArgs(toolName, input);
      return refused
        ? { allow: false, reason: refused }
        : decidePiToolCall(toolName, input, policy);
    },
    kind: 'pi',
    label: 'Pi',
    runTurn,
    usage: { normalise: (report) => summedCallsUsage('', report.calls) },
  };
}

/**
 * Pi as an implementer runtime: {@link piAdapter} in the shared harness runtime
 * (`harness/runtime.ts`), which bounds and traces every policy decision, meters
 * each model call as it completes, and kills what a turn started in the
 * container when it ends. Nothing is installed in the container.
 *
 * One runtime serves one workspace.
 */
export function piRuntime(options: PiRuntimeOptions): HarnessRuntime {
  return harnessRuntime(piAdapter(options), options);
}
