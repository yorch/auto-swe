import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, register } = vi.hoisted(() => ({ findMany: vi.fn(), register: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { packageRegistry: { findMany } } }));
vi.mock('./index.js', () => ({ workerRegistryProxy: () => ({ register }) }));

import type { ResolvedRegistry } from './index.js';
import {
  beginWorkspaceRegistries,
  buildRegistryAllowlist,
  type WorkspaceRegistryAccess,
} from './workspaceWiring.js';

const row = (over: Record<string, unknown>) => ({
  accessMode: 'lockfile',
  allowPrivateNetwork: false,
  authKind: 'bearer',
  ecosystem: 'npm',
  id: 'r',
  isActive: true,
  name: 'registry',
  npmScopes: [] as string[],
  teamId: null,
  tokenAuthTag: null,
  tokenCiphertext: null,
  tokenKeyVersion: null,
  tokenNonce: null,
  upstreamUrl: 'https://upstream.test',
  ...over,
});

const NPM_ROW = row({ id: 'npm-1' });
const GO_ROW = row({ ecosystem: 'go', id: 'go-1', upstreamUrl: 'https://goproxy.test' });
const PYPI_ROW = row({ ecosystem: 'pypi', id: 'pypi-1', upstreamUrl: 'https://pypi.test' });

let registered: { registries: ResolvedRegistry[] } | undefined;

beforeEach(() => {
  registered = undefined;
  findMany.mockReset();
  register.mockReset().mockImplementation(async (r: { registries: ResolvedRegistry[] }) => {
    registered = r;
    return {
      baseUrl: 'http://proxy.internal:9999',
      release: async () => {},
      setAllowlist: () => {},
      token: 'tok',
    };
  });
});

describe('beginWorkspaceRegistries', () => {
  it('never takes a go row for an npm registry', async () => {
    findMany.mockResolvedValue([GO_ROW]);
    // Not asked for Go: nothing resolves at all, in particular no npm registry from the go row.
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x')).toBeNull();
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x', { go: false })).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('wires the go registry as the only registry when asked and no npm row exists', async () => {
    findMany.mockResolvedValue([GO_ROW]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true });
    expect(access?.registries).toEqual([
      {
        accessMode: 'lockfile',
        ecosystem: 'go',
        id: 'go-1',
        isDefault: true,
        name: 'registry',
        scopes: [],
      },
    ]);
    expect(registered?.registries.map((r) => [r.id, r.ecosystem, r.isDefault, r.scopes])).toEqual([
      ['go-1', 'go', true, []],
    ]);
    // No npm client config for a Go-only workspace.
    expect(access?.env.some((p) => p.startsWith('NPM_CONFIG_'))).toBe(false);
    expect(access?.env.some((p) => p.startsWith('GOPROXY='))).toBe(true);
  });

  it('keeps the npm result unchanged when a go row sits beside npm rows and Go is not wanted', async () => {
    findMany.mockResolvedValue([GO_ROW, NPM_ROW]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x');
    expect(access?.registries.map((r) => [r.id, r.ecosystem])).toEqual([['npm-1', 'npm']]);
    expect(access?.env.some((p) => p.startsWith('GOPROXY='))).toBe(false);
  });

  it('wires both ecosystems, and a go row does not shadow the npm default', async () => {
    findMany.mockResolvedValue([GO_ROW, NPM_ROW]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true });
    expect(access?.registries.map((r) => [r.id, r.ecosystem, r.isDefault])).toEqual([
      ['npm-1', 'npm', true],
      ['go-1', 'go', true],
    ]);
    expect(access?.env).toContain('NPM_CONFIG_REGISTRY=http://proxy.internal:9999/npm/npm-1');
  });

  it('keeps one go default, a team row beating a global one', async () => {
    findMany.mockResolvedValue([
      row({ ecosystem: 'go', id: 'go-global' }),
      row({ ecosystem: 'go', id: 'go-team', teamId: 'team-a' }),
    ]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true });
    expect(access?.registries.map((r) => r.id)).toEqual(['go-team']);
  });

  it('is null with no team or no registry', async () => {
    expect(await beginWorkspaceRegistries(null, 'workspace-x', { go: true })).toBeNull();
    findMany.mockResolvedValue([]);
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true })).toBeNull();
  });

  it('wires pypi only when asked, and never takes a pypi row for npm or go', async () => {
    findMany.mockResolvedValue([PYPI_ROW]);
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x')).toBeNull();
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true })).toBeNull();
    expect(register).not.toHaveBeenCalled();

    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { pypi: true });
    expect(access?.registries).toEqual([
      {
        accessMode: 'lockfile',
        ecosystem: 'pypi',
        id: 'pypi-1',
        isDefault: true,
        name: 'registry',
        scopes: [],
      },
    ]);
    expect(registered?.registries.map((r) => [r.id, r.ecosystem, r.isDefault, r.scopes])).toEqual([
      ['pypi-1', 'pypi', true, []],
    ]);
    expect(access?.env.some((p) => p.startsWith('NPM_CONFIG_'))).toBe(false);
    // The token rides as the userinfo password of the index URL, not in its path.
    expect(access?.env).toContain(
      'PIP_INDEX_URL=http://token:tok@proxy.internal:9999/pypi/pypi-1/simple/'
    );
  });

  it('resolves npm, go and pypi separately, none shadowing another', async () => {
    findMany.mockResolvedValue([PYPI_ROW, GO_ROW, NPM_ROW]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', {
      go: true,
      pypi: true,
    });
    expect(access?.registries.map((r) => [r.id, r.ecosystem, r.isDefault])).toEqual([
      ['npm-1', 'npm', true],
      ['go-1', 'go', true],
      ['pypi-1', 'pypi', true],
    ]);
    expect(access?.env).toContain('NPM_CONFIG_REGISTRY=http://proxy.internal:9999/npm/npm-1');
    expect(access?.env.some((p) => p.startsWith('GOPROXY='))).toBe(true);
    expect(access?.env.some((p) => p.startsWith('PIP_INDEX_URL='))).toBe(true);
  });

  it('keeps one pypi default, a team row beating a global one', async () => {
    findMany.mockResolvedValue([
      row({ ecosystem: 'pypi', id: 'pypi-global' }),
      row({ ecosystem: 'pypi', id: 'pypi-team', teamId: 'team-a' }),
    ]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { pypi: true });
    expect(access?.registries.map((r) => r.id)).toEqual(['pypi-team']);
  });
});

describe('buildRegistryAllowlist', () => {
  const GO_SUM_A = [
    'example.com/a v1.0.0 h1:aaaa=',
    'example.com/a v1.0.0/go.mod h1:bbbb=',
    'example.com/b v2.1.0/go.mod h1:cccc=',
  ].join('\n');
  const GO_SUM_B = 'example.com/c v0.3.0 h1:dddd=\n';
  const PACKAGE_LOCK = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/left-pad': { version: '1.3.0' } },
  });

  /** A fake `exec` serving `git ls-tree`, `git cat-file -s` and `git show` over a path → text map. */
  const fakeExec = (files: Record<string, string>) =>
    vi.fn(async (command: string, _max?: number) => {
      if (command.includes('git ls-tree')) {
        return { stdout: `${Object.keys(files).join('\0')}\0` };
      }
      const path = /'[^:']*:([^']*)'/.exec(command)?.[1] ?? '';
      const text = files[path] ?? '';
      return {
        stdout: command.includes('cat-file -s') ? String(Buffer.byteLength(text)) : text,
      };
    });

  const access = (
    registries: Partial<WorkspaceRegistryAccess['registries'][number]>[]
  ): WorkspaceRegistryAccess =>
    ({
      registries: registries.map((r) => ({
        accessMode: 'lockfile',
        ecosystem: 'npm',
        id: 'r',
        isDefault: true,
        name: 'n',
        scopes: [],
        ...r,
      })),
    }) as unknown as WorkspaceRegistryAccess;

  it('builds a go registry allowlist from every go.sum, at any depth', async () => {
    const exec = fakeExec({ 'go.sum': GO_SUM_A, 'svc/tools/go.sum': GO_SUM_B });
    const map = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      exec
    );
    const go = map.get('go-1');
    expect(go?.get('example.com/a')).toEqual(new Set(['v1.0.0', 'v1.0.0/go.mod']));
    expect(go?.get('example.com/b')).toEqual(new Set(['v2.1.0/go.mod']));
    expect(go?.get('example.com/c')).toEqual(new Set(['v0.3.0']));
  });

  it('reads go.work.sum as a go.sum', async () => {
    const exec = fakeExec({ 'go.work.sum': GO_SUM_A });
    const map = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      exec
    );
    expect(map.get('go-1')?.get('example.com/a')).toEqual(new Set(['v1.0.0', 'v1.0.0/go.mod']));
  });

  it('gives a go registry an empty, not absent, allowlist when there is no go.sum', async () => {
    const exec = fakeExec({ 'README.md': 'x' });
    const map = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      exec
    );
    expect(map.has('go-1')).toBe(true);
    expect(map.get('go-1')).toEqual(new Map());
  });

  it('leaves an open-mode go registry unchecked', async () => {
    const exec = fakeExec({ 'go.sum': GO_SUM_A });
    const map = await buildRegistryAllowlist(
      access([{ accessMode: 'open', ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      exec
    );
    expect(map.get('go-1')).toBeNull();
  });

  it('feeds npm registries from npm lockfiles only, and go registries from go.sum only', async () => {
    const exec = fakeExec({ 'go.sum': GO_SUM_A, 'package-lock.json': PACKAGE_LOCK });
    const map = await buildRegistryAllowlist(
      access([
        { ecosystem: 'npm', id: 'npm-1' },
        { ecosystem: 'go', id: 'go-1' },
      ]),
      'HEAD',
      exec
    );
    expect([...(map.get('npm-1')?.keys() ?? [])]).toEqual(['left-pad']);
    expect([...(map.get('go-1')?.keys() ?? [])].sort()).toEqual(['example.com/a', 'example.com/b']);
  });

  it('skips an unparsable or oversized go.sum and keeps the others', async () => {
    const exec = fakeExec({ 'a/go.sum': GO_SUM_B, 'b/go.sum': '\u0000not a go.sum\n garbage' });
    const map = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      exec
    );
    expect([...(map.get('go-1')?.keys() ?? [])]).toEqual(['example.com/c']);

    const big = vi.fn(async (command: string) =>
      command.includes('git ls-tree')
        ? { stdout: 'go.sum\0' }
        : { stdout: command.includes('cat-file -s') ? String(60 * 1024 * 1024) : GO_SUM_B }
    );
    const skipped = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      big
    );
    expect(skipped.get('go-1')).toEqual(new Map());
    // Oversized: never read.
    expect(big.mock.calls.some(([c]) => c.includes('git show'))).toBe(false);
  });

  it('caps the go.sum files read at 50', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 55 }, (_, i) => [`m${i}/go.sum`, `example.com/m${i} v1.0.0 h1:aaaa=\n`])
    );
    const map = await buildRegistryAllowlist(
      access([{ ecosystem: 'go', id: 'go-1' }]),
      'HEAD',
      fakeExec(files)
    );
    expect(map.get('go-1')?.size).toBe(50);
  });

  describe('a pypi registry', () => {
    const REQ_A = 'requests==2.31.0\nflask==3.0.0\n';
    const REQ_B = 'Flask==3.0.1\nnumpy==1.26.4\n';
    const pypi = (over: Partial<WorkspaceRegistryAccess['registries'][number]> = {}) =>
      access([{ ecosystem: 'pypi', id: 'pypi-1', ...over }]);

    it('merges every lockfile at any depth, by union', async () => {
      const exec = fakeExec({ 'requirements.txt': REQ_A, 'svc/api/requirements-dev.txt': REQ_B });
      const map = await buildRegistryAllowlist(pypi(), 'HEAD', exec);
      const list = map.get('pypi-1');
      // Versions are stored canonical: trailing `.0` segments are dropped.
      expect(list?.get('requests')).toEqual(new Set(['2.31']));
      expect(list?.get('flask')).toEqual(new Set(['3', '3.0.1']));
      expect(list?.get('numpy')).toEqual(new Set(['1.26.4']));
    });

    it('skips vendored and virtualenv trees', async () => {
      const exec = fakeExec({
        '.venv/requirements.txt': 'evil==1.0\n',
        'a/node_modules/x/requirements.txt': 'evil==2.0\n',
        'a/site-packages/requirements.txt': 'evil==3.0\n',
        'requirements.txt': REQ_A,
        'third_party/requirements.txt': 'evil==4.0\n',
        'vendor/requirements.txt': 'evil==5.0\n',
        'venv/requirements.txt': 'evil==6.0\n',
      });
      const map = await buildRegistryAllowlist(pypi(), 'HEAD', exec);
      expect([...(map.get('pypi-1')?.keys() ?? [])].sort()).toEqual(['flask', 'requests']);
    });

    it('gives an empty, not absent, allowlist when there is no lockfile', async () => {
      const map = await buildRegistryAllowlist(pypi(), 'HEAD', fakeExec({ 'README.md': '' }));
      expect(map.has('pypi-1')).toBe(true);
      expect(map.get('pypi-1')).toEqual(new Map());
    });

    it('leaves an open-mode registry unchecked and makes no git read for it', async () => {
      const exec = fakeExec({ 'requirements.txt': REQ_A });
      const map = await buildRegistryAllowlist(pypi({ accessMode: 'open' }), 'HEAD', exec);
      expect(map.get('pypi-1')).toBeNull();
      expect(exec.mock.calls.some(([c]) => c.includes('cat-file') || c.includes('git show'))).toBe(
        false
      );
    });

    it('skips an oversized or truncated file', async () => {
      const big = vi.fn(async (command: string) =>
        command.includes('git ls-tree')
          ? { stdout: 'requirements.txt\0' }
          : { stdout: command.includes('cat-file -s') ? String(60 * 1024 * 1024) : REQ_A }
      );
      expect((await buildRegistryAllowlist(pypi(), 'HEAD', big)).get('pypi-1')).toEqual(new Map());
      expect(big.mock.calls.some(([c]) => c.includes('git show'))).toBe(false);

      const truncated = vi.fn(async (command: string) =>
        command.includes('git ls-tree')
          ? { stdout: 'requirements.txt\0' }
          : {
              stdout: command.includes('cat-file -s') ? '10' : 'x'.repeat(50 * 1024 * 1024 + 2),
            }
      );
      expect((await buildRegistryAllowlist(pypi(), 'HEAD', truncated)).get('pypi-1')).toEqual(
        new Map()
      );
    });

    it('caps the lockfiles read at 50', async () => {
      const files = Object.fromEntries(
        Array.from({ length: 55 }, (_, i) => [`m${i}/requirements.txt`, `pkg${i}==1.0.0\n`])
      );
      const map = await buildRegistryAllowlist(pypi(), 'HEAD', fakeExec(files));
      expect(map.get('pypi-1')?.size).toBe(50);
    });

    it('leaves the npm and go allowlists unaffected', async () => {
      const exec = fakeExec({
        'go.sum': GO_SUM_B,
        'package-lock.json': PACKAGE_LOCK,
        'requirements.txt': REQ_A,
      });
      const map = await buildRegistryAllowlist(
        access([
          { ecosystem: 'npm', id: 'npm-1' },
          { ecosystem: 'go', id: 'go-1' },
          { ecosystem: 'pypi', id: 'pypi-1' },
        ]),
        'HEAD',
        exec
      );
      expect([...(map.get('npm-1')?.keys() ?? [])]).toEqual(['left-pad']);
      expect([...(map.get('go-1')?.keys() ?? [])]).toEqual(['example.com/c']);
      expect([...(map.get('pypi-1')?.keys() ?? [])].sort()).toEqual(['flask', 'requests']);
    });
  });
});

describe('a maven registry', () => {
  const MAVEN_ROW = row({ ecosystem: 'maven', id: 'mvn-1', upstreamUrl: 'https://repo.test' });

  it('is wired only when asked, and never taken for npm, go or pypi', async () => {
    findMany.mockResolvedValue([MAVEN_ROW]);
    expect(await beginWorkspaceRegistries('team-a', 'workspace-x')).toBeNull();
    expect(
      await beginWorkspaceRegistries('team-a', 'workspace-x', { go: true, pypi: true })
    ).toBeNull();
    expect(register).not.toHaveBeenCalled();

    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', { maven: true });
    expect(access?.registries).toEqual([
      {
        accessMode: 'lockfile',
        ecosystem: 'maven',
        id: 'mvn-1',
        isDefault: true,
        name: 'registry',
        scopes: [],
      },
    ]);
    expect(registered?.registries.map((r) => [r.id, r.ecosystem, r.isDefault, r.scopes])).toEqual([
      ['mvn-1', 'maven', true, []],
    ]);
    expect(access?.env.some((p) => p.startsWith('NPM_CONFIG_'))).toBe(false);
    expect(access?.env).toContain('MAVEN_ARGS=-s /workspace/.auto-swe/maven-settings.xml');
  });

  it('keeps one default, a team row beating a global one, and leaves the others unaffected', async () => {
    findMany.mockResolvedValue([
      row({ ecosystem: 'maven', id: 'mvn-global' }),
      row({ ecosystem: 'maven', id: 'mvn-team', teamId: 'team-a' }),
      NPM_ROW,
      GO_ROW,
      PYPI_ROW,
    ]);
    const access = await beginWorkspaceRegistries('team-a', 'workspace-x', {
      go: true,
      maven: true,
      pypi: true,
    });
    expect(access?.registries.map((r) => [r.ecosystem, r.id])).toEqual([
      ['npm', 'npm-1'],
      ['go', 'go-1'],
      ['pypi', 'pypi-1'],
      ['maven', 'mvn-team'],
    ]);
    // Without Maven wanted the npm, go and pypi result is what it was.
    const without = await beginWorkspaceRegistries('team-a', 'workspace-x', {
      go: true,
      pypi: true,
    });
    expect(without?.registries.map((r) => r.ecosystem)).toEqual(['npm', 'go', 'pypi']);
  });

  it('always has a null allowlist, whatever its stored mode says', async () => {
    const exec = vi.fn(async (command: string) => ({
      stdout: command.includes('git ls-tree') ? 'pom.xml\0package-lock.json\0go.sum\0' : '',
    }));
    const access = {
      registries: ['lockfile', 'open', 'something-stale'].map((accessMode, i) => ({
        accessMode,
        ecosystem: 'maven',
        id: `mvn-${i}`,
        isDefault: true,
        name: 'n',
        scopes: [],
      })),
    } as unknown as WorkspaceRegistryAccess;
    const map = await buildRegistryAllowlist(access, 'HEAD', exec);
    expect([...map.entries()]).toEqual([
      ['mvn-0', null],
      ['mvn-1', null],
      ['mvn-2', null],
    ]);
  });
});
