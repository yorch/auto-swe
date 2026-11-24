import { getSettingDefinition } from '@auto-swe/shared/config';
import type { ReasoningLevel } from '@auto-swe/shared/types/api';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { ApplicationFailure } from '@temporalio/activity';
import type { LanguageModel } from 'ai';
import { resolveModel } from '../../lib/models.js';
import { createSteeringDrain } from '../../lib/runSteering.js';
import { BROWSER_TOOLS, type BrowserToolset } from '../browserTools.js';
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
import { piKnowledgeTool } from '../knowledgeSearchBindings.js';
import { bindKnowledgeSearch } from '../knowledgeTools.js';
import { type RepoContext, readWorkspaceRepoContext, repoContextBlock } from '../repoContext.js';
import { loadSkillWorkerTool } from '../skillDisclosure.js';
import { toPiTool, type WorkerTool, workerToolNames } from '../workerTool.js';
import {
  type CompactionResult,
  compactMessages,
  createCompactor,
  toolDefinitionChars,
} from './compaction.js';
import { piMcpTools } from './mcp.js';
import { aiSdkStreamFn, piModelDescriptor } from './model.js';
import {
  canonicalisePiArgs,
  decidePiToolCall,
  PI_CAPABILITIES,
  PI_TOOLS,
  type PiPolicyContext,
  type PiTool,
  piToolsFor,
} from './policy.js';
import { buildPiTools, type TurnHolder } from './tools.js';

export function piBrowserToolContent(result?: {
  image?: { data: Buffer; mimeType: string };
  text?: string;
}) {
  return [
    { text: result?.text ?? '', type: 'text' as const },
    ...(result?.image
      ? [
          {
            data: result.image.data.toString('base64'),
            mimeType: result.image.mimeType,
            type: 'image' as const,
          },
        ]
      : []),
  ];
}

/** The most of the repository's context file the system prompt carries. */
export { MAX_REPO_CONTEXT_BYTES as MAX_CONTEXT_FILE_BYTES } from '../repoContext.js';

/** The Agent's resolved model, as the worker's own model binding takes it. */
export interface PiAccess {
  apiBase?: string | null;
  apiKey: string;
  /** `<provider>/<model>`, as the Agent resolved it. */
  spec: string;
  /** The Agent's reasoning level, bound into the model; null/absent = the provider's default. */
  reasoning?: ReasoningLevel | null;
}

export interface PiRuntimeOptions extends Omit<HarnessRuntimeOptions<PiAccess>, 'exactToolKeys'> {
  /**
   * The exact Pi tools to grant, in place of reading `toolKeys`: for a caller
   * whose tool rule is not the implementer's (an agent run grants only what the
   * Agent names). An empty list is no tools, never all of them.
   */
  tools?: readonly PiTool[];
  browserToolset?: BrowserToolset;
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
  projectContext?: RepoContext | null;
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
    prompt += `\n\n${repoContextBlock(input.projectContext)}\n\n`;
  }
  return `${prompt}\nCurrent date: ${date}\nCurrent working directory: ${WORKSPACE_DIR}`;
}

function textOfResult(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/** The text of a tool result's content parts, which is what the model saw. */
function textOfParts(content: readonly { text?: string; type: string }[]): string {
  return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/**
 * One row for each tool call the loop answered without running it.
 *
 * Pi validates a call's arguments against the tool's schema before `beforeToolCall`, and on a
 * mismatch it produces the error result itself: neither the worker's `decide` nor `afterToolCall`
 * runs, so nothing has traced the call. The model still made it and is still billed for it, so it
 * is recorded here with the error the model saw — once, by call id. Two cases are outside it: a
 * turn that throws before the loop returns records nothing from this pass, and a call the policy
 * allowed that hit the loop's abort check after `beforeToolCall` stays untraced.
 */
function recordUnrunCalls(
  turn: HarnessTurn,
  decided: ReadonlySet<string>,
  messages: readonly AgentMessage[]
): void {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      results.set(message.toolCallId, message);
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'toolCall' || decided.has(part.id)) {
        continue;
      }
      const result = results.get(part.id);
      turn.failed(part.id, {
        error: result ? textOfParts(result.content) : 'the call was not executed',
        // The same projection every other Pi row uses: a write's path, never its content.
        inputJson: traceInput(part.name, part.arguments),
        toolName: part.name,
      });
    }
  }
}

/** What the trace records of a call's input: a write's path, not its content. */
function traceInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
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
  const knowledgeSearch = bindKnowledgeSearch(
    workspace.knowledgeBaseSnapshotIds ?? [],
    options.toolKeys?.includes('searchKnowledge') ?? false
  );
  // Every worker-side tool this session binds: the harness's own (`workerTools`,
  // which is the lesson recall tools, `submitLearning` and `provisionTool` the
  // Mastra loop binds) and `loadSkill`, so a skill's full text is fetched on
  // demand exactly as it is on the Mastra loop.
  const skills = options.skills ?? [];
  const workerTools: WorkerTool[] = [
    ...(skills.length > 0 ? [loadSkillWorkerTool(skills, options.tracer)] : []),
    ...(options.workerTools ?? []),
  ];
  const policy: PiPolicyContext = {
    browserTools: [
      ...(options.browserToolset ? BROWSER_TOOLS.map((entry) => entry.name) : []),
      ...(options.evalLessonTools ?? []).map((entry) => entry.name),
    ],
    containerId: workspace.containerId,
    tools,
    workerTools: workerToolNames(workerTools),
  };
  // Worker tools record their own call (`WorkerTool` bodies trace exactly as they do under the
  // Mastra loop), so this loop must not record a second row for them. A call that throws is
  // still traced here: the body had nothing to report.
  const selfTracing = new Set(policy.workerTools);
  // A worker tool may not take one of Pi's own names: the policy decides Pi's tools first, so
  // the binding would be dead — and if the order ever changed, a call named `bash` would reach
  // the container without a path check or a scanner. Refused where the session is built.
  for (const name of selfTracing) {
    if ((PI_TOOLS as readonly string[]).includes(name)) {
      throw ApplicationFailure.nonRetryable(
        `A worker tool is named '${name}', which is one of Pi's own tools. Rename it (mcp tools are prefixed 'mcp__', and the browser's 'browser_'), or the worker's policy cannot tell them apart.`,
        'HARNESS_TOOL_NAME_COLLISION'
      );
    }
  }
  const steer = options.steeringRunId
    ? createSteeringDrain(options.steeringRunId, options.tracer)
    : undefined;
  const holder: TurnHolder = {};
  let session:
    | {
        agentTools: AgentTool[];
        browserTools: AgentTool[];
        /** The relayed MCP tools among `agentTools`. */
        mcpTools: AgentTool[];
        /** The worker-side tools among `agentTools`, besides Pi's own. */
        workerTools: AgentTool[];
        messages: AgentMessage[];
        projectContext: RepoContext | null;
      }
    | undefined;
  let model: LanguageModel | undefined;
  // The Agent's MCP connection, opened once from the worker for the session;
  // null when it has none or it could not be reached (the agent then works
  // without it, as on the Mastra loop).
  let relay: McpRelay | null = null;

  async function openSession() {
    if (!session) {
      const maxToolOutputChars =
        options.maxToolOutputChars ??
        getSettingDefinition('workspace.maxToolOutputChars').defaultValue;
      relay = options.mcp ? await openMcpRelay(options.mcp, options.tracer) : null;
      const mcpTools = [
        ...(relay
          ? piMcpTools({ maxToolOutputChars, relay, tracer: options.tracer, workspace })
          : []),
        ...(knowledgeSearch ? [piKnowledgeTool(knowledgeSearch)] : []),
      ];
      policy.mcpTools = mcpTools.map((t) => t.name);
      const own = await buildPiTools({ granted: tools, holder, maxToolOutputChars, workspace });
      const browserTools = options.browserToolset
        ? BROWSER_TOOLS.map((entry) => ({
            description: entry.description,
            async execute(_id: string, params: unknown) {
              const result = await options.browserToolset?.call(entry.name, params);
              return {
                content: piBrowserToolContent(result),
                details: undefined,
              };
            },
            label: entry.name,
            name: entry.name,
            parameters: entry.schema.toJSONSchema() as AgentTool['parameters'],
          }))
        : [];
      const evalTools = (options.evalLessonTools ?? []).map((entry) => ({
        description: entry.description,
        async execute(_id: string, params: unknown) {
          return {
            content: [{ text: JSON.stringify(await entry.call(params)), type: 'text' as const }],
            details: undefined,
          };
        },
        label: entry.name,
        name: entry.name,
        parameters: entry.schema.toJSONSchema() as AgentTool['parameters'],
      }));
      const own_worker = workerTools.map((tool) => toPiTool(tool));
      session = {
        agentTools: [...own, ...mcpTools, ...browserTools, ...evalTools, ...own_worker],
        browserTools: [...browserTools, ...evalTools],
        mcpTools,
        messages: [],
        // Resolved once, when the workspace was created, from the commit it was created against:
        // the same value the Mastra loop reads, so both loops run under one file.
        projectContext: loadProjectSettings ? readWorkspaceRepoContext(workspace) : null,
        workerTools: own_worker,
      };
    }
    if (!session) {
      throw new Error('Pi session failed to initialize');
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
      const open = await openSession();
      model ??=
        options.languageModel ??
        resolveModel(access.spec, access.apiKey, access.apiBase ?? undefined, access.reasoning);
      const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
      const systemPrompt = piSystemPrompt({
        extraTools: [...open.mcpTools, ...open.browserTools, ...open.workerTools],
        projectContext: open.projectContext,
        system,
        tools,
      });
      const streamFn = aiSdkStreamFn(
        {
          beforeCall: () => turn.precheck(),
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
          system: systemPrompt,
        },
        () => open.agentTools
      );
      const prompt: AgentMessage = { content: user, role: 'user', timestamp: Date.now() };
      const budgetTokens =
        options.harnessContextTokens ??
        getSettingDefinition('workspace.harnessContextTokens').defaultValue;
      const overheadChars = toolDefinitionChars(open.agentTools);
      const noteCompaction = (
        figures: Omit<CompactionResult, 'messages'>,
        sentToModel: boolean
      ) => {
        compaction = {
          budgetTokens,
          calls: (compaction?.calls ?? 0) + (sentToModel ? 1 : 0),
          last: figures,
        };
      };
      const compactor = createCompactor({ budgetTokens, overheadChars, systemPrompt });
      const decided = new Set<string>();
      const added = await runAgentLoop(
        [prompt],
        {
          messages: open.messages,
          tools: open.agentTools,
        },
        {
          afterToolCall: async ({ args, isError, result, toolCall }) => {
            const inputJson = traceInput(toolCall.name, args as Record<string, unknown>);
            if (isError) {
              // A worker tool's body traces its own result, not its throws, so this row is the
              // only one an exception gets.
              turn.failed(toolCall.id, {
                error: textOfResult(result),
                inputJson,
                toolName: toolCall.name,
              });
              return undefined;
            }
            if (selfTracing.has(toolCall.name)) {
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
            decided.add(toolCall.id);
            const verdict = await turn.decide(
              toolCall.id,
              toolCall.name,
              args as Record<string, unknown>,
              WORKSPACE_DIR
            );
            return verdict.allow ? undefined : { block: true, reason: verdict.reason };
          },
          convertToLlm: (messages) => messages as Message[],
          // Called by the library after EVERY turn (a text-only reply too) and the loop goes on
          // while it returns messages, so steering can extend a run past its turn cap. Once the
          // cap is reached it returns nothing and leaves the messages queued, so the loop ends.
          // Never throws.
          ...(steer
            ? {
                getSteeringMessages: async (): Promise<AgentMessage[]> => {
                  if (steps >= maxTurns) {
                    return [];
                  }
                  const block = await steer();
                  return block ? [{ content: block, role: 'user', timestamp: Date.now() }] : [];
                },
              }
            : {}),
          finishTurn: ({ message }) => {
            steps += 1;
            const wantsMore = (message as AssistantMessage).content.some(
              (c) => c.type === 'toolCall'
            );
            atTurnCap = wantsMore && steps >= maxTurns;
            return atTurnCap ? { action: 'end' } : undefined;
          },
          model: piModelDescriptor(access.spec),
          // One call at a time, as the Mastra loop and the trace order them.
          toolExecution: 'sequential',
          // Runs before every model call and receives the loop's live message
          // array, not a copy. Returning a different array shapes what is sent;
          // it is safe only because `compactMessages` never mutates its input.
          transformContext: async (messages: AgentMessage[]) => {
            const { figures, messages: fitted } = compactor.next(messages);
            if (figures) {
              noteCompaction(figures, true);
            }
            return fitted;
          },
        },
        () => turn.heartbeat(),
        turn.abort.signal,
        streamFn
      );

      // A call Pi refused for its arguments never reached the policy or `afterToolCall`.
      recordUnrunCalls(turn, decided, added);
      const last = added.at(-1) as AssistantMessage | ToolResultMessage | undefined;
      const ended = last?.role === 'assistant' ? last : undefined;
      // A failed or aborted call leaves an empty message the next turn must not replay.
      open.messages.push(
        ...added.filter(
          (m) =>
            // Pi declares tool changes as system messages; the model call is
            // given the prompt and the worker's tools directly, so none is kept.
            (m as { role: string }).role !== 'system' &&
            !(
              (m as AssistantMessage).role === 'assistant' &&
              ['error', 'aborted'].includes((m as AssistantMessage).stopReason)
            )
        )
      );
      // The session keeps what the next turn would send, so a long session does
      // not carry history it would only elide or drop again.
      const { messages: kept, ...figures } = compactMessages({
        budgetTokens,
        messages: open.messages,
        overheadChars,
        systemPrompt,
      });
      if (kept !== open.messages) {
        noteCompaction(figures, false);
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
      await options.browserToolset?.close();
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
