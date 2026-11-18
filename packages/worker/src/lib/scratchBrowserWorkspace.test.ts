import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  backend: {
    copyOut: vi.fn(),
    create: vi.fn(),
    exec: vi.fn(),
    execShell: vi.fn(),
    lockEgress: vi.fn(),
    remove: vi.fn(async (_name: string) => {}),
  },
  baseline: ['github.com', 'registry.npmjs.org'] as string[],
  infra: {
    backend: 'docker' as 'docker' | 'kubernetes',
    cpus: 2,
    dns: ['1.1.1.1'],
    harnessModelProxy: { url: 'http://model-proxy:9000' },
    image: 'ghcr.io/acme/workspace-browser:1',
    memory: '4g',
    network: null,
    pidsLimit: 512,
    registryProxy: { url: 'http://registry-proxy:9100' },
  },
  policy: 'restricted' as 'open' | 'restricted' | 'blocked',
  proxy: true,
  register: vi.fn(),
  release: vi.fn(async () => {}),
  team: ['example.com', 'Docs.Example.org'] as string[],
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    team: { findUnique: vi.fn(async () => ({ egressAllowlist: m.team, orgId: null })) },
  },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  DOCKER_HOST_ALIAS: 'host.docker.internal',
  resolveWorkspaceInfra: () => m.infra,
}));
// The allowlist and policy resolution in egressWiring.js is REAL; only the settings it reads, the
// request context and the proxy's `register` call are faked, so what the proxy is told to admit is
// what the production code computes.
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workspace.egressBaselineAllowlist' ? m.baseline : m.policy
  ),
}));
vi.mock('./config/contextLookup.js', () => ({ currentRequestContext: vi.fn(async () => ({})) }));
vi.mock('./toolCatalogLoader.js', () => ({ loadToolCatalog: vi.fn(async () => []) }));
vi.mock('./egressProxy.js', () => ({
  workerEgressProxy: () => (m.proxy ? { register: m.register } : null),
}));
vi.mock('./workspaceBackend/index.js', () => ({ workspaceBackend: () => m.backend }));
vi.mock('./workspaceSizing.js', () => ({
  resolveRunWorkspaceSize: vi.fn(async () => ({ cpus: 1, memory: '2g' })),
}));

import { createScratchBrowserWorkspace } from './scratchBrowserWorkspace.js';

const HANDLE = { id: 'h', keeperPid: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  m.baseline = ['github.com', 'registry.npmjs.org'];
  m.team = ['example.com', 'Docs.Example.org'];
  m.infra.backend = 'docker';
  m.policy = 'restricted';
  m.proxy = true;
  m.register.mockResolvedValue({ release: m.release, token: 'tok', url: 'http://worker:8888' });
  m.backend.create.mockResolvedValue(HANDLE);
  m.backend.lockEgress.mockResolvedValue(undefined);
  m.backend.exec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
});

describe('the allowlist the proxy admits and the browser navigates to', () => {
  it('is the team entries only, identical in the registration and the result, with no baseline', async () => {
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    if (!r.ok) {
      throw new Error('expected a workspace');
    }
    const registered = m.register.mock.calls[0]?.[0] as string[];
    expect(registered).toEqual(['example.com', 'docs.example.org']);
    expect(r.allowedHosts).toEqual(registered);
    expect(r.allowedHostCount).toBe(registered.length);
    expect(registered).not.toContain('github.com');
    expect(registered).not.toContain('registry.npmjs.org');
  });

  it('refuses a team with no entries even though a baseline is configured', async () => {
    m.team = [];
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('allowlist is empty') });
    expect(m.register).not.toHaveBeenCalled();
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('refuses a run with no team at all', async () => {
    const r = await createScratchBrowserWorkspace({ teamId: null });
    expect(r).toMatchObject({ ok: false });
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('refuses on the Kubernetes backend, where cluster DNS stays open, creating nothing', async () => {
    m.infra.backend = 'kubernetes';
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('Kubernetes') });
    expect(m.register).not.toHaveBeenCalled();
    expect(m.backend.create).not.toHaveBeenCalled();
  });
});

describe('createScratchBrowserWorkspace', () => {
  it('creates a no-repository container on the configured image, locked to the egress proxy only', async () => {
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r.ok).toBe(true);

    // The image comes from the resolver, not a literal, and nothing but the proxy wiring is set.
    const spec = m.backend.create.mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      baselineAllow: [],
      cpus: 1,
      image: m.infra.image,
      memory: '2g',
      reachWorker: true,
    });
    expect(spec.name).toMatch(/^workspace-[0-9a-f]{16}$/);
    expect(spec.env).toEqual(expect.arrayContaining(['NODE_USE_ENV_PROXY=1']));
    expect(spec.env.every((e: string) => /^(NO_PROXY|no_proxy|NODE_USE_ENV_PROXY)=/.test(e))).toBe(
      true
    );
    expect(Object.keys(spec.secretEnv).sort()).toEqual([
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'http_proxy',
      'https_proxy',
    ]);
    expect(spec.services).toBeUndefined();
    expect(JSON.stringify(spec)).not.toMatch(/GITHUB|TOKEN=|API_KEY|npmrc/i);

    // Locked to the egress proxy's address alone: no model proxy, registry proxy or git host.
    expect(m.backend.lockEgress).toHaveBeenCalledWith(HANDLE, [{ host: 'worker', port: 8888 }], {
      mode: 'restricted',
    });
    if (r.ok) {
      expect(r.allowedHostCount).toBe(2);
      expect(r.workspace.egressPolicy).toBe('restricted');
    }
  });

  it('also runs restricted when the run policy is open (narrower, never wider)', async () => {
    m.policy = 'open';
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r.ok).toBe(true);
    expect(m.register).toHaveBeenCalledTimes(1);
  });

  it('destroy removes the container and releases the registration, once', async () => {
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    if (!r.ok) {
      throw new Error('expected a workspace');
    }
    await r.workspace.destroy();
    await r.workspace.destroy();
    expect(m.backend.remove).toHaveBeenCalledTimes(1);
    expect(m.backend.remove).toHaveBeenCalledWith(m.backend.create.mock.calls[0]?.[0].name);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('refuses without creating anything when the run policy is blocked', async () => {
    m.policy = 'blocked';
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('blocked') });
    expect(m.register).not.toHaveBeenCalled();
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('refuses without a container when the egress proxy is not configured', async () => {
    m.proxy = false;
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('egress proxy') });
    expect(m.register).not.toHaveBeenCalled();
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('refuses without a container when the effective allowlist is empty', async () => {
    // The baseline is configured and non-empty: it must not make an empty team list usable.
    m.team = [];
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('allowlist is empty') });
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('removes the container and releases the registration when creation fails', async () => {
    m.backend.create.mockRejectedValue(new Error('docker run failed'));
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('docker run failed') });
    // A `docker run` that timed out may still have made the container: removed by name.
    expect(m.backend.remove).toHaveBeenCalledWith(m.backend.create.mock.calls[0]?.[0].name);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('removes the container when the network lock cannot be applied', async () => {
    m.backend.lockEgress.mockRejectedValue(new Error('no NET_ADMIN'));
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false });
    expect(m.backend.remove).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('removes the container when the proxy registration itself fails', async () => {
    m.register.mockRejectedValue(new Error('proxy down'));
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('proxy down') });
    expect(m.backend.create).not.toHaveBeenCalled();
  });

  it('removes the container and reports it when the image has no browser', async () => {
    m.backend.exec.mockResolvedValue({ exitCode: 1, stderr: 'no playwright', stdout: '' });
    const r = await createScratchBrowserWorkspace({ teamId: 'team-1' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('no browser') });
    expect(m.backend.remove).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
  });
});
