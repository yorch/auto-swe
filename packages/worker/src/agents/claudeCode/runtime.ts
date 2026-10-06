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
import {
  type ImplementerRuntime,
  type ImplementerTurnOutcome,
  withSpentUsage,
} from '../implementerRuntime.js';
import {
  binarySha256,
  PLATFORM_PROBE,
  parseContainerPlatform,
  resolveClaudeBinary,
} from './binary.js';
import {
  decideToolCall,
  harnessToolsFor,
  type PolicyContext,
  type ToolDecision,
} from './policy.js';

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
/**
 * Under the harness's `.claude` directory: the one place outside the checkout
 * the policy lets `Read` reach, so the harness can read what it is told to.
 */
const STAGED_PROMPT = `${HARNESS_HOME}/.claude/system-prompt.md`;

/**
 * How long the worker's policy may take over one tool call before the call is
 * refused. The scanners are bounded well inside this; it is here so a stalled
 * dependency (the pattern store) ends in a deny the worker chose.
 */
export const POLICY_DECISION_MS = 60_000;
/**
 * The harness's own deadline for the PreToolUse hook, in seconds. It is longer
 * than {@link POLICY_DECISION_MS}, so the worker always answers first: a hook
 * the harness gives up on falls back to its ordinary permission rules.
 */
export const PRE_TOOL_USE_TIMEOUT_S = 120;

/** The stderr kept for an error message. */
const STDERR_TAIL_CHARS = 4000;

/**
 * Environment the SDK adds for the harness (`CLAUDE_CODE_ENTRYPOINT`,
 * `CLAUDE_AGENT_SDK_VERSION`, …). Only these names are forwarded into the
 * container, and only when the SDK set or changed them — see `sdkEnvArgs`.
 */
const SDK_ENV_NAME = /^CLAUDE_(?:CODE|AGENT_SDK)_[A-Z0-9_]+$/;

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
  /**
   * The resolved Agent's `toolKeys` (`IMPLEMENTER_TOOL_IDS`), read as the Mastra
   * implementer reads them: null, absent or empty grants every tool. Each key
   * stands for harness tools ({@link harnessToolsFor}); the rest are neither
   * offered to the harness nor allowed by the policy.
   */
  toolKeys?: readonly string[] | null;
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
 * Prepare the container once per workspace: learn the platform, make sure bash
 * is there (Claude Code refuses to start a shell tool without it, and Alpine
 * ships only busybox `sh`), and make the harness's home. Returns the worker's
 * binary that matches the container, which {@link installBinary} puts in place.
 */
async function prepareContainer(workspace: Workspace): Promise<string> {
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

  await workspace.exec(`mkdir -p ${HARNESS_HOME}/.claude`);
  return binary;
}

/** The hash `sha256sum` reports for the container's copy of the binary, or '' without one. */
async function installedSha256(workspace: Workspace): Promise<string> {
  const out = await workspace.execCapture(`sha256sum ${HARNESS_BINARY} 2>/dev/null`);
  return out.exitCode === 0 ? (out.stdout.trim().split(/\s+/)[0] ?? '') : '';
}

/**
 * Make sure the container's copy of the binary is the worker's, before every
 * turn. The copy sits on a path the agent can write, and a replaced binary
 * would run without the worker's hooks and report whatever usage it liked; so
 * a copy whose hash differs is replaced, and one that still differs fails the
 * turn. The copy is skipped when the right binary is already there.
 */
async function installBinary(workspace: Workspace, binary: string): Promise<void> {
  const expected = await binarySha256(binary);
  if ((await installedSha256(workspace)) === expected) {
    return;
  }
  const copy = await spawnCaptureAsync(
    'docker',
    ['cp', binary, `${workspace.containerId}:${HARNESS_BINARY}`],
    { heartbeatLabel: 'claude-code: install binary', timeoutMs: 120_000 }
  );
  if (copy.exitCode !== 0) {
    throw new Error(`Could not copy the Claude Code binary into the workspace: ${copy.stderr}`);
  }
  if ((await installedSha256(workspace)) !== expected) {
    throw ApplicationFailure.nonRetryable(
      "The Claude Code binary in the workspace does not match the worker's copy after installing it. The image needs `sha256sum` (coreutils or busybox) for the runtime to verify it.",
      'HARNESS_BINARY_UNVERIFIED'
    );
  }
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

/** `decision`, or a deny once `ms` have passed without one. */
async function withinDeadline(decision: Promise<ToolDecision>, ms: number): Promise<ToolDecision> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ToolDecision>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          allow: false,
          reason: `The security check did not finish within ${ms / 1000} s; the call was refused.`,
        }),
      ms
    );
  });
  try {
    return await Promise.race([decision, expired]);
  } finally {
    clearTimeout(timer);
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
  const tools = harnessToolsFor(options.toolKeys);
  const policy: PolicyContext = {
    containerId: workspace.containerId,
    cwd: WORKSPACE_DIR,
    home: HARNESS_HOME,
    projectConfigLoaded: loadProjectSettings,
    tools,
  };

  let prepared: Promise<string> | undefined;
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
    if (!prepared) {
      const preparing = prepareContainer(workspace);
      prepared = preparing;
      // A failed preparation is not remembered: the next turn tries again.
      preparing.catch(() => {
        if (prepared === preparing) {
          prepared = undefined;
        }
      });
    }
    await installBinary(workspace, await prepared);

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
      const { cwd, tool_name: toolName, tool_input: toolInput } = input as PreToolUseHookInput;
      const id = toolUseId ?? '';
      startedAt.set(id, Date.now());
      let verdict: ToolDecision;
      try {
        // A hook the harness gives up on falls back to its own permission rules;
        // the worker answers first, and a decision it cannot reach is a deny.
        verdict = await withinDeadline(
          decideToolCall(toolName, (toolInput ?? {}) as Record<string, unknown>, policy, cwd),
          POLICY_DECISION_MS
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
            PreToolUse: [{ hooks: [preToolUse], timeout: PRE_TOOL_USE_TIMEOUT_S }],
          },
          // Should the hook still fail, the harness falls back to its permission
          // rules. The policy tier makes it ignore every allow rule outside that
          // tier (a repository's `.claude/settings.json` among them), so the
          // fallback reaches `canUseTool` above, which refuses.
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
            env: { ANTHROPIC_BASE_URL: baseUrl },
            permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
          },
          spawnClaudeCodeProcess: (spawnOptions) => {
            const child = spawn(
              'docker',
              [
                'exec',
                '-i',
                '-w',
                WORKSPACE_DIR,
                // First, so the platform's own `-e` below win any clash.
                ...sdkEnvArgs(spawnOptions.env),
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
            );
            // With a custom spawn the SDK never reads stderr (its `stderr` option only
            // serves its own spawn). Drain it here: unread, a full pipe stalls the
            // harness, and its tail is what explains a run that died.
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', (data: string) => {
              stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
            });
            return child;
          },
          systemPrompt: { append, preset: 'claude_code', type: 'preset' },
          tools: [...tools],
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
          if (result) {
            throw withSpentUsage(harnessFailure(result, stderrTail), usageSince(result));
          }
          // The process died before it could say why: what it wrote to stderr does.
          throw err instanceof Error && stderrTail.trim()
            ? new Error(`${err.message}\n${stderrTail.trim()}`, { cause: err })
            : err;
        }
      }

      if (!result) {
        throw new Error(`Claude Code ended without a result. ${stderrTail.trim()}`.trim());
      }
      if (
        result.subtype !== 'error_max_turns' &&
        (result.is_error || result.subtype !== 'success')
      ) {
        // The failed run was billed for what it spent: the error carries it.
        throw withSpentUsage(harnessFailure(result, stderrTail), usageSince(result));
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
