import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  catalogFindManyMock,
  connectionFindUniqueMock,
  persistTraceMock,
  resolveSettingsMock,
  setupBlockerUpsertMock,
  setupBlockerResolveMock,
  teamFindUniqueMock,
} = vi.hoisted(() => ({
  catalogFindManyMock: vi.fn(async () => [] as unknown[]),
  connectionFindUniqueMock: vi.fn(async () => null as unknown),
  persistTraceMock: vi.fn(async (..._args: unknown[]) => true),
  resolveSettingsMock: vi.fn(async () => ({
    'workspace.toolInstall.enabled': false,
    'workspace.toolInstall.maxTools': 8,
  })),
  setupBlockerResolveMock: vi.fn(async () => ({ count: 0 })),
  setupBlockerUpsertMock: vi.fn(async () => ({})),
  teamFindUniqueMock: vi.fn(async () => null),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: connectionFindUniqueMock },
    repoSetupBlocker: { updateMany: setupBlockerResolveMock, upsert: setupBlockerUpsertMock },
    team: { findUnique: teamFindUniqueMock },
    toolCatalogEntry: { findMany: catalogFindManyMock },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workspace.repoSetupStackDefaults' ? {} : 0
  ),
  resolveSettings: resolveSettingsMock,
}));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: () => 'workflow',
  currentWorkflowRunId: async () => 'run',
  persistActivityTrace: persistTraceMock,
}));

import { ApplicationFailure } from '@temporalio/activity';

const policy = vi.hoisted(() => ({
  setup: 'inherit' as 'inherit' | 'open' | 'restricted',
  value: 'open' as 'open' | 'restricted' | 'blocked',
}));
vi.mock('../lib/egressWiring.js', () => ({
  beginWorkspaceEgress: vi.fn(async () => null),
  blockedEgressAllow: vi.fn(() => [{ host: 'github.com', port: 443 }]),
  egressPolicyFailure: (message: string) =>
    ApplicationFailure.nonRetryable(message, 'EGRESS_POLICY_UNENFORCEABLE'),
  gitHostOf: (url: string) => new URL(url).hostname,
  lfsStorageHostEntries: vi.fn(async () => []),
  lfsStorageHosts: vi.fn(() => []),
  resolveOnboardingDraftEgress: vi.fn(async () => null),
  resolveRunEgressPolicy: vi.fn(async () => policy.value),
  resolveRunSetupEgressPolicy: vi.fn(async () => policy.setup),
}));

import { runWithActivityNodeTag } from '../lib/activityNodeTag.js';
import {
  beginWorkspaceEgress,
  blockedEgressAllow,
  resolveOnboardingDraftEgress,
} from '../lib/egressWiring.js';

afterEach(() => {
  policy.value = 'open';
  policy.setup = 'inherit';
});

vi.mock('../lib/execUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/execUtils.js')>();
  return {
    ...actual,
    execShellAsync: vi.fn(async () => ''),
    spawnCaptureAsync: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
    spawnWithStdinAsync: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
  };
});

/**
 * Default `execShellAsync` behaviour for `createWorkspace`: every command
 * succeeds with empty output, except the driver's keeper-PID probe (run right
 * after `docker run`), which must report exactly one child of PID 1 or
 * creation fails.
 */
const metadataReport = [
  'v4:',
  '-P OUTPUT ACCEPT',
  '-A OUTPUT -j ASW_BASELINE',
  ...baselineRules([], [], false, true).v4.map((r) => `-A ASW_BASELINE ${r}`),
  'v6:',
  '-P OUTPUT ACCEPT',
  '-A OUTPUT -j ASW_BASELINE',
  ...baselineRules([], [], false, true).v6.map((r) => `-A ASW_BASELINE ${r}`),
  'v6disabled=0',
].join('\n');
const okExec = async (cmd: string) =>
  cmd.includes('PPid:') ? '7\n' : cmd.includes('--network container:') ? metadataReport : '';

// `createWorkspace` reads container caps, the default base image and the
// metadata-blocking policy from the environment-backed infra resolver.
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  DOCKER_HOST_ALIAS: 'host.docker.internal',
  resolveWorkspaceInfra: vi.fn(() => ({
    blockMetadata: true,
    blockPrivateEgress: false,
    cpus: 2,
    dns: ['1.1.1.1', '8.8.8.8'],
    image: 'node:24-alpine',
    memory: '4g',
    metadataBlockImage: 'alpine:3.20',
    pidsLimit: 512,
  })),
}));

// `createWorkspace` resolves the commit identity from the database; the real
// resolver is covered by gitIdentity.test.ts.
vi.mock('../lib/gitIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/gitIdentity.js')>();
  return { ...actual, resolveGitIdentity: vi.fn(async () => actual.DEFAULT_GIT_IDENTITY) };
});

// Wraps the real wiring so a test can make registry resolution reject.
vi.mock('../lib/registryProxy/workspaceWiring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/registryProxy/workspaceWiring.js')>();
  return { ...actual, beginWorkspaceRegistries: vi.fn(actual.beginWorkspaceRegistries) };
});

import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { execShellAsync, spawnCaptureAsync, spawnWithStdinAsync } from '../lib/execUtils.js';
import {
  DEFAULT_GIT_IDENTITY,
  type GitIdentity,
  gitIdentityConfigScript,
  resolveGitIdentity,
} from '../lib/gitIdentity.js';
import { beginWorkspaceRegistries } from '../lib/registryProxy/workspaceWiring.js';
import { resolveRepoGateCommands, workspaceConfigReader } from '../lib/repoConfigResolver.js';
import { resetToolCatalogCache } from '../lib/toolCatalogLoader.js';
import { baselineRules, dockerWorkspaceBackend } from '../lib/workspaceBackend/docker.js';
import { ToolRefusal } from '../lib/workspaceTools.js';
import {
  authedGitScript,
  buildBaselineEgressScript,
  buildEgressHelperCommand,
  clearSetupProcessesScript,
  cloneDependencyRepos,
  createWorkspace,
  fetchBranchesSubcommand,
  GIT_AUTH_ENV,
  gitBootstrapScript,
  killStrayProcessesScript,
  killTaggedProcessesScript,
  MAX_DEPENDENCY_CHECKOUTS,
  safeDepDirName,
  shellQuote,
  splitCloneCredential,
} from './workspace.js';

/** How an authenticated git call names its header: read from the environment, never embedded. */
const AUTH_REF = `-c "http.extraheader=\${${GIT_AUTH_ENV}:?git credential not delivered}"`;

/** `installTools` exists only on a workspace created with `toolsFor`; a test that calls it needs it. */
function requireInstallTools(
  ws: Awaited<ReturnType<typeof createWorkspace>>
): NonNullable<Awaited<ReturnType<typeof createWorkspace>>['installTools']> {
  if (!ws.installTools) {
    throw new Error('workspace has no installTools');
  }
  return ws.installTools;
}

describe('shellQuote', () => {
  it('wraps a plain string', () => expect(shellQuote('abc')).toBe("'abc'"));
  it('escapes an embedded single quote', () => expect(shellQuote("it's")).toBe("'it'\\''s'"));
  it('escapes consecutive single quotes', () => expect(shellQuote("''")).toBe("''\\'''\\'''"));
  it('neutralizes command substitution', () =>
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'"));
  it('neutralizes backticks', () => expect(shellQuote('`id`')).toBe("'`id`'"));
  it('neutralizes separators and chaining', () =>
    expect(shellQuote('a; b && c | d')).toBe("'a; b && c | d'"));
  it('preserves newlines inside the quotes', () => expect(shellQuote('a\nb')).toBe("'a\nb'"));
  it('quotes the empty string', () => expect(shellQuote('')).toBe("''"));

  it.each([
    "it's a 'test'",
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    'a; rm -rf / && echo done',
    'line1\nline2',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PATH} is intentional adversarial input
    '$HOME ${PATH} \\backslash',
  ])('round-trips %j through sh -c printf', (input) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(input)}`], {
      encoding: 'utf8',
    });
    expect(out).toBe(input);
  });
});

const metadataCommand = (name: string, image: string) =>
  buildEgressHelperCommand(name, image, buildBaselineEgressScript([], [], false, true));

describe('metadata-only baseline helper', () => {
  it('targets the workspace container network namespace, adds NET_ADMIN, and is self-removing', () => {
    const cmd = metadataCommand('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('--rm');
    expect(cmd).toContain('--network container:workspace-abc123');
    expect(cmd).toContain('--cap-add=NET_ADMIN');
  });

  it('installs verified metadata REJECTs with IPv6 fail-closed handling', () => {
    const cmd = metadataCommand('workspace-abc123', 'alpine:3.20');
    for (const ip of ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254']) {
      expect(cmd).toContain(ip);
    }
    expect(cmd).toContain('-j REJECT');
    expect(cmd).toContain('ip6tables unusable and IPv6 enabled');
    expect(cmd).toContain('iptables -S ASW_BASELINE');
  });

  it('shell-quotes the sidecar image argument', () => {
    const cmd = metadataCommand('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain(shellQuote('alpine:3.20'));
  });

  it('does not grant the sidecar capabilities beyond NET_ADMIN', () => {
    const cmd = metadataCommand('workspace-abc123', 'alpine:3.20');
    expect(cmd).not.toContain('--cap-drop');
  });
});

describe('createWorkspace metadata-IP egress block (execShellAsync mocked — no Docker daemon here)', () => {
  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(okExec);
  });

  it('ignores gates.yml edits and commits after provisioning, reading the captured base SHA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-gates-trust-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const capture = vi.mocked(spawnCaptureAsync).getMockImplementation();
    let ws: Awaited<ReturnType<typeof createWorkspace>> | undefined;
    try {
      git('init', '-q');
      mkdirSync(join(dir, '.auto-swe'));
      writeFileSync(join(dir, '.auto-swe/gates.yml'), 'runTests: trusted tests\n');
      git('add', '.auto-swe/gates.yml');
      git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      vi.mocked(execShellAsync).mockImplementation(async (command) =>
        command.includes('git rev-parse') ? git('rev-parse', 'HEAD') : okExec(command)
      );
      vi.mocked(spawnCaptureAsync).mockImplementation(async (_file, args) => {
        const script = args.at(-1) ?? '';
        if (!script.includes('cat-file')) {
          return { exitCode: 0, stderr: '', stdout: '' };
        }
        const result = spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
        return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
      });
      ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
      expect(ws.baseSha).toBe(base);
      writeFileSync(join(dir, '.auto-swe/gates.yml'), 'runTests: agent bypass\n');
      expect(await resolveRepoGateCommands(workspaceConfigReader(ws))).toEqual({
        runTests: 'trusted tests',
      });
      git('add', '.auto-swe/gates.yml');
      git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agent');
      expect(await resolveRepoGateCommands(workspaceConfigReader(ws))).toEqual({
        runTests: 'trusted tests',
      });
      git('replace', base, 'HEAD');
      expect(await resolveRepoGateCommands(workspaceConfigReader(ws))).toEqual({
        runTests: 'trusted tests',
      });
      expect(await ws.readBaseFile('.auto-swe/preview.yml')).toBeNull();
    } finally {
      await ws?.destroy();
      if (capture) {
        vi.mocked(spawnCaptureAsync).mockImplementation(capture);
      }
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('reads resumed configuration from the trusted base branch, not the snapshot pin', async () => {
    const base = 'a'.repeat(40);
    vi.mocked(execShellAsync).mockImplementation(async (command) =>
      command.includes('git rev-parse') ? `${base}\n` : okExec(command)
    );
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'b',
      'main',
      undefined,
      'b'.repeat(40),
      undefined,
      { trustedBaseBranch: 'main' }
    );
    try {
      expect(ws.baseSha).toBe(base);
      expect(
        vi
          .mocked(execShellAsync)
          .mock.calls.some(
            ([cmd]) =>
              cmd.includes('git rev-parse') &&
              cmd.includes('origin/main') &&
              !cmd.includes('b'.repeat(40))
          )
      ).toBe(true);
    } finally {
      await ws.destroy();
    }
  });

  it.each([false, true])('resolves blockers after successful setup (defer=%s)', async (defer) => {
    setupBlockerResolveMock.mockClear();
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'b',
      'main',
      undefined,
      undefined,
      false,
      {
        repoSetup: { connectionId: 'repo', defer, field: {} },
      }
    );
    if (defer) {
      expect(setupBlockerResolveMock).not.toHaveBeenCalled();
      await ws.runSetup?.();
    }
    expect(setupBlockerResolveMock).toHaveBeenCalledWith({
      data: { resolvedAt: expect.any(Date) },
      where: { connectionId: 'repo', resolvedAt: null },
    });
    await ws.destroy();
  });

  it.each([
    [false, 'inherit'],
    [true, 'inherit'],
    [false, 'open'],
    [true, 'open'],
  ] as const)(
    'records setup failures without replacing them (defer=%s, setup=%s)',
    async (defer, setup) => {
      policy.value = 'blocked';
      policy.setup = setup;
      const lock = vi.spyOn(dockerWorkspaceBackend(), 'lockEgress').mockResolvedValue();
      setupBlockerUpsertMock.mockClear();
      vi.mocked(spawnCaptureAsync).mockImplementation(async (_file, args) => ({
        exitCode: args.join(' ').includes('setup-blocker-test-command') ? 1 : 0,
        stderr: args.join(' ').includes('setup-blocker-test-command') ? 'setup failed' : '',
        stdout: '',
      }));
      let ws: Awaited<ReturnType<typeof createWorkspace>> | undefined;
      const error = await (async () => {
        ws = await createWorkspace(
          'https://github.com/acme/repo.git',
          'b',
          'main',
          undefined,
          undefined,
          false,
          {
            repoSetup: {
              connectionId: 'repo',
              defer,
              field: { steps: [{ name: 'install', run: 'setup-blocker-test-command' }] },
            },
          }
        );
        return ws.runSetup?.();
      })().catch((error: unknown) => error);
      lock.mockRestore();
      expect(error).toMatchObject({
        details: [{ kind: 'step_failed' }],
        type: 'WORKSPACE_SETUP_FAILED',
      });
      expect(setupBlockerUpsertMock).toHaveBeenCalledTimes(1);
      if (setup === 'open') {
        expect(
          vi.mocked(execShellAsync).mock.calls.some(([cmd]) => cmd.includes('docker rm -f'))
        ).toBe(true);
      }
      await ws?.destroy();
    }
  );

  it.each([false, true])(
    'trial setup neither records failures nor resolves blockers (defer=%s)',
    async (defer) => {
      setupBlockerUpsertMock.mockClear();
      setupBlockerResolveMock.mockClear();
      for (const failed of [false, true]) {
        vi.mocked(spawnCaptureAsync).mockImplementation(async (_file, args) => ({
          exitCode: failed && args.join(' ').includes('trial-setup-command') ? 1 : 0,
          stderr: '',
          stdout: '',
        }));
        let ws: Awaited<ReturnType<typeof createWorkspace>> | undefined;
        const work = async () => {
          ws = await createWorkspace(
            'https://github.com/acme/repo.git',
            'b',
            'main',
            undefined,
            undefined,
            false,
            {
              repoSetup: {
                connectionId: 'repo',
                defer,
                field: { steps: [{ name: 'trial', run: 'trial-setup-command' }] },
                recordBlockers: false,
              },
            }
          );
          if (defer) {
            await ws.runSetup?.();
          }
        };
        if (failed) {
          await expect(work()).rejects.toMatchObject({ type: 'WORKSPACE_SETUP_FAILED' });
        } else {
          await work();
        }
        await ws?.destroy();
      }
      expect(setupBlockerUpsertMock).not.toHaveBeenCalled();
      expect(setupBlockerResolveMock).not.toHaveBeenCalled();
    }
  );

  it('does not persist setup results without a connection', async () => {
    setupBlockerResolveMock.mockClear();
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'b',
      'main',
      undefined,
      undefined,
      false,
      {
        repoSetup: { field: {} },
      }
    );
    expect(setupBlockerResolveMock).not.toHaveBeenCalled();
    await ws.destroy();
  });

  it('starts the workspace unprivileged (--cap-drop=ALL, no --cap-add) and runs a distinct metadata-block sidecar', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toBeDefined();
    expect(startCmd).toContain('--cap-drop=ALL');
    expect(startCmd).not.toContain('--cap-add');

    const metadataCmd = commands.find((c) => c.includes('--network container:'));
    expect(metadataCmd).toBeDefined();
    expect(metadataCmd).toContain('--cap-add=NET_ADMIN');
    expect(metadataCmd).not.toContain('--cap-drop=ALL');
    expect(metadataCmd).not.toBe(startCmd);

    // Both commands must reference the same container name — the sidecar
    // joins *this* workspace's netns, not some other container's.
    const nameMatch = startCmd?.match(/--name (\S+)/);
    expect(nameMatch?.[1]).toBeDefined();
    expect(metadataCmd).toContain(`--network container:${nameMatch?.[1]}`);

    await ws.destroy();
  });

  it('hands the workspace the configured resolvers, not a fixed public pair', async () => {
    const start = async () => {
      const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
      await ws.destroy();
      const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
      return commands.find((c) => c.includes('docker run -d --name')) ?? '';
    };
    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      blockMetadata: true,
      blockPrivateEgress: false,
      cpus: 2,
      dns: ['100.64.0.10'],
      image: 'node:24-alpine',
      memory: '4g',
      metadataBlockImage: 'alpine:3.20',
      pidsLimit: 512,
    } as never);
    const custom = await start();
    expect(custom).toContain(`--dns=${shellQuote('100.64.0.10')} `);
    expect(custom).not.toContain('1.1.1.1');
    expect(custom).not.toContain('8.8.8.8');

    vi.mocked(execShellAsync).mockClear();
    expect(await start()).toContain(
      `--dns=${shellQuote('1.1.1.1')} --dns=${shellQuote('8.8.8.8')} `
    );
  });

  it('applies the workspace caps + default image from the environment', async () => {
    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      blockMetadata: true,
      blockPrivateEgress: false,
      cpus: 6,
      dns: ['1.1.1.1', '8.8.8.8'],
      image: 'custom/base:1.2',
      memory: '9g',
      metadataBlockImage: 'alpine:3.20',
      pidsLimit: 999,
    } as never);

    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    // The memory string is shell-quoted (defense-in-depth); numeric caps are not.
    expect(startCmd).toContain(`--memory=${shellQuote('9g')}`);
    expect(startCmd).toContain('--cpus=6');
    expect(startCmd).toContain('--pids-limit=999');
    // No explicit image passed → the resolved config image is used.
    expect(startCmd).toContain(shellQuote('custom/base:1.2'));

    await ws.destroy();
  });

  it('maps the Docker host alias to the host gateway only when the model proxy is advertised there', async () => {
    const infra = {
      blockMetadata: true,
      blockPrivateEgress: false,
      cpus: 2,
      dns: ['1.1.1.1', '8.8.8.8'],
      image: 'node:24-alpine',
      memory: '4g',
      metadataBlockImage: 'alpine:3.20',
      pidsLimit: 512,
    };
    const startCommand = async () => {
      const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/T-1', 'main');
      await ws.destroy();
      const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
      vi.mocked(execShellAsync).mockClear();
      return commands.find((c) => c.includes('docker run -d --name')) ?? '';
    };

    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      ...infra,
      harnessModelProxy: {
        bindHost: '0.0.0.0',
        port: 8790,
        url: 'http://host.docker.internal:8790',
      },
    } as never);
    expect(await startCommand()).toContain('--add-host=host.docker.internal:host-gateway');

    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      ...infra,
      harnessModelProxy: { bindHost: '0.0.0.0', port: 8790, url: 'http://10.0.0.5:8790' },
    } as never);
    expect(await startCommand()).not.toContain('host-gateway');

    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      ...infra,
      harnessModelProxy: null,
    } as never);
    expect(await startCommand()).not.toContain('host-gateway');

    // Or on the network the worker joins: no host gateway needed, the worker is a peer.
    vi.mocked(resolveWorkspaceInfra).mockReturnValueOnce({
      ...infra,
      harnessModelProxy: { bindHost: '0.0.0.0', port: 8790, url: 'http://0123abcd:8790' },
      network: 'auto-swe-workspaces',
    } as never);
    const onNetwork = await startCommand();
    expect(onNetwork).toContain(`--network=${shellQuote('auto-swe-workspaces')}`);
    expect(onNetwork).not.toContain('host-gateway');
  });

  it('honours an explicit image argument over the resolved default image', async () => {
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'auto/TICKET-1',
      'main',
      'ghcr.io/acme/executor:9'
    );
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toContain(shellQuote('ghcr.io/acme/executor:9'));
    expect(startCmd).not.toContain(shellQuote('node:24-alpine'));

    await ws.destroy();
  });

  it('wires workspace proxy credentials as secrets and releases on teardown', async () => {
    const release = vi.fn(async () => {});
    vi.mocked(beginWorkspaceEgress).mockResolvedValueOnce({
      env: ['NO_PROXY=localhost', 'no_proxy=localhost'],
      registration: { release, token: 'proxy-secret', url: 'http://host.docker.internal:8792' },
      secretEnv: {
        HTTP_PROXY: 'http://egress:proxy-secret@host.docker.internal:8792',
        HTTPS_PROXY: 'proxy',
        http_proxy: 'proxy',
        https_proxy: 'proxy',
      },
    });
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    const start = commands.find((cmd) => cmd.includes('docker run -d --name'));
    expect(start).toContain('--add-host=host.docker.internal:host-gateway');
    expect(start).toContain('HTTP_PROXY');
    expect(start).not.toContain('proxy-secret');
    await ws.destroy();
    expect(release).toHaveBeenCalledOnce();
  });

  it('passes the repository git host so it bypasses the egress proxy', async () => {
    const ws = await createWorkspace(
      'https://ghe.corp.internal/acme/repo.git',
      'auto/TICKET-1',
      'main',
      undefined,
      undefined,
      undefined,
      { teamId: 'team-1' }
    );
    expect(beginWorkspaceEgress).toHaveBeenCalledWith('team-1', ['ghe.corp.internal'], 'open');
    await ws.destroy();
  });

  describe('egress policy', () => {
    const backend = dockerWorkspaceBackend();
    const deferredWorkspace = () =>
      createWorkspace(
        'https://github.com/acme/repo.git',
        'b',
        'main',
        undefined,
        undefined,
        undefined,
        { repoSetup: { connectionId: null, defer: true, field: null } }
      );
    beforeEach(() => {
      policy.value = 'open';
      vi.mocked(execShellAsync).mockReset();
      vi.mocked(execShellAsync).mockImplementation(okExec);
    });

    it.each(['blocked', 'restricted'] as const)(
      'registers, locks, audits and revokes draft widening from %s',
      async (realPolicy) => {
        policy.value = realPolicy;
        policy.setup = 'open';
        const expansion = {
          additionalHosts: ['downloads.example'],
          includeTeamAllowlist: realPolicy === 'restricted',
        };
        vi.mocked(resolveOnboardingDraftEgress).mockResolvedValueOnce(expansion);
        const release = vi.fn(async () => {});
        vi.mocked(beginWorkspaceEgress).mockResolvedValueOnce({
          env: [],
          registration: { release, token: 'token', url: 'http://proxy.internal:8792' },
          secretEnv: {
            HTTP_PROXY: 'http://egress:token@proxy.internal',
            HTTPS_PROXY: 'http://egress:token@proxy.internal',
            http_proxy: 'http://egress:token@proxy.internal',
            https_proxy: 'http://egress:token@proxy.internal',
          },
        });
        const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
        const logs = vi.spyOn(console, 'log');
        try {
          const ws = await runWithActivityNodeTag(
            { recordingId: 'r', specNodeId: 'draft', stepAttempt: 1 },
            () =>
              createWorkspace(
                'https://github.com/acme/repo.git',
                'b',
                'main',
                undefined,
                undefined,
                false,
                { onboardingDraft: true, repoSetup: { defer: true, field: {} }, teamId: 'team' }
              )
          );
          expect(ws.egressPolicy).toBe('restricted');
          expect(ws.setupEgressPolicy).toBe('restricted');
          expect(beginWorkspaceEgress).toHaveBeenLastCalledWith(
            'team',
            ['github.com'],
            'restricted',
            expansion
          );
          expect(blockedEgressAllow).toHaveBeenLastCalledWith(
            'github.com',
            expect.objectContaining({ egressProxyUrl: 'http://proxy.internal:8792' })
          );
          expect(lock).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
            mode: 'restricted',
          });
          const prefix = 'workspace.onboardingDraftEgress ';
          const event = logs.mock.calls
            .map(([line]) => String(line))
            .find((line) => line.startsWith(prefix));
          expect(JSON.parse(event?.slice(prefix.length) ?? '{}')).toMatchObject({
            draftHostCount: 1,
            nodeId: 'draft',
            workflowId: 'workflow',
          });
          expect(release).not.toHaveBeenCalled();
          await ws.destroy();
          expect(release).toHaveBeenCalledOnce();
        } finally {
          lock.mockRestore();
          logs.mockRestore();
        }
      }
    );

    it('keeps the real policy when no draft expansion is available', async () => {
      policy.value = 'blocked';
      vi.mocked(resolveOnboardingDraftEgress).mockResolvedValueOnce(null);
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      try {
        const ws = await createWorkspace(
          'https://github.com/acme/repo.git',
          'b',
          'main',
          undefined,
          undefined,
          false,
          { onboardingDraft: true }
        );
        expect(ws.egressPolicy).toBe('blocked');
        expect(beginWorkspaceEgress).toHaveBeenLastCalledWith(null, ['github.com'], 'blocked');
        await ws.destroy();
      } finally {
        lock.mockRestore();
      }
    });

    it.each(['blocked', 'restricted'] as const)(
      'trial disables open setup widening under %s',
      async (realPolicy) => {
        policy.value = realPolicy;
        policy.setup = 'open';
        vi.mocked(resolveOnboardingDraftEgress).mockClear();
        const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
        try {
          const ws = await createWorkspace(
            'https://github.com/acme/repo.git',
            'b',
            'main',
            undefined,
            undefined,
            false,
            {
              inheritSetupEgress: true,
              onboardingDraft: true,
              repoSetup: { defer: true, field: {} },
            }
          );
          expect(ws.setupEgressPolicy).toBe(realPolicy);
          expect(ws.egressPolicy).toBe(realPolicy);
          expect(resolveOnboardingDraftEgress).not.toHaveBeenCalled();
          expect(lock.mock.calls.every(([, , options]) => !options?.prepareOnly)).toBe(true);
          await ws.runSetup?.();
          await ws.finishSetup?.();
          await ws.destroy();
        } finally {
          lock.mockRestore();
        }
      }
    );

    it('runs open setup with the baseline only, then verifies processes and replaces the agent lock once', async () => {
      policy.value = 'blocked';
      policy.setup = 'open';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const exec = vi.spyOn(backend, 'execShell');
      try {
        const ws = await deferredWorkspace();
        expect(lock).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          [{ host: 'github.com', port: 443 }],
          { mode: 'blocked', prepareOnly: true, replace: true }
        );
        expect(ws.setupEgressPolicy).toBe('open');
        await ws.exec('nc -z public.example 443');
        await Promise.all([ws.finishSetup?.(), ws.finishSetup?.()]);
        const cleanup = exec.mock.calls.findIndex(
          ([, , opts]) => opts.heartbeatLabel === 'workspace: verifying setup processes stopped'
        );
        expect(cleanup).toBeGreaterThanOrEqual(0);
        expect(exec.mock.calls[cleanup]?.[1]).toContain('/bin/sh');
        expect(exec.mock.invocationCallOrder[cleanup]).toBeLessThan(
          lock.mock.invocationCallOrder[1]
        );
        expect(lock).toHaveBeenNthCalledWith(
          2,
          expect.anything(),
          [{ host: 'github.com', port: 443 }],
          { mode: 'blocked', replace: true }
        );
        await ws.destroy();
      } finally {
        lock.mockRestore();
        exec.mockRestore();
      }
    });

    it.each(['cleanup', 'lock'])(
      'destroys the workspace if the setup transition %s fails',
      async (failure) => {
        policy.value = 'blocked';
        policy.setup = 'open';
        const lock = vi
          .spyOn(backend, 'lockEgress')
          .mockImplementation(async (_h, _allow, opts) => {
            if (failure === 'lock' && !opts?.prepareOnly) {
              throw new Error('bad final lock');
            }
          });
        const realExec = backend.execShell.bind(backend);
        const exec = vi.spyOn(backend, 'execShell').mockImplementation(async (h, argv, opts) => {
          if (
            failure === 'cleanup' &&
            opts.heartbeatLabel === 'workspace: verifying setup processes stopped'
          ) {
            throw new Error('setup processes remain');
          }
          return realExec(h, argv, opts);
        });
        try {
          const ws = await deferredWorkspace();
          await expect(ws.finishSetup?.()).rejects.toMatchObject({
            nonRetryable: true,
            type: 'EGRESS_POLICY_UNENFORCEABLE',
          });
          expect(
            vi
              .mocked(execShellAsync)
              .mock.calls.some(([cmd]) => cmd === `docker rm -f ${ws.containerId}`)
          ).toBe(true);
          expect(() => ws.exec('nc -z public.example 443')).toThrow('transition');
          if (failure === 'cleanup') {
            expect(lock).toHaveBeenCalledOnce();
          }
        } finally {
          lock.mockRestore();
          exec.mockRestore();
        }
      }
    );

    it.each(['absent', 'empty', 'command'])(
      'finishes %s setup before returning a non-deferred workspace',
      async (setup) => {
        policy.value = 'blocked';
        policy.setup = 'open';
        const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
        try {
          const ws = await createWorkspace(
            'https://github.com/acme/repo.git',
            'b',
            'main',
            undefined,
            undefined,
            undefined,
            setup === 'absent'
              ? undefined
              : {
                  repoSetup: {
                    connectionId: null,
                    field: { steps: setup === 'command' ? [{ run: 'printf setup' }] : [] },
                  },
                }
          );
          expect(lock).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), {
            mode: 'blocked',
            replace: true,
          });
          await ws.finishSetup?.();
          expect(lock).toHaveBeenCalledTimes(2);
          await ws.destroy();
        } finally {
          lock.mockRestore();
        }
      }
    );

    it('does not return a non-deferred workspace if final enforcement fails', async () => {
      policy.value = 'blocked';
      policy.setup = 'open';
      const lock = vi.spyOn(backend, 'lockEgress').mockImplementation(async (_h, _allow, opts) => {
        if (!opts?.prepareOnly) {
          throw new Error('bad final lock');
        }
      });
      try {
        await expect(
          createWorkspace('https://github.com/acme/repo.git', 'b', 'main')
        ).rejects.toMatchObject({ type: 'EGRESS_POLICY_UNENFORCEABLE' });
        expect(
          vi
            .mocked(execShellAsync)
            .mock.calls.some(([cmd]) => cmd.startsWith('docker rm -f workspace-'))
        ).toBe(true);
      } finally {
        lock.mockRestore();
      }
    });

    it('preserves the inherited path for equal and stricter setup policies', async () => {
      policy.value = 'open';
      policy.setup = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      try {
        const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
        expect(ws.finishSetup).toBeUndefined();
        expect(ws.setupEgressPolicy).toBe('open');
        expect(lock).not.toHaveBeenCalled();
        await ws.destroy();
      } finally {
        lock.mockRestore();
      }
    });

    it('inherits blocked when restricted setup has an empty allowlist', async () => {
      policy.value = 'blocked';
      policy.setup = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      try {
        const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
        expect(ws.finishSetup).toBeUndefined();
        expect(ws.setupEgressPolicy).toBe('blocked');
        expect(lock).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), {
          mode: 'blocked',
        });
        await ws.destroy();
      } finally {
        lock.mockRestore();
      }
    });

    it('refuses restricted setup before creating a container when the egress proxy is unavailable', async () => {
      policy.value = 'blocked';
      policy.setup = 'restricted';
      vi.mocked(beginWorkspaceEgress).mockRejectedValueOnce(
        ApplicationFailure.nonRetryable(
          'restricted policy requires the egress proxy',
          'EGRESS_POLICY_UNENFORCEABLE'
        )
      );
      await expect(
        createWorkspace('https://github.com/acme/repo.git', 'b', 'main')
      ).rejects.toMatchObject({ type: 'EGRESS_POLICY_UNENFORCEABLE' });
      expect(beginWorkspaceEgress).toHaveBeenLastCalledWith(null, ['github.com'], 'restricted');
      expect(
        vi.mocked(execShellAsync).mock.calls.some(([cmd]) => cmd.startsWith('docker run -d'))
      ).toBe(false);
    });

    it('replaces a restricted setup lock with blocked and revokes the setup proxy token', async () => {
      policy.value = 'blocked';
      policy.setup = 'restricted';
      const release = vi.fn(async () => {});
      vi.mocked(beginWorkspaceEgress).mockResolvedValueOnce({
        env: [],
        registration: { release, token: 't', url: 'http://egress.internal:8792' },
        secretEnv: { HTTP_PROXY: 'p', HTTPS_PROXY: 'p', http_proxy: 'p', https_proxy: 'p' },
      });
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      try {
        const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
        expect(lock.mock.calls[0]?.[2]).toEqual({ mode: 'restricted', replace: true });
        await ws.finishSetup?.();
        expect(lock.mock.calls[1]?.[2]).toEqual({ mode: 'blocked', replace: true });
        expect(blockedEgressAllow).toHaveBeenLastCalledWith(
          'github.com',
          expect.not.objectContaining({ egressProxyUrl: expect.anything() })
        );
        expect(release).toHaveBeenCalledOnce();
        await ws.destroy();
      } finally {
        lock.mockRestore();
      }
    });

    it('takes the run policy and passes it to the proxy wiring', async () => {
      policy.value = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const ws = await createWorkspace(
        'https://github.com/acme/repo.git',
        'b',
        'main',
        undefined,
        undefined,
        undefined,
        {
          teamId: 'team-1',
        }
      );
      expect(beginWorkspaceEgress).toHaveBeenLastCalledWith('team-1', ['github.com'], 'restricted');
      lock.mockRestore();
      await ws.destroy();
    });

    it('an explicit option overrides the run policy', async () => {
      policy.value = 'blocked';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const ws = await createWorkspace(
        'https://github.com/acme/repo.git',
        'b',
        'main',
        undefined,
        undefined,
        undefined,
        {
          egressPolicy: 'open',
        }
      );
      expect(lock).not.toHaveBeenCalled();
      lock.mockRestore();
      await ws.destroy();
    });

    it('locks a blocked workspace after the clone and before returning it', async () => {
      policy.value = 'blocked';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
      expect(blockedEgressAllow).toHaveBeenCalledWith(
        'github.com',
        expect.objectContaining({
          cleanUrl: 'https://github.com/acme/repo.git',
        })
      );
      expect(lock).toHaveBeenCalledOnce();
      expect(lock.mock.calls[0]?.[1]).toEqual([{ host: 'github.com', port: 443 }]);
      expect(lock.mock.calls[0]?.[2]).toEqual({ mode: 'blocked' });
      const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
      expect(commands.some((c) => c.includes('clone'))).toBe(true);
      lock.mockRestore();
      await ws.destroy();
    });

    it('clones knowledge bases before locking egress and returns only successful mounts', async () => {
      policy.value = 'blocked';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const checkout = {
        authedCloneUrl: 'https://x:kb-secret@ghe.other.test/owner/reference.git',
        flaggedFiles: ['docs/flagged.md'],
        knowledgeBaseId: 'kb',
        mountName: 'reference',
        owner: 'owner',
        path: 'docs',
        repo: 'reference',
        sha: 'a'.repeat(40),
        snapshotId: 'snapshot',
      };
      const ws = await createWorkspace(
        'https://github.com/acme/repo.git',
        'b',
        'main',
        undefined,
        undefined,
        undefined,
        { knowledgeBases: [checkout] }
      );
      const fetchIndex = vi
        .mocked(execShellAsync)
        .mock.calls.findIndex(([command]) => command.includes('sparse-checkout'));
      expect(fetchIndex).toBeGreaterThan(-1);
      expect(vi.mocked(execShellAsync).mock.invocationCallOrder[fetchIndex]).toBeLessThan(
        lock.mock.invocationCallOrder[0]
      );
      expect(ws.knowledgeBases).toEqual([
        {
          knowledgeBaseId: 'kb',
          mountPath: '/workspace/kb/reference',
          owner: 'owner',
          repo: 'reference',
          sha: checkout.sha,
          snapshotId: 'snapshot',
        },
      ]);
      expect(ws.knowledgeBaseSnapshotIds).toEqual(['snapshot']);
      expect(vi.mocked(execShellAsync).mock.calls[fetchIndex][0]).not.toContain('kb-secret');
      lock.mockRestore();
      await ws.destroy();
    });

    it('keeps pinned search scope independently of successful file mounts', async () => {
      const ids = ['snapshot'];
      const ws = await createWorkspace(
        'https://github.com/acme/repo.git',
        'b',
        'main',
        undefined,
        undefined,
        undefined,
        { knowledgeBaseSnapshotIds: ids, knowledgeBases: [] }
      );
      ids[0] = 'other-run';
      expect(ws.knowledgeBases).toEqual([]);
      expect(ws.knowledgeBaseSnapshotIds).toEqual(['snapshot']);
      await ws.destroy();
    });

    it('fails closed: a lock failure removes the workspace and throws a non-retryable failure', async () => {
      policy.value = 'blocked';
      const lock = vi.spyOn(backend, 'lockEgress').mockRejectedValue(new Error('lock failed'));
      const failure = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main').catch(
        (err: unknown) => err
      );
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({
        message: expect.stringContaining('lock failed'),
        nonRetryable: true,
        type: 'EGRESS_POLICY_UNENFORCEABLE',
      });
      const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
      expect(commands.some((c) => c.includes('docker rm'))).toBe(true);
      lock.mockRestore();
    });

    it('does not lock an open workspace', async () => {
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      policy.value = 'open';
      await (await createWorkspace('https://github.com/acme/repo.git', 'b', 'main')).destroy();
      expect(lock).not.toHaveBeenCalled();
      lock.mockRestore();
    });

    it('locks a restricted workspace to the egress proxy as well, so it cannot be bypassed', async () => {
      policy.value = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      vi.mocked(beginWorkspaceEgress).mockResolvedValueOnce({
        env: [],
        registration: {
          release: vi.fn(async () => {}),
          token: 't',
          url: 'http://egress.internal:8792',
        },
        secretEnv: { HTTP_PROXY: 'p', HTTPS_PROXY: 'p', http_proxy: 'p', https_proxy: 'p' },
      });
      const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
      expect(blockedEgressAllow).toHaveBeenLastCalledWith(
        'github.com',
        expect.objectContaining({ egressProxyUrl: 'http://egress.internal:8792' })
      );
      expect(lock).toHaveBeenCalledOnce();
      expect(ws.egressPolicy).toBe('restricted');
      lock.mockRestore();
      await ws.destroy();
    });

    it('locks a restricted workspace with no team allowlist exactly as blocked (no proxy)', async () => {
      policy.value = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockResolvedValue();
      const ws = await createWorkspace('https://github.com/acme/repo.git', 'b', 'main');
      expect(blockedEgressAllow).toHaveBeenLastCalledWith(
        'github.com',
        expect.not.objectContaining({ egressProxyUrl: expect.anything() })
      );
      expect(lock).toHaveBeenCalledOnce();
      lock.mockRestore();
      await ws.destroy();
    });

    it('a restricted lock failure also removes the workspace', async () => {
      policy.value = 'restricted';
      const lock = vi.spyOn(backend, 'lockEgress').mockRejectedValue(new Error('no netpol'));
      await expect(
        createWorkspace('https://github.com/acme/repo.git', 'b', 'main')
      ).rejects.toMatchObject({ nonRetryable: true });
      const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
      expect(commands.some((c) => c.includes('docker rm'))).toBe(true);
      lock.mockRestore();
    });
  });

  it('fails closed and removes the workspace when the baseline helper fails', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('--network container:')) {
        throw new Error('sidecar boom');
      }
      return okExec(cmd);
    });
    await expect(
      createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main')
    ).rejects.toThrow('sidecar boom');
    expect(
      vi.mocked(execShellAsync).mock.calls.some(([cmd]) => cmd.startsWith('docker rm -f'))
    ).toBe(true);
  });
});

describe('createWorkspace clone credential handling (execShellAsync mocked)', () => {
  const AUTHED = 'https://x-access-token:ghp_secret@github.com/acme/repo.git';
  const CLEAN = 'https://github.com/acme/repo.git';
  const HEADER_B64 = Buffer.from('x-access-token:ghp_secret').toString('base64');
  // The clone runs inside `docker exec … sh -c '<script>'`, so a value that is
  // `shellQuote`d in the script appears re-escaped once more in the outer command.
  const Q = (v: string) => shellQuote(v).replace(/'/g, "'\\''");

  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(okExec);
  });

  const cloneCommands = () =>
    vi
      .mocked(execShellAsync)
      .mock.calls.map((call) => call[0] as string)
      .filter((c) => c.includes('git') && c.includes('clone'));

  it('clones with the clean URL, a per-call auth header, and `--` before the URL', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    const [cloneCmd] = cloneCommands();
    expect(cloneCmd).toBeDefined();
    // The raw token never appears on the command line…
    expect(cloneCmd).not.toContain('ghp_secret');
    expect(cloneCmd).not.toContain('x-access-token:');
    // …the credential travels as a per-call header read from the environment,
    // so not even its base64 form is in the script (which a Kubernetes exec
    // would put in an apiserver URL)…
    expect(cloneCmd).toContain(AUTH_REF);
    expect(cloneCmd).not.toContain(HEADER_B64);
    const cloneCall = vi
      .mocked(execShellAsync)
      .mock.calls.find((call) => call[0] === cloneCmd) as unknown as [
      string,
      { env?: Record<string, string> },
    ];
    expect(cloneCall[1].env).toEqual({
      ASW_GIT_AUTH: `AUTHORIZATION: basic ${HEADER_B64}`,
    });
    // …and option parsing is terminated before the (quoted) clean URL.
    expect(cloneCmd).toContain(`-- ${Q(CLEAN)} /workspace/target-repo`);
    expect(cloneCmd).toContain(`-b ${Q('main')}`);
    await ws.destroy();
  });

  it('surfaces a registry wiring failure as an Error with the credential redacted', async () => {
    vi.mocked(beginWorkspaceRegistries).mockRejectedValueOnce(
      new Error('registry lookup failed for ghp_secret')
    );
    const err = await createWorkspace(AUTHED, 'auto/T-1', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('registry lookup failed for ***');

    vi.mocked(beginWorkspaceRegistries).mockRejectedValueOnce('plain string failure');
    const wrapped = await createWorkspace(AUTHED, 'auto/T-1', 'main').catch((e: unknown) => e);
    expect(wrapped).toBeInstanceOf(Error);
    expect((wrapped as Error).message).toBe('plain string failure');
  });

  describe('registry wiring follows the detected stack', () => {
    const wiredWith = async (detectedStack: unknown): Promise<unknown> => {
      vi.mocked(beginWorkspaceRegistries).mockClear();
      vi.mocked(beginWorkspaceRegistries).mockResolvedValueOnce(null);
      const ws = await createWorkspace(
        AUTHED,
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        {
          detectedStack,
          teamId: 'team-a',
        }
      );
      await ws.destroy();
      const [teamId, container, wanted] = vi.mocked(beginWorkspaceRegistries).mock.calls[0] ?? [];
      expect(teamId).toBe('team-a');
      expect(container).toMatch(/^workspace-/);
      return wanted;
    };

    it('wires Go for a detected Go repository', async () => {
      expect(
        await wiredWith({ components: [{ path: '', stacks: ['go'] }], primary: 'go' })
      ).toEqual({
        go: true,
        maven: false,
        pypi: false,
      });
    });

    it('wires PyPI for a detected Python repository and nothing else', async () => {
      expect(
        await wiredWith({ components: [{ path: '', stacks: ['python'] }], primary: 'python' })
      ).toEqual({ go: false, maven: false, pypi: true });
    });

    it('wires Maven for a detected JVM repository and nothing else', async () => {
      expect(
        await wiredWith({ components: [{ path: '', stacks: ['jvm'] }], primary: 'jvm' })
      ).toEqual({ go: false, maven: true, pypi: false });
    });

    it('wires Go for a polyglot repository that has a Go component', async () => {
      expect(
        await wiredWith({
          components: [
            { path: '', stacks: ['node'] },
            { path: 'svc', stacks: ['go'] },
          ],
        })
      ).toEqual({ go: true, maven: false, pypi: false });
    });

    it('does not wire Go, PyPI or Maven for a detected Node repository', async () => {
      expect(
        await wiredWith({ components: [{ path: '', stacks: ['node'] }], primary: 'node' })
      ).toEqual({
        go: false,
        maven: false,
        pypi: false,
      });
    });

    it('wires Go, PyPI and Maven when the detection is unknown', async () => {
      const both = { go: true, maven: true, pypi: true };
      expect(await wiredWith(undefined)).toEqual(both);
      expect(await wiredWith(null)).toEqual(both);
      expect(await wiredWith({ components: [] })).toEqual(both);
    });

    it('keeps the PyPI token in secretEnv, off argv, and scrubs it from a failing exec', async () => {
      const TOKEN = 'cafe0123deadbeef';
      const index = `http://token:${TOKEN}@proxy.internal:9999/pypi/pypi-1/simple/`;
      const setAllowlist = vi.fn();
      vi.mocked(beginWorkspaceRegistries).mockResolvedValueOnce({
        baseUrl: 'http://proxy.internal:9999',
        env: [
          `PIP_INDEX_URL=${index}`,
          `UV_DEFAULT_INDEX=${index}`,
          `UV_INDEX_URL=${index}`,
          'PIP_TRUSTED_HOST=proxy.internal:9999',
        ],
        registration: {
          baseUrl: 'http://proxy.internal:9999',
          release: async () => {},
          setAllowlist,
          token: TOKEN,
        },
        registries: [
          {
            accessMode: 'lockfile',
            ecosystem: 'pypi',
            id: 'pypi-1',
            isDefault: true,
            name: 'pypi',
            scopes: [],
          },
        ],
        token: TOKEN,
      });
      const ws = await createWorkspace(
        AUTHED,
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        { detectedStack: { primary: 'python' }, teamId: 'team-a' }
      );
      await ws.destroy();
      const commands = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
      const startCmd = commands.find((c) => c.includes('docker run -d --name')) ?? '';
      expect(startCmd).toContain('-e PIP_INDEX_URL');
      expect(startCmd).toContain('-e UV_DEFAULT_INDEX');
      expect(startCmd).toContain('-e UV_INDEX_URL');
      expect(startCmd).toContain('PIP_TRUSTED_HOST=proxy.internal:9999');
      expect(startCmd).not.toContain(TOKEN);
      expect(
        vi
          .mocked(execShellAsync)
          .mock.calls.some((c) =>
            (c[1] as { env?: Record<string, string> })?.env?.PIP_INDEX_URL?.includes(TOKEN)
          )
      ).toBe(true);
      // No npm client files for a pypi-only workspace.
      expect(commands.some((c) => c.includes('.auto-swe'))).toBe(false);
      expect(vi.mocked(spawnWithStdinAsync).mock.calls.map((c) => String(c[0]))).not.toEqual(
        expect.arrayContaining([expect.stringContaining('npmrc')])
      );
      const allowlist = setAllowlist.mock.calls[0]?.[0] as Map<string, unknown>;
      expect(allowlist.get('pypi-1')).toEqual(new Map());

      // A failure whose error text carries the token has it scrubbed.
      vi.mocked(beginWorkspaceRegistries).mockResolvedValueOnce({
        baseUrl: 'http://proxy.internal:9999',
        env: [`PIP_INDEX_URL=${index}`],
        registration: {
          baseUrl: 'http://proxy.internal:9999',
          release: async () => {},
          setAllowlist: () => {},
          token: TOKEN,
        },
        registries: [
          {
            accessMode: 'lockfile',
            ecosystem: 'pypi',
            id: 'pypi-1',
            isDefault: true,
            name: 'pypi',
            scopes: [],
          },
        ],
        token: TOKEN,
      });
      vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
        if (cmd.includes('clone')) {
          throw new Error(`pip said no: ${index}`);
        }
        return okExec(cmd);
      });
      const err = await createWorkspace(
        AUTHED,
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        { detectedStack: { primary: 'python' }, teamId: 'team-a' }
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).toContain('***');
    });

    it('writes no npm client files for a Go-only workspace and keeps the token off argv', async () => {
      const TOKEN = 'cafe0123deadbeef';
      const setAllowlist = vi.fn();
      vi.mocked(beginWorkspaceRegistries).mockResolvedValueOnce({
        baseUrl: 'http://proxy.internal:9999',
        env: [`GOPROXY=http://proxy.internal:9999/go/${TOKEN}/go-1`, 'GOTOOLCHAIN=local'],
        registration: {
          baseUrl: 'http://proxy.internal:9999',
          release: async () => {},
          setAllowlist,
          token: TOKEN,
        },
        registries: [
          {
            accessMode: 'lockfile',
            ecosystem: 'go',
            id: 'go-1',
            isDefault: true,
            name: 'goproxy',
            scopes: [],
          },
        ],
        token: TOKEN,
      });
      const ws = await createWorkspace(
        AUTHED,
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        {
          detectedStack: { primary: 'go' },
          teamId: 'team-a',
        }
      );
      await ws.destroy();
      const commands = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
      const startCmd = commands.find((c) => c.includes('docker run -d --name')) ?? '';
      // The secret entry is named on argv (`-e GOPROXY`) and its value is not.
      expect(startCmd).toContain('-e GOPROXY');
      expect(startCmd).not.toContain(TOKEN);
      expect(startCmd).toContain('GOTOOLCHAIN=local');
      expect(
        vi
          .mocked(execShellAsync)
          .mock.calls.some((c) =>
            (c[1] as { env?: Record<string, string> })?.env?.GOPROXY?.includes(TOKEN)
          )
      ).toBe(true);
      // No npmrc / yarnrc is written (they go through spawnWithStdinAsync).
      expect(vi.mocked(spawnWithStdinAsync).mock.calls.map((c) => String(c[0]))).not.toEqual(
        expect.arrayContaining([expect.stringContaining('npmrc')])
      );
      expect(commands.some((c) => c.includes('.auto-swe'))).toBe(false);
      // The go registry still gets its (empty here, no go.sum) allowlist.
      expect(setAllowlist).toHaveBeenCalledTimes(1);
      const allowlist = setAllowlist.mock.calls[0]?.[0] as Map<string, unknown>;
      expect(allowlist.get('go-1')).toEqual(new Map());
    });

    it('writes the Maven settings for a JVM workspace, with MAVEN_ARGS in plain env and the token off argv', async () => {
      const TOKEN = 'cafe0123deadbeef';
      const setAllowlist = vi.fn();
      vi.mocked(spawnWithStdinAsync).mockClear();
      vi.mocked(beginWorkspaceRegistries).mockResolvedValueOnce({
        baseUrl: 'http://proxy.internal:9999',
        env: ['MAVEN_ARGS=-s /workspace/.auto-swe/maven-settings.xml'],
        registration: {
          baseUrl: 'http://proxy.internal:9999',
          release: async () => {},
          setAllowlist,
          token: TOKEN,
        },
        registries: [
          {
            accessMode: 'open',
            ecosystem: 'maven',
            id: 'mvn-1',
            isDefault: true,
            name: 'central',
            scopes: [],
          },
        ],
        token: TOKEN,
      });
      const ws = await createWorkspace(
        AUTHED,
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        {
          detectedStack: { components: [{ path: '', stacks: ['jvm'] }], primary: 'jvm' },
          teamId: 'team-a',
        }
      );
      await ws.destroy();
      const commands = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
      const startCmd = commands.find((c) => c.includes('docker run -d --name')) ?? '';
      // The path is no secret, so it is a plain `-e NAME=value` pair.
      expect(startCmd).toContain('MAVEN_ARGS=-s /workspace/.auto-swe/maven-settings.xml');
      expect(startCmd).not.toContain(TOKEN);
      // The settings reach the file over stdin, never on a command line.
      const writes = vi
        .mocked(spawnWithStdinAsync)
        .mock.calls.filter((c) => String(c[0]) === 'docker' && c[2] !== undefined);
      const settingsWrites = writes.filter((c) => (c[1] as string[]).join(' ').includes('maven'));
      expect(settingsWrites).toHaveLength(1);
      const [, argv, stdin] = settingsWrites[0] ?? [];
      expect((argv as string[]).join(' ')).toContain(
        'chmod 600 /workspace/.auto-swe/maven-settings.xml'
      );
      expect(stdin).toContain('<mirrorOf>*</mirrorOf>');
      expect(stdin).toContain('<url>http://proxy.internal:9999/maven/mvn-1/</url>');
      expect(stdin).toContain(`<password>${TOKEN}</password>`);
      for (const c of commands) {
        expect(c).not.toContain(TOKEN);
      }
      for (const [, args] of vi.mocked(spawnWithStdinAsync).mock.calls) {
        expect((args as string[]).join(' ')).not.toContain(TOKEN);
      }
      // No npm client files for a Maven-only workspace; the registry is open: no allowlist check.
      expect(commands.some((c) => c.includes('npmrc'))).toBe(false);
      expect(
        vi
          .mocked(spawnWithStdinAsync)
          .mock.calls.some((c) => (c[1] as string[]).join(' ').includes('npmrc'))
      ).toBe(false);
      const allowlist = setAllowlist.mock.calls[0]?.[0] as Map<string, unknown>;
      expect(allowlist.get('mvn-1')).toBeNull();
    });
  });

  it('terminates options with `--` on the pinned-SHA and existing-branch clone paths too', async () => {
    await createWorkspace(AUTHED, 'auto/T-1', 'main', undefined, 'deadbeef');
    await createWorkspace(AUTHED, 'auto/T-1', 'main', undefined, undefined, true);
    const cmds = cloneCommands();
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect(c).toContain(`-- ${Q(CLEAN)} /workspace/target-repo`);
      expect(c).not.toContain('ghp_secret');
    }
    expect(cmds[1]).toContain(`-b ${Q('auto/T-1')}`);
  });

  it('redacts the token and its auth header from a clone failure and removes the container', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('clone')) {
        // Shape of a promisify(exec) rejection: the full command line in the
        // message, plus stdout/stderr/cmd own-properties.
        throw Object.assign(new Error(`Command failed: ${cmd}\nfatal: auth failed`), {
          cmd,
          stderr: `fatal: unable to access with ${HEADER_B64} / ghp_secret`,
          stdout: '',
        });
      }
      return okExec(cmd);
    });

    let caught: (Error & { cmd?: string; stderr?: string }) | undefined;
    try {
      await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    } catch (err) {
      caught = err as Error & { cmd?: string; stderr?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('Command failed');
    // The command line no longer carries the header; stderr is where git could echo it.
    expect(caught?.stderr).toContain('***');
    for (const field of [caught?.message, caught?.cmd, caught?.stderr]) {
      expect(field).not.toContain('ghp_secret');
      expect(field).not.toContain(HEADER_B64);
    }

    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    expect(commands.some((c) => c.startsWith('docker rm -f workspace-'))).toBe(true);
  });

  it('redacts the auth header from a failed authenticated push', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('push')) {
        // The command line carries no credential; git's own stderr could echo it.
        throw Object.assign(new Error(`Command failed: ${cmd}`), {
          cmd,
          stderr: `fatal: sent header AUTHORIZATION: basic ${HEADER_B64} for ghp_secret`,
        });
      }
      return okExec(cmd);
    });
    await expect(ws.gitAuthed(`push origin ${shellQuote('auto/TICKET-1')}`)).rejects.toSatisfy(
      (err: Error & { cmd?: string; stderr?: string }) =>
        (err.stderr ?? '').includes('***') &&
        !err.message.includes(HEADER_B64) &&
        !err.message.includes('ghp_secret') &&
        !(err.cmd ?? '').includes(HEADER_B64) &&
        !(err.stderr ?? '').includes(HEADER_B64) &&
        !(err.stderr ?? '').includes('ghp_secret')
    );
  });

  it('runs gitAuthed hardened: config rewritten, hooks off, push to the scrubbed URL', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockClear();
    await ws.gitAuthed(`push origin ${shellQuote('auto/TICKET-1')}`);
    const [cmd] = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    expect(cmd).toContain('mv -f .git/config.auto-swe-tmp .git/config');
    expect(cmd).toContain('-c core.hooksPath=/dev/null');
    expect(cmd).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null');
    expect(cmd).toContain(`push --no-verify ${Q(CLEAN)} ${Q('auto/TICKET-1')}`);
    expect(cmd).not.toContain('push origin');
    // The credential is neither in the script nor in any form on its command line.
    expect(cmd).toContain(AUTH_REF);
    expect(cmd).not.toContain(HEADER_B64);
    expect(cmd).not.toContain('ghp_secret');
    const gitOptions = vi.mocked(execShellAsync).mock.calls[0]?.[1] as
      | { env?: Record<string, string> }
      | undefined;
    expect(gitOptions?.env).toEqual({ ASW_GIT_AUTH: `AUTHORIZATION: basic ${HEADER_B64}` });
    expect(cmd.indexOf('mv -f .git/config')).toBeLessThan(cmd.indexOf('push --no-verify'));
    // Stray processes die first, in the same exec as the rewrite and the call.
    expect(cmd.indexOf('asw_sweep KILL')).toBeGreaterThanOrEqual(0);
    expect(cmd.indexOf('asw_sweep KILL')).toBeLessThan(cmd.indexOf('mv -f .git/config'));
    // The repository is pinned before the credential-bearing call.
    expect(cmd.indexOf('export GIT_DIR GIT_WORK_TREE')).toBeLessThan(
      cmd.indexOf('push --no-verify')
    );
  });

  it('kills the timed-out command inside the container by its exec tag', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string, opts) => {
      if (cmd.includes('yarn test')) {
        await opts?.onTimeout?.();
        throw Object.assign(new Error('Command failed: timed out'), { killed: true });
      }
      return okExec(cmd);
    });
    await expect(ws.exec('yarn test', { timeoutMs: 1000 })).rejects.toThrow('timed out');

    const cmds = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    const run = cmds.find((c) => c.includes('yarn test')) ?? '';
    const tag = /-e AUTO_SWE_EXEC_ID=([0-9a-f]{16}) /.exec(run)?.[1];
    expect(tag).toBeDefined();
    const kill = cmds.find((c) => c.includes('asw_kill')) ?? '';
    expect(kill).toContain(`docker exec ${ws.containerId} sh -c`);
    expect(kill).toContain(`AUTO_SWE_EXEC_ID=${tag}`);
  });

  it('removes the container by name when `docker run` itself fails', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('docker run -d')) {
        throw new Error('Command failed: docker run timed out');
      }
      return okExec(cmd);
    });
    await expect(createWorkspace(AUTHED, 'auto/TICKET-1', 'main')).rejects.toThrow('docker run');
    const cmds = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    const name = /--name (workspace-[0-9a-f]+)/.exec(cmds[0] ?? '')?.[1];
    expect(name).toBeDefined();
    expect(cmds).toContain(`docker rm -f ${name}`);
  });

  it('forwards an explicit exec timeout and gives the clone a 10-minute ceiling', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    const cloneCall = vi
      .mocked(execShellAsync)
      .mock.calls.find((call) => (call[0] as string).includes('clone'));
    expect(cloneCall?.[1]).toMatchObject({ timeoutMs: 600_000 });

    await ws.exec('yarn test', { timeoutMs: 600_000 });
    const testCall = vi.mocked(execShellAsync).mock.calls.at(-1);
    expect(testCall?.[0]).toContain('yarn test');
    expect(testCall?.[1]).toMatchObject({ timeoutMs: 600_000 });

    await ws.exec('git status');
    expect(vi.mocked(execShellAsync).mock.calls.at(-1)?.[1]).toMatchObject({
      timeoutMs: undefined,
    });
  });
});

describe('Workspace.execStdin (spawn mocked)', () => {
  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(okExec);
    vi.mocked(spawnWithStdinAsync).mockReset();
    vi.mocked(spawnWithStdinAsync).mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
  });

  it('pipes the content into `docker exec -i` instead of putting it on the command line', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/T-1', 'main');
    const content = 'z'.repeat(256 * 1024);
    await ws.execStdin("cat > 'big.json'", content);

    expect(spawnWithStdinAsync).toHaveBeenCalledTimes(1);
    const [file, args, stdin] = vi.mocked(spawnWithStdinAsync).mock.calls[0];
    expect(file).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/workspace/target-repo']);
    // Tagged so a timed-out command's in-container process tree can be killed.
    expect(args[4]).toBe('-e');
    expect(args[5]).toMatch(/^AUTO_SWE_EXEC_ID=[0-9a-f]{16}$/);
    expect(args[6]).toBe(ws.containerId);
    expect(args.slice(7)).toEqual(['sh', '-c', "cat > 'big.json'"]);
    expect(stdin).toBe(content);
    // Nothing that large ever went through a shell command string.
    for (const call of vi.mocked(execShellAsync).mock.calls) {
      expect((call[0] as string).length).toBeLessThan(4096);
    }
  });

  it('rejects on a non-zero exit like exec does', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/T-1', 'main');
    vi.mocked(spawnWithStdinAsync).mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'sh: cannot create',
      stdout: '',
    });
    await expect(ws.execStdin('cat > /nope/x', 'data')).rejects.toMatchObject({
      exitCode: 1,
      stderr: 'sh: cannot create',
    });
  });
});

describe('splitCloneCredential', () => {
  it('strips an embedded token and builds the per-call auth header', () => {
    const { cleanUrl, gitAuthHeader } = splitCloneCredential(
      'https://x-access-token:ghp_secret@github.com/acme/repo.git'
    );
    expect(cleanUrl).toBe('https://github.com/acme/repo.git');
    expect(cleanUrl).not.toContain('ghp_secret');
    expect(gitAuthHeader).toContain('AUTHORIZATION: basic ');
    expect(Buffer.from(gitAuthHeader?.split('basic ')[1] ?? '', 'base64').toString()).toBe(
      'x-access-token:ghp_secret'
    );
  });

  it('passes an unauthenticated URL through with no header', () => {
    expect(splitCloneCredential('https://github.com/acme/repo.git')).toEqual({
      cleanUrl: 'https://github.com/acme/repo.git',
    });
  });

  it('passes a non-URL through untouched', () => {
    expect(splitCloneCredential('git@github.com:acme/repo.git')).toEqual({
      cleanUrl: 'git@github.com:acme/repo.git',
    });
  });
});

describe('safeDepDirName', () => {
  it('keeps a normal name', () => expect(safeDepDirName('acme-api')).toBe('acme-api'));
  it('collapses path separators', () =>
    expect(safeDepDirName('../../etc/passwd')).toBe('etc-passwd'));
  it('strips a leading dash so the name cannot become a flag', () =>
    expect(safeDepDirName('--upload-pack=evil')).toBe('upload-pack-evil'));
  it('neutralizes shell metacharacters', () =>
    expect(safeDepDirName('a;rm -rf /')).toBe('a-rm--rf-'));
  it('bounds the length', () => expect(safeDepDirName('x'.repeat(200))).toHaveLength(64));
  it('falls back when nothing survives', () => expect(safeDepDirName('///')).toBe('dep'));
});

describe('cloneDependencyRepos', () => {
  const exec = vi.fn();
  const ws = { exec };

  beforeEach(() => {
    exec.mockReset();
    exec.mockResolvedValue('');
  });

  it('shallow-clones each dependency into /workspace/deps and scrubs the credential', async () => {
    const cloned = await cloneDependencyRepos(ws, [
      {
        authedCloneUrl: 'https://x-access-token:ghp_secret@github.com/acme/api.git',
        branch: 'main',
        name: 'acme-api',
      },
    ]);

    expect(cloned).toEqual([{ label: 'acme-api', path: '/workspace/deps/acme-api' }]);
    const [cloneCmd, scrubCmd] = exec.mock.calls.map((c) => c[0] as string);
    expect(cloneCmd).toContain(' clone --depth=1 ');
    expect(cloneCmd).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null');
    expect(cloneCmd).toContain('-c core.hooksPath=/dev/null');
    expect(cloneCmd).toContain(`-b ${shellQuote('main')}`);
    // The clean URL after `--`, and the credential in no form on the command line:
    // a Kubernetes exec's command is an apiserver URL kept in audit logs.
    const clean = shellQuote('https://github.com/acme/api.git');
    expect(cloneCmd).toContain(`-- ${clean} ${shellQuote('/workspace/deps/acme-api')}`);
    const b64 = Buffer.from('x-access-token:ghp_secret').toString('base64');
    const header = `AUTHORIZATION: basic ${b64}`;
    expect(cloneCmd).not.toContain('ghp_secret');
    expect(cloneCmd).not.toContain(b64);
    expect(cloneCmd).toContain(`-c http.extraheader= ${AUTH_REF}`);
    // The header reaches the clone as a secret, and only the clone.
    expect(exec.mock.calls[0]?.[1]).toEqual({ secretEnv: { [GIT_AUTH_ENV]: header } });
    expect(exec.mock.calls[1]?.[1]).toBeUndefined();
    expect(scrubCmd).toContain('git remote set-url origin');
    expect(scrubCmd).toContain(shellQuote('https://github.com/acme/api.git'));
    expect(scrubCmd).not.toContain('ghp_secret');
  });

  it.each(['blocked', 'restricted'] as const)(
    'warns, naming the policy, when a checkout fails in a %s workspace',
    async (egressPolicy) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      exec.mockRejectedValueOnce(new Error('could not resolve host'));
      const cloned = await cloneDependencyRepos({ egressPolicy, exec }, [
        { authedCloneUrl: 'https://other.example/a.git', name: 'a' },
      ]);
      expect(cloned).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('network-locked workspace'),
        expect.objectContaining({ egressPolicy })
      );
      warn.mockRestore();
    }
  );

  it('omits the branch flag when no branch is given', async () => {
    await cloneDependencyRepos(ws, [{ authedCloneUrl: 'https://h/a.git', name: 'a' }]);
    expect(exec.mock.calls[0][0]).not.toContain('-b ');
  });

  it('sends no header and no secret for an unauthenticated URL', async () => {
    await cloneDependencyRepos(ws, [{ authedCloneUrl: 'https://h/a.git', name: 'a' }]);
    expect(exec.mock.calls[0][0]).toContain(`-- ${shellQuote('https://h/a.git')} `);
    expect(exec.mock.calls[0][0]).not.toContain('http.extraheader');
    expect(exec.mock.calls[0][1]).toBeUndefined();
  });

  it('shell-quotes every interpolated argument', async () => {
    await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/a.git;id', branch: 'a;id', name: 'a;id' },
    ]);
    const cloneCmd = exec.mock.calls[0][0] as string;
    expect(cloneCmd).toContain(shellQuote('https://h/a.git;id'));
    expect(cloneCmd).toContain(shellQuote('a;id'));
    // The directory name is sanitized before it is quoted.
    expect(cloneCmd).toContain(shellQuote('/workspace/deps/a-id'));
  });

  it('caps the number of clones', async () => {
    const deps = Array.from({ length: MAX_DEPENDENCY_CHECKOUTS + 3 }, (_, i) => ({
      authedCloneUrl: `https://h/${i}.git`,
      name: `dep-${i}`,
    }));
    const cloned = await cloneDependencyRepos(ws, deps);
    expect(cloned).toHaveLength(MAX_DEPENDENCY_CHECKOUTS);
  });

  it('disambiguates two dependencies that sanitize to the same directory', async () => {
    const cloned = await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/a.git', name: 'a/b' },
      { authedCloneUrl: 'https://h/b.git', name: 'a;b' },
    ]);
    expect(cloned.map((c) => c.path)).toEqual(['/workspace/deps/a-b', '/workspace/deps/a-b-x']);
  });

  it('is best-effort: one failed clone is cleaned up and the rest still land', async () => {
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/workspace/deps/bad')) {
        if (cmd.includes(' clone ')) {
          throw new Error('clone failed');
        }
      }
      return okExec(cmd);
    });

    const cloned = await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/bad.git', name: 'bad' },
      { authedCloneUrl: 'https://h/good.git', name: 'good' },
    ]);

    expect(cloned).toEqual([{ label: 'good', path: '/workspace/deps/good' }]);
    expect(exec.mock.calls.map((c) => c[0] as string)).toContainEqual(
      `rm -rf ${shellQuote('/workspace/deps/bad')}`
    );
  });

  it('returns an empty list when there are no dependencies', async () => {
    expect(await cloneDependencyRepos(ws, [])).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('authedGitScript against a real git repository', { timeout: 60_000 }, () => {
  // The setup git commands in these tests inherit process.env, and the host's global
  // core.hooksPath (a lefthook shim) made each commit take ~6s under load vs ~0.3s without
  // it, so the setup is isolated from the host git config for speed and hermeticity. (The
  // script under test already ignores host config via HARDENED_GIT_ENV.)
  beforeAll(() => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  });
  // The later gitIdentityConfigScript it.each block writes with `git config --global` and relies on
  // this block's env being restored first (declaration order).
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const HEADER = 'AUTHORIZATION: basic c2VjcmV0';
  // How the driver delivers the header: in the environment, never in the script.
  const run = (script: string) =>
    execFileSync('/bin/sh', ['-c', script], {
      env: { ...process.env, ASW_GIT_AUTH: HEADER },
      stdio: 'pipe',
    });

  // A working clone whose `.git/` an attacker has written to: a pre-push and a
  // reference-transaction hook that dump GIT_CONFIG_PARAMETERS (where
  // `-c http.extraheader` lives), an `insteadOf` and a `pushurl` that redirect
  // origin to an attacker remote, and an fsmonitor command.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'authed-git-'));
    const good = join(root, 'good.git');
    const evil = join(root, 'evil.git');
    git(root, 'init', '-q', '--bare', good);
    git(root, 'init', '-q', '--bare', evil);
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    git(seed, 'push', '-q', good, 'HEAD:refs/heads/main');
    const work = join(root, 'work');
    git(root, 'clone', '-q', '-b', 'main', `file://${good}`, work);
    git(work, 'checkout', '-q', '-b', 'auto/T-1');
    git(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x'
    );
    const loot = join(root, 'loot');
    const hook = `#!/bin/sh\necho "$GIT_CONFIG_PARAMETERS" >> ${loot}\n`;
    mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
    for (const name of ['pre-push', 'reference-transaction']) {
      writeFileSync(join(work, '.git', 'hooks', name), hook);
      chmodSync(join(work, '.git', 'hooks', name), 0o755);
    }
    git(work, 'config', `url.file://${evil}.insteadOf`, `file://${good}`);
    git(work, 'config', '--add', 'remote.origin.pushurl', `file://${evil}`);
    git(work, 'config', 'core.fsmonitor', `echo fsmonitor >> ${loot}; false`);
    return { evil, good, loot, work };
  };

  it('aborts instead of sending the request unauthenticated when the header is missing', () => {
    const { good, work } = setup();
    const script = authedGitScript(work, fetchBranchesSubcommand(['main']), {
      authed: true,
      cleanUrl: `file://${good}`,
    });
    expect(script).not.toContain(HEADER);
    const { [GIT_AUTH_ENV]: _unset, ...bare } = process.env;
    for (const env of [bare, { ...bare, [GIT_AUTH_ENV]: '' }]) {
      const refused = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/git credential not delivered/);
    }
  });

  it('pushes to the real remote without running a planted hook or following a redirect', () => {
    const { evil, good, loot, work } = setup();
    const script = authedGitScript(work, `push origin ${shellQuote('auto/T-1')}`, {
      authed: true,
      cleanUrl: `file://${good}`,
    });
    run(script);

    expect(existsSync(loot)).toBe(false);
    expect(git(good, 'branch', '--list', 'auto/T-1')).toContain('auto/T-1');
    expect(git(evil, 'branch', '--list')).toBe('');
    const config = readFileSync(join(work, '.git', 'config'), 'utf8');
    expect(config).not.toContain('insteadOf');
    expect(config).not.toContain('pushurl');
    expect(config).not.toContain('fsmonitor');
    // `origin` stays usable: its fetch refspec survives the rewrite.
    expect(config).toContain('fetch = +refs/heads/');
  });

  it('fetches from the real remote and still updates origin/<branch>', () => {
    const { loot, good, work } = setup();
    const script = authedGitScript(work, `fetch origin ${shellQuote('main')}`, {
      authed: true,
      cleanUrl: `file://${good}`,
    });
    run(script);
    expect(existsSync(loot)).toBe(false);
    expect(git(work, 'rev-parse', 'origin/main').trim()).toBe(
      git(good, 'rev-parse', 'main').trim()
    );
  });

  it('refuses a broken .git instead of falling back to a parent repository', () => {
    const { evil, good, loot, work } = setup();
    // A parent repository the rewrite never touches, whose config sends the
    // push to the attacker and whose history has the branch being pushed.
    const parent = join(work, '..');
    git(parent, 'init', '-q');
    git(parent, 'config', `url.file://${evil}.insteadOf`, `file://${good}`);
    git(
      parent,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'evil'
    );
    git(parent, 'branch', 'auto/T-1');
    git(parent, 'config', 'core.fsmonitor', `echo fsmonitor >> ${loot}; false`);
    // Deleting HEAD is enough to make git stop treating work/.git as a repo.
    rmSync(join(work, '.git', 'HEAD'));

    for (const sub of [
      `push origin ${shellQuote('auto/T-1')}`,
      fetchBranchesSubcommand(['main']),
    ]) {
      const script = authedGitScript(work, sub, {
        authed: true,
        cleanUrl: `file://${good}`,
      });
      expect(() => run(script)).toThrow(/not a valid repository/);
    }
    expect(git(evil, 'branch', '--list')).toBe('');
    expect(git(good, 'branch', '--list', 'auto/T-1')).toBe('');
    expect(existsSync(loot)).toBe(false);
  });

  it('fetches a non-default branch into origin/<branch> in a single-branch shallow clone', () => {
    const { good, work } = setup();
    // Publish the work branch, then take the clone every workspace starts from.
    git(good, 'branch', 'auto/T-1', 'main');
    const shallow = join(work, '..', 'shallow');
    git(join(work, '..'), 'clone', '-q', '--depth=50', '-b', 'main', `file://${good}`, shallow);

    // A bare branch name lands only in FETCH_HEAD in such a clone.
    const bare = authedGitScript(shallow, `fetch origin ${shellQuote('auto/T-1')}`, {
      cleanUrl: `file://${good}`,
    });
    run(bare);
    expect(() => git(shallow, 'rev-parse', '--verify', '-q', 'origin/auto/T-1')).toThrow();

    const script = authedGitScript(shallow, fetchBranchesSubcommand(['auto/T-1']), {
      authed: true,
      cleanUrl: `file://${good}`,
    });
    run(script);
    expect(git(shallow, 'rev-parse', 'origin/auto/T-1').trim()).toBe(
      git(good, 'rev-parse', 'auto/T-1').trim()
    );
    git(shallow, 'reset', '-q', '--hard', 'origin/auto/T-1');
  });

  it('refuses to run when .git is a gitfile pointing elsewhere', () => {
    const { good, work } = setup();
    const other = mkdtempSync(join(tmpdir(), 'authed-git-gitfile-'));
    writeFileSync(join(other, '.git'), `gitdir: ${join(work, '.git')}\n`);
    const script = authedGitScript(other, `fetch origin ${shellQuote('main')}`, {
      authed: true,
      cleanUrl: `file://${good}`,
    });
    expect(() => run(script)).toThrow();
  });
});

describe('fetchBranchesSubcommand', () => {
  it('writes a forced refspec per branch into origin/<branch>', () => {
    expect(fetchBranchesSubcommand(['main', "auto/it's"])).toBe(
      `fetch origin '+refs/heads/main:refs/remotes/origin/main' ${shellQuote(
        "+refs/heads/auto/it's:refs/remotes/origin/auto/it's"
      )}`
    );
  });
});

describe('killStrayProcessesScript', () => {
  it('adds fail-closed process verification only for an explicit setup transition', () => {
    const checked = clearSetupProcessesScript(42);
    expect(checked).toContain(killStrayProcessesScript(42));
    expect(checked).toContain('if asw_check; then exit 0; fi');
    expect(checked).toContain('workspace processes remain or cannot be inspected');
    expect(checked.trim()).toMatch(/exit 1$/);
    expect(killStrayProcessesScript(42)).not.toContain('asw_check');
    expect(clearSetupProcessesScript(42, true)).toContain('readlink "/proc/42/ns/mnt"');
  });
  // The unfiltered sweep is not executed on the host, where it could signal
  // other processes owned by the test user. The real-process test filters its
  // signals to the spawned child.
  const script = killStrayProcessesScript(42);

  it('stops everything before killing anything', () => {
    const stop = script.indexOf('asw_sweep STOP');
    expect(stop).toBeGreaterThan(0);
    expect(script.lastIndexOf('asw_sweep STOP')).toBeGreaterThan(stop);
    expect(script.lastIndexOf('asw_sweep STOP')).toBeLessThan(script.indexOf('asw_sweep KILL'));
  });

  it('spares PID 1, the keeper, and its own process tree', () => {
    expect(script).toContain(
      'if [ "$asw_p" = 1 ] || [ "$asw_p" = "$asw_keeper" ] || asw_mine "$asw_p"; then continue; fi'
    );
    expect(script).toContain('if [ "$asw_a" = "$$" ]; then return 0; fi');
  });

  it('captures the sweep mount namespace once and skips other or unreadable namespaces', () => {
    const ownNamespace = script.indexOf('asw_mnt=$(readlink "/proc/$$/ns/mnt" 2>/dev/null)');
    expect(ownNamespace).toBeGreaterThanOrEqual(0);
    expect(ownNamespace).toBeLessThan(script.indexOf('asw_sweep STOP'));
    expect(script).toContain('asw_ns=$(readlink "$asw_d/ns/mnt" 2>/dev/null) || continue');
    expect(script).toContain('[ "$asw_ns" = "$asw_mnt" ] || continue');
  });

  it.skipIf(process.platform !== 'linux')(
    'kills a real stray process in its mount namespace',
    async () => {
      const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) {
        child.kill('SIGKILL');
        throw new Error('sleep did not start');
      }

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          const timeout = setTimeout(() => resolve({ code: null, signal: null }), 5000);
          child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
        }
      );
      try {
        const script = [
          `kill() { if [ "$2" = "${pid}" ]; then command kill "$@"; fi; }`,
          killStrayProcessesScript(process.pid),
        ].join('\n');
        execFileSync('/bin/sh', ['-c', script], { timeout: 30_000 });
        expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
        }
      }
    }
  );

  it('uses the keeper pid the driver recorded, rather than inferring one', () => {
    expect(script).toContain('asw_keeper=42');
    expect(killStrayProcessesScript(99)).toContain('asw_keeper=99');
    // No /proc scan for a keeper any more: the driver supplies it.
    expect(script).not.toContain('asw_keeper=' + '$');
  });

  it.each([0, -3, 1.5, Number.NaN, 'abc' as unknown as number])(
    'rejects a keeper pid that is not a positive integer: %s',
    (pid) => {
      expect(() => killStrayProcessesScript(pid)).toThrow('keeper pid');
    }
  );

  it('is valid POSIX sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', script]);
  });
});

describe('gitBootstrapScript', () => {
  it('names the image contract without trying package managers as a non-root user', () => {
    const script = gitBootstrapScript('custom:1');
    const run = () =>
      execFileSync(
        '/bin/sh',
        [
          '-c',
          `
command() { return 1; }
id() { echo 1000; }
apk() { echo unexpected-package-install >&2; }
${script}
`,
        ],
        { stdio: 'pipe' }
      );
    try {
      run();
      throw new Error('expected the image contract to fail');
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer }).stderr);
      expect(stderr).toContain("executor image 'custom:1' must ship git for non-root workspaces");
      expect(stderr).not.toContain('unexpected-package-install');
    }
  });

  it('uses git when present, installs via apk then apt-get, else fails naming the contract', () => {
    const script = gitBootstrapScript('alpine:3.20');
    expect(script).toContain('command -v git');
    expect(script).toContain('apk add --no-cache git');
    // apt-get runs as root: the workspace drops every capability, so apt's own
    // privilege drop to _apt would fail without the sandbox override.
    expect(script).toContain('apt-get -o APT::Sandbox::User=root update');
    expect(script).toContain(
      'apt-get -o APT::Sandbox::User=root install -y --no-install-recommends git'
    );
    expect(script).toContain('apk');
    expect(script.indexOf('apk')).toBeLessThan(script.indexOf('apt-get'));
    // The failure names the image and the contract.
    expect(script).toContain("'alpine:3.20'");
    expect(script).toContain('must provide sh, git and tar');
    expect(script).toContain('exit 1');
  });

  it('is valid POSIX sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', gitBootstrapScript('node:24-alpine')]);
  });
});

describe('killTaggedProcessesScript', () => {
  it('rejects anything but a hex tag', () => {
    expect(() => killTaggedProcessesScript("abc'; rm -rf /")).toThrow();
  });

  it('stops every tagged process before killing any', () => {
    const script = killTaggedProcessesScript('00ff');
    expect(script.indexOf('asw_kill STOP')).toBeLessThan(script.indexOf('asw_kill KILL'));
    expect(script).toContain("grep -qs 'AUTO_SWE_EXEC_ID=00ff'");
  });

  it('matches a longer tag that starts with the one it kills', () => {
    // A harness turn kills every command it tagged `<turn tag><suffix>` by its own tag.
    const pattern = /grep -qs '([^']+)'/.exec(killTaggedProcessesScript('00ff'))?.[1] ?? '';
    const environ = (tag: string) => `PATH=/bin\0AUTO_SWE_EXEC_ID=${tag}\0HOME=/root\0`;
    const matches = (tag: string) =>
      spawnSync('grep', ['-qs', pattern], { input: environ(tag) }).status === 0;
    expect(matches('00ff0000000a')).toBe(true);
    expect(matches('00ff')).toBe(true);
    expect(matches('0aff00ff')).toBe(false);
  });
});

describe('createWorkspace commit identity (execShellAsync mocked)', () => {
  // The config script runs inside `docker exec … sh -c '<script>'`, so a value
  // that is `shellQuote`d in the script appears re-escaped once more outside.
  const Q = (v: string) => shellQuote(v).replace(/'/g, "'\\''");
  const URL = 'https://github.com/acme/repo.git';

  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(okExec);
    vi.mocked(resolveGitIdentity).mockReset();
    vi.mocked(resolveGitIdentity).mockResolvedValue(DEFAULT_GIT_IDENTITY);
  });

  const allCommands = () => vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
  const configValue = (key: string) =>
    allCommands().find((c) => c.includes(`config --global -- ${key} `));

  it('writes the same user.name and user.email as before when no override exists', async () => {
    const ws = await createWorkspace(URL, 'auto/T-1', 'main');
    expect(configValue('user.name')).toContain(`user.name ${Q('auto-swe')}`);
    expect(configValue('user.email')).toContain(`user.email ${Q('auto-swe@localhost')}`);
    for (const key of ['author', 'committer']) {
      expect(configValue(`${key}.name`)).toContain(`${key}.name ${Q('auto-swe')}`);
      expect(configValue(`${key}.email`)).toContain(`${key}.email ${Q('auto-swe@localhost')}`);
    }
    expect(ws.gitIdentity).toEqual(DEFAULT_GIT_IDENTITY);
    await ws.destroy();
  });

  it('resolves the identity for the repository team and writes an override verbatim', async () => {
    const identity: GitIdentity = {
      author: { email: 'ada@acme.example', name: "O'Brien" },
      committer: { email: 'bot@acme.example', name: 'Acme Bot' },
    };
    vi.mocked(resolveGitIdentity).mockResolvedValue(identity);
    const ws = await createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
      teamId: 'team-1',
    });
    expect(resolveGitIdentity).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(configValue('author.name')).toContain(`author.name ${Q("O'Brien")}`);
    expect(configValue('author.email')).toContain(`author.email ${Q('ada@acme.example')}`);
    expect(configValue('committer.name')).toContain(`committer.name ${Q('Acme Bot')}`);
    expect(configValue('user.name')).toContain(`user.name ${Q('Acme Bot')}`);
    expect(configValue('user.email')).toContain(`user.email ${Q('bot@acme.example')}`);
    expect(ws.gitIdentity).toBe(identity);
    await ws.destroy();
  });

  it('resolves from the global tier when the caller has no team', async () => {
    const ws = await createWorkspace(URL, 'auto/T-1', 'main');
    expect(resolveGitIdentity).toHaveBeenCalledWith({ teamId: null });
    await ws.destroy();
  });

  it('quotes a name that is a shell command so it cannot run in the container', async () => {
    const hostile = '$(touch /tmp/x)';
    vi.mocked(resolveGitIdentity).mockResolvedValue({
      author: { email: 'a@x.example', name: hostile },
      committer: { email: 'a@x.example', name: hostile },
    });
    const ws = await createWorkspace(URL, 'auto/T-1', 'main');
    expect(configValue('user.name')).toContain(`user.name ${Q(hostile)}`);
    await ws.destroy();
  });

  it('ends git option parsing before every key it writes', () => {
    const commands = gitIdentityConfigScript(DEFAULT_GIT_IDENTITY).split(' && ');
    expect(commands).toHaveLength(6);
    for (const command of commands) {
      expect(command).toMatch(/^git config --global -- (user|author|committer)\.(name|email) '/);
    }
  });

  it.each(['--amend', '-x', '--unset'])(
    'stores a name of %s as a value, not a git option',
    (name) => {
      const home = mkdtempSync(join(tmpdir(), 'gitident-home-'));
      try {
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: home };
        const script = gitIdentityConfigScript({
          author: { email: 'a@x.example', name },
          committer: { email: 'c@x.example', name },
        });
        execFileSync('sh', ['-c', script], { env });
        const read = (key: string) =>
          execFileSync('git', ['config', '--global', key], { env }).toString().trim();
        expect(read('user.name')).toBe(name);
        expect(read('author.name')).toBe(name);
        expect(read('committer.name')).toBe(name);
        expect(read('user.email')).toBe('c@x.example');
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    }
  );

  it('fails before any container exists when the identity cannot be resolved', async () => {
    vi.mocked(resolveGitIdentity).mockRejectedValue(new Error('connection reset'));
    await expect(createWorkspace(URL, 'auto/T-1', 'main')).rejects.toThrow('connection reset');
    expect(allCommands().some((c) => c.includes('docker run'))).toBe(false);
  });
});

describe('createWorkspace on-demand tools (execShellAsync mocked)', () => {
  const URL = 'https://github.com/acme/repo.git';
  const sha256 = 'a'.repeat(64);
  const catalog = [
    {
      archs: {
        amd64: { sha256, url: 'https://example.test/just-amd64.tar.gz' },
        arm64: { sha256, url: 'https://example.test/just-arm64.tar.gz' },
      },
      key: 'just',
      libc: 'any' as const,
      member: 'just',
      status: 'ACTIVE' as const,
      version: '1.40.0',
    },
  ];

  beforeEach(() => {
    vi.mocked(resolveGitIdentity).mockReset();
    vi.mocked(resolveGitIdentity).mockResolvedValue(DEFAULT_GIT_IDENTITY);
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) =>
      cmd.includes('echo "$PATH"') ? '/usr/local/bin:/usr/bin\n' : okExec(cmd)
    );
  });

  // The next describe asserts nothing ran, so leave no recorded calls behind.
  afterEach(() => vi.mocked(execShellAsync).mockClear());

  const allCommands = () => vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

  it('installs requested tools after the clone and puts them last on PATH for agent execs', async () => {
    const ws = await createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
      toolCatalog: catalog,
      tools: [{ key: 'just' }],
    });
    const commands = allCommands();
    const clone = commands.findIndex((c) => c.includes('git') && c.includes(' clone '));
    const install = commands.findIndex((c) => c.includes('auto-swe tool install'));
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(clone);

    await ws.exec('just --version');
    const exec = allCommands().at(-1) as string;
    expect(exec).toContain('PATH=/usr/local/bin:/usr/bin:/workspace/.tools/bin');
    await ws.destroy();
  });

  it('puts the tools dir LAST on PATH, so a planted git or sh can never shadow the image binary', async () => {
    const ws = await createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
      toolCatalog: catalog,
      tools: [{ key: 'just' }],
    });
    await ws.exec('git status');
    const exec = allCommands().at(-1) as string;
    const pair = exec.match(/PATH=\S+/)?.[0] as string;
    // The agent can write `/workspace/.tools/bin/git`; the image's own directories are searched first.
    expect(pair).toBe('PATH=/usr/local/bin:/usr/bin:/workspace/.tools/bin');
    expect(pair.endsWith(':/workspace/.tools/bin')).toBe(true);
    expect(pair.startsWith('PATH=/workspace/.tools/bin')).toBe(false);
    await ws.destroy();
  });

  it('installs tools before the egress lock, which a blocked policy applies afterwards', async () => {
    const lock = vi.spyOn(dockerWorkspaceBackend(), 'lockEgress').mockResolvedValue();
    const ws = await createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
      egressPolicy: 'blocked',
      toolCatalog: catalog,
      tools: [{ key: 'just' }],
    });
    const calls = vi.mocked(execShellAsync).mock.calls;
    const install = calls.findIndex((c) => (c[0] as string).includes('auto-swe tool install'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(lock).toHaveBeenCalledOnce();
    expect(vi.mocked(execShellAsync).mock.invocationCallOrder[install]).toBeLessThan(
      lock.mock.invocationCallOrder[0] as number
    );
    lock.mockRestore();
    await ws.destroy();
  });

  it('changes nothing for a workspace that requests no tools', async () => {
    const ws = await createWorkspace(URL, 'auto/T-1', 'main');
    await ws.exec('true');
    expect(allCommands().some((c) => c.includes('auto-swe tool install'))).toBe(false);
    expect(allCommands().at(-1)).not.toContain('PATH=');
    await ws.destroy();
  });

  it('fails creation and removes the container when a requested tool is not in the catalog', async () => {
    await expect(
      createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
        toolCatalog: catalog,
        tools: [{ key: 'python' }],
      })
    ).rejects.toThrow(/not in the tool catalog/);
    expect(allCommands().some((c) => c.includes('docker rm'))).toBe(true);
  });

  it('fails creation when the install script fails', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('auto-swe tool install')) {
        throw new Error('just@1.40.0: checksum mismatch');
      }
      return okExec(cmd);
    });
    await expect(
      createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
        toolCatalog: catalog,
        tools: [{ key: 'just' }],
      })
    ).rejects.toThrow('checksum mismatch');
  });
});

describe('createWorkspace catalog tools for a connection (execShellAsync mocked)', () => {
  const URL = 'https://github.com/acme/repo.git';
  const sha256 = 'a'.repeat(64);
  const row = {
    archs: {
      amd64: { sha256, url: 'https://example.test/just-amd64.tar.gz' },
      arm64: { sha256, url: 'https://example.test/just-arm64.tar.gz' },
    },
    key: 'just',
    libc: 'any',
    member: 'just',
    status: 'ACTIVE',
    version: '1.40.0',
  };
  const TOOLS_YML = 'version: 1\ntools:\n  - key: just\n';

  const setting = (enabled: boolean, maxTools = 8) =>
    resolveSettingsMock.mockResolvedValue({
      'workspace.toolInstall.enabled': enabled,
      'workspace.toolInstall.maxTools': maxTools,
    });
  const connection = (over: Record<string, unknown> = {}) =>
    connectionFindUniqueMock.mockResolvedValue({
      tools: null,
      toolsDeny: [],
      toolsFileEnabled: false,
      ...over,
    });
  /** The tools file as the container would print it for `git show <ref>:path`; null = absent. */
  let fileText: string | null;

  beforeEach(() => {
    resetToolCatalogCache();
    vi.mocked(resolveGitIdentity).mockReset();
    vi.mocked(resolveGitIdentity).mockResolvedValue(DEFAULT_GIT_IDENTITY);
    catalogFindManyMock.mockReset();
    catalogFindManyMock.mockResolvedValue([row]);
    connectionFindUniqueMock.mockReset();
    persistTraceMock.mockReset();
    persistTraceMock.mockResolvedValue(true);
    setting(true);
    connection();
    fileText = null;
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('echo "$PATH"')) {
        return '/usr/local/bin:/usr/bin\n';
      }
      if (cmd.includes('git cat-file -s')) {
        return fileText === null ? 'absent\n' : `present\n${fileText}`;
      }
      return okExec(cmd);
    });
  });

  afterEach(() => vi.mocked(execShellAsync).mockClear());

  const allCommands = () => vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
  const installed = () => allCommands().some((c) => c.includes('auto-swe tool install'));
  const removed = () => allCommands().some((c) => c.includes('docker rm'));
  const create = (
    over: { checkoutSha?: string; existingBranch?: boolean } = {},
    options: Parameters<typeof createWorkspace>[6] = { toolsFor: { connectionId: 'c1' } }
  ) =>
    createWorkspace(
      URL,
      'auto/T-1',
      'main',
      undefined,
      over.checkoutSha,
      over.existingBranch,
      options
    );
  const failureOf = async (
    p: Promise<unknown>
  ): Promise<Error & { nonRetryable?: boolean; type?: string }> => {
    try {
      await p;
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected createWorkspace to reject');
  };

  it('installs nothing and reads nothing when the setting is off', async () => {
    setting(false);
    connection({ tools: [{ key: 'just' }], toolsFileEnabled: true });
    fileText = TOOLS_YML;
    const ws = await create();
    expect(installed()).toBe(false);
    expect(ws.installedTools).toEqual([]);
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c.includes('git cat-file'))).toBe(false);
    await ws.destroy();
  });

  it('installs the connection admin list when the setting is on', async () => {
    connection({ tools: [{ key: 'just' }] });
    const ws = await create();
    expect(installed()).toBe(true);
    expect(ws.installedTools).toEqual([{ key: 'just', version: '1.40.0' }]);
    await ws.exec('just --version');
    expect(allCommands().at(-1)).toContain('PATH=/usr/local/bin:/usr/bin:/workspace/.tools/bin');
    await ws.destroy();
  });

  it('installs a tool declared by the file, read from HEAD right after the clone', async () => {
    connection({ toolsFileEnabled: true });
    fileText = TOOLS_YML;
    const ws = await create();
    const commands = allCommands();
    const clone = commands.findIndex((c) => c.includes(' clone '));
    const read = commands.findIndex((c) => c.includes('git cat-file -s'));
    expect(read).toBeGreaterThan(clone);
    expect(commands[read]).toMatch(/HEAD:\.auto-swe\/tools\.yml/);
    expect(commands[read]).not.toContain('target-repo/.auto-swe');
    expect(ws.installedTools?.map((t) => t.key)).toEqual(['just']);
    await ws.destroy();
  });

  it('reads the pinned sha, not the working tree, on the checkoutSha path', async () => {
    connection({ toolsFileEnabled: true });
    fileText = TOOLS_YML;
    const ws = await create({ checkoutSha: 'abc1234' });
    const read = allCommands().find((c) => c.includes('git cat-file -s')) as string;
    expect(read).toMatch(/abc1234:\.auto-swe\/tools\.yml/);
    expect(read).not.toMatch(/HEAD:\.auto-swe/);
    await ws.destroy();
  });

  it('fetches the default branch and reads FETCH_HEAD when the clone holds a candidate branch', async () => {
    connection({ toolsFileEnabled: true });
    fileText = TOOLS_YML;
    const ws = await create({ existingBranch: true });
    const commands = allCommands();
    const fetch = commands.findIndex((c) => /fetch --depth=1 origin/.test(c));
    const read = commands.findIndex((c) => c.includes('git cat-file -s'));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(fetch);
    expect(commands[read]).toMatch(/FETCH_HEAD:\.auto-swe\/tools\.yml/);
    await ws.destroy();
  });

  it('never reads a tools file from the agent branch: every read names a base ref', async () => {
    connection({ toolsFileEnabled: true });
    fileText = null;
    const ws = await create({ existingBranch: true });
    expect(installed()).toBe(false);
    const reads = allCommands().filter((c) => c.includes('tools.yml'));
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) {
      expect(c).toMatch(/FETCH_HEAD:\.auto-swe\/tools\.yml/);
      expect(c).not.toMatch(/\bcat\s[^|]*tools\.yml/);
    }
    await ws.destroy();
  });

  it('ignores the file when the connection has not enabled it', async () => {
    connection({ toolsFileEnabled: false });
    fileText = TOOLS_YML;
    const ws = await create();
    expect(installed()).toBe(false);
    expect(allCommands().some((c) => c.includes('git cat-file'))).toBe(false);
    await ws.destroy();
  });

  it('lets the deny list win over the admin list and the file', async () => {
    connection({ tools: [{ key: 'just' }], toolsDeny: ['just'], toolsFileEnabled: true });
    fileText = TOOLS_YML;
    const ws = await create();
    expect(installed()).toBe(false);
    expect(ws.installedTools).toEqual([]);
    await ws.destroy();
  });

  it('fails creation when more tools are declared than workspace.toolInstall.maxTools allows', async () => {
    setting(true, 1);
    connection({ tools: [{ key: 'just' }, { key: 'jq' }] });
    const err = await failureOf(create());
    expect(err.message).toMatch(/at most 1/);
    expect(err.nonRetryable).toBe(true);
    expect(installed()).toBe(false);
    expect(removed()).toBe(true);
  });

  it('fails non-retryably, removing the container, when a declared key is unknown', async () => {
    connection({ tools: [{ key: 'python' }] });
    const err = await failureOf(create());
    expect(err.message).toMatch(/'python' is not in the tool catalog/);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe('TOOL_INSTALL_FAILED');
    expect(removed()).toBe(true);
  });

  it('surfaces a retryable download failure as a plain, retryable error naming the tool', async () => {
    connection({ tools: [{ key: 'just' }] });
    const base = vi.mocked(execShellAsync).getMockImplementation() as (
      c: string
    ) => Promise<string>;
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('auto-swe tool install')) {
        throw Object.assign(new Error('Command failed'), {
          code: 75,
          stderr:
            'auto-swe tool install: just@1.40.0: download failed from https://example.test/x\n',
        });
      }
      return base(cmd);
    });
    const err = await failureOf(create());
    expect(err.message).toContain('just@1.40.0: download failed');
    expect(err.nonRetryable).toBeUndefined();
    expect(removed()).toBe(true);
  });

  it('fails closed when the catalog cannot be read: no fallback to the built-in table', async () => {
    connection({ tools: [{ key: 'just' }] });
    catalogFindManyMock.mockRejectedValue(new Error('connection refused'));
    const err = await failureOf(create());
    expect(err.message).toMatch(/tool catalog is unreadable/);
    expect(err.nonRetryable).toBeUndefined();
    expect(installed()).toBe(false);
    expect(removed()).toBe(true);
  });

  it('refuses a revoked row, and installs a deprecated one with a warning', async () => {
    connection({ tools: [{ key: 'just', version: '1.40.0' }] });
    catalogFindManyMock.mockResolvedValue([{ ...row, status: 'REVOKED' }]);
    const err = await failureOf(create());
    expect(err.message).toMatch(/revoked/);
    expect(installed()).toBe(false);

    resetToolCatalogCache();
    catalogFindManyMock.mockResolvedValue([{ ...row, status: 'DEPRECATED' }]);
    const ws = await create();
    expect(ws.installedTools?.[0]?.warning).toMatch(/deprecated/);
    await ws.destroy();
  });

  it('merges explicit options.tools with what the connection declares, once per key', async () => {
    connection({ tools: [{ key: 'just' }] });
    const ws = await create({}, { tools: [{ key: 'just' }], toolsFor: { connectionId: 'c1' } });
    expect(ws.installedTools).toHaveLength(1);
    await ws.destroy();
  });

  it('records a workspace.tools_installed event, and a failure records it with the error', async () => {
    connection({ tools: [{ key: 'just' }] });
    const ws = await create();
    expect(persistTraceMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persistTraceMock.mock.calls[0]?.[0])).toContain(
      'workspace.tools_installed'
    );
    await ws.destroy();

    persistTraceMock.mockClear();
    connection({ tools: [{ key: 'python' }] });
    await failureOf(create());
    expect(persistTraceMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persistTraceMock.mock.calls[0]?.[0])).toContain(
      'not in the tool catalog'
    );
  });

  it('redacts the clone credential from the failure recorded in the trace', async () => {
    connection({ tools: [{ key: 'just' }] });
    const base = vi.mocked(execShellAsync).getMockImplementation() as (
      c: string
    ) => Promise<string>;
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('auto-swe tool install')) {
        throw new Error('just@1.40.0: curl failed for ghp_SECRETTOKEN123 at the proxy');
      }
      return base(cmd);
    });
    const err = await failureOf(
      createWorkspace(
        'https://x-access-token:ghp_SECRETTOKEN123@github.com/acme/repo.git',
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        { toolsFor: { connectionId: 'c1' } }
      )
    );
    expect(err.message).not.toContain('ghp_SECRETTOKEN123');
    expect(persistTraceMock).toHaveBeenCalledTimes(1);
    const recorded = JSON.stringify(persistTraceMock.mock.calls[0]?.[0]);
    expect(recorded).toContain('curl failed for');
    expect(recorded).not.toContain('ghp_SECRETTOKEN123');
  });

  it('never fails creation because the trace could not be written', async () => {
    connection({ tools: [{ key: 'just' }] });
    persistTraceMock.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = await create();
    expect(ws.installedTools).toHaveLength(1);
    await ws.destroy();
  });
});

describe('Workspace.installTools: an agent-requested install (execShellAsync mocked)', () => {
  const URL = 'https://github.com/acme/repo.git';
  const sha256 = 'a'.repeat(64);
  const entry = (key: string) => ({
    archs: {
      amd64: { sha256, url: `https://example.test/${key}-amd64.tar.gz` },
      arm64: { sha256, url: `https://example.test/${key}-arm64.tar.gz` },
    },
    key,
    libc: 'any' as const,
    member: key,
    status: 'ACTIVE' as const,
    version: '1.0.0',
  });
  const toolCatalog = [entry('just'), entry('jq')];
  const PATH_PAIR = 'PATH=/usr/local/bin:/usr/bin:/workspace/.tools/bin';

  const setting = (enabled: boolean, maxTools = 8) =>
    resolveSettingsMock.mockResolvedValue({
      'workspace.toolInstall.enabled': enabled,
      'workspace.toolInstall.maxTools': maxTools,
    });

  beforeEach(() => {
    vi.mocked(resolveGitIdentity).mockReset();
    vi.mocked(resolveGitIdentity).mockResolvedValue(DEFAULT_GIT_IDENTITY);
    persistTraceMock.mockReset();
    persistTraceMock.mockResolvedValue(true);
    connectionFindUniqueMock.mockReset();
    connectionFindUniqueMock.mockResolvedValue({
      tools: null,
      toolsDeny: [],
      toolsFileEnabled: false,
    });
    setting(true);
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) =>
      cmd.includes('echo "$PATH"') ? '/usr/local/bin:/usr/bin\n' : okExec(cmd)
    );
    vi.mocked(spawnWithStdinAsync).mockReset();
    vi.mocked(spawnWithStdinAsync).mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
  });

  afterEach(() => vi.mocked(execShellAsync).mockClear());

  const allCommands = () => vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
  const installScripts = () => allCommands().filter((c) => c.includes('auto-swe tool install'));
  const create = (withTools = true) =>
    createWorkspace(
      URL,
      'auto/T-1',
      'main',
      undefined,
      undefined,
      undefined,
      withTools ? { toolCatalog, toolsFor: { connectionId: 'c1' } } : { toolCatalog }
    );
  const lastCommand = () => allCommands().at(-1) as string;

  it('is defined only for a workspace created with toolsFor', async () => {
    const without = await create(false);
    expect(without.installTools).toBeUndefined();
    await without.destroy();
    const withFor = await create();
    expect(typeof withFor.installTools).toBe('function');
    await withFor.destroy();
  });

  it('starts applying PATH to exec, execCapture and execStdin after a late install, but never to gitAuthed', async () => {
    const ws = await create();
    expect(ws.installedTools).toEqual([]);
    await ws.exec('true');
    expect(lastCommand()).not.toContain('PATH=');

    const result = await ws.installTools?.([{ key: 'just' }]);
    expect(result).toEqual([{ key: 'just', version: '1.0.0' }]);
    expect(ws.installedTools).toEqual([{ key: 'just', version: '1.0.0' }]);

    await ws.exec('just --version');
    expect(lastCommand()).toContain(PATH_PAIR);

    vi.mocked(execShellAsync).mockClear();
    vi.mocked(spawnWithStdinAsync).mockClear();
    vi.mocked(spawnCaptureAsync).mockClear();
    await ws.execCapture('just --version');
    await ws.execStdin('cat > x', 'data');
    const via = [
      ...vi.mocked(spawnCaptureAsync).mock.calls.map((c) => (c[1] as string[]).join(' ')),
      ...vi.mocked(spawnWithStdinAsync).mock.calls.map((c) => (c[1] as string[]).join(' ')),
      ...allCommands(),
    ];
    expect(via.filter((s) => s.includes(PATH_PAIR))).toHaveLength(2);
    expect(via).toHaveLength(2);

    vi.mocked(execShellAsync).mockClear();
    await ws.gitAuthed('status');
    expect(lastCommand()).not.toContain('PATH=');
    await ws.destroy();
  });

  it('installs only the new entry on a second call and keeps the earlier one', async () => {
    const ws = await create();
    await ws.installTools?.([{ key: 'just' }]);
    expect(installScripts()).toHaveLength(1);
    expect(installScripts()[0]).toContain('just-amd64');

    await ws.installTools?.([{ key: 'just' }, { key: 'jq' }]);
    expect(installScripts()).toHaveLength(2);
    expect(installScripts()[1]).toContain('jq-amd64');
    expect(installScripts()[1]).not.toContain('just-amd64');
    expect(ws.installedTools?.map((t) => t.key)).toEqual(['just', 'jq']);

    // Everything already there: nothing runs.
    await ws.installTools?.([{ key: 'jq' }]);
    expect(installScripts()).toHaveLength(2);
    await ws.destroy();
  });

  it('records a workspace.tools_installed event for the late install', async () => {
    const ws = await create();
    persistTraceMock.mockClear();
    await ws.installTools?.([{ key: 'just' }]);
    expect(persistTraceMock).toHaveBeenCalledTimes(1);
    await ws.destroy();
  });

  it('refuses a denied key, and does not change PATH when nothing was installed', async () => {
    connectionFindUniqueMock.mockResolvedValue({
      tools: null,
      toolsDeny: ['just'],
      toolsFileEnabled: false,
    });
    const ws = await create();
    await expect(ws.installTools?.([{ key: 'just' }])).rejects.toThrow(/denied/);
    await ws.exec('true');
    expect(lastCommand()).not.toContain('PATH=');
    expect(installScripts()).toHaveLength(0);
    await ws.destroy();
  });

  it('enforces the per-run cap across creation and late installs', async () => {
    setting(true, 1);
    connectionFindUniqueMock.mockResolvedValue({
      tools: [{ key: 'just' }],
      toolsDeny: [],
      toolsFileEnabled: false,
    });
    const ws = await create();
    expect(ws.installedTools?.map((t) => t.key)).toEqual(['just']);
    await expect(ws.installTools?.([{ key: 'jq' }])).rejects.toThrow(/limit of 1/);
    await ws.destroy();
  });

  it('serialises concurrent installs: with one free slot exactly one succeeds', async () => {
    setting(true, 1);
    const ws = await create();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = vi.mocked(execShellAsync).getMockImplementation() as (
      c: string
    ) => Promise<string>;
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('auto-swe tool install')) {
        await gate;
      }
      return base(cmd);
    });
    const first = ws.installTools?.([{ key: 'just' }]) as Promise<unknown>;
    const second = ws.installTools?.([{ key: 'jq' }]) as Promise<unknown>;
    // Let both reach the cap check (or, without the queue, both pass it) before the gate opens.
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(String((settled[1] as PromiseRejectedResult).reason)).toMatch(/limit of 1/);
    expect(installScripts()).toHaveLength(1);
    expect(ws.installedTools?.map((t) => t.key)).toEqual(['just']);
    await ws.destroy();
  });

  it('stops running installers after max(3, maxTools) failed attempts, non-retryably', async () => {
    setting(true, 1);
    const ws = await create();
    const base = vi.mocked(execShellAsync).getMockImplementation() as (
      c: string
    ) => Promise<string>;
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('auto-swe tool install')) {
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stderr: 'auto-swe tool install: just@1.0.0: checksum mismatch\n',
        });
      }
      return base(cmd);
    });
    for (let i = 0; i < 3; i++) {
      await expect(ws.installTools?.([{ key: 'just' }])).rejects.toThrow(/checksum mismatch/);
    }
    expect(installScripts()).toHaveLength(3);
    const err = await requireInstallTools(ws)([{ key: 'just' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolRefusal);
    expect((err as ToolRefusal).message).toBe('too many failed install attempts in this workspace');
    expect((err as ToolRefusal).retryable).toBe(false);
    expect(installScripts()).toHaveLength(3);
    await ws.destroy();
  });

  it('does not count refusals toward the failed-attempt cap', async () => {
    connectionFindUniqueMock.mockResolvedValue({
      tools: null,
      toolsDeny: ['just'],
      toolsFileEnabled: false,
    });
    const ws = await create();
    for (let i = 0; i < 5; i++) {
      await expect(ws.installTools?.([{ key: 'just' }])).rejects.toThrow(/denied/);
    }
    await expect(ws.installTools?.([{ key: 'jq' }])).resolves.toHaveLength(1);
    await ws.destroy();
  });

  it('refuses an agent pinning a deprecated catalog row, while creation still installs one', async () => {
    const deprecated = { ...entry('old'), status: 'DEPRECATED' as const };
    const ws = await createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
      toolCatalog: [deprecated],
      toolsFor: { connectionId: 'c1' },
    });
    const err = await requireInstallTools(ws)([{ key: 'old', version: '1.0.0' }]).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ToolRefusal);
    expect((err as ToolRefusal).message).toMatch(/'old@1\.0\.0' is deprecated/);
    expect(installScripts()).toHaveLength(0);
    await ws.destroy();

    connectionFindUniqueMock.mockResolvedValue({
      tools: [{ key: 'old', version: '1.0.0' }],
      toolsDeny: [],
      toolsFileEnabled: false,
    });
    const atCreation = await createWorkspace(
      URL,
      'auto/T-1',
      'main',
      undefined,
      undefined,
      undefined,
      {
        toolCatalog: [deprecated],
        toolsFor: { connectionId: 'c1' },
      }
    );
    expect(atCreation.installedTools?.[0]?.warning).toMatch(/deprecated/);
    await atCreation.destroy();
  });

  describe('under an egress policy that locks the network', () => {
    const createUnder = (egressPolicy: 'open' | 'blocked' | 'restricted') =>
      createWorkspace(URL, 'auto/T-1', 'main', undefined, undefined, undefined, {
        egressPolicy,
        toolCatalog,
        toolsFor: { connectionId: 'c1' },
      });

    it.each(['blocked', 'restricted'] as const)(
      'refuses a late install under %s without running an installer',
      async (egressPolicy) => {
        const lock = vi.spyOn(dockerWorkspaceBackend(), 'lockEgress').mockResolvedValue();
        const ws = await createUnder(egressPolicy);
        const err = await requireInstallTools(ws)([{ key: 'just' }]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ToolRefusal);
        expect((err as ToolRefusal).message).toBe(
          `tool installs after workspace start are unavailable under the ${egressPolicy} egress policy`
        );
        expect((err as ToolRefusal).retryable).toBe(false);
        expect(installScripts()).toHaveLength(0);
        lock.mockRestore();
        await ws.destroy();
      }
    );

    it('still installs under open', async () => {
      const ws = await createUnder('open');
      await expect(ws.installTools?.([{ key: 'just' }])).resolves.toEqual([
        { key: 'just', version: '1.0.0' },
      ]);
      expect(installScripts()).toHaveLength(1);
      await ws.destroy();
    });
  });
});

describe('createWorkspace service image allowlist', () => {
  it('rejects a service image absent from the team allowlist before creating a workspace', async () => {
    teamFindUniqueMock.mockResolvedValueOnce({ shellImageAllowlist: [] } as never);

    await expect(
      createWorkspace(
        'https://github.com/acme/repo.git',
        'auto/T-1',
        'main',
        undefined,
        undefined,
        undefined,
        {
          services: [{ image: 'mirror.gcr.io/library/postgres:18', name: 'postgres' }],
          teamId: 'team-a',
        }
      )
    ).rejects.toThrow(/not on the shell-step allowlist/i);

    expect(execShellAsync).not.toHaveBeenCalled();
  });
});
