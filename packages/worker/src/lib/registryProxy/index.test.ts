import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createRegistryProxy, tarballVersion } from './index.js';
import { registryWorkspaceEnv, renderNpmrc, renderYarnrc } from './render.js';

vi.mock('../activityLog.js', () => ({ logWarn: vi.fn() }));

const REG = {
  allowPrivateNetwork: false,
  authKind: 'bearer' as const,
  id: 'reg-1',
  name: 'npmjs',
  token: 'up-token',
  upstreamUrl: 'http://upstream.test',
};

/** A real proxy on 127.0.0.1:0 with a stub upstreamFetch. */
async function startProxy(upstream: (url: string, init?: RequestInit) => Promise<Response>) {
  const proxy = createRegistryProxy({
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamFetch: upstream as never,
  });
  const port = await proxy.listen();
  return { base: `http://127.0.0.1:${port}`, proxy };
}

const get = (base: string, path: string, token?: string, method = 'GET') =>
  new Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }>((resolve) => {
    const req = http.request(
      `${base}${path}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {}, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
            status: res.statusCode ?? 0,
          })
        );
      }
    );
    req.end();
  });

describe('registry proxy', () => {
  it('rejects unknown tokens, non-GET methods, and bad paths; serves packuments rewritten', async () => {
    const { base, proxy } = await startProxy(async (url) => {
      expect(url).toBe('http://upstream.test/left-pad');
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.3.0' },
          versions: {
            '1.3.0': { dist: { tarball: 'http://upstream.test/left-pad/-/left-pad-1.3.0.tgz' } },
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    // 503 until the allowlist is set
    expect((await get(base, `/npm/${REG.id}/left-pad`, reg.token)).status).toBe(503);
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/left-pad`)).status).toBe(401);
    expect((await get(base, `/npm/${REG.id}/left-pad`, reg.token, 'POST')).status).toBe(405);
    expect((await get(base, `/npm/nope/left-pad`, reg.token)).status).toBe(404);
    expect((await get(base, `/npm/${REG.id}/-/whoami`, reg.token)).status).toBe(404);
    const res = await get(base, `/npm/${REG.id}/left-pad`, reg.token);
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.versions['1.3.0'].dist.tarball).toBe(
      `${reg.baseUrl}/npm/${REG.id}/left-pad/-/left-pad-1.3.0.tgz`
    );
    await proxy.close();
  });

  it('enforces the lockfile allowlist on packuments and tarballs', async () => {
    const denials: unknown[] = [];
    const packument = JSON.stringify({
      'dist-tags': { beta: '2.0.0', latest: '2.0.0' },
      time: { '1.0.0': 't', '2.0.0': 't', created: 't' },
      versions: {
        '1.0.0': { dist: { tarball: 'http://u/left-pad/-/left-pad-1.0.0.tgz' } },
        '2.0.0': { dist: { tarball: 'http://u/left-pad/-/left-pad-2.0.0.tgz' } },
      },
    });
    const { base, proxy } = await startProxy(async (url) => {
      if (url.endsWith('.tgz')) {
        return new Response('TARBALL', { status: 200 });
      }
      return new Response(packument, { status: 200 });
    });
    const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['left-pad', new Set(['1.0.0'])]])]]));
    const res = await get(base, `/npm/${REG.id}/left-pad`, reg.token);
    const doc = JSON.parse(res.body);
    expect(Object.keys(doc.versions)).toEqual(['1.0.0']);
    expect(doc['dist-tags'].latest).toBe('1.0.0');
    expect(doc['dist-tags'].beta).toBeUndefined();
    expect(doc.time['2.0.0']).toBeUndefined();
    // allowed tarball
    expect((await get(base, `/npm/${REG.id}/left-pad/-/left-pad-1.0.0.tgz`, reg.token)).body).toBe(
      'TARBALL'
    );
    // denied tarball
    const denied = await get(base, `/npm/${REG.id}/left-pad/-/left-pad-2.0.0.tgz`, reg.token);
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('left-pad@2.0.0 is not in the repository');
    // denied packument (name absent from allowlist)
    expect((await get(base, `/npm/${REG.id}/other-pkg`, reg.token)).status).toBe(403);
    expect(denials.length).toBeGreaterThanOrEqual(2);
    await reg.release();
    expect((await get(base, `/npm/${REG.id}/left-pad`, reg.token)).status).toBe(401);
    await proxy.close();
  });

  it('sends the credential header upstream and identity accept-encoding', async () => {
    const seen: Record<string, string | undefined> = {};
    const { base, proxy } = await startProxy(async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      seen.auth = h?.authorization;
      seen.ae = h?.['accept-encoding'];
      seen.accept = h?.accept;
      return new Response('{}', { status: 200 });
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    await get(base, `/npm/${REG.id}/pkg`, reg.token);
    expect(seen.auth).toBe('Bearer up-token');
    expect(seen.ae).toBe('identity');
    await proxy.close();
  });
});

describe('path validation', () => {
  const PATHS = ['..', '.%2e', '%2e%2e', '@x/..', 'foo/-/..%2fx.tgz', 'foo/-/.x.tgz'];
  for (const mode of ['open', 'lockfile'] as const) {
    it(`rejects traversal shapes in ${mode} mode without an upstream call`, async () => {
      const upstream = vi.fn(async () => new Response('x'));
      const { base, proxy } = await startProxy(upstream as never);
      const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
      reg.setAllowlist(
        mode === 'open' ? new Map([[REG.id, null]]) : new Map([[REG.id, new Map()]])
      );
      for (const p of PATHS) {
        const res = await get(base, `/npm/${REG.id}/${p}`, reg.token);
        expect(res.status, p).toBe(404);
      }
      expect(upstream).not.toHaveBeenCalled();
      await proxy.close();
    });
  }
});

describe('tarballVersion', () => {
  it('parses unscoped and scoped names', () => {
    expect(tarballVersion('left-pad', 'left-pad-1.3.0.tgz')).toBe('1.3.0');
    expect(tarballVersion('@acme/lib', 'lib-2.0.0.tgz')).toBe('2.0.0');
    expect(tarballVersion('left-pad', 'other-1.0.0.tgz')).toBeNull();
  });
});

describe('npmrc rendering', () => {
  const regs = [
    { accessMode: 'lockfile', id: 'r1', isDefault: true, name: 'npmjs', scopes: [] },
    { accessMode: 'lockfile', id: 'r2', isDefault: false, name: 'acme', scopes: ['@acme'] },
  ];
  it('renders auth lines per registry and scope lines', () => {
    const npmrc = renderNpmrc(regs, 'http://host.docker.internal:9999', 'tok123');
    expect(npmrc).toContain('//host.docker.internal:9999/npm/r1/:_authToken=tok123');
    expect(npmrc).toContain('//host.docker.internal:9999/npm/r2/:_authToken=tok123');
    expect(npmrc).toContain('@acme:registry=http://host.docker.internal:9999/npm/r2');
  });
  it('renders yarnrc scopes and env', () => {
    const y = renderYarnrc(regs, 'http://h:1');
    expect(y).toContain('npmRegistryServer: "http://h:1/npm/r2"');
    const env = registryWorkspaceEnv(regs, 'http://h:1', 'tok');
    expect(env.join(' ')).toContain('NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc');
    expect(env.join(' ')).toContain('NPM_CONFIG_REGISTRY=http://h:1/npm/r1');
    expect(env.join(' ')).toContain('YARN_NPM_AUTH_TOKEN=tok');
  });
});
