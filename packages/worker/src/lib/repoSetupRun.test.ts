import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'fs' as 's3' | 'fs' | 'pg',
  cacheRow: null as null | { artifactId: string; cacheKey: string },
  settings: { 'workspace.repoSetupStackDefaults': false, 'workspace.setupCacheMaxMb': 1 } as Record<
    string,
    unknown
  >,
}));

const cache = vi.hoisted(() => ({
  delete: vi.fn(async () => ({})),
  findMany: vi.fn(async () => [] as Array<{ artifactId: string; id: string }>),
  findUnique: vi.fn(async () => h.cacheRow),
  update: vi.fn(async () => ({})),
  upsert: vi.fn(async () => ({})),
}));
const artifacts = vi.hoisted(() => ({
  deleteArtifact: vi.fn(async () => {}),
  getArtifact: vi.fn(async () => ({ body: Buffer.from('tgz'), ref: {} })),
  putArtifact: vi.fn(async () => ({ id: 'art-new', sizeBytes: 3 })),
}));

const setupSecrets = vi.hoisted(() => ({
  findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
}));
type TeamSecretRow = {
  grants: string[];
  name: string;
  teamId: string;
  valueAuthTag: Buffer;
  valueCiphertext: Buffer;
  valueKeyVersion: number;
  valueNonce: Buffer;
};
const teamData = vi.hoisted(() => ({
  connection: null as null | {
    team: { id: string; isActive: boolean; organization?: { isActive: boolean } } | null;
    teamId: string | null;
  },
  secrets: [] as TeamSecretRow[],
}));
const teamSecrets = vi.hoisted(() => ({
  // Evaluates the filter the loader sends, so a query that dropped a condition fails a test.
  findMany: vi.fn(
    async (args: {
      where: { grants: { some: { connectionId: string } }; name: { in: string[] }; teamId: string };
    }) =>
      teamData.secrets.filter(
        (r) =>
          r.teamId === args.where.teamId &&
          args.where.name.in.includes(r.name) &&
          r.grants.includes(args.where.grants.some.connectionId)
      )
  ),
}));
const connections = vi.hoisted(() => ({ findUnique: vi.fn(async () => teamData.connection) }));
const deniedCall = vi.hoisted(() => ({
  findFirst: vi.fn(async (): Promise<{ host: string } | null> => null),
}));
vi.mock('./activityContext.js', () => ({
  currentWorkflowId: () => 'workflow',
  currentWorkflowRunId: async () => 'run',
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: connections,
    repoSetupSecret: setupSecrets,
    team: { findUnique: vi.fn(async () => null) },
    teamSecret: teamSecrets,
    workflowHttpCall: deniedCall,
    workspaceSetupCache: cache,
  },
}));
vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: ({ ciphertext }: { ciphertext: Buffer }) => {
    if (ciphertext.toString() === 'corrupt') {
      throw new Error('auth tag mismatch');
    }
    return `plain-${ciphertext.toString()}`;
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => h.settings[key]),
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => artifacts);
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveStorageConfig: () => ({ writeBackend: h.backend }),
}));
vi.mock('./config/contextLookup.js', () => ({ currentRequestContext: vi.fn(async () => ({})) }));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import type { RepoSetup } from '@auto-swe/shared/lib/repoSetup';
import type { CapturedResult } from './execUtils.js';
import {
  fetchSubmodules,
  loadSetupSecrets,
  parseGitmodules,
  type RepoSetupHost,
  readSetupFile,
  resolveWorkspaceSetup,
  runSetupGitPhase,
  runSetupStepsPhase,
  secretScanNeedles,
  submoduleRepo,
  sweepSetupCaches,
  WORKSPACE_SETUP_FAILED,
} from './repoSetupRun.js';

const PARENT = 'https://github.com/acme/app.git';

function fakeHost(over: Partial<RepoSetupHost> = {}) {
  const ok: CapturedResult = { exitCode: 0, stderr: '', stdout: '' };
  const host = {
    capture: vi.fn(async (_cmd: string, _opts: unknown) => ok),
    git: vi.fn(async () => ''),
    mintCredential: vi.fn(async (org: string, repo: string) => ({
      authHeader: `AUTHORIZATION: basic ${org}-${repo}`,
      cleanUrl: `https://github.com/${org}/${repo}.git`,
    })),
    readFile: vi.fn(async () => Buffer.from('tgz')),
    redact: (t: string) => t.replaceAll('sekret', '[REDACTED]'),
    root: vi.fn(async () => ''),
    stdin: vi.fn(async () => {}),
    sweepProcesses: vi.fn(async () => {}),
    ...over,
  };
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.backend = 'fs';
  h.cacheRow = null;
  h.settings['workspace.setupCacheMaxMb'] = 1;
  h.settings['workspace.repoSetupStackDefaults'] = false;
});

const LFS_FILTER =
  "-c 'filter.lfs.clean=git-lfs clean -- %f' -c 'filter.lfs.smudge=git-lfs smudge -- %f' -c 'filter.lfs.process=git-lfs filter-process' -c 'filter.lfs.required=true' ";

describe('submoduleRepo', () => {
  it('resolves relative, absolute and scp-style URLs on the same host', () => {
    expect(submoduleRepo('../lib.git', PARENT, 'github.com')).toEqual({
      organizationName: 'acme',
      repoName: 'lib',
    });
    expect(submoduleRepo('https://github.com/other/kit', PARENT, 'github.com')).toEqual({
      organizationName: 'other',
      repoName: 'kit',
    });
    expect(submoduleRepo('git@github.com:acme/proto.git', PARENT, 'github.com')).toEqual({
      organizationName: 'acme',
      repoName: 'proto',
    });
  });

  it('refuses another host, plain http, embedded credentials and odd shapes', () => {
    expect(submoduleRepo('https://evil.example/acme/lib.git', PARENT, 'github.com')).toHaveProperty(
      'error'
    );
    expect(submoduleRepo('http://github.com/acme/lib.git', PARENT, 'github.com')).toHaveProperty(
      'error'
    );
    expect(
      submoduleRepo('https://u:p@github.com/acme/lib.git', PARENT, 'github.com')
    ).toHaveProperty('error');
    expect(submoduleRepo('https://github.com/acme/lib/extra', PARENT, 'github.com')).toHaveProperty(
      'error'
    );
    expect(submoduleRepo('file:///etc', PARENT, 'github.com')).toHaveProperty('error');
    expect(submoduleRepo('../../../x.git', PARENT, 'github.com')).toHaveProperty('error');
  });
});

describe('parseGitmodules', () => {
  it('groups path and url by submodule name, names with dots included', () => {
    expect(
      parseGitmodules(
        'submodule.lib.path\nvendor/lib\0submodule.lib.url\n../lib.git\0submodule.a.b.url\nx\0'
      )
    ).toEqual([
      { name: 'lib', path: 'vendor/lib', url: '../lib.git' },
      { name: 'a.b', url: 'x' },
    ]);
  });
});

describe('fetchSubmodules', () => {
  it('mints a credential per submodule repository and pins its URL before fetching', async () => {
    const host = fakeHost({
      root: vi.fn(async (cmd: string) =>
        cmd.includes('--get-regexp') && cmd.startsWith("cd '/workspace/target-repo' ")
          ? 'submodule.lib.path\nvendor/lib\0submodule.lib.url\n../lib.git\0'
          : ''
      ),
    });
    await expect(fetchSubmodules(host, 'recursive', PARENT, 'github.com')).resolves.toEqual([
      {
        authHeader: 'AUTHORIZATION: basic acme-lib',
        cleanUrl: 'https://github.com/acme/lib.git',
        dir: '/workspace/target-repo/vendor/lib',
      },
    ]);
    expect(host.mintCredential).toHaveBeenCalledWith('acme', 'lib');
    const pin = vi
      .mocked(host.root)
      .mock.calls.map((c) => String(c[0]))
      .find((c) => c.includes('.url'));
    expect(pin).toContain("'https://github.com/acme/lib.git'");
    expect(pin).toContain('update');
    expect(host.git).toHaveBeenCalledWith(
      '/workspace/target-repo',
      expect.stringContaining("submodule update --init --depth=1 -- 'vendor/lib'"),
      'AUTHORIZATION: basic acme-lib',
      expect.any(Number)
    );
    // Recursive: the submodule's own .gitmodules was listed.
    expect(vi.mocked(host.root).mock.calls.some((c) => String(c[0]).includes('vendor/lib'))).toBe(
      true
    );
  });

  it('refuses a submodule on another host without minting anything', async () => {
    const host = fakeHost({
      root: vi.fn(async () => 'submodule.x.path\nx\0submodule.x.url\nhttps://gitlab.com/a/x.git\0'),
    });
    await expect(fetchSubmodules(host, true, PARENT, 'github.com')).rejects.toMatchObject({
      type: WORKSPACE_SETUP_FAILED,
    });
    expect(host.mintCredential).not.toHaveBeenCalled();
    expect(host.git).not.toHaveBeenCalled();
  });

  it('refuses a submodule path that climbs out of the checkout', async () => {
    const host = fakeHost({
      root: vi.fn(async () => 'submodule.x.path\n../x\0submodule.x.url\n../x.git\0'),
    });
    await expect(fetchSubmodules(host, true, PARENT, 'github.com')).rejects.toThrow(/unsafe path/);
  });

  it('fails clearly when no credential can be minted for the submodule', async () => {
    const host = fakeHost({
      mintCredential: vi.fn(async () => {
        throw new Error('App not installed on sekret');
      }),
      root: vi.fn(async () => 'submodule.x.path\nx\0submodule.x.url\n../x.git\0'),
    });
    await expect(fetchSubmodules(host, true, PARENT, 'github.com')).rejects.toThrow(
      /acme\/x.*App not installed on \[REDACTED\]/
    );
  });
});

describe('resolveWorkspaceSetup', () => {
  it('reads nothing from the repository when the field is set', async () => {
    const host = fakeHost();
    const resolved = await resolveWorkspaceSetup(host, {
      baseRef: 'HEAD',
      cleanUrl: PARENT,
      field: { steps: [{ run: 'make deps' }] },
      gitHost: 'github.com',
      image: 'img',
      teamId: null,
    });
    expect(resolved).toEqual({ setup: { steps: [{ run: 'make deps' }] }, source: 'repository' });
    expect(host.capture).not.toHaveBeenCalled();
  });

  it('reads the file at the base ref and fails on an invalid one', async () => {
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'steps: nope' })),
    });
    await expect(
      resolveWorkspaceSetup(host, {
        baseRef: 'abc123',
        cleanUrl: PARENT,
        field: null,
        gitHost: 'github.com',
        image: 'img',
        teamId: null,
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: WORKSPACE_SETUP_FAILED });
    expect(String(vi.mocked(host.capture).mock.calls[0]?.[0])).toContain(
      "'abc123:.auto-swe/setup.yml'"
    );
  });

  it('is null when there is no field, no file and no stack defaults', async () => {
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 3, stderr: '', stdout: '' })),
    });
    await expect(readSetupFile(host, 'HEAD')).resolves.toBeNull();
    await expect(
      resolveWorkspaceSetup(host, {
        baseRef: 'HEAD',
        cleanUrl: PARENT,
        field: undefined,
        gitHost: 'github.com',
        image: 'img',
        teamId: null,
      })
    ).resolves.toBeNull();
  });
});

describe('runSetupGitPhase', () => {
  it('pulls LFS in the checkout and in each submodule, each with its own endpoint and credential', async () => {
    const host = fakeHost({
      root: vi.fn(async (cmd: string) =>
        cmd.includes('--get-regexp') && cmd.startsWith("cd '/workspace/target-repo' ")
          ? 'submodule.lib.path\nvendor/lib\0submodule.lib.url\n../lib.git\0'
          : ''
      ),
    });
    await expect(
      runSetupGitPhase(
        host,
        { lfs: true, submodules: true },
        { cleanUrl: PARENT, gitHost: 'github.com' },
        'AUTHORIZATION: basic parent'
      )
    ).resolves.toEqual({ lfs: true, submodules: 1 });
    const pulls = vi.mocked(host.git).mock.calls.filter((c) => String(c[1]).includes('lfs pull'));
    expect(pulls).toEqual([
      [
        '/workspace/target-repo',
        `${LFS_FILTER}-c lfs.url='https://github.com/acme/app.git/info/lfs' lfs pull`,
        'AUTHORIZATION: basic parent',
        900_000,
      ],
      [
        '/workspace/target-repo/vendor/lib',
        `${LFS_FILTER}-c lfs.url='https://github.com/acme/lib.git/info/lfs' lfs pull`,
        'AUTHORIZATION: basic acme-lib',
        900_000,
      ],
    ]);
  });

  it('names the submodule whose LFS pull failed', async () => {
    const host = fakeHost({
      git: vi.fn(async (dir: string, sub: string) => {
        if (sub.includes('lfs pull') && dir.endsWith('vendor/lib')) {
          throw new Error('batch response: sekret denied');
        }
        return '';
      }),
      root: vi.fn(async (cmd: string) =>
        cmd.includes('--get-regexp') && cmd.startsWith("cd '/workspace/target-repo' ")
          ? 'submodule.lib.path\nvendor/lib\0submodule.lib.url\n../lib.git\0'
          : ''
      ),
    });
    await expect(
      runSetupGitPhase(
        host,
        { lfs: true, submodules: true },
        { cleanUrl: PARENT, gitHost: 'github.com' }
      )
    ).rejects.toThrow(/git lfs pull in vendor\/lib failed: batch response: \[REDACTED\] denied/);
  });
});

describe('runSetupStepsPhase', () => {
  const inputs = { cleanUrl: PARENT, image: 'node:26', teamId: 'team-a' };
  const setup: RepoSetup = {
    cache: { keyFiles: ['yarn.lock'], paths: ['node_modules', '~/.cache/yarn'] },
    env: { CI: '1' },
    steps: [{ name: 'install', run: 'yarn install', workdir: 'web' }],
  };

  it('runs each step in its workdir with the env, and saves the cache on a miss', async () => {
    const host = fakeHost();
    const result = await runSetupStepsPhase(host, setup, inputs);
    expect(result.cache).toBe('saved');
    expect(result.steps.map((s) => s.name)).toEqual(['install']);
    expect(host.capture).toHaveBeenCalledWith("cd 'web' && yarn install", {
      env: ['CI=1'],
      timeoutMs: 600_000,
    });
    const tar = vi
      .mocked(host.root)
      .mock.calls.map((c) => String(c[0]))
      .find((c) => c.includes('tar -czf'));
    expect(tar).toContain("'workspace/target-repo/node_modules'");
    expect(tar).toContain("HOME#/}\"/'.cache/yarn'");
    expect(artifacts.putArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace-setup-cache' })
    );
    expect(cache.upsert).toHaveBeenCalled();
  });

  it('restores a hit and does not save it again', async () => {
    h.cacheRow = { artifactId: 'art-1', cacheKey: 'k' };
    const host = fakeHost();
    const result = await runSetupStepsPhase(host, setup, inputs);
    expect(result.cache).toBe('hit');
    expect(host.stdin).toHaveBeenCalledWith('tar -xzf - -C /', Buffer.from('tgz'));
    expect(artifacts.putArtifact).not.toHaveBeenCalled();
    expect(cache.update).toHaveBeenCalled();
  });

  it('scopes the cache key by team, with team-less repositories in one shared scope', async () => {
    const keys: unknown[] = [];
    for (const teamId of ['team-a', 'team-b', null, null]) {
      await runSetupStepsPhase(fakeHost(), setup, { ...inputs, teamId });
      keys.push(JSON.stringify((cache.findUnique.mock.calls.at(-1) as unknown[] | undefined)?.[0]));
    }
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(keys[3]);
  });

  it('does not reuse dependency caches across workspace UID or HOME changes', async () => {
    const keys: unknown[] = [];
    for (const identity of ['0\n/root', '1000\n/root', '1000\n/workspace/.home']) {
      const host = fakeHost({
        capture: vi.fn(async (cmd: string) => ({
          exitCode: 0,
          stderr: '',
          stdout: cmd.startsWith('uname -m') ? `x86_64\n${identity}` : '',
        })),
      });
      await runSetupStepsPhase(host, setup, inputs);
      expect(host.capture).toHaveBeenCalledWith(
        expect.stringContaining('id -u; printf "%s\\n" "$HOME"'),
        { timeoutMs: 60_000 }
      );
      keys.push(JSON.stringify(cache.findUnique.mock.calls.at(-1)));
    }
    expect(new Set(keys).size).toBe(3);
  });

  it('isolates looser setup cache entries while preserving the inherited key', async () => {
    const keys: unknown[] = [];
    for (const setupEgressPolicy of [undefined, 'open', 'restricted', undefined] as const) {
      await runSetupStepsPhase(fakeHost(), setup, { ...inputs, setupEgressPolicy });
      keys.push(JSON.stringify(cache.findUnique.mock.calls.at(-1)));
    }
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(keys[3]);
  });

  it('keys on every tracked file a key file glob matches, by path and content', async () => {
    const globbed: RepoSetup = { ...setup, cache: { keyFiles: ['**/build.gradle'], paths: ['x'] } };
    const listing = (files: string[]) =>
      fakeHost({
        capture: vi.fn(async (cmd: string) => ({
          exitCode: 0,
          stderr: '',
          // The hashing script's output stands in for what a shell prints: its own text.
          stdout: cmd.startsWith('git ls-files') ? files.map((f) => `${f}\0`).join('') : cmd,
        })),
      });
    const one = listing(['build.gradle', 'app/build.gradle']);
    await runSetupStepsPhase(one, globbed, inputs);
    const calls = vi.mocked(one.capture).mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe("git ls-files -z -- ':(glob)**/build.gradle'");
    expect(calls[1]).toContain("printf '%s\\n' 'app/build.gradle'; if [ -f 'app/build.gradle' ]");
    const keyOf = () =>
      JSON.stringify((cache.findUnique.mock.calls.at(-1) as unknown[] | undefined)?.[0]);
    const first = keyOf();
    await runSetupStepsPhase(listing(['build.gradle']), globbed, inputs);
    expect(keyOf()).not.toBe(first);
  });

  it('runs without a cache when the globs match too many files', async () => {
    const host = fakeHost({
      capture: vi.fn(async (cmd: string) => ({
        exitCode: 0,
        stderr: '',
        stdout: cmd.startsWith('git ls-files')
          ? Array.from({ length: 501 }, (_, i) => `m${i}/build.gradle\0`).join('')
          : '',
      })),
    });
    const globbed: RepoSetup = { ...setup, cache: { keyFiles: ['**/build.gradle'], paths: ['x'] } };
    expect((await runSetupStepsPhase(host, globbed, inputs)).cache).toBe('error');
    expect(cache.findUnique).not.toHaveBeenCalled();
  });

  it('skips the cache on the Postgres artifact backend', async () => {
    h.backend = 'pg';
    const host = fakeHost();
    expect((await runSetupStepsPhase(host, setup, inputs)).cache).toBe('off');
    expect(cache.findUnique).not.toHaveBeenCalled();
  });

  it('does not store an archive over the size cap', async () => {
    const host = fakeHost({
      readFile: vi.fn(async () => {
        throw new RangeError('too big');
      }),
    });
    expect((await runSetupStepsPhase(host, setup, inputs)).cache).toBe('too-large');
    expect(artifacts.putArtifact).not.toHaveBeenCalled();
  });

  it('fails the workspace on a failing step, with a redacted tail and no cache saved', async () => {
    const host = fakeHost({
      capture: vi.fn(async (cmd: string) =>
        cmd.includes('yarn install')
          ? { exitCode: 1, stderr: 'boom sekret', stdout: '' }
          : { exitCode: 0, stderr: '', stdout: '' }
      ),
    });
    const err = await runSetupStepsPhase(host, setup, inputs).catch((e) => e);
    expect(err).toMatchObject({ type: WORKSPACE_SETUP_FAILED });
    expect(String(err.message)).toContain('"install" failed (exit 1): boom [REDACTED]');
    expect(err.details[0]).toMatchObject({
      detail: 'boom [REDACTED]',
      kind: 'step_failed',
      subject: 'install',
    });
    expect(artifacts.putArtifact).not.toHaveBeenCalled();
  });
});

describe('step blocker classification', () => {
  const inputs = { cleanUrl: PARENT, image: 'img', teamId: null };
  const setup = { steps: [{ name: 'install', run: 'foo install' }] };

  it('classifies exit 127 with no output', async () => {
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 127, stderr: '', stdout: '' })),
    });
    await expect(runSetupStepsPhase(host, setup, inputs)).rejects.toMatchObject({
      details: [{ detail: '', kind: 'missing_tool', step: 'install', subject: 'foo' }],
      nonRetryable: false,
      type: WORKSPACE_SETUP_FAILED,
    });
  });

  it('classifies a thrown capture as timeout and redacts detail', async () => {
    const host = fakeHost({
      capture: vi.fn(async () => {
        throw new Error('timeout sekret');
      }),
    });
    await expect(runSetupStepsPhase(host, setup, inputs)).rejects.toMatchObject({
      details: [
        { detail: 'timeout [REDACTED]', kind: 'step_timeout', step: 'install', subject: 'install' },
      ],
      nonRetryable: false,
    });
  });

  it('prefers a denied host since this step started', async () => {
    deniedCall.findFirst.mockResolvedValueOnce({ host: 'registry.example.com' });
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 1, stderr: '403', stdout: '' })),
    });
    const error = await runSetupStepsPhase(host, setup, inputs).catch((error) => error);
    expect(error.details[0]).toMatchObject({
      kind: 'egress_denied',
      step: 'install',
      subject: 'registry.example.com',
    });
    expect(deniedCall.findFirst).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { host: true },
      where: {
        blocked: true,
        createdAt: { gte: expect.any(Date) },
        runId: 'run',
        source: 'egress_proxy',
        workflowId: 'workflow',
      },
    });
  });

  it('falls back to step classification if the audit lookup fails', async () => {
    deniedCall.findFirst.mockRejectedValueOnce(new Error('db unavailable'));
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 127, stderr: 'sh: foo: not found', stdout: '' })),
    });
    await expect(runSetupStepsPhase(host, setup, inputs)).rejects.toMatchObject({
      details: [{ kind: 'missing_tool', subject: 'foo' }],
    });
  });
});

describe('cleanup and the secret scan', () => {
  const inputs = { cleanUrl: PARENT, image: 'img', teamId: null };
  const calls = (host: ReturnType<typeof fakeHost>) =>
    vi.mocked(host.capture).mock.calls as unknown as Array<
      [string, { secretEnv?: Record<string, string> }]
    >;

  it('deletes the cleanup paths after the steps, in the checkout and the home directory', async () => {
    const host = fakeHost();
    await runSetupStepsPhase(
      host,
      { cleanup: ['.npmrc', '~/.config/tok'], steps: [{ run: 'yarn' }] },
      inputs
    );
    const [first, second] = calls(host).map(([cmd]) => cmd);
    expect(first).toBe('yarn');
    expect(second).toBe(`rm -rf -- '/workspace/target-repo/.npmrc' "$HOME"/'.config/tok'`);
  });

  it('scans for each value through secret env only, its longest line for a multi-line one', async () => {
    const host = fakeHost();
    await runSetupStepsPhase(
      host,
      { secrets: ['NPM_TOKEN', 'KEY'], steps: [{ run: 'yarn' }] },
      inputs,
      { KEY: '---\nlongest-line-of-key\n---', NPM_TOKEN: 'npm_abcdef123' }
    );
    const [script, opts] = calls(host).at(-1) ?? ['', {}];
    expect(script).toContain('grep -lF -e "$AUTO_SWE_SCAN_0" -e "$AUTO_SWE_SCAN_1"');
    expect(script).toContain(`find '/workspace/target-repo' "$HOME" /tmp /var/tmp /dev/shm -xdev`);
    // Files over 20 MiB only when setup wrote them; every file when the marker is gone.
    expect(script).toContain(
      'if s=$(cat /tmp/.auto-swe-setup-started 2>/dev/null) && [ "$s" -gt 0 ] 2>/dev/null; then since="-mmin -$(( ($(date +%s) - s) / 60 + 2 ))"; else since="-type f"; fi;'
    );
    expect(script).toContain('\\( -size -20480k -o $since \\)');
    expect(script).toContain('rm -f /tmp/.auto-swe-setup-started');
    expect(script).not.toContain('npm_abcdef123');
    const searched = Object.values(opts.secretEnv ?? {});
    expect(searched).toEqual(
      expect.arrayContaining([
        ...secretScanNeedles('longest-line-of-key'),
        ...secretScanNeedles('npm_abcdef123'),
      ])
    );
    expect(searched).not.toContain('---');
  });

  it('marks the start of the steps before the first one, when setup has secrets', async () => {
    const host = fakeHost();
    await runSetupStepsPhase(host, { secrets: ['NPM_TOKEN'], steps: [{ run: 'yarn' }] }, inputs, {
      NPM_TOKEN: 'npm_abcdef123',
    });
    const [first, second] = calls(host).map(([cmd]) => cmd);
    expect(first).toBe('date +%s > /tmp/.auto-swe-setup-started');
    expect(second).toBe('yarn');
  });

  it('fails setup when the start of the steps cannot be marked', async () => {
    const host = fakeHost({
      capture: vi.fn(async () => ({ exitCode: 1, stderr: 'read-only file system', stdout: '' })),
    });
    const err = await runSetupStepsPhase(
      host,
      { secrets: ['NPM_TOKEN'], steps: [{ run: 'yarn' }] },
      inputs,
      { NPM_TOKEN: 'npm_abcdef123' }
    ).catch((e) => e);
    expect(err).toMatchObject({ type: WORKSPACE_SETUP_FAILED });
    expect(String(err.message)).toContain('marking the start of the steps failed');
    expect(calls(host)).toHaveLength(1);
  });

  it('searches for a value hex encoded in either case and base64 encoded twice', () => {
    const token = 'tok/en+value:1234';
    const needles = secretScanNeedles(token);
    const hex = Buffer.from(token).toString('hex');
    expect(needles).toContain(hex);
    expect(needles).toContain(hex.toUpperCase());
    const inner = Buffer.from(token).toString('base64');
    for (const prefix of ['', 'u', 'us']) {
      // `printf %s "$TOKEN" | base64 | base64`, also inside a longer encoded string.
      const outer = Buffer.from(`${prefix}${inner}\n`).toString('base64');
      expect(needles.some((n) => outer.includes(n))).toBe(true);
    }
  });

  it('searches for a value written, URL encoded and base64 encoded at every offset', () => {
    const token = 'tok/en+value:1234';
    const needles = secretScanNeedles(token);
    expect(needles).toContain(token);
    expect(needles).toContain(encodeURIComponent(token));
    for (const prefix of ['', 'u', 'us', 'user:']) {
      const encoded = Buffer.from(`${prefix}${token}`).toString('base64');
      const urlSafe = Buffer.from(`${prefix}${token}`).toString('base64url');
      expect(needles.some((n) => encoded.includes(n) && n.length >= 8)).toBe(true);
      expect(needles.some((n) => urlSafe.includes(n) && n.length >= 8)).toBe(true);
    }
    // Encoded after other text, the value still ends up as one of the needles' superstrings.
    expect(needles.every((n) => n.length >= 8)).toBe(true);
    expect(secretScanNeedles('short')).toEqual([]);
  });

  it('refuses a secret shorter than 8 characters before any step runs', async () => {
    const host = fakeHost();
    const err = await runSetupStepsPhase(
      host,
      { secrets: ['NPM_TOKEN', 'PIN'], steps: [{ run: 'yarn' }] },
      inputs,
      { NPM_TOKEN: 'npm_abcdef123', PIN: '1234' }
    ).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: WORKSPACE_SETUP_FAILED });
    expect(String(err.message)).toContain('setup secret PIN is shorter than 8 characters');
    expect(String(err.message)).not.toContain('1234');
    expect(host.capture).not.toHaveBeenCalled();
  });

  it('stops processes the steps left running before cleanup', async () => {
    const order: string[] = [];
    const host = fakeHost({
      capture: vi.fn(async (cmd: string) => {
        order.push(
          cmd.startsWith('date +%s')
            ? 'mark'
            : cmd.startsWith('rm -rf')
              ? 'cleanup'
              : cmd.includes('grep -lF')
                ? 'scan'
                : cmd
        );
        return { exitCode: 0, stderr: '', stdout: '' };
      }),
      sweepProcesses: vi.fn(async () => {
        order.push('sweep');
      }),
    });
    await runSetupStepsPhase(
      host,
      { cleanup: ['.npmrc'], secrets: ['NPM_TOKEN'], steps: [{ run: 'yarn' }] },
      inputs,
      { NPM_TOKEN: 'npm_abcdef123' }
    );
    expect(order).toEqual(['mark', 'yarn', 'sweep', 'cleanup', 'scan']);
  });

  it('fails setup when the process sweep fails', async () => {
    const host = fakeHost({
      sweepProcesses: vi.fn(async () => {
        throw new Error('no /proc');
      }),
    });
    const err = await runSetupStepsPhase(
      host,
      { secrets: ['NPM_TOKEN'], steps: [{ run: 'yarn' }] },
      inputs,
      { NPM_TOKEN: 'npm_abcdef123' }
    ).catch((e) => e);
    expect(err).toMatchObject({ type: WORKSPACE_SETUP_FAILED });
    expect(String(err.message)).toContain('no /proc');
  });

  it('fails setup naming the files a value was left in, and saves no cache', async () => {
    const host = fakeHost({
      capture: vi.fn(async (cmd: string) => ({
        exitCode: 0,
        stderr: '',
        stdout: cmd.includes('grep -lF') ? '.npmrc\n~/.yarnrc.yml\n' : '',
      })),
    });
    const err = await runSetupStepsPhase(
      host,
      {
        cache: { paths: ['node_modules'] },
        secrets: ['NPM_TOKEN'],
        steps: [{ run: 'yarn' }],
      },
      inputs,
      { NPM_TOKEN: 'npm_abcdef123' }
    ).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: WORKSPACE_SETUP_FAILED });
    expect(String(err.message)).toContain('left a secret value in .npmrc, ~/.yarnrc.yml');
    expect(err.details[0].kind).toBe('secret_leak');
    expect(String(err.message)).not.toContain('npm_abcdef123');
    expect(artifacts.putArtifact).not.toHaveBeenCalled();
  });

  it('does not scan when the definition names no secrets, but still stops leftover processes', async () => {
    const host = fakeHost();
    await runSetupStepsPhase(host, { steps: [{ run: 'yarn' }] }, inputs);
    expect(calls(host).map(([cmd]) => cmd)).toEqual(['yarn']);
    expect(host.sweepProcesses).toHaveBeenCalledOnce();
  });

  it('stops no processes when there are no steps', async () => {
    const host = fakeHost();
    await runSetupStepsPhase(host, { cleanup: ['.npmrc'] }, inputs);
    expect(host.sweepProcesses).not.toHaveBeenCalled();
  });
});

describe('sweepSetupCaches', () => {
  it('deletes the tarball before its row', async () => {
    cache.findMany.mockResolvedValueOnce([{ artifactId: 'a1', id: 'r1' }]);
    await expect(sweepSetupCaches(new Date('2026-11-06T00:00:00Z'))).resolves.toBe(1);
    expect(artifacts.deleteArtifact).toHaveBeenCalledWith('a1');
    expect(cache.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });
});

describe('setup secrets', () => {
  const row = (name: string, sealed = name) => ({
    name,
    valueAuthTag: Buffer.from('t'),
    valueCiphertext: Buffer.from(sealed),
    valueKeyVersion: 1,
    valueNonce: Buffer.from('n'),
  });

  it('reads nothing when the definition names no secrets', async () => {
    setupSecrets.findMany.mockClear();
    await expect(loadSetupSecrets('repo-1', [])).resolves.toEqual({});
    expect(setupSecrets.findMany).not.toHaveBeenCalled();
  });

  it("decrypts the named secrets from the repository's own store", async () => {
    setupSecrets.findMany.mockResolvedValueOnce([row('NPM_TOKEN')]);
    await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).resolves.toEqual({
      NPM_TOKEN: 'plain-NPM_TOKEN',
    });
    expect(setupSecrets.findMany).toHaveBeenLastCalledWith({
      where: { connectionId: 'repo-1', name: { in: ['NPM_TOKEN'] } },
    });
  });

  it('fails setup on a secret the repository does not hold', async () => {
    setupSecrets.findMany.mockResolvedValueOnce([row('NPM_TOKEN')]);
    await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN', 'PIP_TOKEN'])).rejects.toMatchObject({
      details: [{ detail: expect.any(String), kind: 'missing_secret', subject: 'PIP_TOKEN' }],
      message: expect.stringContaining(
        'not set on the repository or granted from its team: PIP_TOKEN'
      ),
      type: WORKSPACE_SETUP_FAILED,
    });
  });

  it('fails setup without a repository to read from', async () => {
    await expect(loadSetupSecrets(null, ['NPM_TOKEN'])).rejects.toMatchObject({
      details: [{ detail: expect.any(String), kind: 'invalid_config', subject: 'NPM_TOKEN' }],
      type: WORKSPACE_SETUP_FAILED,
    });
  });

  it('fails setup on a value that cannot be decrypted, without echoing it', async () => {
    setupSecrets.findMany.mockResolvedValueOnce([row('NPM_TOKEN', 'corrupt')]);
    const err = await loadSetupSecrets('repo-1', ['NPM_TOKEN']).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('could not be decrypted');
    expect(String((err as Error).message)).not.toContain('corrupt');
    expect(err).toMatchObject({ details: [{ kind: 'secret_decrypt_failed' }] });
  });

  describe('team secrets', () => {
    const teamRow = (name: string, over: Partial<TeamSecretRow> = {}): TeamSecretRow => ({
      grants: ['repo-1'],
      name,
      teamId: 'team-1',
      valueAuthTag: Buffer.from('t'),
      valueCiphertext: Buffer.from(name),
      valueKeyVersion: 1,
      valueNonce: Buffer.from('n'),
      ...over,
    });

    beforeEach(() => {
      teamData.connection = { team: { id: 'team-1', isActive: true }, teamId: 'team-1' };
      teamData.secrets = [];
      teamSecrets.findMany.mockClear();
      connections.findUnique.mockClear();
    });

    it('fills a name from a granted team secret', async () => {
      teamData.secrets = [teamRow('NPM_TOKEN')];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).resolves.toEqual({
        NPM_TOKEN: 'plain-NPM_TOKEN',
      });
    });

    it("prefers the repository's own secret and never reads the team's", async () => {
      setupSecrets.findMany.mockResolvedValueOnce([row('NPM_TOKEN', 'own')]);
      teamData.secrets = [teamRow('NPM_TOKEN', { valueCiphertext: Buffer.from('team') })];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).resolves.toEqual({
        NPM_TOKEN: 'plain-own',
      });
      expect(teamSecrets.findMany).not.toHaveBeenCalled();
    });

    it('mixes repository and team secrets in one call', async () => {
      setupSecrets.findMany.mockResolvedValueOnce([row('A', 'own-a')]);
      teamData.secrets = [teamRow('B')];
      await expect(loadSetupSecrets('repo-1', ['A', 'B'])).resolves.toEqual({
        A: 'plain-own-a',
        B: 'plain-B',
      });
    });

    it('refuses a team secret that was not granted to this repository', async () => {
      teamData.secrets = [teamRow('NPM_TOKEN', { grants: ['repo-2'] })];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).rejects.toMatchObject({
        details: [{ kind: 'missing_secret', subject: 'NPM_TOKEN' }],
        type: WORKSPACE_SETUP_FAILED,
      });
    });

    it('refuses the secrets of a team whose organization is inactive', async () => {
      teamData.connection = {
        team: { id: 'team-1', isActive: true, organization: { isActive: false } },
        teamId: 'team-1',
      };
      teamData.secrets = [teamRow('NPM_TOKEN')];
      await expect(loadSetupSecrets('conn-1', ['NPM_TOKEN'])).rejects.toThrow(
        /granted from its team/
      );
    });

    it('refuses the secrets of an inactive team', async () => {
      teamData.connection = { team: { id: 'team-1', isActive: false }, teamId: 'team-1' };
      teamData.secrets = [teamRow('NPM_TOKEN')];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).rejects.toMatchObject({
        details: [{ kind: 'missing_secret' }],
      });
      expect(teamSecrets.findMany).not.toHaveBeenCalled();
    });

    it("scopes the lookup to the repository's current team, not the secret's", async () => {
      // The grant outlived a move of the repository to another team.
      teamData.connection = { team: { id: 'team-2', isActive: true }, teamId: 'team-2' };
      teamData.secrets = [teamRow('NPM_TOKEN', { teamId: 'team-1' })];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).rejects.toMatchObject({
        details: [{ kind: 'missing_secret' }],
      });
      expect(teamSecrets.findMany).toHaveBeenCalledWith({
        where: {
          grants: { some: { connectionId: 'repo-1' } },
          name: { in: ['NPM_TOKEN'] },
          teamId: 'team-2',
        },
      });
    });

    it('refuses a repository that no longer exists', async () => {
      teamData.connection = null;
      teamData.secrets = [teamRow('NPM_TOKEN')];
      await expect(loadSetupSecrets('repo-1', ['NPM_TOKEN'])).rejects.toMatchObject({
        details: [{ kind: 'missing_secret' }],
      });
    });

    it('reads no team secret when allowTeam is false', async () => {
      teamData.secrets = [teamRow('NPM_TOKEN')];
      await expect(
        loadSetupSecrets('repo-1', ['NPM_TOKEN'], { allowTeam: false })
      ).rejects.toMatchObject({ details: [{ kind: 'missing_secret' }] });
      expect(connections.findUnique).not.toHaveBeenCalled();
      expect(teamSecrets.findMany).not.toHaveBeenCalled();
    });

    it('fails on a team secret that cannot be decrypted, naming it and not echoing it', async () => {
      teamData.secrets = [teamRow('NPM_TOKEN', { valueCiphertext: Buffer.from('corrupt') })];
      const err = await loadSetupSecrets('repo-1', ['NPM_TOKEN']).catch((e: Error) => e);
      expect(String((err as Error).message)).toContain(
        'team secret NPM_TOKEN could not be decrypted'
      );
      expect(String((err as Error).message)).not.toContain('corrupt');
      expect(err).toMatchObject({ details: [{ kind: 'secret_decrypt_failed' }] });
    });
  });

  it('hands values to the steps as secret environment, never as plain env', async () => {
    const host = fakeHost();
    const setup: RepoSetup = { env: { CI: '1' }, secrets: ['NPM_TOKEN'], steps: [{ run: 'yarn' }] };
    await runSetupStepsPhase(
      host,
      setup,
      { cleanUrl: PARENT, image: 'img', teamId: null },
      { NPM_TOKEN: 'npm_abc12345' }
    );
    // The first call marks the start of the steps; the second runs the step.
    const [command, opts] = vi.mocked(host.capture).mock.calls[1] as unknown as [
      string,
      { env?: string[]; secretEnv?: Record<string, string> },
    ];
    expect(command).toBe('yarn');
    expect(opts.secretEnv).toEqual({ NPM_TOKEN: 'npm_abc12345' });
    expect(opts.env).toEqual(['CI=1']);
    expect(command).not.toContain('npm_abc12345');
  });
});
