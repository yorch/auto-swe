import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The part of the SDK's `query()` options these tests read back. */
interface HookOutput {
  hookSpecificOutput?: Record<string, string>;
}
type HookFn = (input: unknown, toolUseId?: string) => Promise<HookOutput>;
interface QueryOptions {
  abortController: AbortController;
  canUseTool: () => Promise<{ behavior: string }>;
  hooks: Record<
    'PostToolUse' | 'PostToolUseFailure' | 'PreToolUse',
    { hooks: HookFn[]; timeout?: number }[]
  >;
  resume?: string;
  settingSources: string[];
  spawnClaudeCodeProcess: (o: {
    args: string[];
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }) => unknown;
  systemPrompt: { append: string };
  [key: string]: unknown;
}

const { BINARY_SHA } = vi.hoisted(() => ({ BINARY_SHA: 'ab'.repeat(32) }));

const h = vi.hoisted(() => ({
  activityCancellationSignal: vi.fn((): AbortSignal | undefined => undefined),
  decideToolCall: vi.fn(),
  heartbeat: vi.fn(),
  queryCalls: [] as { options: QueryOptions; prompt: string }[],
  script: [] as [unknown[], unknown?, Promise<unknown>?][],
  spawn: vi.fn(),
  spawnCaptureAsync: vi.fn(),
  throwIfActivityCancelled: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: h.heartbeat,
}));
vi.mock('../../lib/cancellation.js', () => ({
  activityCancellationSignal: h.activityCancellationSignal,
  throwIfActivityCancelled: h.throwIfActivityCancelled,
}));
vi.mock('../../lib/execUtils.js', () => ({ spawnCaptureAsync: h.spawnCaptureAsync }));
vi.mock('./binary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./binary.js')>()),
  binarySha256: vi.fn(async () => BINARY_SHA),
  resolveClaudeBinary: vi.fn(() => '/app/node_modules/sdk-linux-x64-musl/claude'),
}));
vi.mock('./policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./policy.js')>()),
  decideToolCall: h.decideToolCall,
}));
// One scripted run per `query()` call: the messages it yields, then optionally a throw.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options, prompt }: { options: QueryOptions; prompt: string }) => {
    h.queryCalls.push({ options, prompt });
    const [messages = [], failure, gate] = h.script.shift() ?? [];
    return (async function* () {
      yield* messages as object[];
      // A run that fails because something happened to it (the activity was cancelled)
      // fails after that happened, not before.
      await gate;
      if (failure) {
        throw failure;
      }
    })();
  },
}));

import type { AgentTracer } from '../../lib/agentTracer.js';
import { spentUsageOf } from '../implementerRuntime.js';
import {
  claudeCodeRuntime,
  normalizeAnthropicBaseUrl,
  POLICY_DECISION_MS,
  PRE_TOOL_USE_TIMEOUT_S,
  sdkEnvArgs,
} from './runtime.js';

const init = (session_id: string) => ({ session_id, subtype: 'init', type: 'system' });
const assistantToolUses = (n: number) => ({
  message: { content: Array.from({ length: n }, () => ({ type: 'tool_use' })) },
  type: 'assistant',
});
/** One streamed assistant message, as the SDK yields it, with its API call's usage. */
const assistantReply = (id: string, model: string, u: object, toolUses = 0) => ({
  message: {
    content: Array.from({ length: toolUses }, () => ({ type: 'tool_use' })),
    id,
    model,
    usage: u,
  },
  type: 'assistant',
});
const streamed = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  input_tokens: input,
  output_tokens: output,
});
const usage = (inputTokens: number, outputTokens: number, cache = 0, cacheWrite = 0) => ({
  cacheCreationInputTokens: cacheWrite,
  cacheReadInputTokens: cache,
  inputTokens,
  outputTokens,
});
const success = (result: string, modelUsage: Record<string, unknown> = {}) => ({
  is_error: false,
  modelUsage,
  result,
  subtype: 'success',
  type: 'result',
});

const API_KEY = 'sk-ant-test-key-do-not-leak';

function setup(overrides: Record<string, unknown> = {}) {
  const exec = vi.fn(async (_c: string) => '');
  // The hash of what is at the binary's path in the container ('' = nothing there).
  const container = { installed: '' };
  h.spawnCaptureAsync.mockImplementation(async () => {
    container.installed = BINARY_SHA;
    return { exitCode: 0, stderr: '', stdout: '' };
  });
  const workspace = {
    container,
    containerId: 'workspace-abc123',
    exec,
    execCapture: vi.fn(async (command: string) =>
      command.startsWith('uname')
        ? { exitCode: 0, stderr: '', stdout: 'x86_64\n/lib/ld-musl-x86_64.so.1\n' }
        : command.startsWith('sha256sum')
          ? container.installed
            ? {
                exitCode: 0,
                stderr: '',
                stdout: `${container.installed}  /workspace/.harness/claude\n`,
              }
            : { exitCode: 1, stderr: '', stdout: '' }
          : { exitCode: 0, stderr: '', stdout: '' }
    ),
    execStdin: vi.fn(async () => ''),
  };
  const toolCalls: Record<string, unknown>[] = [];
  const tracer = { addToolCall: (c: Record<string, unknown>) => toolCalls.push(c) };
  const runtime = claudeCodeRuntime({
    access: {
      apiBase: 'https://kong.example/anthropic/v1/',
      apiKey: API_KEY,
      modelId: 'claude-opus-5-5',
    },
    loadProjectSettings: true,
    maxTurns: 40,
    tracer: tracer as unknown as AgentTracer,
    workspace: workspace as never,
    ...overrides,
  });
  return { exec, runtime, toolCalls, workspace };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.queryCalls.length = 0;
  h.script.length = 0;
  h.decideToolCall.mockResolvedValue({ allow: true });
  h.activityCancellationSignal.mockReturnValue(undefined);
  h.spawn.mockReturnValue({ pid: 1 });
});

describe('normalizeAnthropicBaseUrl', () => {
  it('turns the AI SDK’s /v1 root into the origin the harness expects', () => {
    expect(normalizeAnthropicBaseUrl('https://kong.example/anthropic/v1/')).toBe(
      'https://kong.example/anthropic'
    );
    expect(normalizeAnthropicBaseUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com'
    );
    expect(normalizeAnthropicBaseUrl('https://gw.example')).toBe('https://gw.example');
  });

  it('defaults to Anthropic, and never leaves the harness without a pinned host', () => {
    expect(normalizeAnthropicBaseUrl(undefined)).toBe('https://api.anthropic.com');
    expect(normalizeAnthropicBaseUrl('  ')).toBe('https://api.anthropic.com');
  });
});

describe('preparing the container', () => {
  it('installs bash and copies in the binary that matches the container, once per workspace', async () => {
    const { runtime, workspace, exec } = setup();
    h.script.push([[init('s1'), success('one')]], [[init('s1'), success('two')]]);

    await runtime.runTurn({ system: 'S', user: 'U1' });
    await runtime.runTurn({ system: 'S', user: 'U2' });

    const commands = workspace.execCapture.mock.calls.map((c) => c[0]);
    // Platform probe + bash once; the binary's hash before every turn (and after the copy).
    expect(commands.filter((c) => c.startsWith('uname'))).toHaveLength(1);
    expect(commands.filter((c) => c.includes('apk add --no-cache bash'))).toHaveLength(1);
    expect(
      commands.filter((c) => c.startsWith('sha256sum /workspace/.harness/claude'))
    ).toHaveLength(3);
    expect(exec).toHaveBeenCalledWith('mkdir -p /workspace/.harness/home/.claude');
    expect(h.spawnCaptureAsync).toHaveBeenCalledTimes(1);
    expect(h.spawnCaptureAsync.mock.calls[0]?.slice(0, 2)).toEqual([
      'docker',
      [
        'cp',
        '/app/node_modules/sdk-linux-x64-musl/claude',
        'workspace-abc123:/workspace/.harness/claude',
      ],
    ]);
  });

  it('stops without retrying when the image has no bash and cannot get one', async () => {
    const { runtime, workspace } = setup();
    workspace.execCapture.mockImplementation(async (command: string) =>
      command.startsWith('uname')
        ? { exitCode: 0, stderr: '', stdout: 'x86_64\n' }
        : { exitCode: 1, stderr: '', stdout: '' }
    );
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'HARNESS_NO_SHELL',
    });
  });

  it('reports a failed binary copy', async () => {
    const { runtime } = setup();
    h.spawnCaptureAsync.mockResolvedValue({ exitCode: 1, stderr: 'no space left', stdout: '' });
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).rejects.toThrow(/no space left/);
  });

  it('does not copy a binary that is already in place with the right hash', async () => {
    const { runtime, workspace } = setup();
    workspace.container.installed = BINARY_SHA;
    h.script.push([[init('s1'), success('ok')]]);
    await runtime.runTurn({ system: 'S', user: 'U' });
    expect(h.spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it('replaces a binary that was changed in the container between turns', async () => {
    const { runtime, workspace } = setup();
    h.script.push([[init('s1'), success('one')]], [[init('s1'), success('two')]]);
    await runtime.runTurn({ system: 'S', user: 'U1' });

    workspace.container.installed = 'cd'.repeat(32); // the agent swapped it
    await runtime.runTurn({ system: 'S', user: 'U2' });

    expect(h.spawnCaptureAsync).toHaveBeenCalledTimes(2);
    expect(workspace.container.installed).toBe(BINARY_SHA);
    expect(h.queryCalls).toHaveLength(2);
  });

  it('refuses to run a binary it cannot verify, without retrying', async () => {
    const { runtime } = setup();
    // The copy "succeeds" but the hash never matches (no sha256sum, or a tampered one).
    h.spawnCaptureAsync.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'HARNESS_BINARY_UNVERIFIED',
    });
    expect(h.queryCalls).toHaveLength(0);
  });

  it('tries the preparation again on the next turn after it failed', async () => {
    const { runtime, workspace } = setup();
    const capture = workspace.execCapture.getMockImplementation();
    workspace.execCapture.mockRejectedValueOnce(new Error('docker daemon restarting'));
    if (capture) {
      workspace.execCapture.mockImplementation(capture);
    }
    h.script.push([[init('s1'), success('ok')]]);

    await expect(runtime.runTurn({ system: 'S', user: 'U1' })).rejects.toThrow(/restarting/);
    await expect(runtime.runTurn({ system: 'S', user: 'U2' })).resolves.toMatchObject({
      text: 'ok',
    });
  });
});

describe('what the harness is started with', () => {
  async function started() {
    const ctx = setup();
    h.script.push([[init('s1'), success('ok')]]);
    await ctx.runtime.runTurn({ system: 'THE SYSTEM PROMPT', user: 'THE TASK' });
    return { ...ctx, call: h.queryCalls[0] as (typeof h.queryCalls)[number] };
  }

  it('runs the task with the six workspace tools, unattended, against the pinned host', async () => {
    const { call } = await started();
    expect(call.prompt).toBe('THE TASK');
    expect(call.options).toMatchObject({
      cwd: '/workspace/target-repo',
      maxTurns: 40,
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      settingSources: ['project'],
      settings: {
        env: { ANTHROPIC_BASE_URL: 'https://kong.example/anthropic' },
        permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
      },
      systemPrompt: { append: 'THE SYSTEM PROMPT', preset: 'claude_code', type: 'preset' },
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    });
    await expect(call.options.canUseTool()).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('makes a hook failure fall back to a deny, not to the repository’s allow rules', async () => {
    const { call } = await started();
    // The harness's own deadline is longer than the worker's, so the worker answers first.
    expect(call.options.hooks.PreToolUse[0]?.timeout).toBe(PRE_TOOL_USE_TIMEOUT_S);
    expect(PRE_TOOL_USE_TIMEOUT_S * 1000).toBeGreaterThan(POLICY_DECISION_MS);
    // Allow rules outside the policy tier are ignored, so the fallback reaches canUseTool.
    expect(call.options.managedSettings).toMatchObject({ allowManagedPermissionRulesOnly: true });
  });

  it('offers only the tools the Agent’s toolKeys grant, and the policy enforces the same set', async () => {
    const ctx = setup({ toolKeys: ['readFile'] });
    h.script.push([[init('s1'), success('ok')]]);
    await ctx.runtime.runTurn({ system: 'S', user: 'U' });
    const options = h.queryCalls[0]?.options as QueryOptions;
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);

    await options.hooks.PreToolUse[0]?.hooks[0]?.(
      { cwd: '/workspace/target-repo', tool_input: { command: 'ls' }, tool_name: 'Bash' },
      't'
    );
    expect(h.decideToolCall).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls' },
      expect.objectContaining({ tools: ['Read', 'Glob', 'Grep'] }),
      '/workspace/target-repo'
    );
  });

  it('can be told to ignore the repository’s own settings', async () => {
    const ctx = setup({ loadProjectSettings: false });
    h.script.push([[init('s1'), success('ok')]]);
    await ctx.runtime.runTurn({ system: 'S', user: 'U' });
    expect(h.queryCalls[0]?.options.settingSources).toEqual([]);
  });

  it('spawns the binary through docker exec with a tag, and the key only in docker’s environment', async () => {
    const { call } = await started();
    const signal = new AbortController().signal;

    call.options.spawnClaudeCodeProcess({
      args: ['--output-format', 'stream-json'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      signal,
    });

    const [file, args, spawnOptions] = h.spawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string>; signal?: AbortSignal },
    ];
    expect(file).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/workspace/target-repo']);
    expect(args).toContain('CLAUDE_CODE_ENTRYPOINT=sdk-ts');
    expect(args).toContain('ANTHROPIC_API_KEY'); // named, valueless
    expect(args.join(' ')).not.toContain(API_KEY);
    expect(args).toContain('ANTHROPIC_BASE_URL=https://kong.example/anthropic');
    expect(args).toContain('SHELL=/bin/bash');
    expect(args.some((a) => /^AUTO_SWE_EXEC_ID=[0-9a-f]{16}$/.test(a))).toBe(true);
    expect(args.slice(-3)).toEqual([
      '/workspace/.harness/claude',
      '--output-format',
      'stream-json',
    ]);
    expect(args[args.indexOf('/workspace/.harness/claude') - 1]).toBe('workspace-abc123');
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe(API_KEY);
    expect(spawnOptions.signal).toBe(signal);
  });

  it('forwards only the harness switches the SDK added, never the worker’s own environment', () => {
    const previous = process.env.CLAUDE_CODE_FROM_WORKER;
    process.env.CLAUDE_CODE_FROM_WORKER = 'worker-value';
    try {
      const args = sdkEnvArgs({
        ...process.env,
        CLAUDE_AGENT_SDK_VERSION: 'test-version',
        CLAUDE_CODE_ENTRYPOINT: 'test-entrypoint',
        CLAUDE_CODE_FROM_WORKER: 'worker-value', // the worker's, unchanged by the SDK
        claude_code_lower: 'x',
        DATABASE_URL: 'postgres://secret', // not a harness switch
      });
      expect(args.filter((a) => a !== '-e').sort()).toEqual([
        'CLAUDE_AGENT_SDK_VERSION=test-version',
        'CLAUDE_CODE_ENTRYPOINT=test-entrypoint',
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_FROM_WORKER;
      } else {
        process.env.CLAUDE_CODE_FROM_WORKER = previous;
      }
    }
  });

  it('drains the harness’s stderr and reports its tail when the run ends without a result', async () => {
    const ctx = setup();
    let release: () => void = () => {};
    h.script.push([[init('s1')], undefined, new Promise<void>((r) => (release = r))]);
    const stderr = new PassThrough();
    h.spawn.mockReturnValue({ pid: 1, stderr });

    const turn = ctx.runtime.runTurn({ system: 'S', user: 'U' });
    await vi.waitFor(() => expect(h.queryCalls).toHaveLength(1));
    h.queryCalls[0]?.options.spawnClaudeCodeProcess({ args: [], env: {} });
    stderr.write('Error: ENOSPC writing session\n');
    await new Promise((r) => setImmediate(r));
    release();

    await expect(turn).rejects.toThrow(/ENOSPC writing session/);
  });

  it('keeps an oversized system prompt off the command line, where the harness may read it', async () => {
    const ctx = setup();
    h.script.push([[init('s1'), success('ok')]]);
    const big = 'x'.repeat(100_001);

    await ctx.runtime.runTurn({ system: big, user: 'U' });

    expect(ctx.workspace.execStdin).toHaveBeenCalledWith(
      'cat > /workspace/.harness/home/.claude/system-prompt.md',
      big
    );
    const append = h.queryCalls[0]?.options.systemPrompt.append ?? '';
    expect(append).toContain('/workspace/.harness/home/.claude/system-prompt.md');
    expect(append.length).toBeLessThan(500);
  });
});

describe('sessions', () => {
  it('resumes the same session on later turns, so a TDD loop keeps its context', async () => {
    const { runtime } = setup();
    h.script.push([[init('sess-1'), success('a')]], [[init('sess-1'), success('b')]]);

    await runtime.runTurn({ system: 'S', user: 'first' });
    await runtime.runTurn({ system: 'S', user: 'second' });

    expect(h.queryCalls[0]?.options.resume).toBeUndefined();
    expect(h.queryCalls[1]?.options.resume).toBe('sess-1');
  });
});

describe('the policy hooks', () => {
  async function hooks() {
    const ctx = setup();
    h.script.push([[init('s1'), success('ok')]]);
    await ctx.runtime.runTurn({ system: 'S', user: 'U' });
    const opts = h.queryCalls[0]?.options as QueryOptions;
    return {
      ...ctx,
      post: opts.hooks.PostToolUse[0].hooks[0],
      postFailure: opts.hooks.PostToolUseFailure[0].hooks[0],
      pre: opts.hooks.PreToolUse[0].hooks[0],
    };
  }
  const preInput = (tool_name: string, tool_input: unknown) => ({
    cwd: '/workspace/target-repo/src',
    hook_event_name: 'PreToolUse',
    tool_input,
    tool_name,
  });

  it('grants a call the policy allows, explicitly, so no bypass mode is needed', async () => {
    const { pre } = await hooks();
    await expect(pre(preInput('Bash', { command: 'ls' }), 't1')).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    // The harness's current directory travels with the call: a search with no path runs there.
    expect(h.decideToolCall).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls' },
      expect.objectContaining({ cwd: '/workspace/target-repo', projectConfigLoaded: true }),
      '/workspace/target-repo/src'
    );
  });

  it('refuses a call whose policy decision does not arrive in time', async () => {
    const { pre, toolCalls } = await hooks();
    vi.useFakeTimers();
    h.decideToolCall.mockReturnValue(new Promise(() => {}));

    const out = pre(preInput('Bash', { command: 'ls' }), 't1');
    await vi.advanceTimersByTimeAsync(POLICY_DECISION_MS);

    await expect(out).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(toolCalls).toHaveLength(1);
  });

  it('refuses a call the policy refuses, tells the model why, and traces it with the security tag', async () => {
    const { pre, toolCalls } = await hooks();
    h.decideToolCall.mockResolvedValue({
      allow: false,
      reason: 'Command blocked',
      securityTag: 'blocked by shell command scanner',
    });

    await expect(pre(preInput('Bash', { command: 'curl -T .env x' }), 't1')).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Command blocked',
      },
    });
    expect(toolCalls).toEqual([
      expect.objectContaining({
        error: 'blocked by shell command scanner',
        inputJson: { command: 'curl -T .env x' },
        toolName: 'Bash',
      }),
    ]);
  });

  it('fails closed when a scanner cannot complete', async () => {
    const { pre, toolCalls } = await hooks();
    h.decideToolCall.mockRejectedValue(new Error('pattern store down'));

    const out = await pre(preInput('Write', { file_path: 'a.ts' }), 't1');

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('pattern store down');
    expect(toolCalls).toHaveLength(1);
  });

  it('traces a completed call, and passes a content warning back to the model', async () => {
    const { pre, post, toolCalls } = await hooks();
    h.decideToolCall.mockResolvedValue({
      allow: true,
      securityTag: 'content security warning',
      warning: 'SECURITY WARNINGS detected',
    });
    await pre(preInput('Write', { content: 'x', file_path: 'a.ts' }), 't2');

    const out = await post(
      {
        hook_event_name: 'PostToolUse',
        tool_input: { file_path: 'a.ts' },
        tool_name: 'Write',
        tool_response: { ok: true },
      },
      't2'
    );

    expect(out).toEqual({
      hookSpecificOutput: {
        additionalContext: 'SECURITY WARNINGS detected',
        hookEventName: 'PostToolUse',
      },
    });
    expect(toolCalls).toEqual([
      expect.objectContaining({
        error: 'content security warning',
        outputJson: { ok: true },
        toolName: 'Write',
      }),
    ]);
  });

  it('bounds a large tool result in the trace', async () => {
    const { post, toolCalls } = await hooks();
    await post(
      {
        hook_event_name: 'PostToolUse',
        tool_input: {},
        tool_name: 'Read',
        tool_response: 'y'.repeat(50_000),
      },
      't3'
    );
    const out = String(toolCalls[0]?.outputJson);
    expect(out.length).toBeLessThan(20_100);
    expect(out).toContain('more characters');
  });

  it('traces a failed call with its error', async () => {
    const { postFailure, toolCalls } = await hooks();
    await postFailure(
      {
        error: 'exit 1',
        hook_event_name: 'PostToolUseFailure',
        tool_input: { command: 'x' },
        tool_name: 'Bash',
      },
      't4'
    );
    expect(toolCalls[0]).toMatchObject({ error: 'exit 1', toolName: 'Bash' });
  });
});

describe('the outcome of a turn', () => {
  it('returns the final text and counts the tool calls the model made', async () => {
    const { runtime } = setup();
    h.script.push([[init('s'), assistantToolUses(2), assistantToolUses(1), success('all done')]]);
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).resolves.toMatchObject({
      text: 'all done',
      toolCallCount: 3,
    });
    expect(h.heartbeat).toHaveBeenCalled();
  });

  it('reports usage per model, counting cache traffic as input and apart, largest spender first', async () => {
    const { runtime } = setup();
    h.script.push([
      [
        init('s'),
        success('ok', {
          'claude-haiku-4-5-20251001': usage(10, 5),
          'claude-opus-5-5': usage(100, 40, 900, 200),
        }),
      ],
    ]);

    const outcome = await runtime.runTurn({ system: 'S', user: 'U' });

    expect(outcome.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/claude-opus-5-5',
        usage: {
          cacheCreationInputTokens: 200,
          cachedInputTokens: 900,
          inputTokens: 1200,
          outputTokens: 40,
        },
      },
      {
        modelSpec: 'anthropic/claude-haiku-4-5-20251001',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ]);
  });

  it('records only what a later turn added, because the harness reports running totals', async () => {
    const { runtime } = setup();
    h.script.push(
      [[init('s'), success('a', { m: usage(100, 20, 30) })]],
      // A resumed session starts from its saved totals: the second result includes the first.
      [[init('s'), success('b', { m: usage(160, 50, 80) })]]
    );

    const first = await runtime.runTurn({ system: 'S', user: '1' });
    const second = await runtime.runTurn({ system: 'S', user: '2' });

    expect(first.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/m',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 30,
          inputTokens: 130,
          outputTokens: 20,
        },
      },
    ]);
    expect(second.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/m',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 50,
          inputTokens: 110,
          outputTokens: 30,
        },
      },
    ]);
  });

  it('counts a total that went backwards whole, since the harness reset it', async () => {
    const { runtime } = setup();
    h.script.push(
      [[init('s'), success('a', { m: usage(500, 100) })]],
      [[init('s2'), success('b', { m: usage(40, 10) })]]
    );
    await runtime.runTurn({ system: 'S', user: '1' });
    const second = await runtime.runTurn({ system: 'S', user: '2' });
    expect(second.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/m',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 40,
          outputTokens: 10,
        },
      },
    ]);
  });

  it('treats reaching the turn cap as a normal end, as the Mastra loop does at its step budget', async () => {
    const { runtime } = setup();
    const capped = {
      is_error: true,
      modelUsage: { m: usage(5, 5) },
      subtype: 'error_max_turns',
      type: 'result',
    };
    h.script.push([[init('s'), capped], new Error('Reached maximum number of turns (40)')]);

    const outcome = await runtime.runTurn({ system: 'S', user: 'U' });

    expect(outcome.text).toBeUndefined();
    expect(outcome.usageByModel).toHaveLength(1);
    expect(outcome.stoppedReason).toBe('max_steps');
  });

  it('reports how many model calls the run made, and no stop when it finished', async () => {
    const { runtime } = setup();
    h.script.push([[init('s'), { ...success('done'), num_turns: 7 }]]);
    const outcome = await runtime.runTurn({ system: 'S', user: 'U' });
    expect(outcome.steps).toBe(7);
    expect(outcome.stoppedReason).toBeUndefined();
  });

  it('fails without retrying when the model API refuses the credential', async () => {
    const { runtime } = setup();
    h.script.push([
      [
        init('s'),
        {
          api_error_status: 401,
          errors: ['invalid x-api-key'],
          is_error: true,
          modelUsage: {},
          subtype: 'error_during_execution',
          type: 'result',
        },
      ],
      new Error('Claude Code returned an error result'),
    ]);
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'HARNESS_AUTH_FAILURE',
    });
  });

  it('fails retryably on any other error result, with its detail', async () => {
    const { runtime } = setup();
    h.script.push([
      [
        init('s'),
        {
          errors: ['overloaded'],
          is_error: true,
          modelUsage: {},
          subtype: 'error_during_execution',
          type: 'result',
        },
      ],
    ]);
    const failure = await runtime.runTurn({ system: 'S', user: 'U' }).catch((e) => e);
    expect(failure.message).toContain('error_during_execution');
    expect(failure.message).toContain('overloaded');
    expect(failure.nonRetryable).toBeUndefined();
  });

  it('hands what a failed run spent to the caller on the error, and counts it once', async () => {
    const { runtime } = setup();
    const failed = {
      errors: ['overloaded'],
      is_error: true,
      modelUsage: { m: usage(300, 60) },
      subtype: 'error_during_execution',
      type: 'result',
    };
    h.script.push(
      [[init('s'), failed], new Error('Claude Code returned an error result')],
      [[init('s'), success('ok', { m: usage(350, 70) })]]
    );

    const failure = await runtime.runTurn({ system: 'S', user: 'U' }).catch((e) => e);
    expect(spentUsageOf(failure)).toEqual([
      {
        modelSpec: 'anthropic/m',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 300,
          outputTokens: 60,
        },
      },
    ]);
    // The next turn reports only what it added on top.
    const next = await runtime.runTurn({ system: 'S', user: 'U' });
    expect(next.usageByModel?.[0]?.usage).toMatchObject({ inputTokens: 50, outputTokens: 10 });
  });

  it('fails when the process dies before any result, with what it wrote to stderr', async () => {
    const { runtime } = setup();
    h.script.push([[init('s')], new Error('Claude Code process terminated by signal SIGKILL')]);
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).rejects.toThrow(/SIGKILL/);
  });

  it('hands what a run that died had streamed to the caller on the error', async () => {
    const { runtime } = setup();
    h.script.push([
      [init('s'), assistantReply('msg_1', 'claude-opus-5-5', streamed(100, 20, 50))],
      new Error('Claude Code process terminated by signal SIGKILL'),
    ]);
    const failure = await runtime.runTurn({ system: 'S', user: 'U' }).catch((e) => e);
    expect(spentUsageOf(failure)).toEqual([
      {
        modelSpec: 'anthropic/claude-opus-5-5',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 50,
          inputTokens: 150,
          outputTokens: 20,
        },
      },
    ]);
  });
});

describe('per-call accounting', () => {
  it('debits each API call it streams once the next begins, and reports the rest', async () => {
    const debited: unknown[] = [];
    const onCallSpent = async (spent: unknown) => {
      debited.push(spent);
    };
    const { runtime } = setup();
    h.script.push([
      [
        init('s'),
        // msg_1 streams a message per content block; its last report is the call's.
        assistantReply('msg_1', 'claude-opus-5-5', streamed(100, 5), 1),
        assistantReply('msg_1', 'claude-opus-5-5', streamed(100, 30, 50)),
        assistantReply('msg_2', 'claude-opus-5-5', streamed(200, 10)),
        success('done', { 'claude-opus-5-5': usage(300, 60, 50) }),
      ],
    ]);

    const outcome = await runtime.runTurn({ onCallSpent, system: 'S', user: 'U' });

    expect(debited).toEqual([
      [
        {
          modelSpec: 'anthropic/claude-opus-5-5',
          usage: {
            cacheCreationInputTokens: 0,
            cachedInputTokens: 50,
            inputTokens: 150,
            outputTokens: 30,
          },
        },
      ],
    ]);
    // The result's totals (350 input with the cache read, 60 output) less msg_1.
    expect(outcome.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/claude-opus-5-5',
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 200,
          outputTokens: 30,
        },
      },
    ]);
  });
});

describe('a deadline', () => {
  it('stops the turn without failing it, with what the streamed calls spent', async () => {
    const deadline = new AbortController();
    const { runtime } = setup({ deadline: deadline.signal });
    h.script.push([
      [
        init('s'),
        // One API call streams a message per content block; its last report counts.
        assistantReply('msg_1', 'claude-opus-5-5', streamed(100, 5), 1),
        assistantReply('msg_1', 'claude-opus-5-5', streamed(100, 30)),
        assistantReply('msg_2', 'claude-opus-5-5', streamed(200, 10, 0, 40)),
      ],
      new Error('Claude Code process terminated by signal SIGTERM'),
      new Promise((resolve) => deadline.signal.addEventListener('abort', resolve)),
    ]);

    const turn = runtime.runTurn({ system: 'S', user: 'U' });
    await vi.waitFor(() => expect(h.queryCalls).toHaveLength(1));
    deadline.abort();

    await expect(turn).resolves.toEqual({
      stoppedReason: 'wall_clock',
      toolCallCount: 1,
      usageByModel: [
        {
          modelSpec: 'anthropic/claude-opus-5-5',
          usage: {
            cacheCreationInputTokens: 40,
            cachedInputTokens: 0,
            inputTokens: 340,
            outputTokens: 40,
          },
        },
      ],
    });
    expect(h.queryCalls[0]?.options.abortController.signal.aborted).toBe(true);
  });

  it('starts aborted when the deadline has already passed', async () => {
    const { runtime } = setup({ deadline: AbortSignal.abort() });
    h.script.push([[init('s')], new Error('aborted')]);
    await expect(runtime.runTurn({ system: 'S', user: 'U' })).resolves.toMatchObject({
      stoppedReason: 'wall_clock',
      usageByModel: [],
    });
    expect(h.queryCalls[0]?.options.abortController.signal.aborted).toBe(true);
  });

  it('is not a stop when the turn finishes first', async () => {
    const deadline = new AbortController();
    const { runtime } = setup({ deadline: deadline.signal });
    h.script.push([[init('s'), success('done')]]);
    const outcome = await runtime.runTurn({ system: 'S', user: 'U' });
    expect(outcome).toMatchObject({ stoppedReason: undefined, text: 'done' });
  });
});

describe('an exact tool grant', () => {
  it('offers and allows only the tools it names, in place of the toolKeys rule', async () => {
    const { runtime } = setup({ toolKeys: null, tools: ['Read', 'Glob', 'Grep'] });
    h.script.push([[init('s'), success('ok')]]);
    await runtime.runTurn({ system: 'S', user: 'U' });
    expect(h.queryCalls[0]?.options.tools).toEqual(['Read', 'Glob', 'Grep']);
    await h.queryCalls[0]?.options.hooks.PreToolUse[0]?.hooks[0]?.(
      { cwd: '/workspace/target-repo', tool_input: { command: 'ls' }, tool_name: 'Bash' },
      'tu-1'
    );
    expect(h.decideToolCall.mock.calls[0]?.[2]).toMatchObject({ tools: ['Read', 'Glob', 'Grep'] });
  });

  it('grants nothing for an empty list, never everything', async () => {
    const { runtime } = setup({ tools: [] });
    h.script.push([[init('s'), success('ok')]]);
    await runtime.runTurn({ system: 'S', user: 'U' });
    expect(h.queryCalls[0]?.options.tools).toEqual([]);
  });
});

describe('cancellation and cleanup', () => {
  it('kills everything the turn started, by its tag, whether it succeeded or not', async () => {
    for (const failing of [false, true]) {
      h.queryCalls.length = 0;
      const { runtime, exec } = setup();
      h.script.push(failing ? [[init('s')], new Error('boom')] : [[init('s'), success('ok')]]);
      await runtime.runTurn({ system: 'S', user: 'U' }).catch(() => undefined);

      h.queryCalls[0]?.options.spawnClaudeCodeProcess({ args: [], env: {}, signal: undefined });
      const spawned = h.spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      const tag = spawned?.find((a) => a.startsWith('AUTO_SWE_EXEC_ID='))?.split('=')[1];
      const script = exec.mock.calls.map((c) => c[0]).find((c) => c.includes('kill -'));
      expect(script, `failing=${failing}`).toBeDefined();
      expect(tag).toMatch(/^[0-9a-f]{16}$/);
      // The tag the process was started with is the one the cleanup looks for.
      expect(script).toContain(`AUTO_SWE_EXEC_ID=${tag}`);
    }
  });

  it('aborts the harness when the activity is cancelled, and reports the cancellation', async () => {
    const controller = new AbortController();
    h.activityCancellationSignal.mockReturnValue(controller.signal);
    const cancelled = new Error('activity cancelled');
    h.throwIfActivityCancelled.mockImplementation(() => {
      if (controller.signal.aborted) {
        throw cancelled;
      }
    });
    const { runtime } = setup();
    h.script.push([
      [init('s')],
      new Error('Claude Code process terminated by signal SIGTERM'),
      new Promise((resolve) => controller.signal.addEventListener('abort', resolve)),
    ]);

    const turn = runtime.runTurn({ system: 'S', user: 'U' });
    // Cancel after the harness has started: the SDK's abort controller is the one it was given.
    await vi.waitFor(() => expect(h.queryCalls).toHaveLength(1));
    controller.abort();

    await expect(turn).rejects.toBe(cancelled);
    expect(h.queryCalls[0]?.options.abortController.signal.aborted).toBe(true);
  });
});
