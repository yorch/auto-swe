/**
 * End-to-end proof that a real Go toolchain fetches modules through the registry proxy. A fake
 * Go module upstream (requiring its own Bearer token) sits on the host; containers built from
 * `defaults/Dockerfile.go` reach a real `createRegistryProxy` over the bridge gateway. Needs a
 * Docker daemon:
 *
 *   GO_PROXY_DOCKER_TEST=1 GO_PROXY_TEST_IMAGE=<image> \
 *     yarn vitest run packages/worker/src/lib/registryProxy/goClient.docker.test.ts
 *
 * No internet is required: every URL the Go tool sees points at the proxy. On Docker Desktop the
 * bridge gateway is not the host; set `CLAUDE_CODE_TEST_HOST_ADDRESS` to the host's LAN address.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { buildGoAllowlist, parseGoSum } from '@auto-swe/shared/lib/goModuleAllowlist';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRegistryProxy, type RegistryProxy, type ResolvedRegistry } from './index.js';
import { registryWorkspaceEnv, splitRegistryWorkspaceEnv } from './render.js';

const enabled = process.env.GO_PROXY_DOCKER_TEST === '1';
const IMAGE = process.env.GO_PROXY_TEST_IMAGE ?? 'asw-executor-go:ci';
const DENIED = "is not in the repository's committed lockfiles";
const VERSION = 'v1.0.0';
const UPSTREAM_TOKEN = 'up-token';
const REGISTRY_ID = 'rGo';

interface GoFile {
  data: Buffer;
  name: string;
}

/** Go's `dirhash.Hash1`: sha256 over `"<sha256hex(file)>  <name>\n"` lines, files sorted by name. */
function goHash1(files: GoFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.name}\n`)
    .join('');
  return `h1:${createHash('sha256').update(lines).digest('base64')}`;
}

/** A zip of STORED (uncompressed) entries: local headers, central directory, end record. */
function buildStoredZip(files: GoFile[]): Buffer {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01; Go ignores timestamps
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    const entry = Buffer.concat([local, name, f.data]);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(f.data.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([dir, name]));
    locals.push(entry);
    offset += entry.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

interface GoModule {
  /** The go.sum lines Go checks for this module. */
  goSum: string;
  modFile: Buffer;
  modHash: string;
  path: string;
  zip: Buffer;
  zipHash: string;
}

function buildModule(modulePath: string, pkg: string): GoModule {
  const modFile = Buffer.from(`module ${modulePath}\n\ngo 1.21\n`);
  const source = Buffer.from(`package ${pkg}\n\nfunc Hello() string { return "hello" }\n`);
  const prefix = `${modulePath}@${VERSION}`;
  const zipFiles: GoFile[] = [
    { data: modFile, name: `${prefix}/go.mod` },
    { data: source, name: `${prefix}/${pkg}.go` },
  ];
  const zipHash = goHash1(zipFiles);
  const modHash = goHash1([{ data: modFile, name: 'go.mod' }]);
  return {
    goSum: `${modulePath} ${VERSION} ${zipHash}\n${modulePath} ${VERSION}/go.mod ${modHash}\n`,
    modFile,
    modHash,
    path: modulePath,
    zip: buildStoredZip(zipFiles),
    zipHash,
  };
}

interface FakeUpstream {
  close(): void;
  port: number;
  requests: { auth?: string; path: string }[];
}

/** A Go-module upstream gated on `token`: list, info, mod, zip and `@latest` for each module. */
function startUpstream(modules: GoModule[], token: string): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const info = JSON.stringify({ Time: '2024-01-01T00:00:00Z', Version: VERSION });
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({ auth: req.headers.authorization, path: url });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    for (const m of modules) {
      const base = `/${m.path}`;
      const answers: Record<string, [string, string | Buffer]> = {
        [`${base}/@latest`]: ['application/json', info],
        [`${base}/@v/list`]: ['text/plain', `${VERSION}\n`],
        [`${base}/@v/${VERSION}.info`]: ['application/json', info],
        [`${base}/@v/${VERSION}.mod`]: ['text/plain', m.modFile],
        [`${base}/@v/${VERSION}.zip`]: ['application/zip', m.zip],
      };
      const hit = answers[url];
      if (hit) {
        res.writeHead(200, { 'content-type': hit[0] });
        res.end(hit[1]);
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

// Async on purpose: the proxy and upstream are in-process, so a synchronous docker call would
// block the event loop and dead-lock the fetch.
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

describe('Go module hashes', () => {
  it('hashes a one-file go.mod the way go.sum does', () => {
    // sha256("module m\n") over the line "<hex>  go.mod\n": a value checkable without Go.
    const data = Buffer.from('module m\n');
    const line = `${createHash('sha256').update(data).digest('hex')}  go.mod\n`;
    expect(goHash1([{ data, name: 'go.mod' }])).toBe(
      `h1:${createHash('sha256').update(line).digest('base64')}`
    );
  });

  it('sorts files by name before hashing', () => {
    const a = { data: Buffer.from('a'), name: 'a.go' };
    const b = { data: Buffer.from('b'), name: 'b.go' };
    expect(goHash1([b, a])).toBe(goHash1([a, b]));
  });
});

describe.skipIf(!enabled)('registry proxy against a real Go toolchain', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-go-'));
  const lib = buildModule('example.test/lib', 'lib');
  const other = buildModule('example.test/other', 'other');
  let upstream: FakeUpstream;
  let proxy: RegistryProxy;
  let gatewayIp = '';
  let counter = 0;

  const registry = (): ResolvedRegistry => ({
    allowPrivateNetwork: true,
    authKind: 'bearer',
    ecosystem: 'go',
    id: REGISTRY_ID,
    isDefault: false,
    name: 'go',
    scopes: [],
    token: UPSTREAM_TOKEN,
    upstreamUrl: `http://${gatewayIp}:${upstream.port}`,
  });

  /** Register against the fake upstream; `allow` is the go.sum the allowlist is built from. */
  async function activate(allowFromGoSum: string | null) {
    const denials: { name: string; version?: string }[] = [];
    const reg = await proxy.register({
      onDenied: (d) => denials.push(d),
      registries: [registry()],
    });
    reg.setAllowlist(
      new Map([
        [
          REGISTRY_ID,
          allowFromGoSum === null ? null : buildGoAllowlist(parseGoSum(allowFromGoSum)),
        ],
      ])
    );
    const proxyUrl = `http://${gatewayIp}:${await proxy.listen()}`;
    const full = registryWorkspaceEnv(
      [{ ecosystem: 'go', id: REGISTRY_ID, scopes: [] }],
      proxyUrl,
      reg.token
    );
    return { ...splitRegistryWorkspaceEnv(full), denials, full, reg };
  }

  /** A project requiring `needs`, with a go.sum naming `sumModules` (default: the same). */
  function writeProject(needs: GoModule, sumModules: GoModule[] = [needs]): string {
    counter += 1;
    const dir = path.join(work, `proj-${counter}`);
    mkdirSync(dir, { recursive: true });
    const pkg = needs.path.split('/').pop() as string;
    writeFileSync(
      path.join(dir, 'go.mod'),
      `module example.test/app\n\ngo 1.21\n\nrequire ${needs.path} ${VERSION}\n`
    );
    writeFileSync(
      path.join(dir, 'main.go'),
      `package main\n\nimport (\n\t"fmt"\n\n\t"${needs.path}"\n)\n\nfunc main() { fmt.Println(${pkg}.Hello()) }\n`
    );
    writeFileSync(path.join(dir, 'go.sum'), sumModules.map((m) => m.goSum).join(''));
    return dir;
  }

  /**
   * Runs `command` as the image's default user in `dir`, bind-mounted at the workspace path.
   * Bind mounts keep host ownership and the host and container users differ on CI, so each side
   * opens up what it wrote: the host before the run, the container after it.
   */
  async function client(
    dir: string,
    env: { env: string[]; secretEnv: Record<string, string> },
    command: string[],
    opts?: { extraEnv?: Record<string, string>; ignore?: boolean }
  ) {
    spawnSync('chmod', ['-R', 'a+rwX', dir]);
    const pairs = [
      ...env.env,
      ...Object.entries(env.secretEnv).map(([k, v]) => `${k}=${v}`),
      'GONOSUMDB=example.test',
      'GOFLAGS=-modcacherw',
      ...Object.entries(opts?.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
    ];
    // A later pair for the same name wins, so an `extraEnv` overrides the defaults above.
    const merged = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')), p]));
    const r = await docker([
      'run',
      '--rm',
      '-w',
      '/workspace/target-repo',
      '-v',
      `${dir}:/workspace/target-repo`,
      ...[...merged.values()].flatMap((e) => ['-e', e]),
      IMAGE,
      'sh',
      '-c',
      '"$@"; s=$?; find /workspace/target-repo -user "$(id -u)" -exec chmod a+rwX {} + 2>/dev/null; exit $s',
      'sh',
      ...command,
    ]);
    if (r.code !== 0 && !opts?.ignore) {
      throw new Error(`${command.join(' ')} failed:\n${r.err}\n${r.out}`);
    }
    return r;
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
    upstream = await startUpstream([lib, other], UPSTREAM_TOKEN);
    proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://${gatewayIp}:${p}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
    });
  }, 120_000);

  beforeEach(() => {
    upstream.requests.length = 0;
  });

  afterAll(async () => {
    await proxy?.close();
    upstream?.close();
    rmSync(work, { force: true, recursive: true });
  });

  it('computes the go.sum hashes Go itself computes', async () => {
    const dir = path.join(work, 'hash');
    mkdirSync(dir, { recursive: true });
    const a = await activate(null);
    const r = await client(dir, a, ['go', 'mod', 'download', '-json', `${lib.path}@${VERSION}`], {
      extraEnv: { GOSUMDB: 'off' },
    });
    const dl = JSON.parse(r.out) as { GoModSum?: string; Sum?: string };
    expect(dl.Sum).toBe(lib.zipHash);
    expect(dl.GoModSum).toBe(lib.modHash);
    await a.reg.release();
  }, 300_000);

  it('puts GOPROXY, which carries the token, in secretEnv and not in plain env', async () => {
    const a = await activate(null);
    expect(Object.keys(a.secretEnv)).toEqual(['GOPROXY']);
    expect(a.secretEnv.GOPROXY).toContain(a.reg.token);
    expect(a.env.some((e) => e.startsWith('GOPROXY='))).toBe(false);
    expect(a.env.some((e) => e.includes(a.reg.token))).toBe(false);
    expect(a.env).toContain('GOTOOLCHAIN=local');
    await a.reg.release();
  });

  it('go build works in lockfile mode, with only the upstream credential reaching the upstream', async () => {
    const dir = writeProject(lib);
    const a = await activate(lib.goSum);
    const r = await client(dir, a, ['go', 'build', './...']);
    expect(`${r.err}${r.out}`).not.toMatch(/downloading go\d/);

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((q) => q.auth === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
    expect(upstream.requests.every((q) => !q.auth?.includes(a.reg.token))).toBe(true);
    expect(
      upstream.requests.every((q) => q.path.startsWith(`/${lib.path}/@v/${VERSION}.`)),
      JSON.stringify(upstream.requests)
    ).toBe(true);
    expect(upstream.requests.some((q) => q.path.endsWith('.zip'))).toBe(true);

    const toolchain = await client(dir, a, ['go', 'env', 'GOTOOLCHAIN']);
    expect(toolchain.out.trim()).toBe('local');
    await a.reg.release();
  }, 300_000);

  it('refuses a module outside the allowlist, and the upstream is never asked for it', async () => {
    // The project's go.sum is complete; the allowlist comes from a go.sum without `other`.
    const dir = writeProject(other, [lib, other]);
    const a = await activate(lib.goSum);
    const r = await client(dir, a, ['go', 'build', './...'], { ignore: true });
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toContain(DENIED);
    expect(upstream.requests.some((q) => q.path.includes('other'))).toBe(false);
    expect(a.denials).toContainEqual(expect.objectContaining({ name: other.path }));
    await a.reg.release();
  }, 300_000);

  it('answers go list -m -versions from the proxy, without asking the upstream for the list', async () => {
    const dir = writeProject(lib);
    const a = await activate(lib.goSum);
    const r = await client(dir, a, ['go', 'list', '-m', '-versions', lib.path]);
    expect(r.out.trim()).toBe(`${lib.path} ${VERSION}`);
    expect(upstream.requests.some((q) => q.path.endsWith('/@v/list'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('refuses go get @latest in lockfile mode', async () => {
    const dir = writeProject(lib);
    const a = await activate(lib.goSum);
    const r = await client(dir, a, ['go', 'get', `${lib.path}@latest`], { ignore: true });
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toContain(DENIED);
    expect(upstream.requests.some((q) => q.path.endsWith('/@latest'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('go get fetches a new module in open mode', async () => {
    const dir = writeProject(lib);
    const a = await activate(null);
    await client(dir, a, ['go', 'get', `${other.path}@${VERSION}`], {
      extraEnv: { GOFLAGS: '-mod=mod -modcacherw', GOSUMDB: 'off' },
    });
    expect(readFileSync(path.join(dir, 'go.mod'), 'utf8')).toContain(`${other.path} ${VERSION}`);
    expect(upstream.requests.some((q) => q.path === `/${other.path}/@v/${VERSION}.zip`)).toBe(true);
    expect(upstream.requests.every((q) => q.auth === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
    await a.reg.release();
  }, 300_000);
});
