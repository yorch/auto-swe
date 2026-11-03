import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  modelProxy: false,
  register: vi.fn(async () => ({
    release: vi.fn(),
    token: 'random-secret',
    url: 'http://host.docker.internal:8792',
  })),
  team: vi.fn(async (_args?: unknown) => ({
    egressAllowlist: ['*.example.com'] as string[],
    orgId: 'org-1' as string | null,
  })),
}));
vi.mock('./egressProxy.js', () => ({
  workerEgressProxy: () => (h.enabled ? { register: h.register } : null),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { team: { findUnique: h.team } } }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({
    ...(h.modelProxy ? { harnessModelProxy: { url: 'http://host.docker.internal:8790' } } : {}),
    registryProxy: { url: 'http://registry.internal:8791' },
  }),
}));
const settings = vi.hoisted(() => ({ resolveSetting: vi.fn(async () => 'open') }));
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
  resolveRunEgressPolicy,
} from './egressWiring.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.modelProxy = false;
});
it('does nothing when disabled without querying the team', async () => {
  h.enabled = false;
  expect(await beginWorkspaceEgress('team')).toBeNull();
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
    'NO_PROXY=localhost,127.0.0.1,::1,registry.internal',
    'no_proxy=localhost,127.0.0.1,::1,registry.internal',
  ]);
});
it('supports no team and does not hide registration failures', async () => {
  await beginWorkspaceEgress(null);
  expect(h.register).toHaveBeenCalledWith([]);
  expect(h.team).not.toHaveBeenCalled();
  h.register.mockRejectedValueOnce(new Error('bind failed'));
  await expect(beginEgressAccess([])).rejects.toThrow('bind failed');
});
it('lets the repository git host bypass the proxy', async () => {
  const access = await beginWorkspaceEgress('team', ['ghe.corp.internal']);
  expect(access?.env).toEqual([
    'NO_PROXY=localhost,127.0.0.1,::1,registry.internal,ghe.corp.internal',
    'no_proxy=localhost,127.0.0.1,::1,registry.internal,ghe.corp.internal',
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
