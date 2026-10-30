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

import { beginEgressAccess, beginWorkspaceEgress } from './egressWiring.js';

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
