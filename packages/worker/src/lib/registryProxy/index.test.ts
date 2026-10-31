import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { buildGoAllowlist, parseGoSum } from '@auto-swe/shared/lib/goModuleAllowlist';
import type * as GuardedDispatcher from '@auto-swe/shared/lib/guardedDispatcher';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { buildPypiAllowlist } from '@auto-swe/shared/lib/pypiAllowlist';
import { describe, expect, it, vi } from 'vitest';
import {
  checkAuditBody,
  checkLegacyAuditBody,
  createRegistryProxy,
  TarballCache,
  tarballVersion,
} from './index.js';
import { fileIdFor } from './pypiProxy.js';
import {
  registryWorkspaceEnv,
  renderNpmrc,
  renderYarnrc,
  splitRegistryWorkspaceEnv,
} from './render.js';

vi.mock('../activityLog.js', () => ({ logWarn: vi.fn() }));

// Passes through to the real guarded fetch; the PyPI file tests replace it to see which private-
// network setting each fetch was built with. Every other test injects `upstreamFetch` and never
// reaches it.
vi.mock('@auto-swe/shared/lib/guardedDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof GuardedDispatcher>();
  return { ...actual, createGuardedFetch: vi.fn(actual.createGuardedFetch) };
});

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
async function startProxy(
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  limits: {
    maxBufferedFetches?: number;
    maxQueuedFetches?: number;
    queueWaitMs?: number;
    upstreamDeadlineMs?: number;
  } = {}
) {
  const proxy = createRegistryProxy({
    ...limits,
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamFetch: upstream as never,
  });
  const port = await proxy.listen();
  return { base: `http://127.0.0.1:${port}`, proxy };
}

it('runs upstream requests in the registering activity context, not the server context', async () => {
  const context = new AsyncLocalStorage<string>();
  const seen: (string | undefined)[] = [];
  const { base, proxy } = await startProxy(async () => {
    seen.push(context.getStore());
    return new Response(JSON.stringify({ versions: {} }));
  });
  try {
    const reg = await context.run('activity-one', () =>
      proxy.register({ onDenied: () => {}, registries: [REG] })
    );
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/left-pad`, reg.token)).status).toBe(200);
    expect(seen).toEqual(['activity-one']);
    await reg.release();
  } finally {
    await proxy.close();
  }
});

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

describe('buffered fetch concurrency', () => {
  /** An upstream whose packument answers wait on `open()`; tarballs answer at once. */
  function gatedUpstream() {
    let started = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const upstream = async (url: string) => {
      if (url.endsWith('.tgz')) {
        return new Response('TARBALL', { status: 200 });
      }
      started++;
      await gate;
      return new Response('{}', { status: 200 });
    };
    return { open: () => open(), started: () => started, upstream };
  }
  /** Polls `done` until it holds, so a slow runner waits longer instead of racing a fixed sleep. */
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !done(); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(done()).toBe(true);
  }

  it('holds surplus packument requests, then answers 503 past the bounded queue', async () => {
    const g = gatedUpstream();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 1,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const first = get(base, `/npm/${REG.id}/one`, reg.token);
    await until(() => g.started() === 1);
    // One fetch holds the slot, one of these two waits for it and the other finds the queue full,
    // whichever the proxy sees first. The full one answers at once; the waiting one answers only
    // after the gate opens.
    const second = get(base, `/npm/${REG.id}/two`, reg.token);
    const third = get(base, `/npm/${REG.id}/three`, reg.token);
    const refused = await Promise.race([second, third]);
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(g.started()).toBe(1);
    g.open();
    expect((await first).status).toBe(200);
    const waited = refused === (await second) ? await third : await second;
    expect(waited.status).toBe(200);
    expect(g.started()).toBe(2);
    await proxy.close();
  });

  it('answers 503 to a request that waits longer than the queue allows', async () => {
    const g = gatedUpstream();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 4,
      queueWaitMs: 40,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const first = get(base, `/npm/${REG.id}/one`, reg.token);
    await until(() => g.started() === 1);
    expect((await get(base, `/npm/${REG.id}/two`, reg.token)).status).toBe(503);
    g.open();
    expect((await first).status).toBe(200);
    await proxy.close();
  });

  it('does not count tarballs, which stream, against the limit', async () => {
    const g = gatedUpstream();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const held = get(base, `/npm/${REG.id}/one`, reg.token);
    await until(() => g.started() === 1);
    const tarball = await get(base, `/npm/${REG.id}/one/-/one-1.0.0.tgz`, reg.token);
    expect(tarball.status).toBe(200);
    expect(tarball.body).toBe('TARBALL');
    g.open();
    await held;
    await proxy.close();
  });

  it('gives the slot back when a fetch fails, so later requests are served', async () => {
    let calls = 0;
    const { base, proxy } = await startProxy(
      async () => {
        calls++;
        if (calls === 1) {
          throw new Error('connection reset');
        }
        return new Response('{}', { status: 200 });
      },
      { maxBufferedFetches: 1, maxQueuedFetches: 0 }
    );
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/pkg`, reg.token)).status).toBe(502);
    expect((await get(base, `/npm/${REG.id}/pkg`, reg.token)).status).toBe(200);
    await proxy.close();
  });

  it('limits each registration separately', async () => {
    const g = gatedUpstream();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const a = await proxy.register({ onDenied: () => {}, registries: [REG] });
    const b = await proxy.register({ onDenied: () => {}, registries: [REG] });
    a.setAllowlist(new Map([[REG.id, null]]));
    b.setAllowlist(new Map([[REG.id, null]]));
    const heldA = get(base, `/npm/${REG.id}/one`, a.token);
    await until(() => g.started() === 1);
    const heldB = get(base, `/npm/${REG.id}/one`, b.token);
    await until(() => g.started() === 2);
    expect((await get(base, `/npm/${REG.id}/two`, a.token)).status).toBe(503);
    g.open();
    await Promise.all([heldA, heldB]);
    await proxy.close();
  });

  it('answers 502 and frees the slot when the upstream outlasts the deadline', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    let calls = 0;
    const { base, proxy } = await startProxy(
      (url, init) => {
        calls++;
        if (calls === 1) {
          return hang(url, init);
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      { maxBufferedFetches: 1, maxQueuedFetches: 0, upstreamDeadlineMs: 30 }
    );
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await get(base, `/npm/${REG.id}/slow`, reg.token)).status).toBe(502);
    expect((await get(base, `/npm/${REG.id}/fast`, reg.token)).status).toBe(200);
    await proxy.close();
  });

  it('does not take a slot for a packument the allowlist denies', async () => {
    const g = gatedUpstream();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['one', new Set(['1.0.0'])]])]]));
    const held = get(base, `/npm/${REG.id}/one`, reg.token);
    await until(() => g.started() === 1);
    expect((await get(base, `/npm/${REG.id}/other`, reg.token)).status).toBe(403);
    g.open();
    await held;
    await proxy.close();
  });
});

const AUDIT = '/-/npm/v1/security/advisories/bulk';

const post = (
  base: string,
  path: string,
  token: string | undefined,
  body: Buffer | string,
  gz = false
) =>
  new Promise<{ body: string; status: number }>((resolve) => {
    const req = http.request(
      `${base}${path}`,
      {
        headers: {
          'content-type': 'application/json',
          ...(gz ? { 'content-encoding': 'gzip' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        method: 'POST',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString(), status: res.statusCode ?? 0 })
        );
      }
    );
    req.end(body);
  });

describe('checkAuditBody', () => {
  it('accepts only an object of package names to version lists', () => {
    expect(checkAuditBody('{"left-pad":["1.3.0"],"@s/p":["2.0.0","2.0.1"]}')).toEqual({
      '@s/p': ['2.0.0', '2.0.1'],
      'left-pad': ['1.3.0'],
    });
    for (const bad of [
      'nope',
      '[]',
      '{}',
      '"x"',
      '{"left-pad":"1.0.0"}',
      '{"left-pad":[]}',
      '{"left-pad":[1]}',
      '{"left-pad":["1.0.0; curl x"]}',
      '{"not a name":["1.0.0"]}',
      '{"__proto__":["1.0.0"]}',
      '{"../x":["1.0.0"]}',
    ]) {
      expect(typeof checkAuditBody(bad)).toBe('string');
    }
  });
});

describe('registry proxy audit passthrough', () => {
  const upstreamAnswer = JSON.stringify({ 'left-pad': [{ id: 1, severity: 'high' }] });

  it('relays a well-formed bulk advisory query with the registry credential', async () => {
    const seen: Array<{ body: string; headers: Record<string, string>; url: string }> = [];
    const { base, proxy } = await startProxy(async (url, init) => {
      seen.push({
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
        url,
      });
      return new Response(upstreamAnswer, { status: 200 });
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const body = JSON.stringify({ 'left-pad': ['1.3.0'] });
    // gzip, as npm sends it
    const res = await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, gzipSync(body), true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)['left-pad'][0].severity).toBe('high');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`http://upstream.test${AUDIT}`);
    expect(seen[0]?.body).toBe(body);
    expect(seen[0]?.headers.authorization).toBe('Bearer up-token');
    await proxy.close();
  });

  it('refuses without a token, before the allowlist is ready, and for other POST paths', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    const body = JSON.stringify({ 'left-pad': ['1.3.0'] });
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, undefined, body)).status).toBe(401);
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, body)).status).toBe(503);
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect(
      (await post(base, `/npm/${REG.id}/-/npm/v1/security/advisories`, reg.token, body)).status
    ).toBe(405);
    expect(
      (await post(base, `/npm/${REG.id}/-/user/org.couchdb.user:x`, reg.token, body)).status
    ).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('refuses a body that is not a package/version map, and never calls upstream', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    for (const bad of ['garbage', '{"left-pad":["1.0.0 && id"]}', '{"x":{"y":1}}']) {
      expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, bad)).status).toBe(400);
    }
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, Buffer.from('not gzip'), true)).status
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('in lockfile mode refuses a name or version the lockfile does not hold', async () => {
    const denials: unknown[] = [];
    const upstream = vi.fn(async () => new Response(upstreamAnswer, { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['left-pad', new Set(['1.3.0'])]])]]));
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"left-pad":["1.3.0"]}')).status
    ).toBe(200);
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"left-pad":["1.3.0","9.9.9"]}'))
        .status
    ).toBe(403);
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"exfil":["1.0.0"]}')).status
    ).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(denials).toHaveLength(2);
    await proxy.close();
  });

  it('refuses an audit naming a package another registry serves, rather than sending it to the default', async () => {
    const upstream = vi.fn(async () => new Response(upstreamAnswer, { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const priv = {
      ...REG,
      id: 'reg-private',
      isDefault: false,
      scopes: ['@acme'],
      upstreamUrl: 'http://priv.test',
    };
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, priv] });
    reg.setAllowlist(
      new Map([
        [REG.id, null],
        [priv.id, null],
      ])
    );
    const res = await post(
      base,
      `/npm/${REG.id}${AUDIT}`,
      reg.token,
      '{"left-pad":["1.3.0"],"@acme/secret":["1.0.0"]}'
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/another registry/);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('answers 502 when the upstream cannot be reached', async () => {
    const { base, proxy } = await startProxy(async () => {
      throw new Error('down');
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"left-pad":["1.3.0"]}')).status
    ).toBe(502);
    await proxy.close();
  });
});

/** The tree pnpm posts: an importer holding the lockfile's packages, each with its own subtree. */
const pnpmTree = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    dependencies: {
      '.': {
        dependencies: {
          '@s/p': {
            dependencies: { inner: { dev: true, version: '0.1.0' } },
            dev: false,
            integrity: 'sha512-xyz',
            requires: { inner: '0.1.0' },
            version: '2.0.0',
          },
          'left-pad': { dev: false, integrity: 'sha512-AbC+/=', version: '1.3.0' },
        },
        dev: false,
        requires: { '@s/p': '2.0.0', 'left-pad': '1.3.0' },
        version: '1.0.0',
      },
    },
    dev: false,
    install: [],
    metadata: {},
    remove: [],
    requires: { '.': '1.0.0' },
    ...extra,
  });

describe('checkLegacyAuditBody', () => {
  it('reads the packages, nested ones included, and not the importers', () => {
    const r = checkLegacyAuditBody(pnpmTree());
    expect(typeof r).toBe('object');
    expect((r as { pairs: unknown }).pairs).toEqual({
      '@s/p': ['2.0.0'],
      inner: ['0.1.0'],
      'left-pad': ['1.3.0'],
    });
  });

  it('refuses anything that is not that tree', () => {
    const tree = JSON.parse(pnpmTree());
    const withNode = (patch: Record<string, unknown>) => {
      const t = structuredClone(tree);
      Object.assign(t.dependencies['.'].dependencies['left-pad'], patch);
      return JSON.stringify(t);
    };
    for (const bad of [
      'nope',
      '[]',
      '{}',
      pnpmTree({ extra: 'x' }),
      pnpmTree({ install: ['left-pad'] }),
      pnpmTree({ metadata: { note: 'free text' } }),
      pnpmTree({ name: 'x' }),
      pnpmTree({ dev: true }),
      withNode({ note: 'smuggled' }),
      withNode({ version: '1.0.0; id' }),
      withNode({ integrity: 'sha512-x; curl evil' }),
      withNode({ integrity: 'a'.repeat(2000) }),
      withNode({ dev: 'yes' }),
      withNode({ requires: { 'left-pad': { nested: 1 } } }),
      withNode({ dependencies: { '../x': { version: '1.0.0' } } }),
      withNode({ dependencies: [] }),
      JSON.stringify({ ...tree, dependencies: { __proto__: tree.dependencies['.'] } }),
      JSON.stringify({ ...tree, dependencies: { '.': { dependencies: {}, version: '1.0.0' } } }),
    ]) {
      expect(typeof checkLegacyAuditBody(bad), bad.slice(0, 80)).toBe('string');
    }
  });

  it('bounds the depth of the tree', () => {
    let node: Record<string, unknown> = { version: '1.0.0' };
    for (let i = 0; i < 150; i++) {
      node = { dependencies: { p: node }, version: '1.0.0' };
    }
    const deep = JSON.stringify({ dependencies: { '.': node } });
    expect(typeof checkLegacyAuditBody(deep)).toBe('string');
  });

  it('forwards the validated tree, not the bytes it was sent', () => {
    const r = checkLegacyAuditBody(`  ${pnpmTree()}  `) as { body: string };
    expect(JSON.parse(r.body)).toEqual(JSON.parse(pnpmTree()));
  });
});

describe('registry proxy legacy (pnpm) audit', () => {
  const QUICK = '/-/npm/v1/security/audits/quick';
  const LEGACY = '/-/npm/v1/security/audits';
  const answer = JSON.stringify({ advisories: {}, metadata: {} });

  it('relays both legacy endpoints to the default registry with its credential', async () => {
    const seen: Array<{ headers: Record<string, string>; url: string }> = [];
    const { base, proxy } = await startProxy(async (url, init) => {
      seen.push({ headers: init?.headers as Record<string, string>, url });
      return new Response(answer, { status: 200 });
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    for (const path of [QUICK, LEGACY]) {
      const res = await post(base, `/npm/${REG.id}${path}`, reg.token, pnpmTree());
      expect(res.status).toBe(200);
      expect(res.body).toBe(answer);
    }
    expect(seen.map((x) => x.url)).toEqual([
      `http://upstream.test${QUICK}`,
      `http://upstream.test${LEGACY}`,
    ]);
    expect(
      seen.every(
        (x) =>
          x.headers.authorization === 'Bearer up-A' || x.headers.authorization === 'Bearer up-token'
      )
    ).toBe(true);
    await proxy.close();
  });

  it('relays an upstream that does not serve it, so the client sees the 404', async () => {
    const { base, proxy } = await startProxy(async () => new Response('gone', { status: 404 }));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await post(base, `/npm/${REG.id}${QUICK}`, reg.token, pnpmTree())).status).toBe(404);
    await proxy.close();
  });

  it('refuses a malformed tree before the upstream is asked', async () => {
    const upstream = vi.fn(async () => new Response(answer, { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect(
      (await post(base, `/npm/${REG.id}${QUICK}`, reg.token, '{"dependencies":{}}')).status
    ).toBe(400);
    expect(
      (await post(base, `/npm/${REG.id}${QUICK}`, reg.token, pnpmTree({ install: ['x'] }))).status
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('in lockfile mode refuses a package or version the lockfile does not hold', async () => {
    const upstream = vi.fn(async () => new Response(answer, { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    const all = new Map([
      ['left-pad', new Set(['1.3.0'])],
      ['@s/p', new Set(['2.0.0'])],
      ['inner', new Set(['0.1.0'])],
    ]);
    reg.setAllowlist(new Map([[REG.id, all]]));
    expect((await post(base, `/npm/${REG.id}${QUICK}`, reg.token, pnpmTree())).status).toBe(200);
    all.set('inner', new Set(['9.9.9']));
    expect((await post(base, `/npm/${REG.id}${QUICK}`, reg.token, pnpmTree())).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    await proxy.close();
  });

  it('refuses a tree naming a package another registry serves', async () => {
    const upstream = vi.fn(async () => new Response(answer, { status: 200 }));
    const { base, proxy } = await startProxy(upstream);
    const priv = {
      ...REG,
      id: 'reg-private',
      isDefault: false,
      scopes: ['@s'],
      upstreamUrl: 'http://priv.test',
    };
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, priv] });
    reg.setAllowlist(
      new Map([
        [REG.id, null],
        [priv.id, null],
      ])
    );
    const res = await post(base, `/npm/${REG.id}${QUICK}`, reg.token, pnpmTree());
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/another registry/);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });
});

describe('registry proxy audit relays share the buffered-fetch limits', () => {
  /** An upstream whose audit answers wait on `open()`; everything else answers at once. */
  function gatedAudit() {
    let started = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const upstream = async (url: string) => {
      if (!url.endsWith(AUDIT)) {
        return new Response('{}', { status: 200 });
      }
      started++;
      await gate;
      return new Response('{"left-pad":[]}', { status: 200 });
    };
    return { open: () => open(), started: () => started, upstream };
  }
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !done(); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(done()).toBe(true);
  }
  const query = JSON.stringify({ 'left-pad': ['1.3.0'] });

  it('answers 503 with Retry-After while the registration’s slots are all held', async () => {
    const g = gatedAudit();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const held = post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query);
    await until(() => g.started() === 1);
    const busy = await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query);
    expect(busy.status).toBe(503);
    g.open();
    expect((await held).status).toBe(200);
    // The slot came back: the next audit is served.
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query)).status).toBe(200);
    await proxy.close();
  });

  it('shares the slots with packument fetches, so an audit cannot starve them unbounded', async () => {
    const g = gatedAudit();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    const held = post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query);
    await until(() => g.started() === 1);
    expect((await get(base, `/npm/${REG.id}/left-pad`, reg.token)).status).toBe(503);
    g.open();
    await held;
    await proxy.close();
  });

  it('refuses a malformed or denied body without taking a slot', async () => {
    const g = gatedAudit();
    const { base, proxy } = await startProxy(g.upstream, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, new Map([['left-pad', new Set(['1.3.0'])]])]]));
    const held = post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query);
    await until(() => g.started() === 1);
    // The only slot is held, yet these answer on their own merits, not 503.
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, 'garbage')).status).toBe(400);
    expect(
      (await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"exfil":["1.0.0"]}')).status
    ).toBe(403);
    g.open();
    await held;
    await proxy.close();
  });

  it('ends an upstream that never answers at the deadline with a 502, and frees the slot', async () => {
    const upstream = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const { base, proxy } = await startProxy(upstream as never, {
      maxBufferedFetches: 1,
      maxQueuedFetches: 0,
      upstreamDeadlineMs: 60,
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query)).status).toBe(502);
    // Not 503: the slot was released when the deadline fired.
    expect((await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, query)).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(2);
    await proxy.close();
  });
});

describe('splitRegistryWorkspaceEnv', () => {
  it('moves the token-bearing entries to secretEnv and leaves the rest', () => {
    const regs = [{ id: 'r1', isDefault: true, scopes: [] }];
    const all = registryWorkspaceEnv(regs, 'http://h:1', 'tok=with=eq');
    const { env, secretEnv } = splitRegistryWorkspaceEnv(all);
    expect(secretEnv).toEqual({
      COREPACK_NPM_TOKEN: 'tok=with=eq',
      YARN_NPM_AUTH_TOKEN: 'tok=with=eq',
    });
    expect(env.join('\n')).not.toContain('tok=with=eq');
    expect(env).toContain('NPM_CONFIG_REGISTRY=http://h:1/npm/r1');
    expect(env).toContain('YARN_NPM_ALWAYS_AUTH=true');
    expect(env).toContain('COREPACK_ENABLE_DOWNLOAD_PROMPT=0');
  });

  it('has no Corepack token when there is no default registry', () => {
    const { secretEnv } = splitRegistryWorkspaceEnv(registryWorkspaceEnv([], 'http://h:1', 'tok'));
    expect(secretEnv).toEqual({ YARN_NPM_AUTH_TOKEN: 'tok' });
  });
});

// ---- Go module proxy (`/go/<token>/<registryId>/…`) ----

const GO = {
  ...REG,
  ecosystem: 'go' as const,
  id: 'go-1',
  name: 'goproxy',
  token: 'go-up-token',
  upstreamUrl: 'http://goup.test',
};
const GO_H = 'h1:Zk9oB1xq3YxQb0m8r4K3tq8o1P0lq4vV2m5z7W9y8X0=';
const goLockfile = () =>
  buildGoAllowlist(
    parseGoSum(
      [
        `golang.org/x/text v0.14.0 ${GO_H}`,
        `golang.org/x/text v0.14.0/go.mod ${GO_H}`,
        `golang.org/x/text v0.3.0/go.mod ${GO_H}`,
        `github.com/Azure/go-autorest v14.2.0+incompatible ${GO_H}`,
      ].join('\n')
    )
  );

/** A request with an arbitrary Authorization header; resolves with what arrived, even a cut-off body. */
const rawGet = (base: string, path: string, authorization?: string, method = 'GET') =>
  new Promise<{
    body: string;
    bytes: number;
    cutOff: boolean;
    headers: http.IncomingHttpHeaders;
    status: number;
  }>((resolve) => {
    const req = http.request(
      `${base}${path}`,
      { headers: authorization ? { authorization } : {}, method },
      (res) => {
        const chunks: Buffer[] = [];
        let done = false;
        const finish = (cutOff: boolean) => {
          if (done) {
            return;
          }
          done = true;
          const body = Buffer.concat(chunks);
          resolve({
            body: body.toString(),
            bytes: body.length,
            cutOff,
            headers: res.headers,
            status: res.statusCode ?? 0,
          });
        };
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(false));
        res.on('aborted', () => finish(true));
        res.on('error', () => finish(true));
        res.on('close', () => finish(!res.complete));
      }
    );
    req.on('error', () => {});
    req.end();
  });

const bearer = (t: string) => `Bearer ${t}`;
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** A proxy with no allowlist limits, for the Go relay tests. */
async function startGoProxy(
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  opts: { cache?: TarballCache; maxGoZipBytes?: number; registry?: typeof GO } = {}
) {
  const proxy = createRegistryProxy({
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    cache: opts.cache,
    listenHost: '127.0.0.1',
    listenPort: 0,
    maxGoZipBytes: opts.maxGoZipBytes,
    upstreamFetch: upstream as never,
  });
  const base = `http://127.0.0.1:${await proxy.listen()}`;
  const reg = await proxy.register({ onDenied: () => {}, registries: [opts.registry ?? GO] });
  reg.setAllowlist(new Map([[GO.id, null]]));
  const call = (path: string, method = 'GET') =>
    rawGet(base, `/go/${reg.token}/go-1${path}`, undefined, method);
  return { base, call, proxy, reg };
}

describe('go module proxy: access', () => {
  it('answers 401, 404, 405, 503 and 404 in the npm route’s order', async () => {
    const { base, proxy } = await startProxy(async () => new Response('x'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO, REG] });
    const mod = '/golang.org/x/text/@v/v0.14.0.mod';
    const go = (id: string, method = 'GET') =>
      rawGet(base, `/go/${reg.token}/${id}${mod}`, undefined, method);
    expect((await rawGet(base, `/go/wrong/go-1${mod}`)).status).toBe(401);
    expect((await go('nope')).status).toBe(404);
    // An npm registry id is not a Go registry.
    expect((await go(REG.id)).status).toBe(404);
    expect((await go('go-1', 'POST')).status).toBe(405);
    expect((await go('go-1', 'DELETE')).status).toBe(405);
    expect((await go('go-1')).status).toBe(503);
    reg.setAllowlist(
      new Map([
        [GO.id, null],
        [REG.id, null],
      ])
    );
    const bad = await rawGet(base, `/go/${reg.token}/go-1/golang.org/x/text`);
    expect(bad.status).toBe(404);
    expect(bad.body).toContain('unrecognized Go module path');
    expect((await go('go-1')).status).toBe(200);
    await proxy.close();
  });

  it('authenticates the Go route by its path token alone, never by a header', async () => {
    const { base, proxy, reg } = await startGoProxy(async () => new Response('module x'));
    const mod = '/go-1/golang.org/x/text/@v/v0.14.0.mod';
    // A valid Bearer header with a wrong path token is not enough…
    expect((await rawGet(base, `/go/wrong${mod}`, bearer(reg.token))).status).toBe(401);
    // …and so is its absence from the path: `go-1` then reads as the token.
    expect((await rawGet(base, `/go${mod}`, bearer(reg.token))).status).toBe(401);
    // A valid path token is accepted whatever the header says.
    expect((await rawGet(base, `/go/${reg.token}${mod}`, bearer('bogus'))).status).toBe(200);
    // Basic is not accepted anywhere: not as a password, not as a user name.
    expect((await rawGet(base, `/go/wrong${mod}`, basic('anything', reg.token))).status).toBe(401);
    expect((await rawGet(base, `/go/wrong${mod}`, basic(reg.token, 'x'))).status).toBe(401);
    expect((await rawGet(base, `/go/${reg.token}${mod}`, 'Basic !!!')).status).toBe(200);
    await proxy.close();
  });

  it('never puts the path token in a Go response or a denial report', async () => {
    const denials: unknown[] = [];
    const { base, proxy } = await startProxy(async () => new Response('ok'));
    const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [GO] });
    reg.setAllowlist(new Map([[GO.id, goLockfile()]]));
    const at = (id: string, rest: string, method = 'GET') =>
      rawGet(base, `/go/${reg.token}/${id}${rest}`, undefined, method);
    const responses = [
      await at('go-1', '/golang.org/x/text/@v/v0.14.0.mod'),
      await at('go-1', '/golang.org/x/text/@v/v9.9.9.zip'),
      await at('go-1', '/example.com/other/@v/v1.0.0.mod'),
      await at('go-1', '/golang.org/x/text'),
      await at('nope', '/golang.org/x/text/@v/v0.14.0.mod'),
      await at('go-1', '/golang.org/x/text/@v/v0.14.0.mod', 'POST'),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 403, 404, 404, 405]);
    expect(denials.length).toBeGreaterThan(0);
    for (const r of responses) {
      expect(r.body).not.toContain(reg.token);
      expect(JSON.stringify(r.headers)).not.toContain(reg.token);
    }
    expect(JSON.stringify(denials)).not.toContain(reg.token);
    await proxy.close();
  });

  it('keeps the npm route Bearer-only', async () => {
    const { base, proxy } = await startProxy(async () => new Response('{}'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, basic('u', reg.token))).status).toBe(401);
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, bearer(reg.token))).status).toBe(200);
    await proxy.close();
  });

  /**
   * GET with the request target EXACTLY as written. `http.request(urlString)` runs the target
   * through WHATWG URL parsing, which resolves `..` on the client and so hides the very requests
   * this test is about; a `path` option is sent as given.
   */
  const targetGet = (base: string, path: string, authorization?: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const req = http.request(
        {
          headers: authorization ? { authorization } : {},
          host: u.hostname,
          method: 'GET',
          path,
          port: u.port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });

  it('judges the route by the normalised path, so /go/.. cannot reach npm with a path token or Basic', async () => {
    const { base, proxy } = await startProxy(async () => new Response('{}'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG] });
    reg.setAllowlist(new Map([[REG.id, null]]));
    for (const path of [
      `/go/../npm/${REG.id}/pkg`,
      `/go/%2e%2e/npm/${REG.id}/pkg`,
      `/go/x/../../npm/${REG.id}/pkg`,
    ]) {
      // The router sees an npm path; Basic is refused there, exactly as on the direct path.
      expect(await targetGet(base, path, basic('u', reg.token)), path).toBe(401);
      // Bearer on the same path is an ordinary npm request.
      expect(await targetGet(base, path, bearer(reg.token)), path).toBe(200);
    }
    // A path token reaches nothing on npm: with no Bearer header there is no token at all.
    for (const path of [
      `/go/${reg.token}/../npm/${REG.id}/pkg`,
      `/go/${reg.token}/%2e%2e/npm/${REG.id}/pkg`,
      `/npm/${REG.id}/pkg?token=${reg.token}`,
      `/npm/${reg.token}/${REG.id}/pkg`,
    ]) {
      expect(await targetGet(base, path), path).toBe(401);
    }
    await proxy.close();
  });
});

describe('go module proxy: lockfile mode', () => {
  const setup = async (upstream: (url: string, init?: RequestInit) => Promise<Response>) => {
    const denials: unknown[] = [];
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [GO] });
    reg.setAllowlist(new Map([[GO.id, goLockfile()]]));
    const call = (path: string, method = 'GET') =>
      rawGet(base, `/go/${reg.token}/go-1${path}`, undefined, method);
    return { base, call, denials, proxy, reg };
  };

  it('allows exactly the go.sum versions: zip only for a plain line, mod and info for either', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const { call, proxy } = await setup(upstream);
    expect((await call('/golang.org/x/text/@v/v0.14.0.zip')).status).toBe(200);
    expect((await call('/golang.org/x/text/@v/v0.14.0.mod')).status).toBe(200);
    expect((await call('/golang.org/x/text/@v/v0.14.0.info')).status).toBe(200);
    expect((await call('/golang.org/x/text/@v/v0.3.0.mod')).status).toBe(200);
    expect((await call('/golang.org/x/text/@v/v0.3.0.info')).status).toBe(200);
    expect((await call('/github.com/!azure/go-autorest/@v/v14.2.0+incompatible.zip')).status).toBe(
      200
    );
    expect(upstream).toHaveBeenCalledTimes(6);
    await proxy.close();
  });

  it('denies the rest with a 403 and reports it', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const { call, denials, proxy } = await setup(upstream);
    // A go.mod-only line does not make the module's source available.
    const zip = await call('/golang.org/x/text/@v/v0.3.0.zip');
    expect(zip.status).toBe(403);
    expect(zip.body).toContain('golang.org/x/text@v0.3.0 is not in the repository');
    expect((await call('/golang.org/x/text/@v/v0.15.0.mod')).status).toBe(403);
    expect((await call('/golang.org/x/net/@v/v0.14.0.info')).status).toBe(403);
    // Case matters: go.sum names `Azure`, and `azure` is another module.
    expect((await call('/github.com/azure/go-autorest/@v/v14.2.0+incompatible.mod')).status).toBe(
      403
    );
    expect(upstream).not.toHaveBeenCalled();
    expect(denials[0]).toEqual({
      name: 'golang.org/x/text',
      reason: 'not-in-lockfile',
      registryId: 'go-1',
      version: 'v0.3.0',
    });
    expect(denials).toHaveLength(4);
    await proxy.close();
  });

  it('answers list locally, with no upstream call', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const { call, proxy } = await setup(upstream);
    const list = await call('/golang.org/x/text/@v/list');
    expect(list.status).toBe(200);
    expect(list.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(list.body).toBe('v0.14.0\n');
    expect((await call('/golang.org/x/net/@v/list')).body).toBe('');
    expect((await call('/golang.org/x/text/@v/list', 'HEAD')).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('denies @latest', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const { call, denials, proxy } = await setup(upstream);
    const latest = await call('/golang.org/x/text/@latest');
    expect(latest.status).toBe(403);
    expect(latest.body).toContain('golang.org/x/text is not in the repository');
    expect(denials).toHaveLength(1);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('treats a registry the allowlist map omits as an empty lockfile', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO] });
    reg.setAllowlist(new Map());
    expect(
      (await rawGet(base, `/go/${reg.token}/go-1/golang.org/x/text/@v/v0.14.0.mod`)).status
    ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });
});

describe('go module proxy: open mode and relay', () => {
  it('passes list and latest through, with a fixed content type per kind', async () => {
    const urls: string[] = [];
    const { call, proxy } = await startGoProxy(async (url) => {
      urls.push(url);
      return new Response('upstream-body', { headers: { 'content-type': 'text/html' } });
    });
    const list = await call('/github.com/!azure/go-autorest/@v/list');
    expect(list.body).toBe('upstream-body');
    expect(list.headers['content-type']).toBe('text/plain; charset=utf-8');
    const latest = await call('/golang.org/x/text/@latest');
    expect(latest.headers['content-type']).toBe('application/json');
    expect((await call('/golang.org/x/text/@v/v1.0.0.info')).headers['content-type']).toBe(
      'application/json'
    );
    expect((await call('/golang.org/x/text/@v/v1.0.0.mod')).headers['content-type']).toBe(
      'text/plain; charset=utf-8'
    );
    expect((await call('/golang.org/x/text/@v/v1.0.0.zip')).headers['content-type']).toBe(
      'application/zip'
    );
    expect(urls).toEqual([
      'http://goup.test/github.com/!azure/go-autorest/@v/list',
      'http://goup.test/golang.org/x/text/@latest',
      'http://goup.test/golang.org/x/text/@v/v1.0.0.info',
      'http://goup.test/golang.org/x/text/@v/v1.0.0.mod',
      'http://goup.test/golang.org/x/text/@v/v1.0.0.zip',
    ]);
    await proxy.close();
  });

  it('sends the registry credential and a fixed accept; never the proxy token', async () => {
    const seen: Array<Record<string, string>> = [];
    const { call, proxy, reg } = await startGoProxy(async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      expect(init?.redirect).toBe('error');
      return new Response('ok');
    });
    await call('/golang.org/x/text/@v/v1.0.0.mod');
    expect(seen[0]?.authorization).toBe('Bearer go-up-token');
    expect(seen[0]?.accept).toBe('text/plain; charset=utf-8');
    expect(JSON.stringify(seen)).not.toContain(reg.token);
    await proxy.close();
  });

  it('sends a basic credential as Basic', async () => {
    const seen: Array<Record<string, string>> = [];
    const { call, proxy } = await startGoProxy(
      async (_url, init) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response('ok');
      },
      { registry: { ...GO, authKind: 'basic' as never, token: 'svc:secret' } }
    );
    await call('/a/b/@v/v1.0.0.mod');
    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from('svc:secret').toString('base64')}`);
    await proxy.close();
  });

  it('relays a 404 and a 410 as such, with a fixed body', async () => {
    const { call, proxy } = await startGoProxy(async (url) =>
      url.endsWith('.info')
        ? new Response('SECRET-UPSTREAM-404', { status: 404 })
        : new Response('SECRET-UPSTREAM-410', { status: 410 })
    );
    const notFound = await call('/golang.org/x/text/@v/v1.0.0.info');
    expect(notFound.status).toBe(404);
    expect(notFound.body).not.toContain('SECRET');
    const gone = await call('/golang.org/x/text/@v/v1.0.0.mod');
    expect(gone.status).toBe(410);
    expect(gone.body).not.toContain('SECRET');
    await proxy.close();
  });

  it('turns any other upstream status, a redirect and a fetch failure into a fixed 502', async () => {
    let mode: 'redirect' | 'error' | 'throw' = 'error';
    const { call, proxy } = await startGoProxy(async () => {
      if (mode === 'throw') {
        throw new Error('SECRET connect ECONNREFUSED 10.0.0.1');
      }
      if (mode === 'redirect') {
        // What undici raises for `redirect: 'error'`.
        throw new TypeError('fetch failed', { cause: new Error('SECRET unexpected redirect') });
      }
      return new Response('SECRET upstream 500 body', { status: 500 });
    });
    for (const m of ['error', 'redirect', 'throw'] as const) {
      mode = m;
      const res = await call('/golang.org/x/text/@v/v1.0.0.mod');
      expect(res.status, m).toBe(502);
      expect(res.body, m).not.toContain('SECRET');
      expect(JSON.parse(res.body).error).toMatch(/^the upstream Go module proxy/);
    }
    await proxy.close();
  });

  it('streams a zip and relays HEAD without a body', async () => {
    const { call, proxy } = await startGoProxy(async (_url, init) =>
      init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '9' }, status: 200 })
        : new Response('ZIPBYTES!', { status: 200 })
    );
    const zip = await call('/golang.org/x/text/@v/v1.0.0.zip');
    expect(zip.body).toBe('ZIPBYTES!');
    const head = await call('/golang.org/x/text/@v/v1.0.0.zip', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    await proxy.close();
  });

  it('refuses a zip whose content-length is over the cap, before streaming', async () => {
    const { call, proxy } = await startGoProxy(
      async () => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
      { maxGoZipBytes: 50 }
    );
    const res = await call('/golang.org/x/text/@v/v1.0.0.zip');
    expect(res.status).toBe(502);
    expect(res.cutOff).toBe(false);
    await proxy.close();
  });

  it('cuts a zip off once it passes the cap without a content-length', async () => {
    const aborted = vi.fn();
    const { call, proxy } = await startGoProxy(
      async (_url, init) => {
        init?.signal?.addEventListener('abort', aborted);
        const chunk = new Uint8Array(40).fill(65);
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
            // Like a network body, each chunk arrives in a later turn of the event loop.
            return new Promise((r) => setTimeout(r, 1));
          },
        });
        return new Response(body, { status: 200 });
      },
      { maxGoZipBytes: 100 }
    );
    const res = await call('/golang.org/x/text/@v/v1.0.0.zip');
    expect(res.cutOff).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(100);
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled());
    await proxy.close();
  });

  it('stops the upstream when the client hangs up, and release() waits for the request', async () => {
    let cancelled = false;
    const { base, proxy, reg } = await startGoProxy(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
              return new Promise((r) => setTimeout(r, 5));
            },
          })
        )
    );
    await new Promise<void>((resolve) => {
      const req = http.request(`${base}/go/${reg.token}/go-1/a/b/@v/v1.0.0.zip`, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
      req.end();
    });
    await reg.release();
    expect(cancelled).toBe(true);
    await proxy.close();
  });

  it('serves a cached zip without an upstream call, and caches only zips', async () => {
    const store = new Map<string, Buffer>();
    const cache = {
      get: async (id: string, key: string) => {
        const hit = store.get(`${id} ${key}`);
        return hit ? { createStream: () => Readable.from([hit]) } : null;
      },
      startWrite: async (id: string, key: string) => {
        const parts: Buffer[] = [];
        return {
          abort: async () => {},
          commit: async () => {
            store.set(`${id} ${key}`, Buffer.concat(parts));
          },
          write: async (c: Uint8Array) => {
            parts.push(Buffer.from(c));
          },
        };
      },
    } as unknown as TarballCache;
    const upstream = vi.fn(async () => new Response('ZIPDATA'));
    const { call, proxy } = await startGoProxy(upstream, { cache });
    expect((await call('/a/b/@v/v1.0.0.zip')).body).toBe('ZIPDATA');
    expect((await call('/a/b/@v/v1.0.0.zip')).body).toBe('ZIPDATA');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(store.has('go-1 http://goup.test/a/b/@v/v1.0.0.zip')).toBe(true);
    await call('/a/b/@v/v1.0.0.mod');
    expect(store.size).toBe(1);
    await proxy.close();
  });
});

describe('go and npm registries in one registration', () => {
  const NPM_PLAIN = { ...REG, isDefault: false, scopes: ['@acme'] };
  const both = new Map([
    [GO.id, null],
    [REG.id, null],
  ]);

  it('keeps each route to its own ecosystem', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO, REG] });
    reg.setAllowlist(both);
    expect((await rawGet(base, `/npm/${GO.id}/pkg`, bearer(reg.token))).status).toBe(404);
    expect((await rawGet(base, `/go/${reg.token}/${REG.id}/a/b/@latest`)).status).toBe(404);
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, bearer(reg.token))).status).toBe(200);
    expect((await rawGet(base, `/go/${reg.token}/${GO.id}/a/b/@latest`)).status).toBe(200);
    expect(urls).toEqual(['http://upstream.test/pkg', 'http://goup.test/a/b/@latest']);
    await proxy.close();
  });

  it('never makes a go registry npm’s default, even one flagged isDefault', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    // The only default-flagged registry is the go one.
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO, NPM_PLAIN] });
    reg.setAllowlist(both);
    const res = await rawGet(base, `/npm/${REG.id}/left-pad`, bearer(reg.token));
    expect(res.status).toBe(404);
    expect(res.body).toContain('no registry serves left-pad');
    // The scoped one still routes to its own registry.
    expect((await rawGet(base, `/npm/${REG.id}/@acme%2fx`, bearer(reg.token))).status).toBe(200);
    expect(urls).toEqual(['http://upstream.test/@acme%2fx']);
    await proxy.close();
  });

  it('does not offer a go registry for an npm scope', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    const claimsScope = { ...GO, isDefault: false, scopes: ['@acme'] };
    const reg = await proxy.register({ onDenied: () => {}, registries: [claimsScope, REG] });
    reg.setAllowlist(both);
    expect((await rawGet(base, `/npm/${REG.id}/@acme%2fx`, bearer(reg.token))).status).toBe(200);
    expect(urls).toEqual(['http://upstream.test/@acme%2fx']);
    await proxy.close();
  });

  it('never sends an audit to a go registry', async () => {
    const upstream = vi.fn(async () => new Response('{}'));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO, NPM_PLAIN] });
    reg.setAllowlist(both);
    const res = await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"left-pad":["1.0.0"]}');
    expect(res.status).toBe(404);
    expect(res.body).toContain('no default registry answers audits');
    expect(upstream).not.toHaveBeenCalled();
    // And a Go path rejects POST rather than treating it as an audit.
    expect(
      (await rawGet(base, `/go/${reg.token}/${GO.id}${AUDIT}`, undefined, 'POST')).status
    ).toBe(405);
    await proxy.close();
  });
});

describe('go module proxy: the real tarball cache', () => {
  // The cache is the one place a Go zip and an npm tarball share storage, so its real key layout
  // (a directory per registry id, a file per sha256 of the upstream path) is exercised here
  // instead of through a fake `Map`.
  it('stores a zip on disk under its registry id, serves the second request from it, and caches nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gozip-cache-'));
    const cache = new TarballCache(dir, 10 * 1024 * 1024);
    const upstream = vi.fn(
      async (url: string) => new Response(url.endsWith('.zip') ? 'ZIPDATA' : 'MODDATA')
    );
    const { call, proxy } = await startGoProxy(upstream, { cache });
    expect((await call('/a/b/@v/v1.0.0.zip')).body).toBe('ZIPDATA');
    // The entry is committed (renamed into place as `<sha>.tgz`) after the response ends, so wait
    // for it: a request that races the commit just fetches again, which is harmless but is not
    // what this test is about.
    const committed = () =>
      existsSync(join(dir, GO.id)) && readdirSync(join(dir, GO.id)).some((f) => f.endsWith('.tgz'));
    for (let i = 0; i < 200 && !committed(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(committed()).toBe(true);
    expect((await call('/a/b/@v/v1.0.0.zip')).body).toBe('ZIPDATA');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, GO.id))).toBe(true);
    expect(readdirSync(join(dir, GO.id))).toHaveLength(1);
    // A `.mod` and an `.info` are not cached: they are small and a stale one is worse than a fetch.
    expect((await call('/a/b/@v/v1.0.0.mod')).body).toBe('MODDATA');
    expect(readdirSync(join(dir, GO.id))).toHaveLength(1);
    await proxy.close();
  });

  it('never serves a cached zip the allowlist would deny', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gozip-cache-'));
    const cache = new TarballCache(dir, 10 * 1024 * 1024);
    const upstream = vi.fn(async () => new Response('ZIPDATA'));
    // First an open registration fills the cache; then a lockfile registration that does not
    // list the version must still be refused rather than answered from disk.
    const open = await startGoProxy(upstream, { cache });
    expect((await open.call('/a/b/@v/v1.0.0.zip')).status).toBe(200);
    await open.proxy.close();
    const proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://127.0.0.1:${p}`,
      cache,
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamFetch: upstream as never,
    });
    const base = `http://127.0.0.1:${await proxy.listen()}`;
    const reg = await proxy.register({ onDenied: () => {}, registries: [GO] });
    reg.setAllowlist(new Map([[GO.id, new Map([['a/b', new Set(['v9.9.9'])]])]]));
    expect((await rawGet(base, `/go/${reg.token}/go-1/a/b/@v/v1.0.0.zip`)).status).toBe(403);
    await proxy.close();
  });
});

// ---- PyPI proxy (`/pypi/<registryId>/…`, the token as the Basic password) ----

const PY = {
  ...REG,
  ecosystem: 'pypi' as const,
  id: 'py-1',
  isDefault: false,
  name: 'pypi',
  token: 'py-up-token',
  upstreamUrl: 'http://pyup.test/simple',
};
const SHA = 'a'.repeat(64);
const WHL = 'flask-3.0.0-py3-none-any.whl';
const SDIST = 'flask-2.0.0.tar.gz';
const WHL_URL = `https://files.test/packages/${WHL}`;
const SDIST_URL = `https://files.test/packages/${SDIST}`;
const htmlIndex = (anchors: string[]) =>
  `<!DOCTYPE html><html><body>${anchors.join('\n')}</body></html>`;
const FLASK_HTML = htmlIndex([
  `<a href="${WHL_URL}#sha256=${SHA}" data-requires-python="&gt;=3.8" data-core-metadata="sha256=${SHA}">${WHL}</a>`,
  `<a href="${SDIST_URL}#sha256=${SHA}" data-yanked="oops &amp; bad">${SDIST}</a>`,
]);
const FLASK_JSON = JSON.stringify({
  files: [
    {
      'core-metadata': { sha256: SHA },
      filename: WHL,
      hashes: { sha256: SHA },
      'requires-python': '>=3.8',
      url: WHL_URL,
    },
    { filename: SDIST, hashes: { sha256: SHA }, url: SDIST_URL, yanked: 'oops & bad' },
  ],
  meta: { 'api-version': '1.1' },
  name: 'flask',
});
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const pyLockfile = (...pins: Array<[string, string]>) =>
  buildPypiAllowlist(pins.map(([name, version]) => ({ name, version })));

/** The `<a>` links of a rendered index: href without its fragment, the fragment, the text. */
const linksOf = (body: string) =>
  [...body.matchAll(/<a href="([^"#]*)(?:#([^"]*))?"[^>]*>([^<]*)<\/a>/g)].map((m) => ({
    hash: m[2],
    href: m[1] as string,
    text: m[3] as string,
  }));

async function startPyProxy(
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  opts: {
    allowlist?: Map<string, Set<string>> | null;
    cache?: TarballCache;
    inject?: boolean;
    limits?: { maxBufferedFetches?: number; maxQueuedFetches?: number };
    maxPypiFileBytes?: number;
    registry?: typeof PY;
  } = {}
) {
  const denials: unknown[] = [];
  const proxy = createRegistryProxy({
    ...opts.limits,
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    cache: opts.cache,
    listenHost: '127.0.0.1',
    listenPort: 0,
    maxPypiFileBytes: opts.maxPypiFileBytes,
    upstreamFetch: opts.inject === false ? undefined : (upstream as never),
  });
  const base = `http://127.0.0.1:${await proxy.listen()}`;
  const reg = await proxy.register({
    onDenied: (d) => denials.push(d),
    registries: [opts.registry ?? PY],
  });
  reg.setAllowlist(new Map([[PY.id, opts.allowlist === undefined ? null : opts.allowlist]]));
  const at = (rest: string, method = 'GET', authorization = basic('token', reg.token)) =>
    rawGet(base, `/pypi/${PY.id}${rest}`, authorization, method);
  /** The served index of `flask`, and a request for the rewritten link to `filename`. */
  const file = async (filename: string, method = 'GET') => {
    const index = await at('/simple/flask/');
    const link = linksOf(index.body).find((l) => l.text === filename);
    expect(link, `${filename} is listed`).toBeDefined();
    return {
      index,
      response: await rawGet(base, link?.href as string, basic('token', reg.token), method),
    };
  };
  return { at, base, denials, file, proxy, reg };
}

describe('pypi proxy: access', () => {
  it('answers 401, 404, 405, 503 and 404 in the Go route’s order', async () => {
    const { base, proxy } = await startProxy(async () => html(FLASK_HTML));
    const reg = await proxy.register({ onDenied: () => {}, registries: [PY, REG, GO] });
    const idx = (id: string, method = 'GET') =>
      rawGet(base, `/pypi/${id}/simple/flask/`, basic('token', reg.token), method);
    expect((await rawGet(base, '/pypi/py-1/simple/flask/', basic('token', 'wrong'))).status).toBe(
      401
    );
    expect((await idx('nope')).status).toBe(404);
    // Neither an npm nor a Go registry id is a PyPI registry.
    expect((await idx(REG.id)).status).toBe(404);
    expect((await idx(GO.id)).status).toBe(404);
    expect((await idx('py-1', 'POST')).status).toBe(405);
    expect((await idx('py-1', 'DELETE')).status).toBe(405);
    expect((await idx('py-1')).status).toBe(503);
    reg.setAllowlist(
      new Map([
        [PY.id, null],
        [REG.id, null],
        [GO.id, null],
      ])
    );
    for (const rest of [
      '/simple/',
      '/simple',
      '/',
      '/simple/flask/x',
      '/files/x/y',
      '/other/flask/',
    ]) {
      const res = await rawGet(base, `/pypi/py-1${rest}`, basic('token', reg.token));
      expect(res.status, rest).toBe(404);
      expect(res.body, rest).toContain('unrecognized PyPI path');
    }
    expect((await idx('py-1')).status).toBe(200);
    await proxy.close();
  });

  it('authenticates by the Basic password alone, whatever the user name', async () => {
    const { at, base, proxy, reg } = await startPyProxy(async () => html(FLASK_HTML));
    const index = '/simple/flask/';
    expect((await at(index, 'GET', basic('token', reg.token))).status).toBe(200);
    expect((await at(index, 'GET', basic('', reg.token))).status).toBe(200);
    expect((await at(index, 'GET', basic('anything', reg.token))).status).toBe(200);
    // The token as the user name, or nothing after the colon, is not the password.
    expect((await at(index, 'GET', basic(reg.token, 'x'))).status).toBe(401);
    expect((await at(index, 'GET', basic(reg.token, ''))).status).toBe(401);
    expect(
      (await at(index, 'GET', `Basic ${Buffer.from(reg.token).toString('base64')}`)).status
    ).toBe(401);
    expect((await at(index, 'GET', 'Basic !!!')).status).toBe(401);
    expect((await at(index, 'GET', basic('token', 'wrong'))).status).toBe(401);
    // A token in the path is no credential: the path has no place for one.
    expect((await rawGet(base, `/pypi/${reg.token}/py-1${index}`)).status).toBe(401);
    expect(
      (await rawGet(base, `/pypi/${reg.token}/py-1${index}`, basic('token', reg.token))).status
    ).toBe(404);
    await proxy.close();
  });

  it('refuses a Bearer header, or none, on a pypi path with a Basic challenge', async () => {
    const { base, proxy, reg } = await startPyProxy(async () => html(FLASK_HTML));
    const index = `/pypi/${PY.id}/simple/flask/`;
    for (const authorization of [bearer(reg.token), undefined]) {
      const res = await rawGet(base, index, authorization);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="registry"');
    }
    // The challenge is the first answer, even for a path that is nothing the route serves.
    for (const path of ['/pypi/nope/simple/x/', '/pypi/py-1/other', '/pypi/']) {
      const res = await rawGet(base, path, bearer(reg.token));
      expect(res.status, path).toBe(401);
      expect(res.headers['www-authenticate'], path).toBe('Basic realm="registry"');
    }
    // Only this route challenges.
    const npm = await rawGet(base, `/npm/${REG.id}/pkg`, undefined);
    expect(npm.status).toBe(401);
    expect(npm.headers['www-authenticate']).toBeUndefined();
    await proxy.close();
  });

  it('reads Basic on no route but PyPI: npm stays Bearer-only and Go path-token-only', async () => {
    const { base, proxy } = await startProxy(async () => new Response('{}'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, GO, PY] });
    reg.setAllowlist(
      new Map([
        [PY.id, null],
        [REG.id, null],
        [GO.id, null],
      ])
    );
    const creds = basic('token', reg.token);
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, creds)).status).toBe(401);
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, bearer(reg.token))).status).toBe(200);
    expect((await rawGet(base, `/go/wrong/${GO.id}/a/b/@latest`, creds)).status).toBe(401);
    expect((await rawGet(base, `/go/${GO.id}/a/b/@latest`, creds)).status).toBe(401);
    expect((await rawGet(base, `/go/${reg.token}/${GO.id}/a/b/@latest`)).status).toBe(200);
    await proxy.close();
  });

  it('judges the route by the normalised path: /pypi/.. reaches neither npm nor Go', async () => {
    const { base, proxy } = await startProxy(async () => new Response('{}'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, GO, PY] });
    reg.setAllowlist(
      new Map([
        [PY.id, null],
        [REG.id, null],
        [GO.id, null],
      ])
    );
    // A request target sent exactly as written, so `..` is not resolved on the client.
    const target = (path: string, authorization?: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(base);
        const req = http.request(
          {
            headers: authorization ? { authorization } : {},
            host: u.hostname,
            method: 'GET',
            path,
            port: u.port,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.end();
      });
    for (const path of [
      `/pypi/../npm/${REG.id}/pkg`,
      `/pypi/%2e%2e/npm/${REG.id}/pkg`,
      `/pypi/x/../../npm/${REG.id}/pkg`,
    ]) {
      // Judged as the npm path it normalises to: Basic is refused, Bearer is an ordinary request.
      expect(await target(path, basic('u', reg.token)), path).toBe(401);
      expect(await target(path, bearer(reg.token)), path).toBe(200);
    }
    // Nor does Basic stand in for Go's path token, and with no header at all nothing is reachable.
    expect(await target(`/pypi/../go/wrong/${GO.id}/a/b/@latest`, basic('u', reg.token))).toBe(401);
    for (const path of [
      `/pypi/../npm/${REG.id}/pkg`,
      `/pypi/%2e%2e/npm/${REG.id}/pkg`,
      `/pypi/${PY.id}/../npm/${REG.id}/pkg`,
      `/pypi/${PY.id}/%2e%2e/npm/${REG.id}/pkg`,
    ]) {
      expect(await target(path), path).toBe(401);
    }
    await proxy.close();
  });

  it('keeps a PyPI registry out of the npm and Go routes, and out of npm resolution', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    // The only default-flagged registry is the PyPI one, and it claims a scope.
    const pyDefault = { ...PY, isDefault: true, scopes: ['@acme'] };
    const npmPlain = { ...REG, isDefault: false, scopes: ['@other'] };
    const reg = await proxy.register({ onDenied: () => {}, registries: [pyDefault, npmPlain] });
    reg.setAllowlist(
      new Map([
        [PY.id, null],
        [REG.id, null],
      ])
    );
    const npm = (path: string) => rawGet(base, `/npm/${REG.id}${path}`, bearer(reg.token));
    expect((await rawGet(base, `/npm/${PY.id}/pkg`, bearer(reg.token))).status).toBe(404);
    expect((await rawGet(base, `/go/${reg.token}/${PY.id}/a/b/@latest`)).status).toBe(404);
    // Not the default, and its scope is not offered.
    const noDefault = await npm('/left-pad');
    expect(noDefault.status).toBe(404);
    expect(noDefault.body).toContain('no registry serves left-pad');
    expect((await npm('/@acme%2fx')).status).toBe(404);
    expect((await npm('/@other%2fx')).status).toBe(200);
    // And an audit has no default registry to go to.
    const audit = await post(base, `/npm/${REG.id}${AUDIT}`, reg.token, '{"left-pad":["1.0.0"]}');
    expect(audit.status).toBe(404);
    expect(audit.body).toContain('no default registry answers audits');
    expect(urls).toEqual(['http://upstream.test/@other%2fx']);
    await proxy.close();
  });

  it('never puts the token in a response, header or denial report, the index links included', async () => {
    const denials: unknown[] = [];
    const { base, proxy } = await startProxy(async (url) =>
      url.endsWith('/flask/') ? html(FLASK_HTML) : new Response('SECRET', { status: 500 })
    );
    const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [PY] });
    reg.setAllowlist(new Map([[PY.id, pyLockfile(['flask', '3.0.0'])]]));
    const at = (rest: string, method = 'GET') =>
      rawGet(base, `/pypi/${PY.id}${rest}`, basic('token', reg.token), method);
    const index = await at('/simple/flask/');
    const id = fileIdFor(PY.id, WHL_URL);
    const responses = [
      await at('/simple/django/'),
      await at('/simple/'),
      await at('/simple/flask/', 'POST'),
      await at(`/files/${id}/${WHL}`),
      await at(`/files/${id}/other.whl`),
      await at(`/files/${'0'.repeat(32)}/${WHL}`),
      await rawGet(base, '/pypi/nope/simple/flask/', basic('token', reg.token)),
      await rawGet(base, `/pypi/${PY.id}/simple/flask/`, bearer(reg.token)),
      await rawGet(base, `/pypi/${PY.id}/simple/flask/`, basic('token', `${reg.token}x`)),
      await rawGet(base, `/pypi/${reg.token}/${PY.id}/simple/flask/`),
    ];
    expect(index.status).toBe(200);
    expect(responses.map((r) => r.status)).toEqual([
      403, 404, 405, 502, 404, 404, 404, 401, 401, 401,
    ]);
    expect(linksOf(index.body)).toHaveLength(1);
    expect(index.body).not.toContain(reg.token);
    expect(JSON.stringify(index.headers)).not.toContain(reg.token);
    for (const r of responses) {
      expect(r.body).not.toContain(reg.token);
      expect(JSON.stringify(r.headers)).not.toContain(reg.token);
    }
    expect(denials.length).toBeGreaterThan(0);
    expect(JSON.stringify(denials)).not.toContain(reg.token);
    await proxy.close();
  });
});

describe('pypi proxy: the project index', () => {
  it('rewrites an HTML index and a JSON index to the same HTML', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fromHtml = await startPyProxy(async (url, init) => {
      seen.push({ init, url });
      return html(FLASK_HTML);
    });
    const a = await fromHtml.at('/simple/flask/');
    await fromHtml.proxy.close();
    const fromJson = await startPyProxy(
      async () =>
        new Response(FLASK_JSON, {
          headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' },
        })
    );
    const b = await fromJson.at('/simple/flask/');
    await fromJson.proxy.close();
    expect(a.status).toBe(200);
    // The links name no token, so two registrations render byte-identical indexes.
    expect(b.body).toBe(a.body);
    expect(a.body).not.toContain(fromHtml.reg.token);
    expect(a.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(seen[0]?.url).toBe('http://pyup.test/simple/flask/');
    const links = linksOf(a.body);
    expect(links).toEqual([
      {
        hash: `sha256=${SHA}`,
        href: `/pypi/py-1/files/${fileIdFor(PY.id, WHL_URL)}/${WHL}`,
        text: WHL,
      },
      {
        hash: `sha256=${SHA}`,
        href: `/pypi/py-1/files/${fileIdFor(PY.id, SDIST_URL)}/${SDIST}`,
        text: SDIST,
      },
    ]);
    expect(a.body).toContain('data-requires-python="&gt;=3.8"');
    expect(a.body).toContain('data-yanked="oops &amp; bad"');
    expect(a.body).toContain('<meta name="pypi:repository-version" content="1.0">');
    // PEP 658 metadata files are not proxied, so the attribute that announces them is dropped.
    expect(a.body).not.toContain('data-core-metadata');
    expect(a.body).not.toContain('data-dist-info-metadata');
    // The upstream's own file URLs are not handed out.
    expect(a.body).not.toContain('files.test');
  });

  it('sends the registry credential, a fixed accept and no redirect-following; never the proxy token', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const bearerRun = await startPyProxy(async (url, init) => {
      seen.push({ init, url });
      return html(FLASK_HTML);
    });
    await bearerRun.at('/simple/flask/');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer py-up-token');
    expect(headers.accept).toBe('application/vnd.pypi.simple.v1+json, text/html;q=0.1');
    expect(headers['accept-encoding']).toBe('identity');
    expect(seen[0]?.init?.redirect).toBe('error');
    expect(seen[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(seen)).not.toContain(bearerRun.reg.token);
    await bearerRun.proxy.close();
    const basicRun = await startPyProxy(
      async (url, init) => {
        seen.push({ init, url });
        return html(FLASK_HTML);
      },
      { registry: { ...PY, authKind: 'basic' as never, token: 'svc:secret' } }
    );
    await basicRun.at('/simple/flask/');
    const basicHeaders = seen[1]?.init?.headers as Record<string, string>;
    expect(basicHeaders.authorization).toBe(
      `Basic ${Buffer.from('svc:secret').toString('base64')}`
    );
    await basicRun.proxy.close();
  });

  it('normalises the project spelling for the upstream request', async () => {
    const urls: string[] = [];
    const { at, proxy } = await startPyProxy(async (url) => {
      urls.push(url);
      return html(FLASK_HTML);
    });
    expect((await at('/simple/Flask/')).status).toBe(200);
    expect((await at('/simple/zope.interface/')).status).toBe(200);
    expect((await at('/simple/Zope__Interface')).status).toBe(200);
    expect(urls).toEqual([
      'http://pyup.test/simple/flask/',
      'http://pyup.test/simple/zope-interface/',
      'http://pyup.test/simple/zope-interface/',
    ]);
    await proxy.close();
  });

  it('answers HEAD with the headers of the index and no body', async () => {
    const { at, proxy } = await startPyProxy(async () => html(FLASK_HTML));
    const get = await at('/simple/flask/');
    const head = await at('/simple/flask/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(get.body)));
    await proxy.close();
  });

  it('in lockfile mode keeps the pinned versions and drops the rest', async () => {
    const { at, denials, proxy } = await startPyProxy(async () => html(FLASK_HTML), {
      allowlist: pyLockfile(['flask', '3.0.0']),
    });
    const res = await at('/simple/flask/');
    expect(res.status).toBe(200);
    expect(linksOf(res.body).map((l) => l.text)).toEqual([WHL]);
    expect(res.body).not.toContain(SDIST);
    expect(denials).toEqual([]);
    await proxy.close();
  });

  it('in lockfile mode answers 403 when no version is pinned, and when the project is absent', async () => {
    const upstream = vi.fn(async () => html(FLASK_HTML));
    const { at, denials, proxy } = await startPyProxy(upstream, {
      allowlist: pyLockfile(['flask', '9.9.9'], ['requests', '2.0.0']),
    });
    const none = await at('/simple/flask/');
    expect(none.status).toBe(403);
    expect(none.body).toContain('flask is not in the repository');
    expect(upstream).toHaveBeenCalledTimes(1);
    const absent = await at('/simple/Django/');
    expect(absent.status).toBe(403);
    expect(absent.body).toContain('django is not in the repository');
    // The project the lockfile does not name is refused before the upstream is asked.
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(denials).toEqual([
      { name: 'flask', reason: 'no-versions', registryId: 'py-1' },
      { name: 'django', reason: 'not-in-lockfile', registryId: 'py-1' },
    ]);
    await proxy.close();
  });

  it('treats a registry the allowlist map omits as an empty lockfile', async () => {
    const upstream = vi.fn(async () => html(FLASK_HTML));
    const { base, proxy } = await startProxy(upstream);
    const reg = await proxy.register({ onDenied: () => {}, registries: [PY] });
    reg.setAllowlist(new Map());
    expect((await rawGet(base, '/pypi/py-1/simple/flask/', basic('token', reg.token))).status).toBe(
      403
    );
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('in open mode lists every file, including other projects’ and unpinned versions', async () => {
    const { at, proxy } = await startPyProxy(async () =>
      html(
        htmlIndex([
          `<a href="${WHL_URL}">${WHL}</a>`,
          '<a href="https://f.test/w-1.0.tar.gz">w-1.0.tar.gz</a>',
        ])
      )
    );
    expect(linksOf((await at('/simple/flask/')).body).map((l) => l.text)).toEqual([
      WHL,
      'w-1.0.tar.gz',
    ]);
    await proxy.close();
  });

  it('relays an upstream 404 and 410 as 404, and anything else as a fixed 502', async () => {
    let mode: 'redirect' | '404' | '410' | '500' | 'throw' | 'garbage' | 'binary' = '404';
    const { at, proxy } = await startPyProxy(async () => {
      switch (mode) {
        case 'throw':
          throw new Error('SECRET connect ECONNREFUSED 10.0.0.1');
        case 'redirect':
          throw new TypeError('fetch failed', { cause: new Error('SECRET unexpected redirect') });
        case 'garbage':
          return html('SECRET not an index at all <');
        case 'binary':
          return new Response('SECRET', { headers: { 'content-type': 'image/png' } });
        default:
          return new Response('SECRET upstream body', { status: Number(mode) });
      }
    });
    const expected = {
      '404': [404, /does not have this project/],
      '410': [404, /does not have this project/],
      '500': [502, /answered with an error/],
      binary: [502, /not a simple index/],
      garbage: [502, /not a simple index/],
      redirect: [502, /could not be reached/],
      throw: [502, /could not be reached/],
    } as const;
    for (const m of Object.keys(expected) as Array<keyof typeof expected>) {
      mode = m;
      const res = await at('/simple/flask/');
      expect(res.status, m).toBe(expected[m][0]);
      expect(res.body, m).not.toContain('SECRET');
      expect(JSON.parse(res.body).error, m).toMatch(expected[m][1]);
    }
    await proxy.close();
  });

  it('survives a hostile index: bad entries are dropped, the good one is served', async () => {
    const hostile = htmlIndex([
      `<a href="javascript:alert(1)">flask-1.0.0.tar.gz</a>`,
      `<a href="https://user:pw@evil.test/flask-1.0.1.tar.gz">flask-1.0.1.tar.gz</a>`,
      `<a href="https://f.test/x">flask-1.0.2&#47;..&#47;x.tar.gz</a>`,
      `<a href="https://f.test/y">a/b-1.0.tar.gz</a>`,
      `<a href="https://f.test/z">flask-1.0.3&amp;lt;script&amp;gt;.tar.gz</a>`,
      `<a ${'x="y" '.repeat(50_000)}>flask-1.0.4.tar.gz</a>`,
      `<a href="${'h'.repeat(5000)}">flask-1.0.5.tar.gz</a>`,
      `<a href="https://f.test/${WHL}" data-requires-python="&lt;script&gt;alert(1)&lt;/script&gt;">${WHL}</a>`,
      `<a href="https://f.test/flask-9.0.0.tar.gz">flask-9.0.0.tar.gz`,
      '<a href="https://f.test/tail',
    ]);
    const { at, proxy } = await startPyProxy(async () => html(hostile));
    const res = await at('/simple/flask/');
    expect(res.status).toBe(200);
    expect(linksOf(res.body).map((l) => l.text)).toEqual([WHL, 'flask-9.0.0.tar.gz']);
    expect(res.body).not.toContain('javascript:');
    expect(res.body).not.toContain('evil.test');
    // The decoded attribute is escaped again on the way out.
    expect(res.body).toContain('data-requires-python="&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(res.body).not.toContain('<script>');
    await proxy.close();
  });

  it('takes one of the registration’s buffered-fetch slots, 503s when none is free, and gives it back', async () => {
    let started = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { at, proxy } = await startPyProxy(
      async () => {
        started++;
        await gate;
        return html(FLASK_HTML);
      },
      { limits: { maxBufferedFetches: 1, maxQueuedFetches: 0 } }
    );
    const first = at('/simple/flask/');
    for (let i = 0; i < 1000 && started === 0; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(1);
    const refused = await at('/simple/requests/');
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(started).toBe(1);
    open();
    expect((await first).status).toBe(200);
    expect((await at('/simple/flask/')).status).toBe(200);
    await proxy.close();
  });

  it('stops the upstream when the client hangs up', async () => {
    const aborted = vi.fn();
    const { base, proxy, reg } = await startPyProxy(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // What a real fetch does when its signal fires.
          init?.signal?.addEventListener('abort', () => {
            aborted();
            reject(new Error('aborted'));
          });
        })
    );
    await new Promise<void>((resolve) => {
      const req = http.request(`${base}/pypi/py-1/simple/flask/`, {
        headers: { authorization: basic('token', reg.token) },
      });
      req.on('error', () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled());
    await reg.release();
    await proxy.close();
  });
});

describe('pypi proxy: files', () => {
  /** An upstream serving the flask index, and `bytes` for any file URL. */
  const flaskUpstream =
    (
      onFile: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
        new Response('WHEELBYTES')
    ) =>
    async (url: string, init?: RequestInit) =>
      url.endsWith('/simple/flask/') ? html(FLASK_HTML) : onFile(url, init);

  it('relays a listed file through its rewritten link, with a fixed content type', async () => {
    const { file, proxy } = await startPyProxy(
      flaskUpstream(() => new Response('WHEELBYTES', { headers: { 'content-type': 'text/html' } }))
    );
    const { response } = await file(WHL);
    expect(response.status).toBe(200);
    expect(response.body).toBe('WHEELBYTES');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    await proxy.close();
  });

  it('relays HEAD without a body and passes a content-length through', async () => {
    const { file, proxy } = await startPyProxy(
      flaskUpstream((_url, init) =>
        init?.method === 'HEAD'
          ? new Response(null, { headers: { 'content-length': '10' }, status: 200 })
          : new Response('WHEELBYTES', { headers: { 'content-length': '10' } })
      )
    );
    const get = (await file(WHL)).response;
    expect(get.headers['content-length']).toBe('10');
    const head = (await file(WHL, 'HEAD')).response;
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    await proxy.close();
  });

  it('refuses an id the index never listed, a wrong filename, and any file before an index', async () => {
    const upstream = vi.fn(flaskUpstream());
    const { at, proxy } = await startPyProxy(upstream);
    const id = fileIdFor(PY.id, WHL_URL);
    expect((await at(`/files/${id}/${WHL}`)).status).toBe(404);
    expect((await at('/simple/flask/')).status).toBe(200);
    expect((await at(`/files/${'0'.repeat(32)}/${WHL}`)).status).toBe(404);
    expect((await at(`/files/${id}/${SDIST}`)).status).toBe(404);
    expect((await at(`/files/${id}/${WHL}x`)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await at(`/files/${id}/${WHL}`)).status).toBe(200);
    expect((await at(`/files/${id}/${WHL}`, 'POST')).status).toBe(405);
    await proxy.close();
  });

  it('does not offer a file a lockfile-mode index filtered out', async () => {
    const upstream = vi.fn(flaskUpstream());
    const { at, proxy } = await startPyProxy(upstream, {
      allowlist: pyLockfile(['flask', '3.0.0']),
    });
    await at('/simple/flask/');
    expect((await at(`/files/${fileIdFor(PY.id, SDIST_URL)}/${SDIST}`)).status).toBe(404);
    expect((await at(`/files/${fileIdFor(PY.id, WHL_URL)}/${WHL}`)).status).toBe(200);
    await proxy.close();
  });

  it('checks the pin again on a file, and reports the denial without the token', async () => {
    const upstream = vi.fn(flaskUpstream());
    const { at, denials, file, proxy, reg } = await startPyProxy(upstream);
    const { response } = await file(WHL);
    expect(response.status).toBe(200);
    // The lockfile changes after the index was served: the listed file is no longer pinned.
    reg.setAllowlist(new Map([[PY.id, pyLockfile(['flask', '2.0.0'])]]));
    const denied = await at(`/files/${fileIdFor(PY.id, WHL_URL)}/${WHL}`);
    expect(denied.status).toBe(403);
    // The version is the canonical form the allowlist compares (`3.0.0` is `3`).
    expect(denied.body).toContain('flask@3 is not in the repository');
    expect(denials).toEqual([
      { name: 'flask', reason: 'not-in-lockfile', registryId: 'py-1', version: '3' },
    ]);
    expect(JSON.stringify(denials)).not.toContain(reg.token);
    await proxy.close();
  });

  it('sends the registry credential only to a file on the registry’s own origin', async () => {
    const sameOriginUrl = 'http://pyup.test/packages/flask-1.0.0.tar.gz';
    const index = htmlIndex([
      `<a href="${WHL_URL}">${WHL}</a>`,
      `<a href="${sameOriginUrl}">flask-1.0.0.tar.gz</a>`,
      '<a href="/elsewhere/flask-1.1.0.tar.gz">flask-1.1.0.tar.gz</a>',
    ]);
    const seen = new Map<string, Record<string, string>>();
    const { file, proxy } = await startPyProxy(async (url, init) => {
      if (url.endsWith('/simple/flask/')) {
        return html(index);
      }
      seen.set(url, init?.headers as Record<string, string>);
      expect(init?.redirect).toBe('error');
      return new Response('BYTES');
    });
    expect((await file(WHL)).response.status).toBe(200);
    expect((await file('flask-1.0.0.tar.gz')).response.status).toBe(200);
    expect((await file('flask-1.1.0.tar.gz')).response.status).toBe(200);
    // Other host: nothing. Same origin, by an absolute URL and a relative one: the credential.
    expect(seen.get(WHL_URL)?.authorization).toBeUndefined();
    expect(seen.get(sameOriginUrl)?.authorization).toBe('Bearer py-up-token');
    expect(seen.get('http://pyup.test/elsewhere/flask-1.1.0.tar.gz')?.authorization).toBe(
      'Bearer py-up-token'
    );
    expect(JSON.stringify([...seen])).not.toContain('Basic');
    await proxy.close();
  });

  it('uses a guard without the private-network opt-in for another origin, and the registry’s own for the same origin', async () => {
    const calls: Array<{ allowPrivate: boolean | undefined; url: string }> = [];
    vi.mocked(createGuardedFetch).mockImplementation(
      (opts) =>
        (async (url: string) => {
          calls.push({ allowPrivate: opts?.allowPrivate, url: String(url) });
          return String(url).endsWith('/simple/flask/')
            ? html(
                htmlIndex([
                  `<a href="${WHL_URL}">${WHL}</a>`,
                  '<a href="/packages/flask-1.0.0.tar.gz">flask-1.0.0.tar.gz</a>',
                ])
              )
            : new Response('BYTES');
        }) as never
    );
    try {
      const { file, proxy } = await startPyProxy(async () => new Response('unused'), {
        inject: false,
        registry: { ...PY, allowPrivateNetwork: true },
      });
      expect((await file(WHL)).response.status).toBe(200);
      expect((await file('flask-1.0.0.tar.gz')).response.status).toBe(200);
      expect(calls.filter((c) => c.url === WHL_URL).map((c) => c.allowPrivate)).toEqual([false]);
      expect(calls.filter((c) => c.url === 'http://pyup.test/packages/flask-1.0.0.tar.gz')).toEqual(
        [{ allowPrivate: true, url: 'http://pyup.test/packages/flask-1.0.0.tar.gz' }]
      );
      // The index itself is the registry's: its opt-in applies.
      expect(calls.find((c) => c.url.endsWith('/simple/flask/'))?.allowPrivate).toBe(true);
      await proxy.close();
    } finally {
      vi.mocked(createGuardedFetch).mockReset();
    }
  });

  it('does not list an index entry whose URL does not end in its filename', async () => {
    const index = htmlIndex([
      `<a href="http://pyup.test/api/v1/admin/secrets">flask-1.0.0.tar.gz</a>`,
      `<a href="http://pyup.test/packages/flask-1.0.1.tar.gz?token=x">flask-1.0.1.tar.gz</a>`,
      `<a href="http://pyup.test/packages/flask-1.0.2.tar.gz/..">flask-1.0.2.tar.gz</a>`,
      `<a href="http://pyup.test/packages/flask-1.0.3.tar.gz%2Fx">flask-1.0.3.tar.gz</a>`,
      `<a href="http://pyup.test/packages/flask-1.0.4.tar.gz">flask-1.0.4.tar.gz</a>`,
      `<a href="http://pyup.test/packages/${'p'.repeat(2000)}/flask-1.0.5.tar.gz">flask-1.0.5.tar.gz</a>`,
    ]);
    const { at, proxy } = await startPyProxy(async () => html(index));
    expect(linksOf((await at('/simple/flask/')).body).map((l) => l.text)).toEqual([
      'flask-1.0.4.tar.gz',
    ]);
    await proxy.close();
  });

  it('sends the credential only under the registry’s path prefix, not to a same-origin sibling path', async () => {
    const registry = { ...PY, upstreamUrl: 'http://pyup.test/artifactory/api/pypi/repo/simple' };
    const under = 'http://pyup.test/artifactory/api/pypi/repo/packages/flask-1.0.0.tar.gz';
    const sibling = 'http://pyup.test/artifactory/api/pypi/repo-evil/packages/flask-1.1.0.tar.gz';
    const outside = 'http://pyup.test/api/v1/flask-1.2.0.tar.gz';
    const escaped = 'http://pyup.test/artifactory/api/pypi/repo/../../x/flask-1.3.0.tar.gz';
    const index = htmlIndex(
      [under, sibling, outside, escaped].map((u) => {
        const name = u.slice(u.lastIndexOf('/') + 1);
        return `<a href="${u}">${name}</a>`;
      })
    );
    const seen = new Map<string, Record<string, string>>();
    const { file, proxy } = await startPyProxy(
      async (url, init) => {
        if (url.endsWith('/simple/flask/')) {
          return html(index);
        }
        seen.set(url, init?.headers as Record<string, string>);
        return new Response('BYTES');
      },
      { registry }
    );
    for (const name of [
      'flask-1.0.0.tar.gz',
      'flask-1.1.0.tar.gz',
      'flask-1.2.0.tar.gz',
      'flask-1.3.0.tar.gz',
    ]) {
      expect((await file(name)).response.status, name).toBe(200);
    }
    expect(seen.get(under)?.authorization).toBe('Bearer py-up-token');
    expect(seen.get(sibling)?.authorization).toBeUndefined();
    expect(seen.get(outside)?.authorization).toBeUndefined();
    // The parser resolved `..`, so the request goes to the resolved path, outside the prefix.
    expect(
      seen.get('http://pyup.test/artifactory/api/x/flask-1.3.0.tar.gz')?.authorization
    ).toBeUndefined();
    await proxy.close();
  });

  it('fetches a same-origin file outside the prefix through a guard without the private opt-in', async () => {
    const calls: Array<{ allowPrivate: boolean | undefined; url: string }> = [];
    vi.mocked(createGuardedFetch).mockImplementation(
      (opts) =>
        (async (url: string) => {
          calls.push({ allowPrivate: opts?.allowPrivate, url: String(url) });
          return String(url).endsWith('/simple/flask/')
            ? html(
                htmlIndex([
                  '<a href="/packages/flask-1.0.0.tar.gz">flask-1.0.0.tar.gz</a>',
                  '<a href="/elsewhere/flask-1.1.0.tar.gz">flask-1.1.0.tar.gz</a>',
                ])
              )
            : new Response('BYTES');
        }) as never
    );
    try {
      const { file, proxy } = await startPyProxy(async () => new Response('unused'), {
        inject: false,
        registry: {
          ...PY,
          allowPrivateNetwork: true,
          upstreamUrl: 'http://pyup.test/repo/simple',
        },
      });
      // Relative URLs resolve against the index URL `/repo/simple/flask/`.
      expect((await file('flask-1.0.0.tar.gz')).response.status).toBe(200);
      expect((await file('flask-1.1.0.tar.gz')).response.status).toBe(200);
      const byUrl = (u: string) => calls.filter((c) => c.url === u).map((c) => c.allowPrivate);
      expect(byUrl('http://pyup.test/packages/flask-1.0.0.tar.gz')).toEqual([false]);
      expect(byUrl('http://pyup.test/elsewhere/flask-1.1.0.tar.gz')).toEqual([false]);
      await proxy.close();
    } finally {
      vi.mocked(createGuardedFetch).mockReset();
    }
  });

  it('refuses a cross-origin http file, without fetching it', async () => {
    const urls: string[] = [];
    const index = htmlIndex([
      `<a href="http://files.test/packages/${WHL}">${WHL}</a>`,
      `<a href="http://pyup.test/packages/${SDIST}">${SDIST}</a>`,
    ]);
    const { file, proxy } = await startPyProxy(async (url) => {
      urls.push(url);
      return url.endsWith('/simple/flask/') ? html(index) : new Response('BYTES');
    });
    const blocked = await file(WHL);
    expect(blocked.response.status).toBe(502);
    expect(JSON.parse(blocked.response.body).error).toMatch(/not on a permitted address/);
    // Plain http is fine on the registry's own origin.
    expect((await file(SDIST)).response.status).toBe(200);
    expect(urls.filter((u) => u.startsWith('http://files.test'))).toEqual([]);
    await proxy.close();
  });

  it('does not follow a redirect, and turns every other outcome into a fixed message', async () => {
    let mode: 'redirect' | '404' | '410' | '500' | 'throw' = '404';
    const { file, proxy } = await startPyProxy(
      flaskUpstream((_url, init) => {
        expect(init?.redirect).toBe('error');
        if (mode === 'throw') {
          throw new Error('SECRET connect ECONNREFUSED 10.0.0.1');
        }
        if (mode === 'redirect') {
          throw new TypeError('fetch failed', { cause: new Error('SECRET unexpected redirect') });
        }
        return new Response('SECRET upstream body', { status: Number(mode) });
      })
    );
    const expected = { '404': 404, '410': 404, '500': 502, redirect: 502, throw: 502 } as const;
    for (const m of Object.keys(expected) as Array<keyof typeof expected>) {
      mode = m;
      const { response } = await file(WHL);
      expect(response.status, m).toBe(expected[m]);
      expect(response.body, m).not.toContain('SECRET');
    }
    await proxy.close();
  });

  it('refuses a file whose content-length is over the cap, before streaming', async () => {
    const { file, proxy } = await startPyProxy(
      flaskUpstream(() => new Response('x'.repeat(100), { headers: { 'content-length': '100' } })),
      { maxPypiFileBytes: 50 }
    );
    const { response } = await file(WHL);
    expect(response.status).toBe(502);
    expect(response.cutOff).toBe(false);
    await proxy.close();
  });

  it('cuts a file off once it passes the cap without a content-length', async () => {
    const aborted = vi.fn();
    const { file, proxy } = await startPyProxy(
      flaskUpstream((_url, init) => {
        init?.signal?.addEventListener('abort', aborted);
        const chunk = new Uint8Array(40).fill(65);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
              // Like a network body, each chunk arrives in a later turn of the event loop.
              return new Promise((r) => setTimeout(r, 1));
            },
          })
        );
      }),
      { maxPypiFileBytes: 100 }
    );
    const { response } = await file(WHL);
    expect(response.cutOff).toBe(true);
    expect(response.bytes).toBeLessThanOrEqual(100);
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled());
    await proxy.close();
  });

  it('stops the upstream when the client hangs up, and release() waits for the request', async () => {
    let cancelled = false;
    const { at, base, proxy, reg } = await startPyProxy(
      flaskUpstream(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
              pull(controller) {
                controller.enqueue(new Uint8Array(1024));
                return new Promise((r) => setTimeout(r, 5));
              },
            })
          )
      )
    );
    const link = linksOf((await at('/simple/flask/')).body)[0]?.href as string;
    await new Promise<void>((resolve) => {
      const req = http.request(
        `${base}${link}`,
        { headers: { authorization: basic('token', reg.token) } },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        }
      );
      req.on('error', () => {});
      req.end();
    });
    await reg.release();
    expect(cancelled).toBe(true);
    await proxy.close();
  });

  it('serves a cached file without an upstream call, keyed by registry and file URL, and caches only GETs', async () => {
    const store = new Map<string, Buffer>();
    const cache = {
      get: async (id: string, key: string) => {
        const hit = store.get(`${id} ${key}`);
        return hit ? { createStream: () => Readable.from([hit]) } : null;
      },
      startWrite: async (id: string, key: string) => {
        const parts: Buffer[] = [];
        return {
          abort: async () => {},
          commit: async () => {
            store.set(`${id} ${key}`, Buffer.concat(parts));
          },
          write: async (c: Uint8Array) => {
            parts.push(Buffer.from(c));
          },
        };
      },
    } as unknown as TarballCache;
    const fileFetch = vi.fn(() => new Response('WHEELBYTES'));
    const { at, file, proxy, reg } = await startPyProxy(flaskUpstream(fileFetch), { cache });
    expect((await file(WHL)).response.body).toBe('WHEELBYTES');
    await vi.waitFor(() => expect(store.has(`py-1 ${WHL_URL}`)).toBe(true));
    expect((await file(WHL)).response.body).toBe('WHEELBYTES');
    expect(fileFetch).toHaveBeenCalledTimes(1);
    // The key holds the file URL, never the token.
    expect([...store.keys()].join('\n')).not.toContain(reg.token);
    expect((await at(`/files/${fileIdFor(PY.id, WHL_URL)}/${WHL}`, 'HEAD')).status).toBe(200);
    await proxy.close();
  });

  it('never serves a cached file the allowlist would deny', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pypi-cache-'));
    const cache = new TarballCache(dir, 10 * 1024 * 1024);
    const upstream = vi.fn(flaskUpstream());
    const { at, file, proxy, reg } = await startPyProxy(upstream, { cache });
    expect((await file(WHL)).response.body).toBe('WHEELBYTES');
    // The entry is committed (renamed into place as `<sha>.tgz`) after the response ends.
    const committed = () =>
      existsSync(join(dir, PY.id)) && readdirSync(join(dir, PY.id)).some((f) => f.endsWith('.tgz'));
    for (let i = 0; i < 200 && !committed(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(committed()).toBe(true);
    const link = `/files/${fileIdFor(PY.id, WHL_URL)}/${WHL}`;
    // Served from disk while it is allowed…
    const calls = upstream.mock.calls.length;
    expect((await at(link)).body).toBe('WHEELBYTES');
    expect(upstream.mock.calls.length).toBe(calls);
    // …and refused, not served from disk, once it is not.
    reg.setAllowlist(new Map([[PY.id, pyLockfile(['flask', '2.0.0'])]]));
    expect((await at(link)).status).toBe(403);
    // A cross-origin plain-http entry cannot be reached through the cache either: it never got in.
    expect(readdirSync(join(dir, PY.id))).toHaveLength(1);
    await proxy.close();
  });
});

// ---- Maven proxy (`/maven/<registryId>/…`, the token as the Basic password) ----

const MV = {
  ...REG,
  ecosystem: 'maven' as const,
  id: 'mv-1',
  isDefault: false,
  name: 'central',
  token: 'mv-up-token',
  upstreamUrl: 'http://mvup.test/maven2',
};
const JAR = 'org/acme/lib/1.0/lib-1.0.jar';
const POM = 'org/acme/lib/1.0/lib-1.0.pom';

/** A request target sent exactly as written, so `..` and escapes are not resolved on the client. */
const rawTarget = (base: string, path: string, authorization?: string, method = 'GET') =>
  new Promise<{ body: string; status: number }>((resolve, reject) => {
    const u = new URL(base);
    const req = http.request(
      {
        headers: authorization ? { authorization } : {},
        host: u.hostname,
        method,
        path,
        port: u.port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString(), status: res.statusCode ?? 0 })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });

/** An in-memory stand-in for the tarball cache, keyed like the real one. */
function memoryCache() {
  const store = new Map<string, Buffer>();
  const cache = {
    get: async (id: string, key: string) => {
      const hit = store.get(`${id} ${key}`);
      return hit ? { createStream: () => Readable.from([hit]) } : null;
    },
    startWrite: async (id: string, key: string) => {
      const parts: Buffer[] = [];
      return {
        abort: async () => {},
        commit: async () => {
          store.set(`${id} ${key}`, Buffer.concat(parts));
        },
        write: async (c: Uint8Array) => {
          parts.push(Buffer.from(c));
        },
      };
    },
  } as unknown as TarballCache;
  return { cache, store };
}

async function startMavenProxy(
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  opts: {
    allowlist?: Map<string, Set<string>> | null;
    cache?: TarballCache;
    maxMavenFileBytes?: number;
    registry?: typeof MV;
    upstreamDeadlineMs?: number;
  } = {}
) {
  const denials: unknown[] = [];
  const proxy = createRegistryProxy({
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    cache: opts.cache,
    listenHost: '127.0.0.1',
    listenPort: 0,
    maxMavenFileBytes: opts.maxMavenFileBytes,
    upstreamDeadlineMs: opts.upstreamDeadlineMs,
    upstreamFetch: upstream as never,
  });
  const base = `http://127.0.0.1:${await proxy.listen()}`;
  const reg = await proxy.register({
    onDenied: (d) => denials.push(d),
    registries: [opts.registry ?? MV],
  });
  reg.setAllowlist(new Map([[MV.id, opts.allowlist === undefined ? null : opts.allowlist]]));
  const at = (path: string, method = 'GET', authorization = basic('token', reg.token)) =>
    rawGet(base, `/maven/${MV.id}/${path}`, authorization, method);
  return { at, base, denials, proxy, reg };
}

describe('maven proxy: access', () => {
  it('answers 401, 404, 405, 503 and 404 in the PyPI route’s order', async () => {
    const { base, proxy } = await startProxy(async () => new Response('x'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [MV, REG, GO, PY] });
    const at = (id: string, method = 'GET') =>
      rawGet(base, `/maven/${id}/${JAR}`, basic('token', reg.token), method);
    expect((await rawGet(base, `/maven/mv-1/${JAR}`, basic('token', 'wrong'))).status).toBe(401);
    expect((await at('nope')).status).toBe(404);
    // Neither an npm, a Go nor a PyPI registry id is a Maven registry.
    for (const id of [REG.id, GO.id, PY.id]) {
      expect((await at(id)).status, id).toBe(404);
    }
    expect((await at('mv-1', 'POST')).status).toBe(405);
    expect((await at('mv-1', 'DELETE')).status).toBe(405);
    expect((await at('mv-1')).status).toBe(503);
    reg.setAllowlist(
      new Map([
        [MV.id, null],
        [REG.id, null],
        [GO.id, null],
        [PY.id, null],
      ])
    );
    const bad = await rawGet(base, `/maven/mv-1/org/acme`, basic('token', reg.token));
    expect(bad.status).toBe(404);
    expect(bad.body).toContain('unrecognized Maven path');
    expect((await at('mv-1')).status).toBe(200);
    await proxy.close();
  });

  it('authenticates by the Basic password alone, whatever the user name', async () => {
    const { at, base, proxy, reg } = await startMavenProxy(async () => new Response('JAR'));
    expect((await at(JAR, 'GET', basic('token', reg.token))).status).toBe(200);
    expect((await at(JAR, 'GET', basic('', reg.token))).status).toBe(200);
    expect((await at(JAR, 'GET', basic('anything', reg.token))).status).toBe(200);
    expect((await at(JAR, 'GET', basic(reg.token, 'x'))).status).toBe(401);
    expect((await at(JAR, 'GET', basic(reg.token, ''))).status).toBe(401);
    expect(
      (await at(JAR, 'GET', `Basic ${Buffer.from(reg.token).toString('base64')}`)).status
    ).toBe(401);
    expect((await at(JAR, 'GET', 'Basic !!!')).status).toBe(401);
    expect((await at(JAR, 'GET', basic('token', 'wrong'))).status).toBe(401);
    // A token in the path is no credential.
    expect((await rawGet(base, `/maven/${reg.token}/${MV.id}/${JAR}`)).status).toBe(401);
    expect(
      (await rawGet(base, `/maven/${reg.token}/${MV.id}/${JAR}`, basic('token', reg.token))).status
    ).toBe(404);
    await proxy.close();
  });

  it('refuses a Bearer header, or none, with a Basic challenge before anything else', async () => {
    const { base, proxy, reg } = await startMavenProxy(async () => new Response('JAR'));
    for (const authorization of [bearer(reg.token), undefined]) {
      const res = await rawGet(base, `/maven/${MV.id}/${JAR}`, authorization);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="registry"');
    }
    for (const path of ['/maven/nope/x.jar', '/maven/mv-1/other', '/maven/']) {
      const res = await rawGet(base, path, bearer(reg.token));
      expect(res.status, path).toBe(401);
      expect(res.headers['www-authenticate'], path).toBe('Basic realm="registry"');
    }
    await proxy.close();
  });

  it('judges the route by the normalised path: /maven/.. reaches neither npm nor Go', async () => {
    const { base, proxy } = await startProxy(async () => new Response('{}'));
    const reg = await proxy.register({ onDenied: () => {}, registries: [REG, GO, MV] });
    reg.setAllowlist(
      new Map([
        [MV.id, null],
        [REG.id, null],
        [GO.id, null],
      ])
    );
    const creds = basic('u', reg.token);
    // Basic is read on no route but PyPI and Maven.
    expect((await rawGet(base, `/npm/${REG.id}/pkg`, creds)).status).toBe(401);
    expect((await rawGet(base, `/go/wrong/${GO.id}/a/b/@latest`, creds)).status).toBe(401);
    for (const path of [
      `/maven/../npm/${REG.id}/pkg`,
      `/maven/%2e%2e/npm/${REG.id}/pkg`,
      `/maven/x/../../npm/${REG.id}/pkg`,
    ]) {
      // Judged as the npm path it normalises to: Basic is refused, Bearer is an ordinary request.
      expect((await rawTarget(base, path, creds)).status, path).toBe(401);
      expect((await rawTarget(base, path, bearer(reg.token))).status, path).toBe(200);
      expect((await rawTarget(base, path)).status, path).toBe(401);
    }
    // `/maven/<id>/../npm/…` is the Maven route with the registry id `npm`: with no credential
    // it is a challenge, with one an unknown registry — never npm.
    const sibling = `/maven/${MV.id}/../npm/${REG.id}/pkg`;
    expect((await rawTarget(base, sibling)).status).toBe(401);
    expect((await rawTarget(base, sibling, creds)).status).toBe(404);
    expect((await rawTarget(base, `/maven/../go/wrong/${GO.id}/a/b/@latest`, creds)).status).toBe(
      401
    );
    await proxy.close();
  });

  it('puts the proxy token in no response, header or denial report', async () => {
    const seenByUpstream: string[] = [];
    const { at, base, denials, proxy, reg } = await startMavenProxy(async (url, init) => {
      seenByUpstream.push(url, JSON.stringify(init?.headers));
      return url.endsWith('.pom')
        ? new Response('SECRET-UPSTREAM', { status: 500 })
        : new Response('JAR');
    });
    const responses = [
      await at(JAR),
      await at(POM),
      await at('org/acme'),
      await at(JAR, 'POST'),
      await at(JAR, 'GET', basic('token', 'wrong')),
      await rawGet(base, `/maven/nope/${JAR}`, basic('token', reg.token)),
      await rawGet(base, `/maven/${reg.token}/${MV.id}/${JAR}`, basic('token', reg.token)),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 502, 404, 405, 401, 404, 404]);
    expect(JSON.stringify(responses.map((r) => [r.body, r.headers]))).not.toContain(reg.token);
    expect(JSON.stringify(seenByUpstream)).not.toContain(reg.token);
    expect(denials).toEqual([]);
    await proxy.close();
  });
});

describe('maven proxy: isolation from the other ecosystems', () => {
  it('keeps a Maven registry out of the npm, Go and PyPI routes', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    const reg = await proxy.register({ onDenied: () => {}, registries: [MV, REG] });
    reg.setAllowlist(
      new Map([
        [MV.id, null],
        [REG.id, null],
      ])
    );
    expect((await rawGet(base, `/npm/${MV.id}/pkg`, bearer(reg.token))).status).toBe(404);
    expect((await rawGet(base, `/go/${reg.token}/${MV.id}/a/b/@latest`)).status).toBe(404);
    expect((await rawGet(base, `/pypi/${MV.id}/simple/flask/`, basic('t', reg.token))).status).toBe(
      404
    );
    expect(urls).toEqual([]);
    await proxy.close();
  });

  it('ignores a Maven row in npm default resolution, scopes and the audit relay', async () => {
    const urls: string[] = [];
    const { base, proxy } = await startProxy(async (url) => {
      urls.push(url);
      return new Response('{}');
    });
    // The only default-flagged registry is the Maven one, and it claims a scope.
    const mvDefault = { ...MV, isDefault: true, scopes: ['@acme'] };
    const npmPlain = { ...REG, isDefault: false, scopes: ['@other'] };
    const reg = await proxy.register({ onDenied: () => {}, registries: [mvDefault, npmPlain] });
    reg.setAllowlist(
      new Map([
        [MV.id, null],
        [REG.id, null],
      ])
    );
    const npm = (path: string, method = 'GET') =>
      rawGet(base, `/npm/${REG.id}${path}`, bearer(reg.token), method);
    const noDefault = await npm('/left-pad');
    expect(noDefault.status).toBe(404);
    expect(noDefault.body).toContain('no registry serves left-pad');
    expect((await npm('/@acme%2fx')).status).toBe(404);
    expect((await npm('/@other%2fx')).status).toBe(200);
    const audit = await npm('/-/npm/v1/security/advisories/bulk', 'POST');
    expect(audit.status).toBe(404);
    expect(audit.body).toContain('no default registry answers audits');
    expect(urls).toEqual(['http://upstream.test/@other%2fx']);
    await proxy.close();
  });
});

describe('maven proxy: paths and kinds', () => {
  it('never reaches the upstream for a path that is not a plain file path', async () => {
    const upstream = vi.fn(async () => new Response('x'));
    const { base, proxy, reg } = await startMavenProxy(upstream);
    const creds = basic('t', reg.token);
    const longSegment = 'a'.repeat(201);
    const deep = Array.from({ length: 25 }, () => 'a').join('/');
    for (const rest of [
      '',
      '/',
      '/org/acme/',
      '/org/acme',
      '/org//acme/x.jar',
      '/org/.hidden/x.jar',
      '/org/acme/x%2ejar',
      '/org/ac%2fme/x.jar',
      '/org/acme/x%00.jar',
      '/org/acme/x%20y.jar',
      '/org/acme/x%5c..%5cy.jar',
      '/org/acme/%C3%A9.jar',
      `/${longSegment}/x.jar`,
      `/${deep}/x.jar`,
    ]) {
      const res = await rawTarget(base, `/maven/${MV.id}${rest}`, creds);
      expect(res.status, rest).toBe(404);
      expect(res.body, rest).toContain('unrecognized Maven path');
    }
    // `..` is resolved before routing: it can climb out of the route, never into the upstream.
    const out = await rawTarget(base, `/maven/${MV.id}/../../etc/x.jar`, creds);
    expect(out.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('builds the upstream URL from the validated path alone, with no query', async () => {
    const urls: string[] = [];
    const { at, proxy } = await startMavenProxy(async (url) => {
      urls.push(url);
      return new Response('x');
    });
    await at(JAR);
    await at(`${POM}?x=1#frag`);
    await at('org/acme/lib/1.0/lib-1.0+b_1~2.jar');
    expect(urls).toEqual([
      `http://mvup.test/maven2/${JAR}`,
      `http://mvup.test/maven2/${POM}`,
      'http://mvup.test/maven2/org/acme/lib/1.0/lib-1.0+b_1~2.jar',
    ]);
    await proxy.close();
  });

  it('answers a fixed content type per file, never the upstream’s own', async () => {
    const { at, proxy } = await startMavenProxy(
      async () => new Response('x', { headers: { 'content-type': 'text/html' } })
    );
    expect((await at(POM)).headers['content-type']).toBe('application/xml');
    expect((await at(`${JAR}.sha1`)).headers['content-type']).toBe('text/plain; charset=utf-8');
    expect((await at(JAR)).headers['content-type']).toBe('application/octet-stream');
    await proxy.close();
  });
});

describe('maven proxy: relay', () => {
  it('sends the registry credential to its own origin with redirects refused', async () => {
    const seen: Array<{ headers: Record<string, string>; redirect?: string; url: string }> = [];
    const { at, proxy, reg } = await startMavenProxy(async (url, init) => {
      seen.push({
        headers: init?.headers as Record<string, string>,
        redirect: init?.redirect,
        url,
      });
      return new Response('x');
    });
    await at(JAR);
    expect(seen[0]?.headers.authorization).toBe('Bearer mv-up-token');
    expect(seen[0]?.redirect).toBe('error');
    expect(new URL(seen[0]?.url ?? '').origin).toBe(new URL(MV.upstreamUrl).origin);
    expect(JSON.stringify(seen)).not.toContain(reg.token);
    await proxy.close();
  });

  it('sends a basic credential as Basic', async () => {
    const seen: Array<Record<string, string>> = [];
    const { at, proxy } = await startMavenProxy(
      async (_url, init) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response('x');
      },
      { registry: { ...MV, authKind: 'basic' as never, token: 'svc:secret' } }
    );
    await at(JAR);
    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from('svc:secret').toString('base64')}`);
    await proxy.close();
  });

  it('answers a 404 and a 410 as 404, with a fixed body', async () => {
    const { at, proxy } = await startMavenProxy(async (url) =>
      url.endsWith('.pom')
        ? new Response('SECRET-UPSTREAM-404', { status: 404 })
        : new Response('SECRET-UPSTREAM-410', { status: 410 })
    );
    for (const path of [POM, JAR]) {
      const res = await at(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('SECRET');
      expect(JSON.parse(res.body).error).toMatch(/^the upstream Maven repository/);
    }
    await proxy.close();
  });

  it('turns any other upstream status, a redirect and a fetch failure into a fixed 502', async () => {
    let mode: 'redirect' | 'error' | 'throw' = 'error';
    const { at, proxy } = await startMavenProxy(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      if (mode === 'throw') {
        throw new Error('SECRET connect ECONNREFUSED 10.0.0.1');
      }
      if (mode === 'redirect') {
        throw new TypeError('fetch failed', { cause: new Error('SECRET unexpected redirect') });
      }
      return new Response('SECRET upstream 500 body', { status: 500 });
    });
    for (const m of ['error', 'redirect', 'throw'] as const) {
      mode = m;
      for (const path of [POM, JAR]) {
        const res = await at(path);
        expect(res.status, `${m} ${path}`).toBe(502);
        expect(res.body, `${m} ${path}`).not.toContain('SECRET');
        expect(JSON.parse(res.body).error).toMatch(/^the upstream Maven repository/);
      }
    }
    await proxy.close();
  });

  it('relays HEAD without a body', async () => {
    const methods: Array<string | undefined> = [];
    const { at, proxy } = await startMavenProxy(async (_url, init) => {
      methods.push(init?.method);
      return init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '3' }, status: 200 })
        : new Response('JAR');
    });
    const head = await at(JAR, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(methods).toEqual(['HEAD']);
    await proxy.close();
  });

  it('refuses a file whose content-length is over the cap, before streaming', async () => {
    const { at, proxy } = await startMavenProxy(
      async () => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
      { maxMavenFileBytes: 50 }
    );
    const res = await at(JAR);
    expect(res.status).toBe(502);
    expect(res.cutOff).toBe(false);
    await proxy.close();
  });

  it('cuts a file off once it passes the cap without a content-length', async () => {
    const aborted = vi.fn();
    const { at, proxy } = await startMavenProxy(
      async (_url, init) => {
        init?.signal?.addEventListener('abort', aborted);
        const chunk = new Uint8Array(40).fill(65);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
              return new Promise((r) => setTimeout(r, 1));
            },
          })
        );
      },
      { maxMavenFileBytes: 100 }
    );
    const res = await at(JAR);
    expect(res.cutOff).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(100);
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled());
    await proxy.close();
  });

  it('holds a small file to the upstream deadline and lets an archive stream past it', async () => {
    const slow = async (url: string, init?: RequestInit) => {
      if (url.endsWith('.pom')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      await new Promise((r) => setTimeout(r, 120));
      return new Response('JARBYTES');
    };
    const { at, proxy } = await startMavenProxy(slow, { upstreamDeadlineMs: 40 });
    const pom = await at(POM);
    expect(pom.status).toBe(502);
    expect(JSON.parse(pom.body).error).toMatch(/^the upstream Maven repository/);
    const jar = await at(JAR);
    expect(jar.status).toBe(200);
    expect(jar.body).toBe('JARBYTES');
    await proxy.close();
  });
});

describe('maven proxy: open mode only', () => {
  it('serves nothing from a registry whose allowlist is not open', async () => {
    const upstream = vi.fn(async () => new Response('JAR'));
    const lockfile = await startMavenProxy(upstream, {
      allowlist: new Map([['org.acme:lib', new Set(['1.0'])]]),
    });
    const res = await lockfile.at(JAR);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toBe('a Maven registry serves open mode only');
    expect((await lockfile.at(JAR, 'HEAD')).status).toBe(503);
    expect(lockfile.denials).toEqual([]);
    await lockfile.proxy.close();
    // A registry the allowlist map does not name at all is not open either.
    const proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://127.0.0.1:${p}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamFetch: upstream as never,
    });
    const base = `http://127.0.0.1:${await proxy.listen()}`;
    const reg = await proxy.register({ onDenied: () => {}, registries: [MV] });
    reg.setAllowlist(new Map());
    const unnamed = await rawGet(base, `/maven/${MV.id}/${JAR}`, basic('t', reg.token));
    expect(unnamed.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });
});

describe('maven proxy: cache', () => {
  it('caches a release file and answers the second request from it', async () => {
    const { cache, store } = memoryCache();
    const upstream = vi.fn(async () => new Response('JARDATA'));
    const { at, proxy } = await startMavenProxy(upstream, { cache });
    expect((await at(JAR)).body).toBe('JARDATA');
    expect((await at(JAR)).body).toBe('JARDATA');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(store.has(`mv-1 http://mvup.test/maven2/${JAR}`)).toBe(true);
    // HEAD always asks the upstream.
    await at(JAR, 'HEAD');
    expect(upstream).toHaveBeenCalledTimes(2);
    await proxy.close();
  });

  it('never caches nor serves from the cache metadata and snapshot files', async () => {
    const { cache, store } = memoryCache();
    const stale = [
      'org/acme/lib/maven-metadata.xml',
      'org/acme/lib/maven-metadata.xml.sha1',
      'org/acme/lib/1.0-SNAPSHOT/maven-metadata.xml',
      'org/acme/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar',
      'org/acme/lib/1.0-SNAPSHOT/lib-1.0-20240101.123456-3.jar',
      'org/acme/lib/1.0-SNAPSHOT/lib-1.0-20240101.123456-3.pom',
    ];
    for (const p of stale) {
      store.set(`mv-1 http://mvup.test/maven2/${p}`, Buffer.from('STALE'));
    }
    const seeded = store.size;
    const upstream = vi.fn(async () => new Response('FRESH'));
    const { at, proxy } = await startMavenProxy(upstream, { cache });
    for (const p of stale) {
      expect((await at(p)).body, p).toBe('FRESH');
      expect((await at(p)).body, p).toBe('FRESH');
    }
    expect(upstream).toHaveBeenCalledTimes(stale.length * 2);
    expect(store.size).toBe(seeded);
    await proxy.close();
  });

  // The real cache is the one place a Maven file, a Go zip and an npm tarball share storage, so its
  // key layout (a directory per registry id) is exercised here and not only through a fake.
  it('stores a release on disk under its registry id and serves the second request from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maven-cache-'));
    const cache = new TarballCache(dir, 10 * 1024 * 1024);
    const upstream = vi.fn(async () => new Response('JARDATA'));
    const { at, proxy } = await startMavenProxy(upstream, { cache });
    expect((await at(JAR)).body).toBe('JARDATA');
    // The entry is committed (renamed into place as `<sha>.tgz`) after the response ends.
    const committed = () =>
      existsSync(join(dir, MV.id)) && readdirSync(join(dir, MV.id)).some((f) => f.endsWith('.tgz'));
    for (let i = 0; i < 200 && !committed(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(committed()).toBe(true);
    expect((await at(JAR)).body).toBe('JARDATA');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(dir, MV.id))).toHaveLength(1);
    // Metadata and a snapshot add nothing to the directory.
    await at('org/acme/lib/maven-metadata.xml');
    await at('org/acme/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar');
    expect(readdirSync(join(dir, MV.id))).toHaveLength(1);
    await proxy.close();
  });
});

// ---- Go checksum-database relay (`/go/<token>/<registryId>/sumdb/sum.golang.org/…`) ----

const SUMDB = '/sumdb/sum.golang.org';

async function startSumdbProxy(
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  opts: {
    allowlist?: Map<string, Set<string>> | null;
    cache?: TarballCache;
    limits?: {
      maxBufferedFetches?: number;
      maxQueuedFetches?: number;
      upstreamDeadlineMs?: number;
    };
  } = {}
) {
  const denials: unknown[] = [];
  const proxy = createRegistryProxy({
    ...opts.limits,
    advertisedUrl: (p) => `http://127.0.0.1:${p}`,
    cache: opts.cache,
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamFetch: upstream as never,
  });
  const base = `http://127.0.0.1:${await proxy.listen()}`;
  const reg = await proxy.register({ onDenied: (d) => denials.push(d), registries: [GO] });
  reg.setAllowlist(new Map([[GO.id, opts.allowlist === undefined ? null : opts.allowlist]]));
  const call = (rest: string, method = 'GET') =>
    rawGet(base, `/go/${reg.token}/${GO.id}${rest}`, undefined, method);
  return { base, call, denials, proxy, reg };
}

describe('go checksum database relay', () => {
  it('relays the four request shapes to the same path upstream, with a fixed content type', async () => {
    const urls: string[] = [];
    const { call, proxy } = await startSumdbProxy(async (url) => {
      urls.push(url);
      return new Response('answer', { headers: { 'content-type': 'text/html' } });
    });
    const text = [
      'supported',
      'latest',
      'lookup/golang.org/x/text@v0.14.0',
      'lookup/github.com/!azure/go-autorest@v14.2.0+incompatible',
    ];
    const tiles = ['tile/8/0/000', 'tile/8/1/x001/234', 'tile/8/0/x001/x234/567.p/128'];
    for (const rest of text) {
      const res = await call(`${SUMDB}/${rest}`);
      expect(res.status, rest).toBe(200);
      expect(res.body).toBe('answer');
      expect(res.headers['content-type'], rest).toBe('text/plain; charset=utf-8');
    }
    for (const rest of tiles) {
      const res = await call(`${SUMDB}/${rest}`);
      expect(res.status, rest).toBe(200);
      expect(res.headers['content-type'], rest).toBe('application/octet-stream');
    }
    expect(urls).toEqual([...text, ...tiles].map((r) => `http://goup.test${SUMDB}/${r}`));
    await proxy.close();
  });

  it('refuses another database, traversal and malformed shapes before any upstream call', async () => {
    const upstream = vi.fn(async () => new Response('x'));
    const { call, proxy } = await startSumdbProxy(upstream);
    for (const rest of [
      '/sumdb/sum.example.org/supported',
      '/sumdb/sum.golang.org.evil/supported',
      '/sumdb/',
      '/sumdb/sum.golang.org',
      `${SUMDB}/`,
      `${SUMDB}/other`,
      `${SUMDB}/supported/x`,
      `${SUMDB}/lookup/golang.org/x/text`,
      `${SUMDB}/lookup/golang.org/x/text@latest`,
      `${SUMDB}/lookup/a%2fb@v1.0.0`,
      `${SUMDB}/lookup/Golang.org/x/text@v0.14.0`,
      `${SUMDB}/tile/8/0/1`,
      `${SUMDB}/tile/8/0/x01/234`,
      `${SUMDB}/tile/8/0/234.p`,
      `${SUMDB}/tile/8/0/234.p/x`,
      `${SUMDB}//supported`,
      `${SUMDB}/a%2fb/supported`,
    ]) {
      const res = await call(rest);
      expect(res.status, rest).toBe(404);
      expect(res.body, rest).toContain('unrecognized Go checksum database path');
    }
    expect(upstream).not.toHaveBeenCalled();
    await proxy.close();
  });

  it('judges a traversal by the normalised path', async () => {
    const urls: string[] = [];
    const { base, proxy, reg } = await startSumdbProxy(async (url) => {
      urls.push(url);
      return new Response('x');
    });
    // `..` is resolved before routing, so this is `/sumdb/latest`, which is not the database.
    const res = await rawTarget(base, `/go/${reg.token}/${GO.id}${SUMDB}/../latest`);
    expect(res.status).toBe(404);
    expect(urls).toEqual([]);
    await proxy.close();
  });

  it('sends the registry credential with redirects refused, and never the proxy token', async () => {
    const seen: Array<{ headers: Record<string, string>; redirect?: string }> = [];
    const { call, proxy, reg } = await startSumdbProxy(async (_url, init) => {
      seen.push({ headers: init?.headers as Record<string, string>, redirect: init?.redirect });
      return new Response('x');
    });
    await call(`${SUMDB}/supported`);
    expect(seen[0]?.headers.authorization).toBe('Bearer go-up-token');
    expect(seen[0]?.headers['accept-encoding']).toBe('identity');
    expect(seen[0]?.redirect).toBe('error');
    expect(JSON.stringify(seen)).not.toContain(reg.token);
    await proxy.close();
  });

  it('is GET and HEAD only, and caches nothing', async () => {
    const { cache, store } = memoryCache();
    const upstream = vi.fn(async () => new Response('answer'));
    const { call, proxy } = await startSumdbProxy(upstream, { cache });
    expect((await call(`${SUMDB}/latest`, 'POST')).status).toBe(405);
    expect((await call(`${SUMDB}/latest`)).body).toBe('answer');
    expect((await call(`${SUMDB}/latest`)).body).toBe('answer');
    expect((await call(`${SUMDB}/tile/8/0/000`)).body).toBe('answer');
    expect((await call(`${SUMDB}/latest`, 'HEAD')).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(store.size).toBe(0);
    await proxy.close();
  });

  it('answers a 404 and a 410 as 404, and never relays an upstream body on an error', async () => {
    let status = 404;
    const { call, proxy } = await startSumdbProxy(async () => {
      if (status === 0) {
        throw new Error('SECRET connect ECONNREFUSED 10.0.0.1');
      }
      return new Response(`SECRET-UPSTREAM-${status}`, { status });
    });
    for (const s of [404, 410]) {
      status = s;
      const res = await call(`${SUMDB}/lookup/a/b@v1.0.0`);
      expect(res.status, String(s)).toBe(404);
      expect(res.body).not.toContain('SECRET');
    }
    for (const s of [500, 302, 0]) {
      status = s;
      const res = await call(`${SUMDB}/supported`);
      expect(res.status, String(s)).toBe(502);
      expect(res.body).not.toContain('SECRET');
      expect(JSON.parse(res.body).error).toMatch(/^the upstream Go checksum database/);
    }
    await proxy.close();
  });

  it('refuses an answer over 8 MiB', async () => {
    const { call, proxy } = await startSumdbProxy(
      async () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })
    );
    const res = await call(`${SUMDB}/tile/8/0/000`);
    expect(res.status).toBe(502);
    expect(res.cutOff).toBe(false);
    await proxy.close();
  });

  it('is served in lockfile mode too, without touching the module allowlist', async () => {
    const urls: string[] = [];
    const { call, denials, proxy } = await startSumdbProxy(
      async (url) => {
        urls.push(url);
        return new Response('answer');
      },
      { allowlist: goLockfile() }
    );
    expect((await call(`${SUMDB}/supported`)).status).toBe(200);
    expect((await call(`${SUMDB}/lookup/example.com/other@v1.0.0`)).status).toBe(200);
    expect((await call(`${SUMDB}/tile/8/0/000`)).status).toBe(200);
    expect(denials).toEqual([]);
    // The module routes still enforce the lockfile.
    expect((await call('/example.com/other/@v/v1.0.0.zip')).status).toBe(403);
    expect(urls).toHaveLength(3);
    await proxy.close();
  });

  it('takes a buffered-fetch slot for the whole relay: a taken slot is a 503', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started = 0;
    const { call, proxy } = await startSumdbProxy(
      async () => {
        started++;
        await gate;
        return new Response('answer');
      },
      { limits: { maxBufferedFetches: 1, maxQueuedFetches: 0 } }
    );
    const first = call(`${SUMDB}/latest`);
    for (let i = 0; i < 1000 && started === 0; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(1);
    const busy = await call(`${SUMDB}/supported`);
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('5');
    open();
    expect((await first).status).toBe(200);
    // The slot is given back.
    expect((await call(`${SUMDB}/supported`)).status).toBe(200);
    await proxy.close();
  });

  it('answers a fixed 502 when the upstream does not answer within the deadline', async () => {
    const { call, proxy } = await startSumdbProxy(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { limits: { upstreamDeadlineMs: 40 } }
    );
    const res = await call(`${SUMDB}/supported`);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/^the upstream Go checksum database/);
    await proxy.close();
  });
});
