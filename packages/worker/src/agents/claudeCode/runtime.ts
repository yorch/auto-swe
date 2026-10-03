import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import {
  EXEC_TAG_ENV,
  killTaggedProcessesScript,
  type Workspace,
} from '../../activities/workspace.js';
import type { AgentTracer } from '../../lib/agentTracer.js';
import { activityCancellationSignal, throwIfActivityCancelled } from '../../lib/cancellation.js';
import { spawnCaptureAsync } from '../../lib/execUtils.js';
import type { ImplementerRuntime, ImplementerTurnOutcome } from '../implementerRuntime.js';
import { PLATFORM_PROBE, parseContainerPlatform, resolveClaudeBinary } from './binary.js';
import { decideToolCall, HARNESS_TOOLS, type PolicyContext } from './policy.js';

/** The checkout inside every workspace container (`createWorkspace` clones here). */
const WORKSPACE_DIR = '/workspace/target-repo';
/**
 * Where the harness lives inside the container: beside the checkout, not in it,
 * so `git add -A` can never sweep the binary, its transcripts or its home into a
 * commit (the same reason tool output is offloaded to `/workspace/.tool-output`).
 */
const HARNESS_DIR = '/workspace/.harness';
const HARNESS_HOME = `${HARNESS_DIR}/home`;
const HARNESS_BINARY = `${HARNESS_DIR}/claude`;

/**
 * `--append-system-prompt` travels on the `docker exec` command line, and Linux
 * caps one argument at 128 KiB. A prompt past this is staged as a file in the
 * container and the prompt points at it.
 */
const MAX_INLINE_SYSTEM_CHARS = 100_000;
const STAGED_PROMPT = `${HARNESS_DIR}/system-prompt.md`;

/** A tool result in a trace row is bounded: a `Read` of a large file would otherwise fill the row. */
const TRACE_OUTPUT_CHARS = 20_000;

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface ClaudeCodeAccess {
  /** The credential's base URL, in the AI SDK's spelling (it may end in `/v1`). */
  apiBase?: string;
  apiKey: string;
  /** The bare model id the harness passes to the API (`claude-opus-5-5`). */
  modelId: string;
}

export interface ClaudeCodeRuntimeOptions {
  access: ClaudeCodeAccess;
  /** Load the repository's own `.claude` settings and `CLAUDE.md`. */
  loadProjectSettings: boolean;
  /** `workspace.agentMaxSteps`, as the cap on turns in one harness run. */
  maxTurns: number;
  tracer: AgentTracer;
  workspace: Workspace;
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

function forTrace(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > TRACE_OUTPUT_CHARS
    ? `${text.slice(0, TRACE_OUTPUT_CHARS)}… [${text.length - TRACE_OUTPUT_CHARS} more characters]`
    : value;
}

/**
 * Put the harness into the container once per workspace: learn the platform,
 * make sure bash is there (Claude Code refuses to start a shell tool without
 * it, and Alpine ships only busybox `sh`), and copy in the binary that matches.
 */
async function prepareContainer(workspace: Workspace): Promise<void> {
  const probe = await workspace.execCapture(PLATFORM_PROBE);
  const { arch, libc } = parseContainerPlatform(probe.stdout);
  const binary = resolveClaudeBinary(arch, libc);

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

  await workspace.exec(`mkdir -p ${HARNESS_HOME}`);
  const copy = await spawnCaptureAsync(
    'docker',
    ['cp', binary, `${workspace.containerId}:${HARNESS_BINARY}`],
    { heartbeatLabel: 'claude-code: install binary', timeoutMs: 120_000 }
  );
  if (copy.exitCode !== 0) {
    throw new Error(`Could not copy the Claude Code binary into the workspace: ${copy.stderr}`);
  }
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

/** A model's running usage totals as the harness reports them. */
interface Totals {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

/**
 * The Claude Code harness as an implementer runtime.
 *
 * The SDK runs here, in the worker; the `claude` binary runs in the workspace
 * container, reached through `docker exec -i`. Every tool call is decided by
 * `decideToolCall` in this process before the harness runs it, so the scanners
 * that guard the Mastra tools guard this loop too, and the agent cannot edit
 * them from inside the container.
 *
 * One runtime serves one workspace. Turns after the first resume the same
 * session, so a TDD loop keeps its context and its prompt cache.
 */
export function claudeCodeRuntime(options: ClaudeCodeRuntimeOptions): ImplementerRuntime {
  const { access, loadProjectSettings, maxTurns, tracer, workspace } = options;
  const baseUrl = normalizeAnthropicBaseUrl(access.apiBase);
  const policy: PolicyContext = {
    containerId: workspace.containerId,
    cwd: WORKSPACE_DIR,
    home: HARNESS_HOME,
  };

  let prepared: Promise<void> | undefined;
  let sessionId: string | undefined;
  // The harness reports usage as running totals per model, and a resumed session
  // starts from its saved totals. What a turn spent is the change since the last.
  const reported = new Map<string, Totals>();

  function usageSince(result: SDKResultMessage): ImplementerTurnOutcome['usageByModel'] {
    const spent: NonNullable<ImplementerTurnOutcome['usageByModel']> = [];
    for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
      // Cache reads and writes are input the run was billed for, so they count
      // in the input total the budget meters; they are also reported apart so
      // pricing can apply the cache rates instead of the full input price.
      const total: Totals = {
        cacheRead: u.cacheReadInputTokens,
        cacheWrite: u.cacheCreationInputTokens,
        input: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
        output: u.outputTokens,
      };
      const before = reported.get(model) ?? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
      reported.set(model, total);
      // A total that went backwards means the harness reset it: count it whole.
      const reset =
        total.input < before.input ||
        total.output < before.output ||
        total.cacheRead < before.cacheRead ||
        total.cacheWrite < before.cacheWrite;
      const delta = (k: keyof Totals) => (reset ? total[k] : total[k] - before[k]);
      const input = delta('input');
      const output = delta('output');
      if (input > 0 || output > 0) {
        spent.push({
          modelSpec: `anthropic/${model}`,
          usage: {
            cacheCreationInputTokens: delta('cacheWrite'),
            cachedInputTokens: delta('cacheRead'),
            inputTokens: input,
            outputTokens: output,
          },
        });
      }
    }
    return spent.sort((a, b) => (b.usage.outputTokens ?? 0) - (a.usage.outputTokens ?? 0));
  }

  async function runTurn({ system, user }: { system: string; user: string }) {
    prepared ??= prepareContainer(workspace);
    await prepared;

    const tag = randomBytes(8).toString('hex');
    const abort = new AbortController();
    const cancellation = activityCancellationSignal();
    const onCancel = () => abort.abort();
    cancellation?.addEventListener('abort', onCancel, { once: true });
    if (cancellation?.aborted) {
      abort.abort();
    }

    let stderrTail = '';
    let result: SDKResultMessage | undefined;
    let toolCalls = 0;
    const startedAt = new Map<string, number>();
    const warnings = new Map<string, { tag?: string; text: string }>();

    const preToolUse: HookCallback = async (input, toolUseId) => {
      const { tool_name: toolName, tool_input: toolInput } = input as PreToolUseHookInput;
      const id = toolUseId ?? '';
      startedAt.set(id, Date.now());
      let verdict: Awaited<ReturnType<typeof decideToolCall>>;
      try {
        verdict = await decideToolCall(
          toolName,
          (toolInput ?? {}) as Record<string, unknown>,
          policy
        );
      } catch (err) {
        // A scanner that cannot complete cannot clear the call: fail closed.
        verdict = {
          allow: false,
          reason: `The security check could not complete (${err instanceof Error ? err.message : String(err)}); the call was refused.`,
        };
      }
      if (!verdict.allow) {
        tracer.addToolCall({
          durationMs: Date.now() - (startedAt.get(id) ?? Date.now()),
          error: verdict.securityTag ?? 'blocked by workspace policy',
          inputJson: toolInput,
          outputJson: { result: verdict.reason },
          toolName,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: verdict.reason,
          },
        };
      }
      if (verdict.warning) {
        warnings.set(id, { tag: verdict.securityTag, text: verdict.warning });
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
      const id = toolUseId ?? '';
      const warning = warnings.get(id);
      tracer.addToolCall({
        durationMs: Date.now() - (startedAt.get(id) ?? Date.now()),
        error: warning?.tag,
        inputJson: toolInput,
        outputJson: forTrace(response),
        toolName,
      });
      return warning
        ? {
            hookSpecificOutput: {
              additionalContext: warning.text,
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
      tracer.addToolCall({
        durationMs: Date.now() - (startedAt.get(toolUseId ?? '') ?? Date.now()),
        error: String(error).slice(0, 1000),
        inputJson: toolInput,
        toolName,
      });
      return {};
    };

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      // The prompt rides the command line; past the per-argument cap it is staged
      // as a file the harness is told to read first.
      let append = system;
      if (system.length > MAX_INLINE_SYSTEM_CHARS) {
        await workspace.execStdin(`cat > ${STAGED_PROMPT}`, system);
        append = `Your operating instructions are in ${STAGED_PROMPT}. Read that file in full before anything else, and follow it as if it were this prompt.`;
      }

      const stream = query({
        options: {
          abortController: abort,
          // Anything not allowed by the policy hook is refused: nobody is attending.
          canUseTool: async () => ({
            behavior: 'deny',
            message: 'This workspace run is unattended, so no one can approve that action.',
          }),
          cwd: WORKSPACE_DIR,
          hooks: {
            PostToolUse: [{ hooks: [postToolUse] }],
            PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
            PreToolUse: [{ hooks: [preToolUse] }],
          },
          maxTurns,
          model: access.modelId,
          // Hook decisions grant each call; `bypassPermissions` would skip them,
          // and the harness refuses it as root anyway.
          permissionMode: 'default',
          resume: sessionId,
          settingSources: loadProjectSettings ? ['project'] : [],
          // The highest-priority settings layer: a repository's own `.claude/settings.json`
          // cannot point the harness (and the key it sends) at another host.
          settings: { env: { ANTHROPIC_BASE_URL: baseUrl } },
          spawnClaudeCodeProcess: (spawnOptions) =>
            spawn(
              'docker',
              [
                'exec',
                '-i',
                '-w',
                WORKSPACE_DIR,
                '-e',
                `${EXEC_TAG_ENV}=${tag}`,
                // Named without a value: docker reads it from its own environment below,
                // so the key never appears on a command line or in `ps`.
                '-e',
                'ANTHROPIC_API_KEY',
                '-e',
                `ANTHROPIC_BASE_URL=${baseUrl}`,
                '-e',
                `HOME=${HARNESS_HOME}`,
                '-e',
                'SHELL=/bin/bash',
                '-e',
                'DISABLE_AUTOUPDATER=1',
                '-e',
                'DISABLE_TELEMETRY=1',
                '-e',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
                workspace.containerId,
                HARNESS_BINARY,
                ...spawnOptions.args,
              ],
              {
                env: { ...process.env, ANTHROPIC_API_KEY: access.apiKey },
                signal: spawnOptions.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            ),
          stderr: (data) => {
            stderrTail = (stderrTail + data).slice(-4000);
          },
          systemPrompt: { append, preset: 'claude_code', type: 'preset' },
          tools: [...HARNESS_TOOLS],
        },
        prompt: user,
      });

      try {
        for await (const message of stream) {
          heartbeat('claude-code');
          if (message.type === 'system' && message.subtype === 'init') {
            sessionId = message.session_id;
          } else if (message.type === 'assistant') {
            // The block type comes from the SDK's `@anthropic-ai/sdk` peer, which is not installed.
            const blocks: { type: string }[] = message.message.content;
            toolCalls += blocks.filter((b) => b.type === 'tool_use').length;
          } else if (message.type === 'result') {
            result = message;
          }
        }
      } catch (err) {
        // A cancelled activity surfaces as a killed process: report the cancellation.
        throwIfActivityCancelled();
        // Reaching the turn cap ends the run with an error result and then a throw. The
        // Mastra loop stops at its step budget without error, so this does too.
        if (result?.subtype !== 'error_max_turns') {
          throw result ? harnessFailure(result, stderrTail) : err;
        }
      }

      if (!result) {
        throw new Error(`Claude Code ended without a result. ${stderrTail.trim()}`.trim());
      }
      if (
        result.subtype !== 'error_max_turns' &&
        (result.is_error || result.subtype !== 'success')
      ) {
        throw harnessFailure(result, stderrTail);
      }

      return {
        text: result.subtype === 'success' ? result.result : undefined,
        toolCallCount: toolCalls,
        usageByModel: usageSince(result),
      };
    } finally {
      cancellation?.removeEventListener('abort', onCancel);
      // `docker exec` does not stop what it started when its client dies. Every process the
      // harness began carries the tag, so this leaves nothing running between turns.
      await workspace.exec(killTaggedProcessesScript(tag)).catch(() => undefined);
    }
  }

  return { runTurn };
}
