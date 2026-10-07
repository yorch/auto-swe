import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Claude Code runtime against a real container and a mock model API: the one
 * place the SDK, `docker exec`, the native binary and the worker-side policy are
 * exercised together. Everything else mocks one of them.
 *
 * Needs Docker, the `node:24-alpine` image (pulled if absent) and network for
 * `apk add bash` inside the container. No API key: the model is a local mock.
 *
 *   CLAUDE_CODE_DOCKER_TEST=1 yarn vitest run \
 *     packages/worker/src/agents/claudeCode/runtime.docker.test.ts
 */
const enabled = process.env.CLAUDE_CODE_DOCKER_TEST === '1';

const h = vi.hoisted(() => ({
  cancellation: { signal: undefined as AbortSignal | undefined },
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('../../lib/cancellation.js', () => ({
  activityCancellationSignal: () => h.cancellation.signal,
  throwIfActivityCancelled: () => h.cancellation.signal?.throwIfAborted(),
}));
// The scanners read their patterns from the database; the policy is under test, not them.
vi.mock('../../lib/shellCommandScanner.js', () => ({
  scanShellCommand: async (command: string) =>
    command.includes('forbidden') ? 'Command blocked by the shell scanner' : null,
}));
vi.mock('../../lib/sensitiveFileScanner.js', () => ({ checkSensitiveFilePath: async () => null }));
// `docker cp` through the same helper the worker uses, minus the Temporal heartbeat.
vi.mock('../../lib/execUtils.js', () => ({
  spawnCaptureAsync: async (file: string, args: string[]) => {
    try {
      const { stderr, stdout } = await promisify(execFile)(file, args);
      return { exitCode: 0, stderr, stdout };
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      return { exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' };
    }
  },
}));

import type { AgentTracer } from '../../lib/agentTracer.js';
import { type MockMessagesApi, startMockMessagesApi } from './mockMessagesApi.js';
import { createModelProxy, type ModelProxy } from './modelProxy.js';
import { claudeCodeRuntime } from './runtime.js';

const run = promisify(execFile);
const REPO = '/workspace/target-repo';
const API_KEY = 'sk-ant-integration-test';
/** The mock Messages API reports no prompt-cache tokens, and the runtime reports both fields. */
const NO_CACHE = { cacheCreationInputTokens: 0, cachedInputTokens: 0 };

let api: MockMessagesApi;
let containers: string[] = [];

/** The bridge gateway: where a container reaches a server listening on the host. */
async function hostAddress(): Promise<string> {
  const { stdout } = await run('docker', [
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  return stdout.trim();
}

/** A container shaped like `createWorkspace`'s: same hardening, default Alpine image. */
async function startWorkspace() {
  const name = `claude-code-it-${Math.random().toString(16).slice(2, 10)}`;
  await run('docker', [
    'run',
    '-d',
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=4g',
    '--cpus=2',
    '--pids-limit=512',
    '--name',
    name,
    'node:24-alpine',
    'sleep',
    'infinity',
  ]);
  containers.push(name);
  await run('docker', ['exec', name, 'mkdir', '-p', REPO]);

  const exec = (command: string, stdin?: string | Buffer) =>
    new Promise<{ exitCode: number; stderr: string; stdout: string }>((resolve) => {
      const child = spawn('docker', ['exec', '-i', '-w', REPO, name, 'sh', '-c', command]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr, stdout }));
      child.stdin.end(stdin);
    });
  const workspace = {
    containerId: name,
    exec: async (command: string) => {
      const r = await exec(command);
      if (r.exitCode !== 0) {
        throw new Error(`${command}: ${r.stderr}`);
      }
      return r.stdout;
    },
    execCapture: (command: string) => exec(command),
    execStdin: async (command: string, stdin: string | Buffer) =>
      (await exec(command, stdin)).stdout,
  };
  return { name, shell: async (c: string) => (await exec(c)).stdout.trim(), workspace };
}

async function makeRuntime(
  ws: Awaited<ReturnType<typeof startWorkspace>>,
  overrides: { apiBase?: string; modelProxy?: ModelProxy } = {}
) {
  const toolCalls: Record<string, unknown>[] = [];
  const runtime = claudeCodeRuntime({
    access: {
      // The AI SDK spelling of a base URL, with its /v1: the runtime must normalize it.
      apiBase: overrides.apiBase ?? `http://${await hostAddress()}:${api.port}/v1`,
      apiKey: API_KEY,
      modelId: 'claude-sonnet-5-5',
    },
    loadProjectSettings: true,
    maxTurns: 8,
    tracer: {
      addToolCall: (c: Record<string, unknown>) => toolCalls.push(c),
    } as unknown as AgentTracer,
    workspace: ws.workspace as never,
    ...(overrides.modelProxy ? { modelProxy: overrides.modelProxy } : {}),
  });
  return { runtime, toolCalls };
}

beforeAll(async () => {
  if (enabled) {
    api = await startMockMessagesApi();
  }
}, 30_000);

afterAll(async () => {
  await api?.close();
  await Promise.all(containers.map((c) => run('docker', ['rm', '-f', c]).catch(() => undefined)));
  containers = [];
});

describe.skipIf(!enabled)('the Claude Code runtime against a real container', () => {
  it('runs the harness: a tool call is granted by the worker, runs in the container, and is traced', async () => {
    const ws = await startWorkspace();
    const { runtime, toolCalls } = await makeRuntime(ws);
    api.requests.length = 0;

    const outcome = await runtime.runTurn({
      system: 'You are the implementer.',
      user: 'write hello',
    });

    expect(outcome.text).toBe('all done');
    expect(outcome.toolCallCount).toBe(1);
    expect(await ws.shell('cat out.txt')).toBe('hello');
    expect(toolCalls).toEqual([
      expect.objectContaining({
        inputJson: expect.objectContaining({ command: expect.stringContaining('out.txt') }),
        toolName: 'Bash',
      }),
    ]);
    // Two model calls (the tool request, then the answer), billed to the model that was asked for.
    expect(outcome.usageByModel).toEqual([
      {
        modelSpec: 'anthropic/claude-sonnet-5-5',
        usage: { ...NO_CACHE, inputTokens: 200, outputTokens: 40 },
      },
    ]);

    const main = api.requests.filter((r) => r.tools.includes('Bash'));
    expect(main[0]).toMatchObject({ apiKey: API_KEY, model: 'claude-sonnet-5-5' });
    expect([...(main[0]?.tools ?? [])].sort()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
    expect(main[0]?.system).toContain('You are the implementer.');
  }, 180_000);

  it('sends every model call through the worker’s proxy: the container holds a turn token, not the key', async () => {
    const gateway = await hostAddress();
    const proxy = createModelProxy({
      advertisedUrl: (port) => `http://${gateway}:${port}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
    });
    try {
      const ws = await startWorkspace();
      // The provider is reached from the worker, so its address is the worker's view of it.
      const { runtime } = await makeRuntime(ws, {
        apiBase: `http://127.0.0.1:${api.port}/v1`,
        modelProxy: proxy,
      });
      api.requests.length = 0;
      const debited: { usage: { inputTokens: number; outputTokens: number } }[][] = [];

      const outcome = await runtime.runTurn({
        onCallSpent: async (spent) => {
          debited.push(spent as never);
        },
        system: 'S',
        user: 'write hello',
      });

      expect(outcome.text).toBe('all done');
      expect(await ws.shell('cat out.txt')).toBe('hello');
      // The provider saw the real key; the harness only ever had its turn token.
      expect(api.requests.length).toBeGreaterThan(0);
      expect(api.requests.every((r) => r.apiKey === API_KEY)).toBe(true);
      // Each call was debited as it ended, so the turn owes nothing more.
      const calls = debited.flat();
      expect(calls.reduce((n, c) => n + c.usage.inputTokens, 0)).toBe(100 * api.requests.length);
      expect(outcome.usageByModel).toEqual([]);
    } finally {
      await proxy.close();
    }
  }, 180_000);

  it('refuses a command the policy blocks, tells the model, and leaves the container untouched', async () => {
    const ws = await startWorkspace();
    const { runtime, toolCalls } = await makeRuntime(ws);

    const outcome = await runtime.runTurn({ system: 'S', user: 'DENY please' });

    expect(outcome.text).toBe('all done');
    expect(toolCalls).toEqual([
      expect.objectContaining({
        error: 'blocked by shell command scanner',
        outputJson: { result: 'Command blocked by the shell scanner' },
        toolName: 'Bash',
      }),
    ]);
    expect(await ws.shell('ls')).toBe('');
  }, 180_000);

  it('resumes the session on the next turn and reports only what that turn spent', async () => {
    const ws = await startWorkspace();
    const { runtime } = await makeRuntime(ws);
    api.requests.length = 0;

    const first = await runtime.runTurn({ system: 'S', user: 'write hello' });
    const second = await runtime.runTurn({ system: 'S', user: 'now what' });

    expect(first.usageByModel?.[0]?.usage).toEqual({
      ...NO_CACHE,
      inputTokens: 200,
      outputTokens: 40,
    });
    // The harness reports running totals; the second turn made one model call.
    expect(second.usageByModel?.[0]?.usage).toEqual({
      ...NO_CACHE,
      inputTokens: 100,
      outputTokens: 20,
    });
    const history = api.requests.filter((r) => r.tools.includes('Bash')).map((r) => r.messageCount);
    expect(history.at(-1)).toBeGreaterThan(history[0] ?? Number.POSITIVE_INFINITY);
  }, 180_000);

  it("loads the repository's CLAUDE.md, and a repository setting cannot move the API host", async () => {
    const ws = await startWorkspace();
    await ws.shell(
      `echo 'PROJECT-RULE-7731: always run the linter.' > CLAUDE.md && mkdir -p .claude && echo '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9"}}' > .claude/settings.json`
    );
    const { runtime } = await makeRuntime(ws);
    api.requests.length = 0;

    const outcome = await runtime.runTurn({ system: 'S', user: 'write hello' });

    // Reaching the mock at all proves the pinned host won over the repo's.
    expect(outcome.text).toBe('all done');
    const main = api.requests.find((r) => r.tools.includes('Bash'));
    expect(main?.firstMessage).toContain('PROJECT-RULE-7731');
  }, 180_000);

  it('stops what it started when the activity is cancelled', async () => {
    const ws = await startWorkspace();
    const { runtime } = await makeRuntime(ws);
    const controller = new AbortController();
    h.cancellation.signal = controller.signal;

    try {
      const turn = runtime.runTurn({ system: 'S', user: 'HANG forever' }).catch((e) => e);
      // Wait for the shell tool's `sleep 300` to be running in the container.
      await vi.waitFor(async () => expect(await ws.shell('ps')).toContain('sleep 300'), {
        interval: 500,
        timeout: 120_000,
      });
      controller.abort();

      const failure = await turn;
      expect(failure).toBeInstanceOf(Error);
      const left = await ws.shell("ps -o args | grep -E 'claude|sleep 300' | grep -v grep || true");
      expect(left).toBe('');
    } finally {
      h.cancellation.signal = undefined;
    }
  }, 240_000);
});
