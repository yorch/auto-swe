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
 * One tool call the model issued, as it moves through the loop.
 *
 * Keyed per *occurrence* rather than per id, because nothing stops a model from reusing a call id
 * within a batch: a reused id then gets a row of its own instead of collapsing into the first. Its
 * arguments and outcome may be approximate for such a batch — no provider contract covers it — but
 * no call goes unaccounted for.
 */
interface CallRecord {
  /** A row exists for it: whoever owns the call wrote one, or this file did. */
  accounted: boolean;
  args: Record<string, unknown>;
  callId: string;
  /** The `tool_execution_end` event has been seen. */
  ended: boolean;
  /** The tool actually ran (`durationMs` was present). */
  ran: boolean;
  /** The last end event's text, for a row written here because nothing else recorded the call. */
  text?: string;
  toolName: string;
}

/**
 * Record a tool call the loop answered without running it.
 *
 * Pi validates a call's arguments against the tool's schema before `beforeToolCall`, so a mismatch
 * (and the loop's own abort check) produces the error result without ever reaching the worker's
 * `decide` or `afterToolCall`. The loop's `tool_execution_end` event says which calls those were:
 * it carries `durationMs` only when `execute()` ran. Every other row is written by whoever ran the
 * call — `afterToolCall`, a worker tool's own body, or `decide` for a denial.
 *
 * Doing this from the event, rather than from the messages the loop returns, means a turn that
 * throws later still records the calls before it.
 */
function recordUnaccountedCall(turn: HarnessTurn, record: CallRecord, reason: string): void {
  try {
    turn.failed(record.callId, {
      error: record.text || reason,
      inputJson: traceInput(record.toolName, record.args),
      toolName: record.toolName,
    });
    record.accounted = true;
  } catch {
    // The tracer itself failed: there is no row to write. Nothing here can fix that, and the turn
    // is already ending, so it must not throw out of the caller's cleanup.
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
  // Two owners besides this file, and they differ in what they cover. A worker tool's body records
  // the call it ran — but only a successful one, so a throw is still traced here. A browser tool's
  // body records both outcomes and rethrows, so nothing is added for it either way.
  const bodyRecordsSuccess = new Set(policy.workerTools);
  const bodyRecordsEverything = new Set(
    options.browserToolset ? BROWSER_TOOLS.map((entry) => entry.name) : []
  );
  // A worker tool may not take one of Pi's own names: the policy decides Pi's tools first, so
  // the binding would be dead — and if the order ever changed, a call named `bash` would reach
  // the container without a path check or a scanner. Refused where the session is built.
  for (const name of bodyRecordsSuccess) {
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
      /**
       * Every call the model issued this turn, in the order it issued them. Registered from the
       * assistant message (`message_end`, which arrives before any tool runs) so a batch a
       * cancellation or a throw cuts short is still known in full.
       */
      const records: CallRecord[] = [];
      const registered = new WeakSet<object>();
      const noteBatch = (message: AgentMessage) => {
        if (message.role !== 'assistant' || registered.has(message)) {
          return;
        }
        registered.add(message);
        for (const part of message.content) {
          if (part.type === 'toolCall') {
            records.push({
              accounted: false,
              args: part.arguments,
              callId: part.id,
              ended: false,
              ran: false,
              toolName: part.name,
            });
          }
        }
      };
      /** The occurrence of `callId` the loop is working on: the first one not yet ended. */
      const live = (callId: string): CallRecord | undefined =>
        records.find((record) => record.callId === callId && !record.ended);
      /** The row for a call is written, by whoever owns it. */
      const recorded = (callId: string) => {
        const record = live(callId);
        if (record) {
          record.accounted = true;
        }
      };
      let added: AgentMessage[] = [];
      try {
        added = await runAgentLoop(
          [prompt],
          {
            messages: open.messages,
            tools: open.agentTools,
          },
          {
            afterToolCall: async ({ args, isError, result, toolCall }) => {
              const inputJson = traceInput(toolCall.name, args as Record<string, unknown>);
              if (bodyRecordsEverything.has(toolCall.name)) {
                // The browser toolset recorded this call, success or failure, and rethrew.
                recorded(toolCall.id);
                return undefined;
              }
              // No try/catch: `recorded` runs only after the trace call returns, so a throw leaves
              // the call unaccounted and the cleanup below writes its row from the end event. Pi
              // catches a hook's exception itself, so the turn is not failed by one.
              if (isError) {
                // A worker tool's body traces its own result, not its throws, so this row is the
                // only one an exception gets.
                turn.failed(toolCall.id, {
                  error: textOfResult(result),
                  inputJson,
                  toolName: toolCall.name,
                });
                recorded(toolCall.id);
                return undefined;
              }
              if (bodyRecordsSuccess.has(toolCall.name)) {
                // The body wrote its own row.
                recorded(toolCall.id);
                return undefined;
              }
              const { warning } = turn.completed(toolCall.id, {
                inputJson,
                output: textOfResult(result),
                toolName: toolCall.name,
              });
              recorded(toolCall.id);
              return warning
                ? { content: [...result.content, { text: `\n\n${warning}`, type: 'text' }] }
                : undefined;
            },
            // Awaited before every tool call. The decision rewrites the call's path
            // to the absolute one it decided, in place, and Pi runs the call on the
            // same object.
            beforeToolCall: async ({ args, assistantMessage, toolCall }) => {
              toolCalls += 1;
              // Belt and braces: `message_end` has normally registered the batch already, and this
              // keeps a hook-only arrival accounted for.
              noteBatch(assistantMessage);
              const verdict = await turn.decide(
                toolCall.id,
                toolCall.name,
                args as Record<string, unknown>,
                WORKSPACE_DIR
              );
              if (!verdict.allow) {
                // The refusal wrote the row.
                recorded(toolCall.id);
                return { block: true, reason: verdict.reason };
              }
              // The decision resolved the path in place, in the object Pi executes with: that is
              // the path this call's row should carry.
              const current = live(toolCall.id);
              if (current) {
                current.args = args as Record<string, unknown>;
              }
              return undefined;
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
          async (event: {
            args?: Record<string, unknown>;
            durationMs?: number;
            isError?: boolean;
            message?: AgentMessage;
            result?: { content?: readonly { text?: string; type: string }[] };
            toolCallId?: string;
            toolName?: string;
            type?: string;
          }) => {
            if (event.type === 'message_end' && event.message) {
              // The whole batch, before any tool in it runs: a cancelled or truncated batch cannot
              // hide its later calls from the cleanup.
              noteBatch(event.message);
              return;
            }
            if (event.type === 'tool_execution_start' && event.toolCallId !== undefined) {
              // A call the batch registration never saw (a provider message shape the loop
              // assembles itself) still gets a record, with the arguments as the model wrote them.
              if (!live(event.toolCallId)) {
                records.push({
                  accounted: false,
                  args: event.args ?? {},
                  callId: event.toolCallId,
                  ended: false,
                  ran: false,
                  toolName: event.toolName ?? 'unknown',
                });
              }
              return;
            }
            if (event.type !== 'tool_execution_end' || event.toolCallId === undefined) {
              return;
            }
            const call = live(event.toolCallId);
            if (call) {
              call.ended = true;
              // `durationMs` is present only when `execute()` ran; the row for a call that ran is
              // written by the tool, `afterToolCall`, or (a denial) `decide`.
              call.ran = event.durationMs !== undefined;
              call.text = textOfParts(event.result?.content ?? []) || undefined;
              if (!call.ran && !call.accounted) {
                recordUnaccountedCall(turn, call, 'The call was not executed.');
              }
            }
            turn.heartbeat();
          },
          turn.abort.signal,
          streamFn
        );
      } finally {
        // However the turn ends — a cancelled batch (the loop stops issuing events for calls it
        // never reached), a throw out of the loop, an abort, a tracer that failed — every call the
        // model issued has a row by the time this returns. A call that ran keeps its outcome; one
        // the loop never reached says so.
        for (const record of records) {
          if (!record.accounted) {
            recordUnaccountedCall(
              turn,
              record,
              record.ran
                ? 'The call ran, but its result could not be recorded.'
                : 'The turn ended before this call ran.'
            );
          }
        }
      }

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
