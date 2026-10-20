import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createRegistryProxy, tarballVersion } from './index.js';
import { registryWorkspaceEnv, renderNpmrc, renderYarnrc } from './render.js';

vi.mock('../activityLog.js', () => ({ logWarn: vi.fn() }));

const REG = {
  allowPrivateNetwork: false,
  authKind: 'bearer' as const,
  id: 'reg-1',
  isDefault: true,
  name: 'npmjs',
  scopes: [] as string[],
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

describe('name-based routing and prefixed tarball paths', () => {
  const SCOPED = {
    ...REG,
    id: 'reg-scoped',
    isDefault: false,
    name: 'acme',
    scopes: ['@acme'],
    upstreamUrl: 'http://acme.test',
  };
  const getTarball = async (path: string, reg: { token: string }, base: string) =>
    get(base, path, reg.token);

  const start = async (upstream: (url: string) => Promise<Response>) => {
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, SCOPED] });
    reg.setAllowlist(
      new Map([
        [REG.id, null],
        [SCOPED.id, null],
      ])
    );
    return { base, proxy, reg };
  };

  it('serves an Artifactory-prefixed unscoped tarball through the default registry', async () => {
    const seen: string[] = [];
    const { base, proxy, reg } = await start(async (url) => {
      seen.push(url);
      return new Response('TARBALL');
    });
    const res = await getTarball(
      `/npm/${REG.id}/artifactory/api/npm/npm-remote/left-pad/-/left-pad-1.3.0.tgz`,
      reg,
      base
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(['http://upstream.test/left-pad/-/left-pad-1.3.0.tgz']);
    await proxy.close();
  });

  it('serves an Artifactory-prefixed scoped tarball with the @scope/ file form', async () => {
    const seen: string[] = [];
    const { base, proxy, reg } = await start(async (url) => {
      seen.push(url);
      return new Response('TARBALL');
    });
    const res = await getTarball(
      `/npm/${SCOPED.id}/artifactory/api/npm/npm-remote/@acme/lib/-/@acme/lib-1.0.0.tgz`,
      reg,
      base
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(['http://acme.test/@acme/lib/-/lib-1.0.0.tgz']);
    await proxy.close();
  });

  it('routes a scoped tarball addressed to the default id to the scoped registry', async () => {
    const seen: string[] = [];
    const { base, proxy, reg } = await start(async (url) => {
      seen.push(url);
      return new Response('TARBALL');
    });
    const res = await getTarball(`/npm/${REG.id}/@acme/lib/-/lib-1.0.0.tgz`, reg, base);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['http://acme.test/@acme/lib/-/lib-1.0.0.tgz']);
    await proxy.close();
  });

  it('routes an unscoped request on the scoped id to the default registry', async () => {
    const seen: string[] = [];
    const { base, proxy, reg } = await start(async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ versions: {} }));
    });
    const res = await getTarball(`/npm/${SCOPED.id}/left-pad`, reg, base);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['http://upstream.test/left-pad']);
    await proxy.close();
  });

  it('answers 404 when no default registry is registered', async () => {
    const { base, proxy } = await startProxy(async () => new Response('x'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [SCOPED] });
    reg.setAllowlist(new Map([[SCOPED.id, null]]));
    const res = await get(base, `/npm/${SCOPED.id}/left-pad`, reg.token);
    expect(res.status).toBe(404);
    expect(res.body).toContain('no registry serves left-pad');
    await proxy.close();
  });

  it('rejects prefix dot-segments with 404 and zero upstream calls', async () => {
    let calls = 0;
    const { base, proxy, reg } = await start(async () => {
      calls += 1;
      return new Response('x');
    });
    for (const path of [
      `/npm/${REG.id}/../left-pad/-/left-pad-1.3.0.tgz`,
      `/npm/${REG.id}/%2e%2e/left-pad/-/left-pad-1.3.0.tgz`,
    ]) {
      expect((await get(base, path, reg.token)).status).toBe(404);
    }
    expect(calls).toBe(0);
    await proxy.close();
  });

  it('still denies lockfile-mode tarballs after routing', async () => {
    const denials: { name: string; registryId: string }[] = [];
    const { base, proxy } = await startProxy(async () => new Response('x'));
    const reg = await proxy.register({
      onDenied: (d) => denials.push(d),
      registries: [REG, SCOPED],
    });
    reg.setAllowlist(
      new Map([
        [REG.id, new Map([['left-pad', new Set(['1.0.0'])]])],
        [SCOPED.id, null],
      ])
    );
    const res = await get(base, `/npm/${REG.id}/left-pad/-/left-pad-1.3.0.tgz`, reg.token);
    expect(res.status).toBe(403);
    expect(denials).toEqual([
      { name: 'left-pad', reason: 'not-in-lockfile', registryId: REG.id, version: '1.3.0' },
    ]);
    await proxy.close();
  });
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
  it('whitelists the http proxy for Berry even with only a default registry', () => {
    const y = renderYarnrc([regs[0] as (typeof regs)[number]], 'http://h:1');
    expect(y).toContain('unsafeHttpWhitelist:\n  - "h"');
    expect(y).not.toContain('npmScopes');
    expect(renderYarnrc([], 'http://h:1')).toBeNull();
  });
});

describe('version manifests (Corepack)', () => {
  const manifest = (over: object = {}) => ({
    dist: {
      integrity: 'sha512-AAAA',
      signatures: [{ keyid: 'SHA256:x', sig: 'c2ln' }],
      tarball: 'http://upstream.test/pnpm/-/pnpm-9.15.9.tgz',
    },
    name: 'pnpm',
    version: '9.15.9',
    ...over,
  });

  it('serves /pnpm/9.15.9 with the upstream credential and rewrites dist.tarball only', async () => {
    const calls: { auth?: string; url: string }[] = [];
    const { base, proxy } = await startProxy(async (url, init) => {
      calls.push({
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
        url,
      });
      return new Response(JSON.stringify(manifest()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['pnpm', new Set(['9.15.9'])]])]]));
    const res = await get(base, `/npm/${REG.id}/pnpm/9.15.9`, reg.token);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ auth: 'Bearer up-token', url: 'http://upstream.test/pnpm/9.15.9' }]);
    const doc = JSON.parse(res.body);
    expect(doc.dist.tarball).toBe(`${reg.baseUrl}/npm/${REG.id}/pnpm/-/pnpm-9.15.9.tgz`);
    expect(doc.dist.signatures).toEqual([{ keyid: 'SHA256:x', sig: 'c2ln' }]);
    expect(doc.dist.integrity).toBe('sha512-AAAA');
    await proxy.close();
  });

  it('serves scoped version manifests, literal and %2f-encoded alike', async () => {
    const calls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify(manifest({ name: '@yarnpkg/cli-dist', version: '4.5.0' })),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }
      );
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['@yarnpkg/cli-dist', new Set(['4.5.0'])]])]]));
    for (const path of ['/@yarnpkg/cli-dist/4.5.0', '/@yarnpkg%2fcli-dist/4.5.0']) {
      const res = await get(base, `/npm/${REG.id}${path}`, reg.token);
      expect(res.status).toBe(200);
    }
    expect(calls).toEqual([
      'http://upstream.test/@yarnpkg%2fcli-dist/4.5.0',
      'http://upstream.test/@yarnpkg%2fcli-dist/4.5.0',
    ]);
    await proxy.close();
  });

  it('denies a version outside the allowlist without calling upstream', async () => {
    let called = false;
    const { base, proxy } = await startProxy(async () => {
      called = true;
      return new Response('{}');
    });
    const denials: { name?: string; version?: string }[] = [];
    const reg = await proxy.register({
      onDenied: (d) => denials.push(d),
      registries: [REG],
    });
    reg.setAllowlist(new Map([[REG.id, new Map([['pnpm', new Set(['9.15.9'])]])]]));
    const res = await get(base, `/npm/${REG.id}/pnpm/9.15.8`, reg.token);
    expect(res.status).toBe(403);
    expect(res.body).toContain("is not in the repository's committed lockfiles");
    expect(denials).toEqual([
      { name: 'pnpm', reason: 'not-in-lockfile', registryId: 'reg-1', version: '9.15.8' },
    ]);
    expect(called).toBe(false);
    await proxy.close();
  });

  it('denies dist-tags in lockfile mode and forwards them in open mode', async () => {
    const calls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(manifest()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['pnpm', new Set(['9.15.9'])]])]]));
    expect((await get(base, `/npm/${REG.id}/pnpm/latest`, reg.token)).status).toBe(403);
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/pnpm/latest`, reg.token)).status).toBe(200);
    expect(calls).toEqual(['http://upstream.test/pnpm/latest']);
    await proxy.close();
  });

  it('404s invalid version segments without calling upstream', async () => {
    let called = false;
    const { base, proxy } = await startProxy(async () => {
      called = true;
      return new Response('{}');
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    for (const v of ['..', '%2e%2e', '.hidden', 'a%2fb', 'x%2f..']) {
      expect((await get(base, `/npm/${REG.id}/pnpm/${v}`, reg.token)).status).toBe(404);
    }
    expect(called).toBe(false);
    await proxy.close();
  });

  it('serves a literal-slash scoped packument and applies the allowlist', async () => {
    const calls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { dist: { tarball: 'http://upstream.test/@s/p/-/p-1.0.0.tgz' } } },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['@s/p', new Set(['1.0.0'])]])]]));
    const res = await get(base, `/npm/${REG.id}/@s/p`, reg.token);
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.versions['1.0.0'].dist.tarball).toBe(
      `${reg.baseUrl}/npm/${REG.id}/@s/p/-/p-1.0.0.tgz`
    );
    expect(calls).toEqual(['http://upstream.test/@s%2fp']);
    await proxy.close();
  });

  it('404s a third trailing segment after the name', async () => {
    let called = false;
    const { base, proxy } = await startProxy(async () => {
      called = true;
      return new Response('{}');
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/pkg/1.0.0/extra`, reg.token)).status).toBe(404);
    expect(called).toBe(false);
    await proxy.close();
  });
});
