import type {
  HookCallback,
  ModelUsage,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../../activities/workspace.js';
import {
  HARNESS_DIR,
  HARNESS_HOME,
  type HarnessAdapter,
  type HarnessRuntimeOptions,
  type HarnessTurn,
  type HarnessTurnResult,
  WORKSPACE_DIR,
  withUsageReport,
} from '../harness/adapter.js';
import { type McpRelay, openMcpRelay } from '../harness/mcpRelay.js';
import { POLICY_DECISION_MS } from '../harness/policy.js';
import { type HarnessRuntime, harnessRuntime } from '../harness/runtime.js';
import { runningTotalsUsage, summedCallsUsage, type UsageTotals } from '../harness/usage.js';
import type { McpTracer } from '../mcpTools.js';
import { binarySha256, resolveClaudeBinary } from './binary.js';
import { type ModelProxy, workerModelProxy } from './modelProxy.js';
import {
  CLAUDE_CODE_CAPABILITIES,
  decideToolCall,
  type HarnessTool,
  harnessToolsFor,
  MCP_RELAY_SERVER,
  type PolicyContext,
  relayedToolName,
} from './policy.js';

export { POLICY_DECISION_MS } from '../harness/policy.js';

const HARNESS_BINARY = `${HARNESS_DIR}/claude`;

/**
 * `--append-system-prompt` travels on the `docker exec` command line, and Linux
 * caps one argument at 128 KiB. A prompt past this is staged as a file in the
 * container and the prompt points at it.
 */
const MAX_INLINE_SYSTEM_CHARS = 100_000;
/**
 * Under the harness's `.claude` directory: the one place outside the checkout
 * the policy lets `Read` reach, so the harness can read what it is told to.
 */
const STAGED_PROMPT = `${HARNESS_HOME}/.claude/system-prompt.md`;

/**
 * The harness's own deadline for the PreToolUse hook, in seconds. It is longer
 * than {@link POLICY_DECISION_MS}, so the worker always answers first: a hook
 * the harness gives up on falls back to its ordinary permission rules.
 */
export const PRE_TOOL_USE_TIMEOUT_S = 120;

/**
 * Environment the SDK adds for the harness (`CLAUDE_CODE_ENTRYPOINT`,
 * `CLAUDE_AGENT_SDK_VERSION`, …). Only these names are forwarded into the
 * container, and only when the SDK set or changed them — see `sdkEnvArgs`.
 */
const SDK_ENV_NAME = /^CLAUDE_(?:CODE|AGENT_SDK)_[A-Z0-9_]+$/;

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface ClaudeCodeAccess {
  /** The credential's base URL, in the AI SDK's spelling (it may end in `/v1`). */
  apiBase?: string;
  apiKey: string;
  /** The bare model id the harness passes to the API (`claude-opus-5-5`). */
  modelId: string;
}

/**
 * Each of `toolKeys` stands for harness tools ({@link harnessToolsFor}); the
 * rest are neither offered to the harness nor allowed by the policy.
 */
export interface ClaudeCodeRuntimeOptions
  extends Omit<HarnessRuntimeOptions<ClaudeCodeAccess>, 'exactToolKeys'> {
  /**
   * The exact harness tools to grant, in place of reading `toolKeys`. For a
   * caller whose tool rule is not the implementer's: an agent run grants only
   * what the Agent names, and an empty list here is no tools, never all of them.
   */
  tools?: readonly HarnessTool[];
  /**
   * The model proxy the turns go through: omitted, the worker's own (when the
   * deployment runs one); `null`, none — the harness holds the credential.
   */
  modelProxy?: ModelProxy | null;
}

/**
 * The harness wants the API's origin and appends `/v1/messages` itself, while
 * the AI SDK credential this reuses names the `/v1` root. Strip it so one
 * credential serves both runtimes.
 */
export function normalizeAnthropicBaseUrl(apiBase: string | undefined): string {
  const trimmed = (apiBase ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return trimmed || DEFAULT_ANTHROPIC_BASE_URL;
}

/**
 * Make sure bash is there (Claude Code refuses to start a shell tool without
 * it, and Alpine ships only busybox `sh`), and make the harness's home.
 */
async function prepareContainer(workspace: Workspace): Promise<void> {
  const bash = await workspace.execCapture(
    'command -v bash >/dev/null 2>&1 || { command -v apk >/dev/null 2>&1 && apk add --no-cache bash >/dev/null 2>&1; }; command -v bash >/dev/null 2>&1',
    { timeoutMs: 120_000 }
  );
  if (bash.exitCode !== 0) {
    throw ApplicationFailure.nonRetryable(
      'The workspace image has no bash and it could not be installed (it needs to run as root with network access on Alpine). Claude Code needs bash for its shell tool; use an executor image that includes it.',
      'HARNESS_NO_SHELL'
    );
  }
  await workspace.exec(`mkdir -p ${HARNESS_HOME}/.claude`);
}

/**
 * `docker exec -e` arguments for what the SDK added to the harness's
 * environment. The SDK builds that environment from the worker's own
 * `process.env`, which holds the worker's secrets, so it is never forwarded
 * whole: only `CLAUDE_CODE_*` / `CLAUDE_AGENT_SDK_*` names whose value the SDK
 * set or changed (it is absent from, or differs from, `process.env`) travel,
 * with their value spelled out. Those are the SDK's own switches (entrypoint,
 * version, session-state flags), not credentials.
 */
export function sdkEnvArgs(env: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SDK_ENV_NAME.test(name) && process.env[name] !== value) {
      args.push('-e', `${name}=${value}`);
    }
  }
  return args;
}

/** What `result` says went wrong, as a Temporal failure the retry policy can read. */
function harnessFailure(result: SDKResultMessage, stderrTail: string): Error {
  const detail = ('errors' in result ? result.errors : []).join('; ') || stderrTail.trim();
  const status = 'api_error_status' in result ? result.api_error_status : null;
  if (status === 401 || status === 403) {
    return ApplicationFailure.nonRetryable(
      `The model API refused the Claude Code run (HTTP ${status}). Check the Anthropic credential or the gateway key. ${detail}`.trim(),
      'HARNESS_AUTH_FAILURE'
    );
  }
  return new Error(`Claude Code ended with ${result.subtype}: ${detail || 'no detail'}`);
}

/** The usage block of one Messages API response, as an assistant message streams it. */
interface StreamedUsage {
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

/**
 * The parts of an assistant message read here. The message type comes from the
 * SDK's `@anthropic-ai/sdk` peer, which is not installed, so it is narrowed here.
 */
interface AssistantReply {
  content: { type: string }[];
  id?: string;
  model?: string;
  usage?: StreamedUsage;
}

/** The SDK's per-model running totals, in the shape the usage normaliser reads. */
function totalsOf(modelUsage: Record<string, ModelUsage> | undefined) {
  const totals: Record<string, UsageTotals> = {};
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    totals[model] = {
      cacheRead: u.cacheReadInputTokens,
      cacheWrite: u.cacheCreationInputTokens,
      input: u.inputTokens,
      output: u.outputTokens,
    };
  }
  return totals;
}

/**
 * What a turn reports about its usage: the result's per-model running totals,
 * or — for a turn that never reached its result (stopped by a deadline, or its
 * process died) — the usage each streamed assistant message carried, keyed by
 * message id. One API call can stream several messages; the last report per id
 * counts. Calls the harness makes without streaming a message (a small-model
 * side task) are not seen, so the streamed form undercounts.
 */
type ClaudeUsageReport =
  | { modelUsage: Record<string, ModelUsage> | undefined }
  | { streamed: Map<string, { model: string; usage: StreamedUsage }> };

/** One streamed usage block as the shared usage counters. */
function totalsOfStreamed(usage: StreamedUsage): UsageTotals {
  return {
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

function streamedCalls(streamed: Map<string, { model: string; usage: StreamedUsage }>) {
  return [...streamed.values()].map(({ model, usage }) => ({
    model,
    usage: totalsOfStreamed(usage),
  }));
}

/**
 * Claude Code as a harness adapter.
 *
 * The Claude Agent SDK runs in the worker and speaks to the binary over the
 * `docker exec` pipe. Its `PreToolUse` hook is a callback in this process that
 * the harness waits on before every tool call, so `decideToolCall` decides each
 * one here — the per-call guarantee the registry requires. The SDK's flag and
 * policy settings layers, passed over the same pipe, keep a repository's own
 * `.claude/settings.json` from granting calls or moving the API host.
 *
 * Turns after the first resume the same session, so a TDD loop keeps its
 * context and its prompt cache.
 */
export function claudeCodeAdapter(
  options: Omit<ClaudeCodeRuntimeOptions, 'tracer'> & { tracer?: McpTracer }
): HarnessAdapter<ClaudeUsageReport> {
  const { access, loadProjectSettings, maxTurns, mcp, modelProxy, workspace } = options;
  // The Agent's MCP connection, opened once from the worker and served to each
  // turn; `null` once opening it failed (the agent then works without it).
  let relay: Promise<McpRelay | null> | undefined;
  const openRelay = () => {
    relay ??= mcp ? openMcpRelay(mcp, options.tracer) : Promise.resolve(null);
    return relay;
  };
  const baseUrl = normalizeAnthropicBaseUrl(access.apiBase);
  const tools = options.tools ? [...options.tools] : harnessToolsFor(options.toolKeys);
  const policy: PolicyContext = {
    containerId: workspace.containerId,
    cwd: WORKSPACE_DIR,
    home: HARNESS_HOME,
    projectConfigLoaded: loadProjectSettings,
    tools,
  };
  // The harness reports usage as running totals per model, and a resumed session
  // starts from its saved totals. What a turn spent is the change since the last.
  const totals = runningTotalsUsage('anthropic/');
  let sessionId: string | undefined;

  /**
   * One turn against `endpoint`: the provider itself with the real key, or the
   * worker's model proxy with a token good only for this turn.
   */
  async function driveTurn(
    turn: HarnessTurn,
    { system, user }: { system: string; user: string },
    endpoint: { baseUrl: string; apiKey: string; proxied: boolean },
    mcpServer: { instance: McpServer; timeout: number } | undefined
  ): Promise<HarnessTurnResult<ClaudeUsageReport>> {
    let result: SDKResultMessage | undefined;
    let toolCalls = 0;
    const streamed = new Map<string, { model: string; usage: StreamedUsage }>();
    const spent = (): ClaudeUsageReport =>
      result ? { modelUsage: result.modelUsage } : { streamed };
    // The deadline is a stop: end the turn with what it has and what it spent.
    const stopped = () => ({
      stoppedReason: 'wall_clock' as const,
      toolCallCount: toolCalls,
      usage: spent(),
    });

    const preToolUse: HookCallback = async (input, toolUseId) => {
      const { cwd, tool_name: toolName, tool_input: toolInput } = input as PreToolUseHookInput;
      // A hook the harness gives up on falls back to its own permission rules;
      // the worker answers first, and a decision it cannot reach is a deny.
      const verdict = await turn.decide(
        toolUseId ?? '',
        toolName,
        (toolInput ?? {}) as Record<string, unknown>,
        cwd
      );
      if (!verdict.allow) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: verdict.reason,
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
        },
      };
    };

    const postToolUse: HookCallback = async (input, toolUseId) => {
      const {
        tool_input: toolInput,
        tool_name: toolName,
        tool_response: response,
      } = input as PostToolUseHookInput;
      const { warning } = turn.completed(toolUseId ?? '', {
        inputJson: toolInput,
        output: response,
        toolName,
      });
      return warning
        ? {
            hookSpecificOutput: {
              additionalContext: warning,
              hookEventName: 'PostToolUse' as const,
            },
          }
        : {};
    };

    const postToolUseFailure: HookCallback = async (input, toolUseId) => {
      const {
        error,
        tool_input: toolInput,
        tool_name: toolName,
      } = input as PostToolUseFailureHookInput;
      turn.failed(toolUseId ?? '', { error, inputJson: toolInput, toolName });
      return {};
    };

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // The prompt rides the command line; past the per-argument cap it is staged
    // as a file the harness is told to read first.
    let append = system;
    if (system.length > MAX_INLINE_SYSTEM_CHARS) {
      await turn.workspace.execStdin(`cat > ${STAGED_PROMPT}`, system);
      append = `Your operating instructions are in ${STAGED_PROMPT}. Read that file in full before anything else, and follow it as if it were this prompt.`;
    }

    const stream = query({
      options: {
        abortController: turn.abort,
        // Anything not allowed by the policy hook is refused: nobody is attending.
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'This workspace run is unattended, so no one can approve that action.',
        }),
        cwd: WORKSPACE_DIR,
        hooks: {
          PostToolUse: [{ hooks: [postToolUse] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
          PreToolUse: [{ hooks: [preToolUse], timeout: PRE_TOOL_USE_TIMEOUT_S }],
        },
        // Should the hook still fail, the harness falls back to its permission
        // rules. The policy tier makes it ignore every allow rule outside that
        // tier (a repository's `.claude/settings.json` among them), so the
        // fallback reaches `canUseTool` above, which refuses.
        // The Agent's own MCP connection, relayed from the worker, and no other:
        // a repository's `.mcp.json` or the harness's settings add no server.
        ...(mcpServer
          ? {
              mcpServers: {
                [MCP_RELAY_SERVER]: {
                  instance: mcpServer.instance,
                  name: MCP_RELAY_SERVER,
                  timeout: mcpServer.timeout,
                  type: 'sdk' as const,
                },
              },
            }
          : {}),
        managedSettings: {
          allowManagedPermissionRulesOnly: true,
          permissions: { disableBypassPermissionsMode: 'disable' },
        },
        maxTurns,
        model: access.modelId,
        // Hook decisions grant each call; `bypassPermissions` would skip them,
        // and the harness refuses it as root anyway.
        permissionMode: 'default',
        resume: sessionId,
        settingSources: loadProjectSettings ? ['project'] : [],
        // The highest-priority settings layer: a repository's own `.claude/settings.json`
        // cannot point the harness (and the key it sends) at another host, nor
        // start it in a mode that grants tool calls without asking.
        settings: {
          env: { ANTHROPIC_BASE_URL: endpoint.baseUrl },
          permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
        },
        // With a custom spawn the SDK never reads stderr (its `stderr` option only
        // serves its own spawn); the shared spawn drains it.
        spawnClaudeCodeProcess: (spawnOptions) =>
          turn.spawn({
            args: spawnOptions.args,
            env: [
              `ANTHROPIC_BASE_URL=${endpoint.baseUrl}`,
              `HOME=${HARNESS_HOME}`,
              'SHELL=/bin/bash',
              'DISABLE_AUTOUPDATER=1',
              'DISABLE_TELEMETRY=1',
              'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
            ],
            leadingEnvArgs: sdkEnvArgs(spawnOptions.env),
            secretEnv: { ANTHROPIC_API_KEY: endpoint.apiKey },
            signal: spawnOptions.signal,
          }),
        strictMcpConfig: true,
        systemPrompt: { append, preset: 'claude_code', type: 'preset' },
        tools: [...tools],
      },
      prompt: user,
    });

    try {
      for await (const message of stream) {
        turn.heartbeat();
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
        } else if (message.type === 'assistant') {
          const reply = message.message as AssistantReply;
          toolCalls += reply.content.filter((b) => b.type === 'tool_use').length;
          if (reply.id && reply.model && reply.usage) {
            streamed.set(reply.id, { model: reply.model, usage: reply.usage });
            // One API call streams a message per content block, each with the
            // call's usage so far; a new id means the previous call is done.
            // Through the proxy every call is metered there, exactly, instead.
            if (!endpoint.proxied) {
              turn.callUsage(reply.id, `anthropic/${reply.model}`, totalsOfStreamed(reply.usage));
            }
          }
        } else if (message.type === 'result') {
          result = message;
        }
      }
    } catch (err) {
      turn.throwIfCancelled();
      if (turn.deadlineReached()) {
        return stopped();
      }
      // Reaching the turn cap ends the run with an error result and then a throw. The
      // Mastra loop stops at its step budget without error, so this does too.
      if (result?.subtype !== 'error_max_turns') {
        if (result) {
          throw withUsageReport(harnessFailure(result, turn.stderrTail()), spent());
        }
        // The process died before it could say why: what it wrote to stderr does.
        // Its streamed messages still say what the calls it made were billed.
        const stderr = turn.stderrTail().trim();
        throw withUsageReport(
          err instanceof Error && stderr
            ? new Error(`${err.message}\n${stderr}`, { cause: err })
            : err,
          spent()
        );
      }
    }

    if (!result && turn.deadlineReached()) {
      return stopped();
    }
    if (!result) {
      throw new Error(`Claude Code ended without a result. ${turn.stderrTail().trim()}`.trim());
    }
    if (result.subtype !== 'error_max_turns' && (result.is_error || result.subtype !== 'success')) {
      throw withUsageReport(harnessFailure(result, turn.stderrTail()), spent());
    }

    return {
      steps: result.num_turns,
      // Reaching the turn cap is the Mastra loop's step budget: a stop, not a failure.
      stoppedReason: result.subtype === 'error_max_turns' ? 'max_steps' : undefined,
      text: result.subtype === 'success' ? result.result : undefined,
      toolCallCount: toolCalls,
      usage: spent(),
    };
  }

  return {
    capabilities: CLAUDE_CODE_CAPABILITIES,
    async close() {
      await (await relay)?.close();
    },
    decide: (toolName, input, harnessCwd) => decideToolCall(toolName, input, policy, harnessCwd),
    kind: 'claude-code',
    label: 'Claude Code',
    provisioning: {
      containerPath: HARNESS_BINARY,
      prepareContainer,
      resolveBinary: ({ arch, libc }) => resolveClaudeBinary(arch, libc),
      sha256: binarySha256,
    },
    async runTurn(turn, input) {
      const mcpRelay = await openRelay();
      policy.mcpTools = mcpRelay?.tools.map((tool) => relayedToolName(tool.name)) ?? [];
      const mcpServer = mcpRelay
        ? { instance: mcpRelay.createServer(), timeout: mcpRelay.callTimeoutMs }
        : undefined;
      // Through the worker's model proxy when the deployment runs one: the
      // container gets a token good only for this turn's model calls, never the
      // credential, and every call — the small-model side calls the harness
      // makes without streaming a message included — is metered as it ends.
      const proxy = modelProxy === undefined ? workerModelProxy() : modelProxy;
      const registration = proxy
        ? await proxy.register({
            apiKey: access.apiKey,
            onCall: (call) => turn.callSpent(call.id, `anthropic/${call.model}`, call.usage),
            signal: turn.abort.signal,
            upstreamBaseUrl: baseUrl,
          })
        : undefined;
      try {
        return await driveTurn(
          turn,
          input,
          registration
            ? { apiKey: registration.token, baseUrl: registration.baseUrl, proxied: true }
            : { apiKey: access.apiKey, baseUrl, proxied: false },
          mcpServer
        );
      } finally {
        // Every call the turn made is reported before the turn's usage is settled.
        await registration?.release();
        await mcpServer?.instance.close().catch(() => undefined);
      }
    },
    usage: {
      normalise: (report) =>
        'streamed' in report
          ? summedCallsUsage('anthropic/', streamedCalls(report.streamed))
          : totals.normalise(totalsOf(report.modelUsage)),
    },
  };
}

/**
 * The Claude Code harness as an implementer runtime: {@link claudeCodeAdapter}
 * in the shared harness runtime (`harness/runtime.ts`), which provisions and
 * verifies the binary, spawns it through `docker exec`, bounds and traces every
 * policy decision, and kills what a turn started when it ends.
 *
 * One runtime serves one workspace.
 */
export function claudeCodeRuntime(options: ClaudeCodeRuntimeOptions): HarnessRuntime {
  return harnessRuntime(claudeCodeAdapter(options), options);
}
