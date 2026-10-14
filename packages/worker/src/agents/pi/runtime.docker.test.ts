import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The Pi runtime against a real container: the one place Pi's agent loop, its
 * own file tools, `docker exec` through the turn's tagged exec and the
 * worker-side policy are exercised together. The model is a scripted AI SDK
 * mock, so no API key or network is needed beyond the image.
 *
 * Needs Docker and the `node:24-alpine` image (pulled if absent);
 * `PI_DOCKER_TEST_IMAGE` names another image with a POSIX shell.
 *
 *   PI_DOCKER_TEST=1 yarn vitest run packages/worker/src/agents/pi/runtime.docker.test.ts
 */
const enabled = process.env.PI_DOCKER_TEST === '1';
const IMAGE = process.env.PI_DOCKER_TEST_IMAGE || 'node:24-alpine';

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
vi.mock('../../lib/sensitiveFileScanner.js', () => ({
  checkSensitiveFilePath: async (p: string) => (p === '.env' ? 'blocked: .env' : null),
}));

import type { AgentTracer } from '../../lib/agentTracer.js';
import { piRuntime } from './runtime.js';

const run = promisify(execFile);
const REPO = '/workspace/target-repo';
const SPEC = 'anthropic/claude-sonnet-5-5';

let containers: string[] = [];

type Step = { text: string } | { calls: { name: string; input: Record<string, unknown> }[] };

function scriptedModel(steps: Step[]) {
  const prompts: unknown[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      const step = steps[i++] ?? { text: 'done' };
      const usage = {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 100, total: 100 },
        outputTokens: { reasoning: 0, text: 20, total: 20 },
      };
      return 'text' in step
        ? {
            content: [{ text: step.text, type: 'text' }],
            finishReason: { raw: 'end_turn', unified: 'stop' },
            usage,
            warnings: [],
          }
        : {
            content: step.calls.map((c, n) => ({
              input: JSON.stringify(c.input),
              toolCallId: `call-${i}-${n}`,
              toolName: c.name,
              type: 'tool-call',
            })),
            finishReason: { raw: 'tool_use', unified: 'tool-calls' },
            usage,
            warnings: [],
          };
    },
  } as never);
  return { model, prompts };
}

/** A container shaped like `createWorkspace`'s: same hardening, the checkout made. */
async function startWorkspace() {
  const name = `pi-it-${Math.random().toString(16).slice(2, 10)}`;
  await run('docker', [
    'run',
    '-d',
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=1g',
    '--pids-limit=256',
    '--name',
    name,
    IMAGE,
    'sleep',
    'infinity',
  ]);
  containers.push(name);
  await run('docker', ['exec', name, 'mkdir', '-p', REPO]);
  const shell = async (command: string) =>
    (await run('docker', ['exec', '-w', REPO, name, 'sh', '-c', command])).stdout.trim();
  const workspace = {
    containerId: name,
    exec: shell,
    execCapture: async (command: string) => {
      try {
        return { exitCode: 0, stderr: '', stdout: await shell(command) };
      } catch (err) {
        return { exitCode: (err as { code?: number }).code ?? 1, stderr: '', stdout: '' };
      }
    },
    execStdin: async (command: string, stdin: string | Buffer) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          'docker',
          ['exec', '-i', '-w', REPO, name, 'sh', '-c', command],
          (err, stdout) => (err ? reject(err) : resolve(stdout))
        );
        child.stdin?.end(stdin);
      }),
  };
  return { name, shell, workspace };
}

function makeRuntime(
  ws: Awaited<ReturnType<typeof startWorkspace>>,
  model: MockLanguageModelV4,
  options: { maxToolOutputChars?: number } = {}
) {
  const toolCalls: Record<string, unknown>[] = [];
  const runtime = piRuntime({
    access: { apiKey: 'unused', spec: SPEC },
    languageModel: model,
    loadProjectSettings: true,
    maxToolOutputChars: options.maxToolOutputChars,
    maxTurns: 8,
    tracer: {
      addActivityEvent: () => undefined,
      addToolCall: (c: Record<string, unknown>) => toolCalls.push(c),
    } as unknown as AgentTracer,
    workspace: ws.workspace as never,
  });
  return { runtime, toolCalls };
}

afterAll(async () => {
  await Promise.all(containers.map((c) => run('docker', ['rm', '-f', c]).catch(() => undefined)));
  containers = [];
});

describe.skipIf(!enabled)('the Pi runtime against a real container', () => {
  it("runs Pi's own tools in the container, each decided and traced by the worker", async () => {
    const ws = await startWorkspace();
    await ws.shell(`printf 'Answer tersely.\\n' > AGENTS.md`);
    const { model, prompts } = scriptedModel([
      { calls: [{ input: { content: 'one\ntwo\n', path: 'src/a.txt' }, name: 'write' }] },
      {
        calls: [
          {
            input: { edits: [{ newText: 'TWO', oldText: 'two' }], path: 'src/a.txt' },
            name: 'edit',
          },
        ],
      },
      { calls: [{ input: { path: 'src/a.txt' }, name: 'read' }] },
      { calls: [{ input: {}, name: 'ls' }] },
      { calls: [{ input: { command: 'wc -l < src/a.txt' }, name: 'bash' }] },
      { text: 'all done' },
    ]);
    const { runtime, toolCalls } = makeRuntime(ws, model);

    const outcome = await runtime.runTurn({ system: 'You are the implementer.', user: 'go' });

    expect(outcome.text).toBe('all done');
    expect(outcome.toolCallCount).toBe(5);
    expect(await ws.shell('cat src/a.txt')).toBe('one\nTWO');
    expect(toolCalls.map((c) => [c.toolName, c.error])).toEqual([
      ['write', undefined],
      ['edit', undefined],
      ['read', undefined],
      ['ls', undefined],
      ['bash', undefined],
    ]);
    const seen = JSON.stringify(prompts);
    expect(seen).toContain('Answer tersely.');
    expect(seen).toContain('one\\nTWO');
    expect(seen).toMatch(/AGENTS\.md\\n.*src\//);
    expect(outcome.usageByModel).toEqual([
      {
        modelSpec: SPEC,
        usage: {
          cacheCreationInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 600,
          outputTokens: 120,
        },
      },
    ]);
  }, 60_000);

  it('never runs a refused call, in the shell or on a file', async () => {
    const ws = await startWorkspace();
    const { model, prompts } = scriptedModel([
      {
        calls: [
          { input: { command: 'touch forbidden-ran' }, name: 'bash' },
          { input: { content: 'SECRET=1', path: '.env' }, name: 'write' },
          { input: { content: 'x', path: '/etc/evil' }, name: 'write' },
          { input: { content: 'x', path: '~/.profile' }, name: 'write' },
          { input: { content: 'x', path: 'AGENTS.md' }, name: 'write' },
        ],
      },
      { text: 'ok' },
    ]);
    const { runtime, toolCalls } = makeRuntime(ws, model);

    await runtime.runTurn({ system: '', user: 'go' });

    expect(await ws.shell('ls -A; ls /etc/evil 2>/dev/null; echo end')).toBe('end');
    expect(toolCalls).toHaveLength(5);
    expect(toolCalls.every((c) => typeof c.error === 'string')).toBe(true);
    expect(JSON.stringify(prompts[1])).toContain('Command blocked by the shell scanner');
  }, 60_000);

  it('kills a command at its timeout, and what a turn left running when it ends', async () => {
    const ws = await startWorkspace();
    const { model } = scriptedModel([
      {
        calls: [
          { input: { command: 'sleep 300', timeout: 1 }, name: 'bash' },
          { input: { command: '(sleep 301 &) ; echo started' }, name: 'bash' },
        ],
      },
      { text: 'ok' },
    ]);
    const { runtime, toolCalls } = makeRuntime(ws, model);

    const started = Date.now();
    await runtime.runTurn({ system: '', user: 'go' });

    expect(Date.now() - started).toBeLessThan(30_000);
    expect(String(toolCalls[0]?.error)).toContain('timed out after 1 seconds');
    const procs = await ws.shell(
      'for p in /proc/[0-9]*; do cat "$p/cmdline" 2>/dev/null | tr "\\0" " "; echo; done'
    );
    expect(procs).not.toMatch(/sleep 30[01]/);
  }, 60_000);

  it('offloads a long result beside the checkout, where read can reach it', async () => {
    const ws = await startWorkspace();
    const { model, prompts } = scriptedModel([
      { calls: [{ input: { command: 'seq 1 5000' }, name: 'bash' }] },
      { text: 'ok' },
    ]);
    const { runtime } = makeRuntime(ws, model, { maxToolOutputChars: 2000 });

    await runtime.runTurn({ system: '', user: 'go' });

    const result = JSON.stringify(prompts[1]);
    const file = /\/workspace\/\.tool-output\/[^\s"\\]+/.exec(result)?.[0];
    expect(file).toBeDefined();
    expect(await ws.shell(`tail -n 1 ${file}`)).toBe('5000');
    expect(await ws.shell('ls -A')).toBe('');
  }, 60_000);
});
