/**
 * End-to-end proof that real package managers install through the registry
 * proxy. Two fake upstreams (each requiring its own Bearer token) sit on the
 * host; containers built from `defaults/Dockerfile.node` reach a real
 * `createRegistryProxy` over the bridge gateway. Needs a Docker daemon:
 *
 *   REGISTRY_PROXY_DOCKER_TEST=1 REGISTRY_PROXY_TEST_IMAGE=<image> \
 *     yarn vitest run packages/worker/src/lib/registryProxy/clients.docker.test.ts
 *
 * No internet is required: every URL the clients see points at the proxy.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as signSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildAllowlist,
  packageManagerPins,
  parseLockfile,
} from '@auto-swe/shared/lib/lockfileAllowlist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRegistryProxy,
  type RegistryProxy,
  type RegistryRegistration,
  type ResolvedRegistry,
} from './index.js';
import { registryWorkspaceEnv, renderNpmrc, renderYarnrc } from './render.js';

const enabled = process.env.REGISTRY_PROXY_DOCKER_TEST === '1';
const IMAGE = process.env.REGISTRY_PROXY_TEST_IMAGE ?? 'asw-executor-node:ci';
const AUDIT_PATH = '/-/npm/v1/security/advisories/bulk';
/** pnpm audit posts its dependency tree here (and to `/audits` if this does not answer 200). */
const PNPM_AUDIT_PATH = '/-/npm/v1/security/audits/quick';
/** A clean audit in the legacy report shape pnpm reads. */
const CLEAN_LEGACY_AUDIT = {
  actions: [],
  advisories: {},
  metadata: {
    dependencies: 1,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 1,
    vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 },
  },
  muted: [],
};
const DENIED = "is not in the repository's committed lockfiles";

/** One tarball built in a temp dir: `package/package.json` gzipped. */
function buildTarball(name: string, version: string, dir: string): Buffer {
  const stage = mkdtempSync(path.join(dir, 'pkg-'));
  mkdirSync(path.join(stage, 'package'));
  writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({ name, version }));
  const out = path.join(dir, `${name.replace('/', '_')}.tgz`);
  execFileSync('tar', ['czf', out, '-C', stage, 'package']);
  return readFileSync(out);
}

interface FakeUpstream {
  close(): void;
  port: number;
  requests: { auth?: string; method?: string; path: string }[];
}

/** An npm-shaped upstream gated on `token`, serving packument + tarball. */
function startUpstream(
  packages: {
    name: string;
    version: string;
    tgz: Buffer;
    signatures?: { keyid: string; sig: string }[];
  }[],
  token: string
): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ auth: req.headers.authorization, method: req.method, path: req.url ?? '' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    // The bulk advisory query `npm audit`, `pnpm audit` and `yarn npm audit` send: no
    // advisories, so a clean audit exits 0.
    if (req.method === 'POST' && (req.url === AUDIT_PATH || req.url === PNPM_AUDIT_PATH)) {
      const legacy = req.url === PNPM_AUDIT_PATH;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(legacy ? CLEAN_LEGACY_AUDIT : {}));
      });
      return;
    }
    const port = (server.address() as { port: number }).port;
    const nameUrl = (n: string) => [
      `/${n}`,
      `/${n.replace('/', '%2f')}`,
      `/${n.replace('/', '%2F')}`,
    ];
    const nameVersionUrl = (n: string, v: string) =>
      nameUrl(n).map((u) => `${u}/${encodeURIComponent(v)}`);
    const distOf = (p: (typeof packages)[number]) => ({
      dist: {
        integrity: `sha512-${createHash('sha512').update(p.tgz).digest('base64')}`,
        ...(p.signatures !== undefined ? { signatures: p.signatures } : {}),
        shasum: createHash('sha1').update(p.tgz).digest('hex'),
        tarball: `http://127.0.0.1:${port}/${p.name}/-/${p.name.split('/').pop()}-${p.version}.tgz`,
      },
      name: p.name,
      version: p.version,
    });
    for (const p of packages) {
      const unscoped = p.name.split('/').pop() ?? '';
      // Version manifest — what Corepack fetches for a packageManager pin.
      if (nameVersionUrl(p.name, p.version).includes(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(distOf(p)));
        return;
      }
      if (nameUrl(p.name).includes(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            'dist-tags': { latest: p.version },
            name: p.name,
            time: {
              '1.0.0': '2026-01-01T00:00:00.000Z',
              created: '2026-01-01T00:00:00.000Z',
              modified: '2026-01-01T00:00:00.000Z',
            },
            versions: {
              [p.version]: {
                dist: {
                  integrity: `sha512-${createHash('sha512').update(p.tgz).digest('base64')}`,
                  shasum: createHash('sha1').update(p.tgz).digest('hex'),
                  tarball: `http://127.0.0.1:${port}/${p.name}/-/${unscoped}-${p.version}.tgz`,
                },
                name: p.name,
                version: p.version,
              },
            },
          })
        );
        return;
      }
      if (req.url === `/${p.name}/-/${unscoped}-${p.version}.tgz`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(p.tgz);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () =>
      resolve({
        close: () => server.close(),
        port: (server.address() as { port: number }).port,
        requests,
      })
    );
  });
}

const execFileAsync = promisify(execFile);

// Async on purpose: the proxy and upstreams are in-process, so a synchronous
// docker call would block the event loop and dead-lock the install.
async function docker(args: string[]): Promise<{ code: number; err: string; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, err: stderr.toString(), out: stdout.toString() };
  } catch (e) {
    const err = e as { code?: number; stderr?: string; stdout?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      err: err.stderr ?? '',
      out: err.stdout ?? '',
    };
  }
}

const REG_VIEW = [
  { id: 'rA', isDefault: true, scopes: [] as string[] },
  { id: 'rB', isDefault: false, scopes: ['@asw'] },
];

describe.skipIf(!enabled)('registry proxy against real package managers', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-clients-'));
  const tgzA = buildTarball('asw-fixture-a', '1.0.0', work);
  const tgzC = buildTarball('asw-fixture-c', '1.0.0', work);
  const tgzB = buildTarball('@asw/fixture-b', '1.0.0', work);
  let upstreamA: FakeUpstream;
  let upstreamB: FakeUpstream;
  let proxy: RegistryProxy;
  let gatewayIp = '';
  /** Container env + npmrc path for the *current* registration token. */
  let envPairs: string[] = [];
  /** Bind-mounts standing in for the workspace volume + $HOME. */
  let mounts: { home: string; ws: string } = { home: '', ws: '' };

  const registries = (): ResolvedRegistry[] => [
    {
      allowPrivateNetwork: true,
      authKind: 'bearer',
      id: 'rA',
      isDefault: true,
      name: 'a',
      scopes: [],
      token: 'up-A',
      upstreamUrl: `http://${gatewayIp}:${upstreamA.port}`,
    },
    {
      allowPrivateNetwork: true,
      authKind: 'bearer',
      id: 'rB',
      isDefault: false,
      name: 'b',
      scopes: ['@asw'],
      token: 'up-B',
      upstreamUrl: `http://${gatewayIp}:${upstreamB.port}`,
    },
  ];

  /** Register (open or with an allowlist) and render env + npmrc into `dir`. */
  async function activate(
    _dir: string,
    allow: Map<string, Set<string>> | null
  ): Promise<RegistryRegistration> {
    const reg = await proxy.register({ onDenied: () => {}, registries: registries() });
    reg.setAllowlist(
      allow
        ? new Map([
            ['rA', allow],
            ['rB', allow],
          ])
        : new Map([
            ['rA', null],
            ['rB', null],
          ])
    );
    const port = await proxy.listen();
    const proxyUrl = `http://${gatewayIp}:${port}`;
    // Production layout: npmrc lives at /workspace/.auto-swe/npmrc and in the
    // exec user's $HOME — never inside the project.
    const home = mkdtempSync(path.join(work, 'home-'));
    const ws = mkdtempSync(path.join(work, 'ws-'));
    const npmrc = renderNpmrc(REG_VIEW, proxyUrl, reg.token);
    mkdirSync(path.join(ws, '.auto-swe'), { recursive: true });
    writeFileSync(path.join(ws, '.auto-swe/npmrc'), npmrc);
    writeFileSync(path.join(home, '.npmrc'), npmrc);
    const yarnrc = renderYarnrc(REG_VIEW, proxyUrl);
    if (yarnrc) {
      writeFileSync(path.join(home, '.yarnrc.yml'), yarnrc);
    }
    // Bind mounts inherit the host owner's perms; the container runs `node`
    // (another uid), so the config dirs and files must be world-readable.
    const world = (f: string) =>
      execFileSync('chmod', [statSync(f).isDirectory() ? '0755' : '0644', f]);
    world(ws);
    world(home);
    world(path.join(ws, '.auto-swe'));
    world(path.join(ws, '.auto-swe/npmrc'));
    world(path.join(home, '.npmrc'));
    if (yarnrc) {
      world(path.join(home, '.yarnrc.yml'));
    }
    mounts = { home, ws };
    envPairs = registryWorkspaceEnv(REG_VIEW, proxyUrl, reg.token);
    return reg;
  }

  /** Parse the dir's lockfiles (+ packageManager pin) into the allowlist map. */
  function allowlistFor(dir: string, names: string[]): Map<string, Set<string>> {
    const allow = new Map<string, Set<string>>();
    for (const name of names) {
      const file = path.join(dir, name);
      if (!existsSync(file)) {
        continue;
      }
      for (const [n, vs] of buildAllowlist(parseLockfile(name, readFileSync(file, 'utf8')))) {
        allow.set(n, vs);
      }
    }
    for (const pin of packageManagerPins(readFileSync(path.join(dir, 'package.json'), 'utf8'))) {
      allow.set(pin.name, new Set([pin.version]));
    }
    return allow;
  }

  /**
   * Bind mounts keep host ownership, and the host and container users differ on
   * CI (the runner is uid 1001, the image's `node` is 1000; locally both are
   * often 1000, which hides it). Each side therefore opens up what it wrote:
   * the host before a run (it can only chmod its own files — the rest were
   * opened by the container), the container after every command — through
   * `find -user`, because busybox `chmod -R` gives up on a whole tree once it
   * fails on its host-owned top directory. `REGISTRY_PROXY_TEST_USER` overrides
   * the container user (default `node`), which reproduces CI's mismatch
   * locally (e.g. `1234`).
   */
  function openUp(...paths: string[]) {
    for (const p of paths) {
      spawnSync('chmod', ['-R', 'a+rwX', p]);
    }
  }

  async function client(dir: string, command: string[], opts?: { ignore?: boolean }) {
    openUp(dir, mounts.ws, mounts.home);
    const r = await docker([
      'run',
      '--rm',
      '-u',
      process.env.REGISTRY_PROXY_TEST_USER ?? 'node',
      '-w',
      '/workspace/target-repo',
      '-v',
      `${dir}:/workspace/target-repo`,
      '-v',
      `${mounts.ws}:/workspace`,
      '-v',
      `${mounts.home}:/home/node`,
      // `node`'s own HOME; explicit so an overriding uid with no passwd entry
      // gets the same layout instead of HOME=/.
      '-e',
      'HOME=/home/node',
      ...envPairs.flatMap((e) => ['-e', e]),
      IMAGE,
      'sh',
      '-c',
      '"$@"; s=$?; find /workspace /home/node -user "$(id -u)" -exec chmod a+rwX {} + 2>/dev/null; exit $s',
      'sh',
      ...command,
    ]);
    if (r.code !== 0 && !opts?.ignore) {
      throw new Error(`${command.join(' ')} failed:\n${r.err}\n${r.out}`);
    }
    return r;
  }

  function writeProject(dir: string, packageManager?: string) {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { '@asw/fixture-b': '1.0.0', 'asw-fixture-a': '1.0.0' },
        name: 'it-proj',
        private: true,
        ...(packageManager ? { packageManager } : {}),
      })
    );
  }

  function assertInstalled(dir: string) {
    expect(existsSync(path.join(dir, 'node_modules/asw-fixture-a/package.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'node_modules/@asw/fixture-b/package.json'))).toBe(true);
  }

  function assertRouting(token: string) {
    expect(upstreamB.requests.some((q) => q.path.includes('fixture-b'))).toBe(true);
    expect(upstreamA.requests.every((q) => !q.path.includes('@asw'))).toBe(true);
    expect(upstreamA.requests.every((q) => q.auth === 'Bearer up-A')).toBe(true);
    expect(upstreamB.requests.every((q) => q.auth === 'Bearer up-B')).toBe(true);
    for (const u of [upstreamA, upstreamB]) {
      expect(u.requests.every((q) => !q.auth?.includes(token))).toBe(true);
    }
  }

  beforeAll(async () => {
    gatewayIp =
      process.env.CLAUDE_CODE_TEST_HOST_ADDRESS ??
      (
        await docker([
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
        ])
      ).out.trim();
    upstreamA = await startUpstream(
      [
        { name: 'asw-fixture-a', tgz: tgzA, version: '1.0.0' },
        { name: 'asw-fixture-c', tgz: tgzC, version: '1.0.0' },
      ],
      'up-A'
    );
    upstreamB = await startUpstream(
      [{ name: '@asw/fixture-b', tgz: tgzB, version: '1.0.0' }],
      'up-B'
    );
    proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://${gatewayIp}:${p}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
    });
  }, 120_000);

  afterAll(async () => {
    await proxy?.close();
    upstreamA?.close();
    upstreamB?.close();
    rmSync(work, { force: true, recursive: true });
  });

  it('npm ci works in lockfile mode, including Artifactory-shaped resolved URLs', async () => {
    const dir = path.join(work, 'npm');
    mkdirSync(dir, { recursive: true });
    writeProject(dir);
    await activate(dir, null);
    await client(dir, ['npm', 'install', '--no-audit', '--no-fund']);

    // Rewrite `resolved` to the Artifactory layout: path prefix kept, scope
    // under the *default* id — the 2c routing this suite exists to prove.
    const lock = JSON.parse(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string }>;
    };
    for (const entry of Object.values(lock.packages)) {
      if (!entry.resolved) {
        continue;
      }
      const file = entry.resolved.split('/').pop() ?? '';
      const isScoped = entry.resolved.includes('/@asw/');
      const name = isScoped ? '@asw/fixture-b' : 'asw-fixture-a';
      entry.resolved =
        `https://artifactory.example/artifactory/api/npm/npm-remote/` +
        `${name}/-/${isScoped ? '@asw/' : ''}${file}`;
    }
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));

    const reg = await activate(dir, allowlistFor(dir, ['package-lock.json']));
    rmSync(path.join(dir, 'node_modules'), { force: true, recursive: true });
    const r = await client(dir, ['npm', 'ci', '--no-audit', '--no-fund']);
    assertInstalled(dir);
    expect(r.out).toContain('added');
    assertRouting(reg.token);

    const denied = await client(dir, ['npm', 'install', 'asw-fixture-c'], { ignore: true });
    expect(denied.code).not.toBe(0);
    expect(`${denied.err}${denied.out}`).toContain(DENIED);
    await reg.release();
  }, 300_000);

  it('pnpm install --frozen-lockfile works in lockfile mode', async () => {
    const dir = path.join(work, 'pnpm');
    mkdirSync(dir, { recursive: true });
    writeProject(dir, 'pnpm@10.34.7');
    await activate(dir, null);
    await client(dir, ['pnpm', 'install']);

    const reg = await activate(dir, allowlistFor(dir, ['pnpm-lock.yaml']));
    rmSync(path.join(dir, 'node_modules'), { force: true, recursive: true });
    await client(dir, ['pnpm', 'install', '--frozen-lockfile']);
    assertInstalled(dir);
    assertRouting(reg.token);

    const denied = await client(dir, ['pnpm', 'add', 'asw-fixture-c'], { ignore: true });
    expect(denied.code).not.toBe(0);
    expect(`${denied.err}${denied.out}`).toContain(DENIED);
    await reg.release();
  }, 300_000);

  it('yarn classic install --frozen-lockfile works in lockfile mode', async () => {
    const dir = path.join(work, 'yarn1');
    mkdirSync(dir, { recursive: true });
    writeProject(dir);
    await activate(dir, null);
    await client(dir, ['yarn', 'install']);

    // Rewrite resolved hosts to registry.yarnpkg.com — the only host shape yarn
    // classic rewrites against its configured registry.
    const lock = readFileSync(path.join(dir, 'yarn.lock'), 'utf8').replace(
      /resolved\s+"https?:\/\/[^"]+?(\/[^"/]+\/-\/[^"/]+\.tgz)"/g,
      (_m, tail) => `resolved "https://registry.yarnpkg.com${tail}"`
    );
    writeFileSync(path.join(dir, 'yarn.lock'), lock);

    const reg = await activate(dir, allowlistFor(dir, ['yarn.lock']));
    rmSync(path.join(dir, 'node_modules'), { force: true, recursive: true });
    await client(dir, ['yarn', 'install', '--frozen-lockfile']);
    assertInstalled(dir);
    assertRouting(reg.token);

    const denied = await client(dir, ['yarn', 'add', 'asw-fixture-c'], { ignore: true });
    expect(denied.code).not.toBe(0);
    expect(`${denied.err}${denied.out}`).toContain(DENIED);
    await reg.release();
  }, 300_000);

  it('yarn berry install --immutable works in lockfile mode', async () => {
    const dir = path.join(work, 'berry');
    mkdirSync(dir, { recursive: true });
    writeProject(dir, 'yarn@4.18.1');
    await activate(dir, null);
    // Only project-level settings stay in the project file; registry
    // config (scopes, whitelist, default server via env) comes from
    // $HOME/.yarnrc.yml + env, exactly as production renders it.
    writeFileSync(
      path.join(dir, '.yarnrc.yml'),
      ['nodeLinker: node-modules', 'enableGlobalCache: false'].join('\n')
    );
    await client(dir, ['yarn', 'install']);

    const reg = await activate(dir, allowlistFor(dir, ['yarn.lock']));
    // The fresh lockfile-mode token must replace the open-mode one in yarnrc's env…
    // (env is re-rendered by activate; the yarnrc registry URLs are stable).
    rmSync(path.join(dir, 'node_modules'), { force: true, recursive: true });
    await client(dir, ['yarn', 'install', '--immutable']);
    assertInstalled(dir);
    assertRouting(reg.token);

    const denied = await client(dir, ['yarn', 'add', 'asw-fixture-c'], { ignore: true });
    expect(denied.code).not.toBe(0);
    expect(`${denied.err}${denied.out}`).toContain(DENIED);
    await reg.release();
  }, 300_000);

  /** A project depending only on `asw-fixture-a`, which the default registry serves. */
  function writeDefaultOnlyProject(dir: string, packageManager?: string) {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'asw-fixture-a': '1.0.0' },
        name: 'audit-proj',
        private: true,
        ...(packageManager ? { packageManager } : {}),
      })
    );
  }

  const auditPosts = (u: FakeUpstream) => u.requests.filter((q) => q.method === 'POST');

  it('npm audit reaches the default registry through the proxy, with its credential', async () => {
    const dir = path.join(work, 'audit-npm');
    mkdirSync(dir, { recursive: true });
    writeDefaultOnlyProject(dir);
    await activate(dir, null);
    await client(dir, ['npm', 'install', '--no-audit', '--no-fund']);

    const reg = await activate(dir, allowlistFor(dir, ['package-lock.json']));
    const before = auditPosts(upstreamA).length;
    const r = await client(dir, ['npm', 'audit', '--audit-level=high'], { ignore: true });
    expect(r.code, `${r.err}${r.out}`).toBe(0);
    const posts = auditPosts(upstreamA).slice(before);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ auth: 'Bearer up-A', path: AUDIT_PATH });
    expect(upstreamA.requests.every((q) => !q.auth?.includes(reg.token))).toBe(true);
    await reg.release();
  }, 300_000);

  it('npm audit of a project that names a private-scope package is refused, and nothing is sent', async () => {
    const dir = path.join(work, 'audit-npm-scoped');
    mkdirSync(dir, { recursive: true });
    writeProject(dir);
    await activate(dir, null);
    await client(dir, ['npm', 'install', '--no-audit', '--no-fund']);

    const reg = await activate(dir, allowlistFor(dir, ['package-lock.json']));
    const beforeA = auditPosts(upstreamA).length;
    const beforeB = auditPosts(upstreamB).length;
    const r = await client(dir, ['npm', 'audit'], { ignore: true });
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toContain('another registry');
    expect(auditPosts(upstreamA).length).toBe(beforeA);
    expect(auditPosts(upstreamB).length).toBe(beforeB);
    await reg.release();
  }, 300_000);

  it('pnpm audit reaches the default registry through the proxy', async () => {
    const dir = path.join(work, 'audit-pnpm');
    mkdirSync(dir, { recursive: true });
    writeDefaultOnlyProject(dir, 'pnpm@10.34.7');
    await activate(dir, null);
    await client(dir, ['pnpm', 'install']);

    const reg = await activate(dir, allowlistFor(dir, ['pnpm-lock.yaml']));
    const before = auditPosts(upstreamA).length;
    const r = await client(dir, ['pnpm', 'audit', '--audit-level', 'high'], { ignore: true });
    expect(r.code, `${r.err}${r.out}`).toBe(0);
    expect(auditPosts(upstreamA).slice(before)[0]).toMatchObject({
      auth: 'Bearer up-A',
      path: PNPM_AUDIT_PATH,
    });
    await reg.release();
  }, 300_000);

  it('yarn npm audit reaches the default registry through the proxy', async () => {
    const dir = path.join(work, 'audit-berry');
    mkdirSync(dir, { recursive: true });
    writeDefaultOnlyProject(dir, 'yarn@4.18.1');
    await activate(dir, null);
    writeFileSync(
      path.join(dir, '.yarnrc.yml'),
      ['nodeLinker: node-modules', 'enableGlobalCache: false'].join('\n')
    );
    await client(dir, ['yarn', 'install']);

    const reg = await activate(dir, allowlistFor(dir, ['yarn.lock']));
    const before = auditPosts(upstreamA).length;
    const r = await client(dir, ['yarn', 'npm', 'audit', '--severity', 'high'], { ignore: true });
    expect(r.code, `${r.err}${r.out}`).toBe(0);
    expect(auditPosts(upstreamA).slice(before)[0]).toMatchObject({
      auth: 'Bearer up-A',
      path: AUDIT_PATH,
    });
    await reg.release();
  }, 300_000);
});

describe.skipIf(!enabled)('Corepack bootstrap through the proxy', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-corepack-'));
  let gatewayIp = '';
  let upstream: FakeUpstream;
  let proxy: RegistryProxy;
  let envPairs: string[] = [];
  let mounts: { home: string; ws: string } = { home: '', ws: '' };
  const denials: { name: string; version?: string }[] = [];

  // A fake `pnpm@9.15.9` whose bin prints a marker — version deliberately not
  // pre-installed in the image (which carries 10.34.7), so a hit means the
  // proxy's download path worked.
  const PIN_VERSION = '9.15.9';
  const tgz = (() => {
    const stage = mkdtempSync(path.join(work, 'pkg-'));
    mkdirSync(path.join(stage, 'package/bin'), { recursive: true });
    writeFileSync(
      path.join(stage, 'package/package.json'),
      JSON.stringify({
        bin: { pnpm: 'bin/pnpm.cjs' },
        name: 'pnpm',
        version: PIN_VERSION,
      })
    );
    writeFileSync(
      path.join(stage, 'package/bin/pnpm.cjs'),
      `#!/usr/bin/env node\nconsole.log('fake-pnpm ${PIN_VERSION}');\n`
    );
    execFileSync('chmod', ['+x', path.join(stage, 'package/bin/pnpm.cjs')]);
    const out = path.join(work, 'pnpm.tgz');
    execFileSync('tar', ['czf', out, '-C', stage, 'package']);
    return readFileSync(out);
  })();
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const integrityHex = createHash('sha512').update(tgz).digest('hex');

  // Test signing key — production never sets COREPACK_INTEGRITY_KEYS.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sign = (over: string) =>
    signSync('sha256', Buffer.from(over), privateKey).toString('base64');
  const goodSig = sign(`pnpm@${PIN_VERSION}:${integrity}`);
  const integrityKeys = JSON.stringify({
    npm: [
      {
        expires: null,
        key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        keyid: 'SHA256:test',
        keytype: 'ecdsa-sha2-nistp256',
        scheme: 'ecdsa-sha2-nistp256',
      },
    ],
  });

  const regView = [{ id: 'rA', isDefault: true, scopes: [] as string[] }];

  async function activate(allow: Map<string, Set<string>> | null) {
    denials.length = 0;
    const reg = await proxy.register({
      onDenied: (d) => denials.push(d),
      registries: [
        {
          allowPrivateNetwork: true,
          authKind: 'bearer',
          id: 'rA',
          isDefault: true,
          name: 'a',
          scopes: [],
          token: 'up-A',
          upstreamUrl: `http://${gatewayIp}:${upstream.port}`,
        },
      ],
    });
    reg.setAllowlist(allow ? new Map([['rA', allow]]) : new Map([['rA', null]]));
    const proxyUrl = `http://${gatewayIp}:${await proxy.listen()}`;
    const home = mkdtempSync(path.join(work, 'home-'));
    const ws = mkdtempSync(path.join(work, 'ws-'));
    const npmrc = renderNpmrc(regView, proxyUrl, reg.token);
    mkdirSync(path.join(ws, '.auto-swe'), { recursive: true });
    writeFileSync(path.join(ws, '.auto-swe/npmrc'), npmrc);
    writeFileSync(path.join(home, '.npmrc'), npmrc);
    mounts = { home, ws };
    // Production env + a scratch COREPACK_HOME so the pre-installed cache can
    // never mask a download, + the test integrity keys.
    envPairs = [
      ...registryWorkspaceEnv(regView, proxyUrl, reg.token),
      'COREPACK_HOME=/tmp/corepack-home',
      `COREPACK_INTEGRITY_KEYS=${integrityKeys}`,
    ];
    return reg;
  }

  function allowFromPin(pin: string): Map<string, Set<string>> {
    const allow = new Map<string, Set<string>>();
    for (const p of packageManagerPins(JSON.stringify({ packageManager: pin }))) {
      allow.set(p.name, new Set([p.version]));
    }
    return allow;
  }

  async function client(dir: string, command: string[], opts?: { ignore?: boolean }) {
    spawnSync('chmod', ['-R', 'a+rwX', dir]);
    spawnSync('chmod', ['-R', 'a+rwX', mounts.ws]);
    spawnSync('chmod', ['-R', 'a+rwX', mounts.home]);
    const r = await docker([
      'run',
      '--rm',
      '-u',
      process.env.REGISTRY_PROXY_TEST_USER ?? 'node',
      '-w',
      '/workspace/target-repo',
      '-v',
      `${dir}:/workspace/target-repo`,
      '-v',
      `${mounts.ws}:/workspace`,
      '-v',
      `${mounts.home}:/home/node`,
      '-e',
      'HOME=/home/node',
      ...envPairs.flatMap((e) => ['-e', e]),
      IMAGE,
      'sh',
      '-c',
      '"$@"; s=$?; find /workspace /home/node -user "$(id -u)" -exec chmod a+rwX {} + 2>/dev/null; exit $s',
      'sh',
      ...command,
    ]);
    if (r.code !== 0 && !opts?.ignore) {
      throw new Error(`${command.join(' ')} failed:\n${r.err}\n${r.out}`);
    }
    return r;
  }

  function writeProject(dir: string, pin: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'it-proj', packageManager: pin, private: true })
    );
  }

  beforeAll(async () => {
    gatewayIp =
      process.env.CLAUDE_CODE_TEST_HOST_ADDRESS ??
      (
        await docker([
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
        ])
      ).out.trim();
    proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://${gatewayIp}:${p}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
    });
  }, 120_000);

  afterAll(async () => {
    await proxy?.close();
    upstream?.close();
    rmSync(work, { force: true, recursive: true });
  });

  function startPinUpstream(signatures: { keyid: string; sig: string }[] | undefined) {
    upstream?.close();
    return startUpstream([{ name: 'pnpm', signatures, tgz, version: PIN_VERSION }], 'up-A');
  }

  it('downloads a signed pin through the proxy (signature verified)', async () => {
    upstream = await startPinUpstream([{ keyid: 'SHA256:test', sig: goodSig }]);
    const dir = path.join(work, 'cp-signed');
    writeProject(dir, `pnpm@${PIN_VERSION}`);
    const reg = await activate(allowFromPin(`pnpm@${PIN_VERSION}`));
    const r = await client(dir, ['pnpm', '--version']);
    expect(r.out.trim()).toBe(`fake-pnpm ${PIN_VERSION}`);
    expect(upstream.requests.some((q) => q.path === `/pnpm/${PIN_VERSION}`)).toBe(true);
    expect(upstream.requests.some((q) => q.path.includes('.tgz'))).toBe(true);
    expect(upstream.requests.every((q) => q.auth === 'Bearer up-A')).toBe(true);
    expect(upstream.requests.every((q) => !q.auth?.includes(reg.token))).toBe(true);
    await reg.release();
  }, 300_000);

  it('rejects a wrong signature', async () => {
    upstream = await startPinUpstream([
      { keyid: 'SHA256:test', sig: sign('pnpm@0.0.0:sha512-AAAA') },
    ]);
    const dir = path.join(work, 'cp-badsig');
    writeProject(dir, `pnpm@${PIN_VERSION}`);
    const reg = await activate(allowFromPin(`pnpm@${PIN_VERSION}`));
    const r = await client(dir, ['pnpm', '--version'], { ignore: true });
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toMatch(/Signature does not match|not signed by any trusted keys/);
    await reg.release();
  }, 300_000);

  it('downloads a hash pin with no signatures served', async () => {
    upstream = await startPinUpstream(undefined);
    const dir = path.join(work, 'cp-hash');
    writeProject(dir, `pnpm@${PIN_VERSION}+sha512.${integrityHex}`);
    const reg = await activate(allowFromPin(`pnpm@${PIN_VERSION}`));
    const r = await client(dir, ['pnpm', '--version']);
    expect(r.out.trim()).toBe(`fake-pnpm ${PIN_VERSION}`);
    await reg.release();
  }, 300_000);

  it('denies a pin absent from the allowlist', async () => {
    upstream = await startPinUpstream([{ keyid: 'SHA256:test', sig: goodSig }]);
    const dir = path.join(work, 'cp-denied');
    writeProject(dir, 'pnpm@9.15.8');
    // Allowlist built from a different package.json — pins 9.15.9 only.
    const reg = await activate(allowFromPin(`pnpm@${PIN_VERSION}`));
    const r = await client(dir, ['pnpm', '--version'], { ignore: true });
    expect(r.code).not.toBe(0);
    expect(denials).toContainEqual(expect.objectContaining({ name: 'pnpm', version: '9.15.8' }));
    await reg.release();
  }, 300_000);
});
