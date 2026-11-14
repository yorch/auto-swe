import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  modelProxy: false,
  register: vi.fn(async () => ({
    release: vi.fn(),
    token: 'random-secret',
    url: 'http://host.docker.internal:8792',
  })),
  registries: vi.fn(async (): Promise<unknown[]> => []),
  team: vi.fn(async (_args?: unknown) => ({
    egressAllowlist: ['*.example.com'] as string[],
    orgId: 'org-1' as string | null,
  })),
  tools: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('./egressProxy.js', () => ({
  workerEgressProxy: () => (h.enabled ? { register: h.register } : null),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { packageRegistry: { findMany: h.registries }, team: { findUnique: h.team } },
}));
vi.mock('./toolCatalogLoader.js', () => ({ loadToolCatalog: h.tools }));
vi.mock('./activityLog.js', () => ({ logWarn: h.warn }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({
    ...(h.modelProxy ? { harnessModelProxy: { url: 'http://host.docker.internal:8790' } } : {}),
    registryProxy: { url: 'http://registry.internal:8791' },
  }),
}));
const settings = vi.hoisted(() => ({
  resolveSetting: vi.fn(
    async (key: string): Promise<string | string[]> =>
      key === 'workspace.egressBaselineAllowlist' ? [] : 'open'
  ),
}));
vi.mock('@auto-swe/shared/config', () => settings);
const contextLookup = vi.hoisted(() => ({
  currentRequestContext: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      pinnedSettings: { 'workspace.egressPolicy': 'x' },
    })
  ),
}));
vi.mock('./config/contextLookup.js', () => contextLookup);

import {
  assertStepEgressEnforceable,
  beginEgressAccess,
  beginWorkspaceEgress,
  blockedEgressAllow,
  capStepNetwork,
  gitHostOf,
  lfsStorageHosts,
  resolveOnboardingDraftEgress,
  resolveRunEgressAllowlist,
  resolveRunEgressPolicy,
  resolveRunSetupEgressPolicy,
} from './egressWiring.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.modelProxy = false;
});

describe('temporary onboarding draft access', () => {
  beforeEach(() => {
    h.registries.mockResolvedValue([]);
    h.tools.mockResolvedValue([]);
  });

  it.each([true, false])(
    'includes the live baseline only when the draft inherits the team allowlist (%s)',
    async (includeTeamAllowlist) => {
      if (includeTeamAllowlist) {
        settings.resolveSetting.mockResolvedValueOnce(['baseline.example']);
      }
      await beginWorkspaceEgress('team', [], 'restricted', {
        additionalHosts: ['draft.example'],
        includeTeamAllowlist,
      });
      expect(h.register).toHaveBeenCalledWith(
        includeTeamAllowlist
          ? ['baseline.example', '*.example.com', 'draft.example']
          : ['draft.example']
      );
      if (!includeTeamAllowlist) {
        expect(settings.resolveSetting).not.toHaveBeenCalled();
        expect(h.team).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses inherited draft access when the live baseline cannot be resolved', async () => {
    settings.resolveSetting.mockRejectedValueOnce(new Error('baseline unavailable'));
    await expect(
      beginWorkspaceEgress('team', [], 'restricted', {
        additionalHosts: ['draft.example'],
        includeTeamAllowlist: true,
      })
    ).rejects.toThrow('baseline unavailable');
    expect(h.register).not.toHaveBeenCalled();
  });

  it.each(['restricted', 'blocked'] as const)(
    'derives workspace-only hosts under %s',
    async (policy) => {
      settings.resolveSetting.mockResolvedValueOnce(['draft.example', 'downloads.example']);
      const registry = (id: string, teamId: string | null, upstreamUrl: string) => ({
        ecosystem: 'npm',
        id,
        isActive: true,
        npmScopes: [],
        teamId,
        upstreamUrl,
      });
      h.registries.mockResolvedValueOnce([
        registry('global', null, 'https://shadowed.example'),
        registry('team', 'team', 'https://registry.example/path'),
        registry('other', 'other', 'https://other.example'),
      ]);
      h.tools.mockResolvedValueOnce([
        {
          archs: {
            amd64: { url: 'https://downloads.example/linux.tar.gz' },
            arm64: { url: 'https://arm.example/linux.tar.gz' },
          },
          status: 'ACTIVE',
        },
        { archs: { amd64: { url: 'https://old.example/tool.tar.gz' } }, status: 'DEPRECATED' },
        { archs: { amd64: { url: 'https://revoked.example/tool.tar.gz' } }, status: 'REVOKED' },
      ]);
      const expansion = await resolveOnboardingDraftEgress('team', policy);
      expect(expansion).toEqual({
        additionalHosts: [
          'arm.example',
          'downloads.example',
          'draft.example',
          'old.example',
          'registry.example',
          'shadowed.example',
        ],
        includeTeamAllowlist: policy === 'restricted',
      });
      expect(settings.resolveSetting).toHaveBeenCalledWith(
        'onboarding.draftEgressHosts',
        expect.objectContaining({ orgId: 'org-1', teamId: 'team' })
      );
      await beginWorkspaceEgress('team', ['git.example'], 'restricted', expansion ?? undefined);
      expect(h.register).toHaveBeenLastCalledWith([
        ...(policy === 'restricted' ? ['*.example.com'] : []),
        ...(expansion?.additionalHosts ?? []),
      ]);
    }
  );

  it('leaves open unchanged without reading hosts or catalogs', async () => {
    expect(await resolveOnboardingDraftEgress('team', 'open')).toBeNull();
    expect(settings.resolveSetting).not.toHaveBeenCalled();
    expect(h.registries).not.toHaveBeenCalled();
    expect(h.tools).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'restricted'] as const)(
    'keeps %s unchanged without a proxy and warns',
    async (policy) => {
      h.enabled = false;
      expect(await resolveOnboardingDraftEgress('team', policy)).toBeNull();
      expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('unchanged'), {
        policy,
        teamId: 'team',
      });
      expect(h.register).not.toHaveBeenCalled();
      expect(settings.resolveSetting).not.toHaveBeenCalled();
    }
  );

  it('never turns an empty derived host list into unrestricted proxy access', async () => {
    settings.resolveSetting.mockResolvedValueOnce([]);
    expect(await resolveOnboardingDraftEgress(null, 'blocked')).toBeNull();
    expect(h.register).not.toHaveBeenCalled();
  });

  it('does not hide host configuration/catalog lookup failures', async () => {
    settings.resolveSetting.mockResolvedValueOnce([]);
    h.tools.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(resolveOnboardingDraftEgress('team', 'blocked')).rejects.toThrow(
      'catalog unavailable'
    );
    expect(h.register).not.toHaveBeenCalled();
  });
});
it('merges live organization baseline entries for restricted and open/non-empty only', async () => {
  settings.resolveSetting.mockResolvedValueOnce(['registry.npmjs.org']);
  expect(await resolveRunEgressAllowlist('team', ['team.test'], 'restricted')).toEqual([
    'registry.npmjs.org',
    'team.test',
  ]);
  expect(settings.resolveSetting).toHaveBeenLastCalledWith(
    'workspace.egressBaselineAllowlist',
    expect.objectContaining({ orgId: 'org-1', teamId: 'team' })
  );
  settings.resolveSetting.mockResolvedValueOnce(['pypi.org']);
  expect(await resolveRunEgressAllowlist('team', ['team.test'], 'open')).toEqual([
    'pypi.org',
    'team.test',
  ]);
  settings.resolveSetting.mockClear();
  expect(await resolveRunEgressAllowlist('team', [], 'open')).toEqual([]);
  expect(await resolveRunEgressAllowlist('team', ['team.test'], 'blocked')).toEqual([]);
  expect(settings.resolveSetting).not.toHaveBeenCalled();
});
it('propagates baseline resolution errors rather than granting unrestricted access', async () => {
  settings.resolveSetting.mockRejectedValueOnce(new Error('configuration unavailable'));
  await expect(resolveRunEgressAllowlist('team', [], 'restricted')).rejects.toThrow(
    'configuration unavailable'
  );
});
it('resolves the setup setting with the same pinned scope as the agent setting', async () => {
  settings.resolveSetting.mockResolvedValueOnce('restricted');
  expect(await resolveRunSetupEgressPolicy('team')).toBe('restricted');
  expect(settings.resolveSetting).toHaveBeenLastCalledWith(
    'workspace.setupEgressPolicy',
    expect.objectContaining({ pinnedSettings: { 'workspace.egressPolicy': 'x' }, teamId: 'team' })
  );
});
it('does nothing when disabled without querying the team', async () => {
  h.enabled = false;
  expect(await beginWorkspaceEgress('team', [], 'open')).toBeNull();
  expect(h.team).not.toHaveBeenCalled();
  expect(h.register).not.toHaveBeenCalled();
});
it('strips brackets from an IPv6-literal git host in the lock allowlist', () => {
  expect(
    blockedEgressAllow('[2001:db8::1]', { cleanUrl: 'https://[2001:db8::1]/o/r.git' })
  ).toEqual([{ host: '2001:db8::1', port: 443 }]);
});
it('uses the team allowlist and supplies upper/lowercase secret proxy variables with local exclusions', async () => {
  const access = await beginWorkspaceEgress('team');
  expect(h.register).toHaveBeenCalledWith(['*.example.com']);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    expect(access?.secretEnv[key as keyof typeof access.secretEnv]).toBe(
      'http://egress:random-secret@host.docker.internal:8792/'
    );
  }
  expect(access?.env).toEqual([
    'NO_PROXY=localhost,127.0.0.1,::1,[::1],registry.internal,host.docker.internal',
    'no_proxy=localhost,127.0.0.1,::1,[::1],registry.internal,host.docker.internal',
    'NODE_USE_ENV_PROXY=1',
  ]);
});
it('makes Node fetch use the proxy only when a proxy is configured', async () => {
  const access = await beginEgressAccess([]);
  expect(access?.env).toContain('NODE_USE_ENV_PROXY=1');
  expect(access?.secretEnv).not.toHaveProperty('NODE_USE_ENV_PROXY');
  h.enabled = false;
  expect(await beginEgressAccess([])).toBeNull();
});
it('excludes the egress proxy host and both IPv6 loopback spellings from the proxy', async () => {
  const access = await beginEgressAccess([]);
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = access?.env.find((entry) => entry.startsWith(`${name}=`))?.split('=')[1];
    expect(entries?.split(',')).toEqual(
      expect.arrayContaining(['host.docker.internal', '::1', '[::1]'])
    );
  }
});
it('does not repeat a host shared by the proxy, the registry and the bypass list', async () => {
  h.register.mockResolvedValueOnce({
    release: vi.fn(),
    token: 'random-secret',
    url: 'http://registry.internal:8792',
  });
  const access = await beginEgressAccess([], ['registry.internal']);
  expect(access?.env[0]).toBe('NO_PROXY=localhost,127.0.0.1,::1,[::1],registry.internal');
});
it('supports no team and does not hide registration failures', async () => {
  await beginWorkspaceEgress(null, [], 'open');
  expect(h.register).toHaveBeenCalledWith([]);
  expect(h.team).not.toHaveBeenCalled();
  h.register.mockRejectedValueOnce(new Error('bind failed'));
  await expect(beginEgressAccess([])).rejects.toThrow('bind failed');
});
it('lets the repository git host bypass the proxy', async () => {
  const access = await beginWorkspaceEgress('team', ['ghe.corp.internal']);
  expect(access?.env).toEqual([
    'NO_PROXY=localhost,127.0.0.1,::1,[::1],registry.internal,host.docker.internal,ghe.corp.internal',
    'no_proxy=localhost,127.0.0.1,::1,[::1],registry.internal,host.docker.internal,ghe.corp.internal',
    'NODE_USE_ENV_PROXY=1',
  ]);
});
it('extracts the git host from https, ssh and scp-style URLs', () => {
  expect(gitHostOf('https://ghe.corp.internal/org/repo.git')).toBe('ghe.corp.internal');
  expect(gitHostOf('ssh://git@github.com/org/repo.git')).toBe('github.com');
  expect(gitHostOf('git@github.com:org/repo.git')).toBe('github.com');
  expect(gitHostOf(null)).toBeNull();
});
it('accepts IP literals and lower-cases a scp-style host', () => {
  expect(gitHostOf('https://[2001:db8::1]/org/repo.git')).toBe('[2001:db8::1]');
  expect(gitHostOf('https://10.0.0.5/org/repo.git')).toBe('10.0.0.5');
  expect(gitHostOf('git@GitHub.com:org/repo.git')).toBe('github.com');
});
it('never lets a wildcard, list, space or userinfo reach NO_PROXY', () => {
  expect(gitHostOf('*')).toBeNull();
  expect(gitHostOf('https://*/x')).toBeNull();
  expect(gitHostOf('https://a,b.com/x')).toBeNull();
  expect(gitHostOf('https://a b.com/x')).toBeNull();
  expect(gitHostOf('a,b.com:org/repo.git')).toBeNull();
  expect(gitHostOf('*@*:org/repo.git')).toBeNull();
  expect(gitHostOf('https://user:pw@evil.com/x')).toBe('evil.com');
  expect(gitHostOf('ssh://user:pw@host.example/x')).toBe('host.example');
  expect(gitHostOf('user:pw@host.example:org/repo.git')).toBe('host.example');
});

it("'restricted' with an empty team allowlist needs no proxy: it is locked like 'blocked'", async () => {
  h.team.mockResolvedValueOnce({ egressAllowlist: [], orgId: null });
  expect(await beginWorkspaceEgress('team', [], 'restricted')).toBeNull();
  expect(await beginWorkspaceEgress(null, [], 'restricted')).toBeNull();
  h.enabled = false;
  h.team.mockResolvedValueOnce({ egressAllowlist: [], orgId: null });
  expect(await beginWorkspaceEgress('team', [], 'restricted')).toBeNull();
  expect(h.register).not.toHaveBeenCalled();
});
it("'restricted' with an allowlist registers it", async () => {
  await beginWorkspaceEgress('team', [], 'restricted');
  expect(h.register).toHaveBeenCalledWith(['*.example.com']);
});
it("'restricted' with an allowlist refuses (non-retryable) when the proxy is not configured; 'open' runs without it", async () => {
  h.enabled = false;
  await expect(beginWorkspaceEgress('team', [], 'restricted')).rejects.toMatchObject({
    message: expect.stringContaining('restricted'),
    nonRetryable: true,
    type: 'EGRESS_POLICY_UNENFORCEABLE',
  });
  expect(await beginWorkspaceEgress('team', [], 'open')).toBeNull();
});
it("'blocked' registers nothing with the proxy", async () => {
  expect(await beginWorkspaceEgress('team', [], 'blocked')).toBeNull();
  expect(h.register).not.toHaveBeenCalled();
});
it('resolves the policy from the run context at the team scope', async () => {
  settings.resolveSetting.mockResolvedValueOnce('blocked');
  expect(await resolveRunEgressPolicy('team')).toBe('blocked');
  expect(settings.resolveSetting).toHaveBeenCalledWith('workspace.egressPolicy', {
    orgId: 'org-1',
    pinnedSettings: { 'workspace.egressPolicy': 'x' },
    teamId: 'team',
  });
});
it('derives the organization from the team when the run context has none', async () => {
  contextLookup.currentRequestContext.mockResolvedValueOnce({});
  await resolveRunEgressPolicy('team');
  expect(settings.resolveSetting).toHaveBeenLastCalledWith('workspace.egressPolicy', {
    orgId: 'org-1',
    teamId: 'team',
  });
  contextLookup.currentRequestContext.mockResolvedValueOnce({ orgId: 'ctx-org' });
  await resolveRunEgressPolicy('team');
  expect(settings.resolveSetting).toHaveBeenLastCalledWith('workspace.egressPolicy', {
    orgId: 'ctx-org',
    teamId: 'team',
  });
  contextLookup.currentRequestContext.mockResolvedValueOnce({});
  await resolveRunEgressPolicy(null);
  expect(settings.resolveSetting).toHaveBeenLastCalledWith('workspace.egressPolicy', {});
});
it('refuses a restricted step that keeps egress when the proxy is not configured', () => {
  expect(() => assertStepEgressEnforceable('restricted', 'egress')).not.toThrow();
  expect(() => assertStepEgressEnforceable('restricted', 'none')).not.toThrow();
  h.enabled = false;
  expect(() => assertStepEgressEnforceable('open', 'egress')).not.toThrow();
  expect(() => assertStepEgressEnforceable('blocked', 'none')).not.toThrow();
  expect(() => assertStepEgressEnforceable('restricted', 'none')).not.toThrow();
  expect(() => assertStepEgressEnforceable('restricted', 'egress')).toThrow(
    expect.objectContaining({ nonRetryable: true, type: 'EGRESS_POLICY_UNENFORCEABLE' })
  );
});
it('caps a step network by policy', () => {
  expect(capStepNetwork('open', [], 'egress')).toEqual({ capped: false, network: 'egress' });
  expect(capStepNetwork('restricted', ['a.com'], 'egress')).toEqual({
    capped: false,
    network: 'egress',
  });
  expect(capStepNetwork('restricted', [], 'egress')).toEqual({ capped: true, network: 'none' });
  expect(capStepNetwork('blocked', ['a.com'], 'egress')).toEqual({ capped: true, network: 'none' });
  expect(capStepNetwork('blocked', [], undefined)).toEqual({ capped: false, network: 'none' });
});
it('allows the model proxy, a wired registry and the git host on the scheme default port', () => {
  h.modelProxy = true;
  expect(
    blockedEgressAllow('github.com', {
      cleanUrl: 'https://github.com/o/r.git',
      registryUrl: 'http://registry.internal:8791',
    })
  ).toEqual([
    { host: 'host.docker.internal', port: 8790 },
    { host: 'registry.internal', port: 8791 },
    { host: 'github.com', port: 443 },
  ]);
});
it('uses 80 for http, 22 for ssh and scp forms, and an explicit port when named', () => {
  expect(blockedEgressAllow('ghe.corp', { cleanUrl: 'http://ghe.corp/o/r.git' })).toEqual([
    { host: 'ghe.corp', port: 80 },
  ]);
  expect(blockedEgressAllow('ghe.corp', { cleanUrl: 'ssh://git@ghe.corp/o/r.git' })).toEqual([
    { host: 'ghe.corp', port: 22 },
  ]);
  expect(blockedEgressAllow('ghe.corp', { cleanUrl: 'git@ghe.corp:o/r.git' })).toEqual([
    { host: 'ghe.corp', port: 22 },
  ]);
  expect(blockedEgressAllow('ghe.corp', { cleanUrl: 'https://ghe.corp:8443/o/r.git' })).toEqual([
    { host: 'ghe.corp', port: 8443 },
  ]);
  expect(blockedEgressAllow('ghe.corp')).toEqual([
    { host: 'ghe.corp', port: 443 },
    { host: 'ghe.corp', port: 22 },
  ]);
});
it('adds the egress proxy to the lock only when asked', () => {
  expect(
    blockedEgressAllow('github.com', {
      cleanUrl: 'https://github.com/o/r.git',
      egressProxyUrl: 'http://egress.internal:8792',
    })
  ).toEqual([
    { host: 'egress.internal', port: 8792 },
    { host: 'github.com', port: 443 },
  ]);
});

describe('lfsStorageHosts', () => {
  const entries = [
    'github.com=github-cloud.githubusercontent.com',
    'github.com=media.githubusercontent.com',
    'git.corp.example=lfs-objects.corp.example:9000',
  ];

  it('admits the storage hosts listed for the git host, and nothing for an unlisted one', () => {
    expect(lfsStorageHosts('GitHub.com', entries)).toEqual([
      'github-cloud.githubusercontent.com',
      'media.githubusercontent.com',
    ]);
    expect(lfsStorageHosts('git.corp.example', entries)).toEqual(['lfs-objects.corp.example:9000']);
    expect(lfsStorageHosts('ghe.example.com', entries)).toEqual([]);
    expect(lfsStorageHosts(null, entries)).toEqual([]);
  });

  it('opens each storage host on its own port, 443 by default', () => {
    const allow = blockedEgressAllow(null, {
      lfsHosts: ['media.githubusercontent.com', 'lfs-objects.corp.example:9000'],
    });
    expect(allow).toContainEqual({ host: 'media.githubusercontent.com', port: 443 });
    expect(allow).toContainEqual({ host: 'lfs-objects.corp.example', port: 9000 });
  });
});
