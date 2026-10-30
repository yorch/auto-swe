import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  register: vi.fn(async () => ({
    release: vi.fn(),
    token: 'random-secret',
    url: 'http://host.docker.internal:8792',
  })),
  team: vi.fn(async () => ({ egressAllowlist: ['*.example.com'] })),
}));
vi.mock('./egressProxy.js', () => ({
  workerEgressProxy: () => (h.enabled ? { register: h.register } : null),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { team: { findUnique: h.team } } }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({ registryProxy: { url: 'http://registry.internal:8791' } }),
}));

import { beginEgressAccess, beginWorkspaceEgress, gitHostOf } from './egressWiring.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
});
it('does nothing when disabled without querying the team', async () => {
  h.enabled = false;
  expect(await beginWorkspaceEgress('team')).toBeNull();
  expect(h.team).not.toHaveBeenCalled();
  expect(h.register).not.toHaveBeenCalled();
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
