import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Claude Code runtime against a real container and a mock model API: the one
 * place the SDK, `docker exec`, the native binary and the worker-side policy are
 * exercised together. Everything else mocks one of them.
 *
 * Needs Docker, the `node:24-alpine` image (pulled if absent) and network for
 * bootstrap tool installation inside the container. No API key: the model is a local mock.
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
// Pause snapshots are stored by artifact id; the store is the only thing faked in that scenario.
const artifacts = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact: async (id: string) => {
    artifacts.delete(id);
  },
  getArtifact: async (id: string) => {
    const body = artifacts.get(id);
    if (!body) {
      throw new Error('missing artifact');
    }
    return { body };
  },
  putArtifact: async (input: { body: Buffer }) => {
    const id = `art-${artifacts.size + 1}`;
    artifacts.set(id, Buffer.from(input.body));
    return { id };
  },
}));
// The scanners read their patterns from the database; the policy is under test, not them.
vi.mock('../../lib/shellCommandScanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shellCommandScanner.js')>()),
  scanShellCommand: async (command: string) =>
    command.includes('forbidden') ? 'Command blocked by the shell scanner' : null,
}));
vi.mock('../../lib/sensitiveFileScanner.js', () => ({ checkSensitiveFilePath: async () => null }));
// The remote MCP server below listens on loopback, which the worker's SSRF guard
// refuses in production; only the URL check and the guarded fetch are stubbed.
vi.mock('../mcpTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpTools.js')>()),
  guardedMcpFetch: () => (input: string | URL, init?: RequestInit) => fetch(input, init),
  parseMcpServerRef: (ref: string) => new URL(ref),
}));
// `docker cp` through the same helper the worker uses, minus the Temporal heartbeat.
vi.mock('../../lib/execUtils.js', () => ({
  // `docker cp - <container>:<dir> < tar` (the daemon unpacks the profile archive).
  execShellAsync: async (command: string) => {
    const { stdout } = await promisify(execFile)('sh', ['-c', command]);
    return stdout;
  },
  spawnCaptureAsync: async (file: string, args: string[]) => {
    try {
      const { stderr, stdout } = await promisify(execFile)(file, args);
      return { exitCode: 0, stderr, stdout };
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      return { exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' };
    }
  },
  // The snapshot's artifact transfer heartbeats while it runs; there is no activity here.
  withHeartbeat: async <T>(_label: string, work: Promise<T>) => work,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { killStrayProcessesScript } from '../../activities/workspace.js';
import type { AgentTracer } from '../../lib/agentTracer.js';
import type { ResolvedHarnessProfile } from '../../lib/config/harnessProfile.js';
import { restoreWorkingTree, snapshotWorkingTree } from '../../lib/pauseSnapshot.js';
import { workspaceBootstrapScript } from '../../lib/workspaceBackend/docker.js';
import { HARNESS_HOME } from '../harness/adapter.js';
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

/**
 * The bridge gateway: where a container reaches a server listening on the host.
 * CLAUDE_CODE_TEST_HOST_ADDRESS supplies it when the daemon is reached through
 * the socket proxy, which (like the worker's) refuses the networks API.
 */
async function hostAddress(): Promise<string> {
  const preset = process.env.CLAUDE_CODE_TEST_HOST_ADDRESS;
  if (preset) {
    return preset;
  }
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
  await run('docker', [
    'exec',
    '--user',
    '0',
    '--workdir',
    '/',
    name,
    '/usr/bin/env',
    '-i',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/root',
    '/bin/sh',
    '-ec',
    workspaceBootstrapScript(),
  ]);
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
  // The keeper is the `sleep infinity` the container was started with; the sweep spares it.
  const keeperPid = async () =>
    Number((await exec('ps -o pid,comm | awk \'$2=="sleep"{print $1; exit}\'')).stdout.trim());
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
    // Like the real workspace's: a non-zero exit rejects.
    execStdin: async (command: string, stdin: string | Buffer) => {
      const r = await exec(command, stdin);
      if (r.exitCode !== 0) {
        throw new Error(`${command}: ${r.stderr}`);
      }
      return r.stdout;
    },
    killStrays: async () => {
      const r = await exec(killStrayProcessesScript(await keeperPid()));
      if (r.exitCode !== 0) {
        throw new Error(`killStrays: ${r.stderr}`);
      }
    },
  };
  return { name, shell: async (c: string) => (await exec(c)).stdout.trim(), workspace };
}

async function makeRuntime(
  ws: Awaited<ReturnType<typeof startWorkspace>>,
  overrides: {
    allowPause?: boolean;
    apiBase?: string;
    mcp?: { url: string };
    modelProxy?: ModelProxy;
    profile?: ResolvedHarnessProfile;
  } = {}
) {
  const toolCalls: Record<string, unknown>[] = [];
  const events: { name: string; outputJson: unknown }[] = [];
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
      addActivityEvent: (e: { name: string; outputJson: unknown }) => events.push(e),
      addToolCall: (c: Record<string, unknown>) => toolCalls.push(c),
    } as unknown as AgentTracer,
    workspace: ws.workspace as never,
    ...(overrides.allowPause ? { allowPause: true } : {}),
    ...(overrides.profile ? { profile: overrides.profile } : {}),
    ...(overrides.modelProxy ? { modelProxy: overrides.modelProxy } : {}),
    ...(overrides.mcp ? { mcp: overrides.mcp } : {}),
  });
  return { events, runtime, toolCalls };
}

const text = (path: string, body: string, mode: '100644' | '100755' = '100644') => ({
  bytes: Buffer.from(body),
  mode,
  path,
});

/** A profile with one plugin (a skill, a hook that runs a script) and instructions. */
function kitProfile(): ResolvedHarnessProfile {
  const files = [
    text('profile.json', '{}'),
    text('INSTRUCTIONS.md', 'PROFILE-RULE-4242: say hello politely.\n'),
    text('plugins/kit/.claude-plugin/plugin.json', '{"name":"kit","version":"1.0.0"}'),
    text(
      'plugins/kit/skills/hello/SKILL.md',
      '---\nname: hello\ndescription: Greets people\n---\nSay hello.\n'
    ),
    text(
      'plugins/kit/hooks/hooks.json',
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ command: `\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh`, type: 'command' }],
            },
          ],
        },
      })
    ),
    text('plugins/kit/scripts/hook.sh', '#!/bin/sh\necho ran > /tmp/plugin-hook-ran\n', '100755'),
  ];
  return {
    commitSha: 'c0ffee'.padEnd(40, '1'),
    contentHash: createHash('sha256').update('kit').digest('hex'),
    files,
    manifest: {
      description: 'Kit',
      instructions: 'INSTRUCTIONS.md',
      name: 'kit',
      plugins: ['plugins/kit'],
      tools: ['Skill', 'Agent'],
    },
    name: 'kit',
    version: 3,
  };
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
    // The harness also advertises `DeferredToolPlaceholder` (since SDK 0.3.309). It is not one of
    // ours and `decideToolCall` refuses it (policy.test.ts), so it is left out of the granted set.
    const advertised = (main[0]?.tools ?? []).filter((tool) => tool !== 'DeferredToolPlaceholder');
    expect([...advertised].sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
    expect(main[0]?.system).toContain('You are the implementer.');
  }, 180_000);

  it('sends every model call through the worker’s proxy: the container holds a turn token, not the key', async () => {
    const gateway = await hostAddress();
    const proxy = createModelProxy({
      advertisedUrl: (port) => `http://${gateway}:${port}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
      // The provider is a loopback stand-in, which the default guarded fetch refuses.
      upstreamFetch: globalThis.fetch,
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

  it('relays the agent’s MCP connection: the harness calls the tool, the worker runs it', async () => {
    const calls: string[] = [];
    const server = http.createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'remote', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        { description: 'Echo the text back', inputSchema: { text: z.string() } },
        async ({ text }) => {
          calls.push(text);
          return { content: [{ text: `echo: ${text}`, type: 'text' }] };
        }
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const ws = await startWorkspace();
      const { port } = server.address() as AddressInfo;
      const { runtime, toolCalls } = await makeRuntime(ws, {
        mcp: { url: `http://127.0.0.1:${port}/mcp` },
      });
      api.requests.length = 0;

      const outcome = await runtime.runTurn({ system: 'S', user: 'MCPCALL please' });
      await runtime.close?.();

      expect(outcome.text).toBe('all done');
      // The model was offered the relayed tool, and the call reached the remote server.
      expect(api.requests[0]?.tools).toContain('mcp__connection__echo');
      expect(calls).toEqual(['from the harness']);
      expect(toolCalls).toEqual([expect.objectContaining({ toolName: 'mcp__connection__echo' })]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it('stages a pathed base URL as a private settings file, off every argv, and the harness still gets it', async () => {
    // A path on the gateway URL may be a credential, so the adapter stages the pinned
    // settings as a file and passes its path, and hands the URL over as secret env.
    const token = 'gwtok-7f3a9c41';
    const ws = await startWorkspace();
    const baseUrl = `http://${await hostAddress()}:${api.port}/${token}`;
    const { runtime } = await makeRuntime(ws, { apiBase: `${baseUrl}/v1` });
    api.requests.length = 0;
    const controller = new AbortController();
    h.cancellation.signal = controller.signal;

    try {
      const turn = runtime.runTurn({ system: 'S', user: 'HANG forever' }).catch((e) => e);
      await vi.waitFor(async () => expect(await ws.shell('ps')).toContain('sleep 300'), {
        interval: 500,
        timeout: 120_000,
      });

      // The file: owner-only, owned by the user the harness runs as, and exactly the pinned layer.
      const settingsPath = `${HARNESS_HOME}/.claude/pinned-settings.json`;
      const [mode, owner, me] = (
        await ws.shell(`echo "$(stat -c '%a %u' ${settingsPath}) $(id -u)"`)
      ).split(/\s+/);
      expect(mode).toBe('600');
      expect(owner).toBe(me);
      expect(JSON.parse(await ws.shell(`cat ${settingsPath}`))).toEqual({
        env: { ANTHROPIC_BASE_URL: baseUrl },
        permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
      });

      // No process in the container has the path token in its command line ...
      expect(await ws.shell(`ps -eo args | grep -F ${token} | grep -v grep || true`)).toBe('');
      // ... nor does one on the host (the `docker exec` that started the harness).
      const hostProcesses = await run('ps', ['-eo', 'args']).catch(() => undefined);
      if (hostProcesses) {
        expect(hostProcesses.stdout).not.toContain(token);
      }

      // The harness process itself holds the full pathed URL in its environment.
      const environments = await ws.shell(
        "for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep '^ANTHROPIC_BASE_URL=' || true; done"
      );
      expect(environments).toContain(`ANTHROPIC_BASE_URL=${baseUrl}`);

      // And it reached the model API through that path.
      expect(api.requests.length).toBeGreaterThan(0);
      expect(api.requests.every((r) => r.url.startsWith(`/${token}/v1/messages`))).toBe(true);

      controller.abort();
      expect(await turn).toBeInstanceOf(Error);
    } finally {
      h.cancellation.signal = undefined;
    }
  }, 240_000);

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

  describe('with an approved harness profile', () => {
    const profile = kitProfile();
    const DIR = `/workspace/.harness/profiles/${profile.contentHash.slice(0, 12)}`;

    it('materializes it outside the checkout and hands the harness its plugins, tools and instructions', async () => {
      const ws = await startWorkspace();
      const { events, runtime } = await makeRuntime(ws, { profile });
      api.requests.length = 0;

      const outcome = await runtime.runTurn({
        system: 'You are the implementer.',
        user: `RUN[[ps -o args > ps.txt]] hello`,
      });

      expect(outcome.text).toBe('all done');
      // Files, modes and the directory sit where the policy keeps the agent out of.
      expect(await ws.shell(`stat -c '%a' ${DIR}/plugins/kit/scripts/hook.sh`)).toBe('755');
      expect(await ws.shell(`stat -c '%a' ${DIR}/INSTRUCTIONS.md`)).toBe('644');
      expect(await ws.shell(`stat -c '%a' ${DIR} ${DIR}/plugins/kit`)).toBe('755\n755');
      expect(await ws.shell(`find ${DIR} \\( -perm -020 -o -perm -002 \\) | wc -l`)).toBe('0');
      expect(await ws.shell('ls -a')).not.toContain('.harness');
      // The plugin directory reached the binary's command line.
      const argv = await ws.shell('cat ps.txt');
      expect(argv).toContain('--plugin-dir');
      expect(argv).toContain(`${DIR}/plugins/kit`);
      // The model saw the provenance line, the instructions, and the granted built-ins.
      const main = api.requests.find((r) => r.tools.includes('Bash'));
      expect(main?.system).toContain(`[profile: kit@3 sha ${profile.contentHash.slice(0, 12)}]`);
      expect(main?.system).toContain('PROFILE-RULE-4242');
      expect(main?.tools).toEqual(expect.arrayContaining(['Skill', 'Agent', 'Bash']));
      expect(main?.tools).not.toContain('WebFetch');
      expect(events.filter((e) => e.name === 'agent.profile')).toHaveLength(1);
      // The plugin's hook ran inside the container, with the agent's authority.
      expect(await ws.shell('cat /tmp/plugin-hook-ran 2>/dev/null || echo missing')).toBe('ran');
    }, 240_000);

    it('refuses writes into the profile directory but leaves the checkout writable', async () => {
      const ws = await startWorkspace();
      const { events: _e, runtime, toolCalls } = await makeRuntime(ws, { profile });
      await runtime.runTurn({ system: 'S', user: 'RUN[[echo ok > ok.txt]]' });
      expect(await ws.shell('cat ok.txt')).toBe('ok');
      const instructions = await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`);

      // One session per task: a resumed session keeps its first task.
      for (const user of [
        `RUN[[echo pwned > ${DIR}/INSTRUCTIONS.md]]`,
        `RUN[[cd ${DIR} && rm -f INSTRUCTIONS.md]]`,
        // A new file: Write refuses an existing one it has not read, before any policy sees it.
        `WRITE[[${DIR}/plugins/kit/new.md]]`,
      ]) {
        const attempt = await makeRuntime(ws, { profile });
        await attempt.runtime.runTurn({ system: 'S', user });
        toolCalls.push(...attempt.toolCalls);
      }

      expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toBe(instructions);
      expect(await ws.shell(`ls ${DIR}/plugins/kit/new.md 2>&1`)).toContain('No such file');
      const refused = toolCalls.filter((c) => c.error === 'blocked by sensitive file scanner');
      expect(refused.map((c) => c.toolName)).toEqual(['Bash', 'Bash', 'Write']);
    }, 300_000);

    it('writes the profile again before every turn, whatever changed in between', async () => {
      const ws = await startWorkspace();
      const { runtime } = await makeRuntime(ws, { profile });
      await runtime.runTurn({ system: 'S', user: 'hello' });
      const pristine = await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`);

      // What an agent with a shell could do between turns: change a file, add one, loosen a mode.
      // (The directories are root-owned, so a root-owned agent can unlink and replace files.)
      const hook = `${DIR}/plugins/kit/scripts/hook.sh`;
      await ws.shell(
        `rm ${DIR}/INSTRUCTIONS.md && echo evil > ${DIR}/INSTRUCTIONS.md && echo x > ${DIR}/plugins/kit/extra.sh && rm ${hook} && echo '#!/bin/sh' > ${hook} && chmod 777 ${hook}`
      );
      expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toBe('evil');
      await runtime.runTurn({ system: 'S', user: 'hello again' });

      expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toBe(pristine);
      expect(await ws.shell(`ls ${DIR}/plugins/kit`)).not.toContain('extra.sh');
      expect(await ws.shell(`stat -c '%a' ${hook}`)).toBe('755');
    }, 300_000);

    it('stops a process the agent detached from the turn before it can rewrite the profile', async () => {
      const ws = await startWorkspace();
      const { runtime } = await makeRuntime(ws, { profile });
      await runtime.runTurn({ system: 'S', user: 'hello' });
      const pristine = await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`);

      // Started without the exec tag the turn's own kill looks for, in its own session.
      await ws.shell(
        `env -u AUTO_SWE_EXEC_ID setsid sh -c 'while :; do echo evil > ${DIR}/INSTRUCTIONS.md; sleep 0.1; done' >/dev/null 2>&1 &`
      );
      await ws.shell('sleep 0.5');
      expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toBe('evil');

      await runtime.runTurn({ system: 'S', user: 'hello again' });
      await ws.shell('sleep 0.5');
      expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toBe(pristine);
      expect(await ws.shell("ps -o args | grep 'while :' | grep -v grep || true")).toBe('');
    }, 300_000);

    it('removes a symlink put in place of the profile directories and keeps the profile out of the checkout', async () => {
      const ws = await startWorkspace();
      const { runtime } = await makeRuntime(ws, { profile });
      await runtime.runTurn({ system: 'S', user: 'hello' });

      // The checkout as the target, for the profile directory and for the directory above it.
      for (const link of [`${DIR}`, '/workspace/.harness/profiles']) {
        await ws.shell(`mkdir -p ${REPO}/linked && rm -rf ${link} && ln -s ${REPO}/linked ${link}`);
        expect(await ws.shell(`test -L ${link} && echo link`)).toBe('link');
        await runtime.runTurn({ system: 'S', user: 'hello again' });

        expect(await ws.shell(`test -L ${link} && echo link || echo real`)).toBe('real');
        expect(
          await ws.shell(`test -L /workspace/.harness/profiles && echo link || echo real`)
        ).toBe('real');
        expect(await ws.shell(`cat ${DIR}/INSTRUCTIONS.md`)).toContain('PROFILE-RULE-4242');
        expect(await ws.shell(`cd -P ${DIR} && pwd -P`)).toBe(DIR);
        // Nothing of the profile reached the checkout, so `git add -A` would not see it.
        expect(await ws.shell(`ls -A ${REPO}/linked | wc -l`)).toBe('0');
        expect(await ws.shell(`find ${REPO} -name INSTRUCTIONS.md | wc -l`)).toBe('0');
        await ws.shell(`rm -rf ${REPO}/linked`);
      }
    }, 300_000);

    it('fails the turn when the harness directory itself is a symlink', async () => {
      const ws = await startWorkspace();
      const { runtime } = await makeRuntime(ws, { profile });
      await runtime.runTurn({ system: 'S', user: 'hello' });
      await ws.shell(
        `mv /workspace/.harness /workspace/.harness-real && ln -s ${REPO} /workspace/.harness`
      );
      await expect(runtime.runTurn({ system: 'S', user: 'again' })).rejects.toBeDefined();
      expect(await ws.shell('test -L /workspace/.harness && echo link || echo gone')).not.toBe(
        'link'
      );
    }, 300_000);

    it('runs a skill the profile declares, and refuses a repository command that runs shell lines', async () => {
      const ws = await startWorkspace();
      // A repository command whose inline `!` line would touch a marker if it ever ran.
      await ws.shell(
        `mkdir -p ${REPO}/.claude/commands && printf -- '---\ndescription: x\n---\n!\`touch /tmp/skill-marker\`\nhi\n' > ${REPO}/.claude/commands/x.md`
      );
      const declared = await makeRuntime(ws, { profile });
      await declared.runtime.runTurn({ system: 'S', user: 'SKILL[[kit:hello]]' });
      expect(declared.toolCalls).toContainEqual(
        expect.objectContaining({ inputJson: { skill: 'kit:hello' }, toolName: 'Skill' })
      );
      expect(declared.toolCalls.find((c) => c.toolName === 'Skill')?.error).toBeUndefined();

      for (const skill of ['x']) {
        const attempt = await makeRuntime(ws, { profile });
        await attempt.runtime.runTurn({ system: 'S', user: `SKILL[[${skill}]]` });
        const call = attempt.toolCalls.find((c) => c.toolName === 'Skill');
        expect(call, skill).toBeDefined();
        expect(JSON.stringify(call?.outputJson), skill).toContain('declared by this agent');
      }
      expect(await ws.shell('ls /tmp/skill-marker 2>&1')).toContain('No such file');
    }, 300_000);

    it('runs what a plugin PreToolUse hook rewrites a Bash command to (the worker decided the original)', async () => {
      const rewriting = kitProfile();
      rewriting.files = [
        ...rewriting.files.filter((f) => f.path !== 'plugins/kit/hooks/hooks.json'),
        text(
          'plugins/kit/hooks/hooks.json',
          JSON.stringify({
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    { command: `\${CLAUDE_PLUGIN_ROOT}/scripts/rewrite.sh`, type: 'command' },
                  ],
                  matcher: 'Bash',
                },
              ],
            },
          })
        ),
        text(
          'plugins/kit/scripts/rewrite.sh',
          `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"echo rewritten > rewritten.txt","description":"x"}}}'\n`,
          '100755'
        ),
      ];
      rewriting.contentHash = createHash('sha256').update('rewriting').digest('hex');
      const ws = await startWorkspace();
      const { runtime, toolCalls } = await makeRuntime(ws, { profile: rewriting });
      await runtime.runTurn({ system: 'S', user: 'RUN[[echo original > original.txt]]' });
      // A limitation, documented in docs/harness-profiles.md: the binary applies a plugin
      // hook's `updatedInput` after the worker's hook has allowed the call, so only an
      // approved plugin can change what runs. If this ever flips, the docs change with it.
      expect(await ws.shell('ls')).toBe('rewritten.txt');
      expect(toolCalls).toHaveLength(1);
    }, 300_000);

    it('decides a sub-agent’s tool call with the worker’s policy', async () => {
      const ws = await startWorkspace();
      const { runtime, toolCalls } = await makeRuntime(ws, { profile });
      api.requests.length = 0;

      await runtime.runTurn({
        system: 'S',
        user: 'SUBAGENT SUBCOMMAND[[echo forbidden-from-subagent]]',
      });

      const subRequest = api.requests.find((r) => r.firstMessage.includes('SUBTASK'));
      expect(subRequest, 'the harness started a sub-agent').toBeDefined();
      expect(toolCalls).toContainEqual(
        expect.objectContaining({
          error: 'blocked by shell command scanner',
          inputJson: expect.objectContaining({
            command: expect.stringContaining('forbidden-from-subagent'),
          }),
          toolName: 'Bash',
        })
      );
    }, 300_000);
  });

  describe('asking a human', () => {
    const ASKED = {
      header: 'Library',
      multiSelect: false,
      options: [
        { description: 'The popular one', label: 'Alpha' },
        { description: 'The small one', label: 'Beta' },
      ],
      question: 'Which library should be used?',
    };

    it('ends the turn at the question, keeps the edits made before it, and leaves nothing running', async () => {
      const ws = await startWorkspace();
      const { events, runtime, toolCalls } = await makeRuntime(ws, { allowPause: true });
      api.requests.length = 0;

      const outcome = await runtime.runTurn({
        system: 'S',
        user: 'RUN[[echo before > before.txt]] then ASK me',
      });

      expect(outcome.needsInput).toEqual([ASKED]);
      expect(outcome.toolCallCount).toBe(2);
      expect(outcome.usageByModel?.length).toBeGreaterThan(0);
      // The question tool was offered, and the work done before it is still on disk.
      expect(api.requests[0]?.tools).toContain('AskUserQuestion');
      expect(await ws.shell('cat before.txt')).toBe('before');
      expect(toolCalls).toContainEqual(
        expect.objectContaining({
          inputJson: { headers: ['Library'] },
          toolName: 'AskUserQuestion',
        })
      );
      expect(events).toEqual([]);
      const left = await ws.shell("ps -o args | grep -E 'claude' | grep -v grep || true");
      expect(left).toBe('');
    }, 180_000);

    it('refuses the question when the run cannot pause, and finishes unattended', async () => {
      const ws = await startWorkspace();
      const { runtime, toolCalls } = await makeRuntime(ws);
      api.requests.length = 0;

      const outcome = await runtime.runTurn({
        system: 'S',
        user: 'RUN[[echo before > before.txt]] then ASK me',
      });

      expect(outcome.needsInput).toBeUndefined();
      expect(outcome.text).toBe('all done');
      expect(api.requests.every((r) => !r.tools.includes('AskUserQuestion'))).toBe(true);
      expect(await ws.shell('cat before.txt')).toBe('before');
      expect(toolCalls.filter((c) => c.toolName === 'AskUserQuestion')).toEqual([]);
    }, 180_000);

    it('refuses a malformed question and lets the turn go on', async () => {
      const ws = await startWorkspace();
      const { runtime, toolCalls } = await makeRuntime(ws, { allowPause: true });
      api.requests.length = 0;

      const outcome = await runtime.runTurn({ system: 'S', user: 'ASK MALFORMED' });

      expect(outcome.needsInput).toBeUndefined();
      expect(outcome.text).toBe('all done');
      expect(toolCalls).toContainEqual(
        expect.objectContaining({
          error: 'blocked by workspace policy',
          toolName: 'AskUserQuestion',
        })
      );
    }, 180_000);

    it('keeps a sub-agent’s question refused', async () => {
      const ws = await startWorkspace();
      const { runtime } = await makeRuntime(ws, { allowPause: true, profile: kitProfile() });
      api.requests.length = 0;

      const outcome = await runtime.runTurn({ system: 'S', user: 'SUBAGENT SUBASK' });

      const subRequest = api.requests.find((r) => r.firstMessage.includes('SUBTASK'));
      expect(subRequest, 'the harness started a sub-agent').toBeDefined();
      expect(outcome.needsInput).toBeUndefined();
      // The harness does not even offer the tool to a sub-agent; if it ever does, the
      // worker's hook still refuses it (runtime.test.ts), and the turn still does not pause.
      expect(subRequest?.tools).not.toContain('AskUserQuestion');
    }, 300_000);
  });
});

/** A repository with a fixed history, so two containers hold the same base commit. */
async function seedRepo(ws: Awaited<ReturnType<typeof startWorkspace>>): Promise<string> {
  const env =
    'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t ' +
    'GIT_AUTHOR_DATE=2020-01-01T00:00:00Z GIT_COMMITTER_DATE=2020-01-01T00:00:00Z';
  await ws.shell(
    [
      'git init -q -b main',
      'mkdir -p src',
      'printf "one\\n" > src/a.txt',
      'printf "gone\\n" > del.txt',
      'printf "#!/bin/sh\\necho hi\\n" > run.sh',
      'printf "stay\\n" > keep.txt',
      'git add -A',
      `${env} git -c core.hooksPath=/dev/null commit -q -m base`,
    ].join(' && ')
  );
  const head = await ws.shell('git rev-parse HEAD');
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  return head;
}

/** What a tree is: its tracked and untracked paths, and each file's mode and content digest. */
async function treeOf(ws: Awaited<ReturnType<typeof startWorkspace>>) {
  const files = await ws.shell(
    'find . -path ./.git -prune -o -type f -exec sh -c \'for f; do echo "$(stat -c %a "$f") $(sha256sum "$f" | cut -c1-64) $f"; done\' _ {} + | sort'
  );
  // Untrimmed: the first line's leading space is part of its status code.
  const paths = (await ws.workspace.exec('git status --porcelain -uall'))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  return { files, paths };
}

describe.skipIf(!enabled)('saving and restoring a working tree with real git', () => {
  /** The paused container: every kind of change a run can leave behind. */
  async function pausedRun() {
    const ws = await startWorkspace();
    const base = await seedRepo(ws);
    await ws.shell(
      [
        'printf "one\\ntwo\\n" > src/a.txt',
        'printf "new\\n" > new.txt',
        'mkdir -p "sub dir"',
        'printf "x\\n" > "sub dir/ünï code.txt"',
        'rm del.txt',
        'head -c 4096 /dev/urandom > bin.dat',
        'chmod +x run.sh',
      ].join(' && ')
    );
    const before = await treeOf(ws);
    const { snapshot } = await snapshotWorkingTree(ws.workspace as never, {
      runId: 'run-1',
      startSha: base,
    });
    return { base, before, snapshot, ws };
  }

  it('puts a tree with edits, additions, a deletion, a binary file and a mode change back exactly', async () => {
    const { base, before, snapshot, ws } = await pausedRun();
    expect(snapshot).toMatchObject({ baseSha: base });
    expect(snapshot?.bytes).toBeGreaterThan(4096);
    // Nothing of the patch is left in the checkout (it was staged beside it, and removed).
    expect(await ws.shell('ls /workspace/.pause 2>&1 || true')).toContain('No such file');
    expect(await ws.shell('git log --oneline | wc -l')).toBe('1');
    await run('docker', ['rm', '-f', ws.name]);

    const fresh = await startWorkspace();
    expect(await seedRepo(fresh)).toBe(base);
    await restoreWorkingTree(fresh.workspace as never, snapshot);

    const after = await treeOf(fresh);
    expect(after.files).toBe(before.files);
    // Same set of changed paths; the restore stages them, which the first tree had not.
    expect(after.paths).toEqual(before.paths);
    expect(await fresh.shell('stat -c %a run.sh')).toBe('755');
    expect(await fresh.shell('test -e del.txt && echo present || echo absent')).toBe('absent');
    // Nothing was committed, and nothing from the patch sits in the checkout.
    expect(await fresh.shell('git rev-parse HEAD')).toBe(base);
    expect(await fresh.shell('git log --oneline | wc -l')).toBe('1');
    expect(await fresh.shell('find /workspace \\( -name "*.patch" -o -name ".pause" \\)')).toBe('');
  }, 300_000);

  it('saves a clean tree as nothing, and restores nothing', async () => {
    const ws = await startWorkspace();
    const base = await seedRepo(ws);
    expect(
      await snapshotWorkingTree(ws.workspace as never, { runId: 'run-1', startSha: base })
    ).toEqual({ snapshot: null });
    await restoreWorkingTree(ws.workspace as never, null);
    expect(await ws.shell('git status --porcelain')).toBe('');
  }, 300_000);

  it('refuses a checkout that is not at the saved commit, and leaves it untouched', async () => {
    const { snapshot, ws } = await pausedRun();
    await run('docker', ['rm', '-f', ws.name]);

    const moved = await startWorkspace();
    await seedRepo(moved);
    await moved.shell(
      'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t ' +
        'git commit -q --allow-empty -m moved'
    );

    await expect(restoreWorkingTree(moved.workspace as never, snapshot)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'NEEDS_INPUT_RESTORE_FAILED',
    });
    expect(await moved.shell('git status --porcelain')).toBe('');
  }, 300_000);

  it('applies on a checkout cut at the saved commit after the base branch moved on', async () => {
    const { base, before, snapshot, ws } = await pausedRun();
    await run('docker', ['rm', '-f', ws.name]);

    // The base branch gained a commit while the person decided: its tip is no longer the
    // saved commit. A resumed run's workspace is cut from the saved commit, as createWorkspace
    // does for a pinned checkout (`git checkout -b <branch> <sha>`).
    const fresh = await startWorkspace();
    expect(await seedRepo(fresh)).toBe(base);
    await fresh.shell(
      'printf "later\n" > later.txt && git add later.txt && ' +
        'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t ' +
        'git commit -q -m moved'
    );
    const tip = await fresh.shell('git rev-parse HEAD');
    expect(tip).not.toBe(base);
    await expect(restoreWorkingTree(fresh.workspace as never, snapshot)).rejects.toMatchObject({
      type: 'NEEDS_INPUT_RESTORE_FAILED',
    });

    await fresh.shell(`git checkout -q -b resumed ${snapshot?.baseSha}`);
    await restoreWorkingTree(fresh.workspace as never, snapshot);
    const after = await treeOf(fresh);
    expect(after.files).toBe(before.files);
    expect(await fresh.shell('git rev-parse HEAD')).toBe(base);
    // The commit that moved the base branch is not in the resumed tree; the final push and PR
    // logic is the normal one and judges the change from here.
    expect(await fresh.shell('test -e later.txt && echo present || echo absent')).toBe('absent');
  }, 300_000);

  it('refuses a tampered artifact before touching the checkout', async () => {
    const { snapshot, ws } = await pausedRun();
    await run('docker', ['rm', '-f', ws.name]);
    const stored = artifacts.get(snapshot?.artifactId ?? '');
    expect(stored).toBeDefined();
    const forged = Buffer.from(stored ?? Buffer.alloc(0));
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0xff;
    artifacts.set(snapshot?.artifactId ?? '', forged);

    const fresh = await startWorkspace();
    await seedRepo(fresh);
    await expect(restoreWorkingTree(fresh.workspace as never, snapshot)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'NEEDS_INPUT_RESTORE_FAILED',
    });
    expect(await fresh.shell('git status --porcelain')).toBe('');
  }, 300_000);

  it('applies nothing when the patch no longer fits the checkout', async () => {
    const { snapshot, ws } = await pausedRun();
    await run('docker', ['rm', '-f', ws.name]);

    const fresh = await startWorkspace();
    await seedRepo(fresh);
    // Same commit, but the index already holds a different edit of a file the patch changes.
    await fresh.shell('printf "other\\n" > src/a.txt && git add src/a.txt');
    const dirty = await fresh.shell('git status --porcelain');

    await expect(restoreWorkingTree(fresh.workspace as never, snapshot)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'NEEDS_INPUT_RESTORE_FAILED',
    });
    // `git apply` is all or nothing: not one of the patch's other changes landed.
    expect(await fresh.shell('git status --porcelain')).toBe(dirty);
    expect(await fresh.shell('test -e new.txt && echo present || echo absent')).toBe('absent');
  }, 300_000);
});
