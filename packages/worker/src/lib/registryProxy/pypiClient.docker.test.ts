/**
 * End-to-end proof that real pip and real uv install packages through the registry proxy. A fake
 * PEP 503 / PEP 691 upstream (requiring its own Bearer token) sits on the host; containers built
 * from `defaults/Dockerfile.python` reach a real `createRegistryProxy` at the host's address.
 * Needs a Docker daemon:
 *
 *   PYPI_PROXY_DOCKER_TEST=1 PYPI_PROXY_TEST_IMAGE=<image> \
 *     yarn vitest run packages/worker/src/lib/registryProxy/pypiClient.docker.test.ts
 *
 * No internet is required: every URL the Python tools see points at the proxy. On Docker Desktop
 * the bridge gateway is not the host; set `CLAUDE_CODE_TEST_HOST_ADDRESS` to the host's LAN address.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { buildPypiAllowlist, parsePypiLockfile } from '@auto-swe/shared/lib/pypiAllowlist';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRegistryProxy, type RegistryProxy, type ResolvedRegistry } from './index.js';
import { registryWorkspaceEnv, splitRegistryWorkspaceEnv } from './render.js';

const enabled = process.env.PYPI_PROXY_DOCKER_TEST === '1';
const IMAGE = process.env.PYPI_PROXY_TEST_IMAGE ?? 'asw-executor-python:ci';
const UPSTREAM_TOKEN = 'up-token';
const REGISTRY_ID = 'rPy';

interface ZipFile {
  data: Buffer;
  name: string;
}

/** A zip of STORED (uncompressed) entries: local headers, central directory, end record. */
function buildStoredZip(files: ZipFile[]): Buffer {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
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

interface Wheel {
  data: Buffer;
  filename: string;
  /** PEP 503 name. */
  project: string;
  sha256: string;
  version: string;
}

/** A pure-python wheel: `<module>/__init__.py` with `VERSION`, plus a dist-info with a real RECORD. */
function buildWheel(project: string, version: string): Wheel {
  const module = project.replace(/-/g, '_');
  const dist = `${module}-${version}.dist-info`;
  const body: ZipFile[] = [
    { data: Buffer.from(`VERSION = "${version}"\n`), name: `${module}/__init__.py` },
    {
      data: Buffer.from(`Metadata-Version: 2.1\nName: ${project}\nVersion: ${version}\n`),
      name: `${dist}/METADATA`,
    },
    {
      data: Buffer.from(
        'Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
      ),
      name: `${dist}/WHEEL`,
    },
  ];
  const record = `${[
    ...body.map(
      (f) =>
        `${f.name},sha256=${createHash('sha256').update(f.data).digest('base64url')},${f.data.length}`
    ),
    `${dist}/RECORD,,`,
  ].join('\n')}\n`;
  const data = buildStoredZip([...body, { data: Buffer.from(record), name: `${dist}/RECORD` }]);
  return {
    data,
    filename: `${module}-${version}-py3-none-any.whl`,
    project,
    sha256: createHash('sha256').update(data).digest('hex'),
    version,
  };
}

interface FakeUpstream {
  close(): void;
  origin: string;
  port: number;
  requests: { auth?: string; path: string }[];
}

/**
 * A simple-index upstream. `/simple/<project>/` answers PEP 691 JSON when `Accept` asks for it and
 * PEP 503 HTML otherwise; every file URL is absolute and points at `fileOrigin(wheel)`. With a
 * `token`, the index and the files require it; without one nothing is checked.
 */
function startUpstream(opts: {
  fileOrigin?: (self: string, wheel: Wheel) => string;
  token?: string;
  wheels: Wheel[];
  host: string;
}): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({ auth: req.headers.authorization, path: url });
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const origin = `http://${opts.host}:${(server.address() as { port: number }).port}`;
    const index = /^\/simple\/([^/]+)\/$/.exec(url);
    if (index) {
      const mine = opts.wheels.filter((w) => w.project === index[1]);
      if (mine.length === 0) {
        res.writeHead(404);
        res.end();
        return;
      }
      const fileUrl = (w: Wheel) =>
        `${opts.fileOrigin ? opts.fileOrigin(origin, w) : origin}/packages/${w.project}/${w.filename}`;
      if ((req.headers.accept ?? '').includes('application/vnd.pypi.simple.v1+json')) {
        res.writeHead(200, { 'content-type': 'application/vnd.pypi.simple.v1+json' });
        res.end(
          JSON.stringify({
            files: mine.map((w) => ({
              filename: w.filename,
              hashes: { sha256: w.sha256 },
              url: fileUrl(w),
            })),
            meta: { 'api-version': '1.0' },
            name: index[1],
          })
        );
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><body>${mine
            .map((w) => `<a href="${fileUrl(w)}#sha256=${w.sha256}">${w.filename}</a><br/>`)
            .join('')}</body></html>`
        );
      }
      return;
    }
    const file = /^\/packages\/([^/]+)\/([^/]+)$/.exec(url);
    const wheel = file && opts.wheels.find((w) => w.project === file[1] && w.filename === file[2]);
    if (wheel) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(wheel.data);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        close: () => server.close(),
        origin: `http://${opts.host}:${port}`,
        port,
        requests,
      });
    });
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

describe('stored zip wheels', () => {
  it('builds a wheel whose hash is the sha256 of its bytes', () => {
    const w = buildWheel('demo-lib', '1.0');
    expect(w.filename).toBe('demo_lib-1.0-py3-none-any.whl');
    expect(w.sha256).toBe(createHash('sha256').update(w.data).digest('hex'));
    // End-of-central-directory record, three body entries plus RECORD.
    expect(w.data.readUInt32LE(w.data.length - 22)).toBe(0x06054b50);
    expect(w.data.readUInt16LE(w.data.length - 22 + 10)).toBe(4);
  });
});

describe.skipIf(!enabled)('registry proxy against real pip and uv', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-py-'));
  const demo1 = buildWheel('demo-lib', '1.0');
  const demo2 = buildWheel('demo-lib', '2.0');
  const other = buildWheel('other-lib', '1.0');
  const WHEELS = [demo1, demo2, other];
  let upstream: FakeUpstream;
  let proxy: RegistryProxy;
  let gatewayIp = '';
  let counter = 0;

  const registry = (origin: string): ResolvedRegistry => ({
    allowPrivateNetwork: true,
    authKind: 'bearer',
    ecosystem: 'pypi',
    id: REGISTRY_ID,
    isDefault: false,
    name: 'pypi',
    scopes: [],
    token: UPSTREAM_TOKEN,
    upstreamUrl: `${origin}/simple`,
  });

  /** Register against `origin`; `requirements` is the requirements.txt the allowlist is built from. */
  async function activate(requirements: string | null, origin = upstream.origin) {
    const denials: { name: string; version?: string }[] = [];
    const reg = await proxy.register({
      onDenied: (d) => denials.push(d),
      registries: [registry(origin)],
    });
    reg.setAllowlist(
      new Map([
        [
          REGISTRY_ID,
          requirements === null
            ? null
            : buildPypiAllowlist(parsePypiLockfile('requirements.txt', requirements)),
        ],
      ])
    );
    const proxyUrl = `http://${gatewayIp}:${await proxy.listen()}`;
    const full = registryWorkspaceEnv(
      [{ ecosystem: 'pypi', id: REGISTRY_ID, scopes: [] }],
      proxyUrl,
      reg.token
    );
    return { ...splitRegistryWorkspaceEnv(full), denials, full, reg };
  }

  function newProject(): string {
    counter += 1;
    const dir = path.join(work, `proj-${counter}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Runs `script` (a `sh -c` body) as the image's default user in `dir`, bind-mounted at the
   * workspace path. Bind mounts keep host ownership and the host and container users differ on CI,
   * so each side opens up what it wrote: the host before the run, the container after it.
   * Caches live under /tmp so no run depends on, or fills, another's.
   */
  async function client(
    dir: string,
    env: { env: string[]; secretEnv: Record<string, string> },
    script: string,
    opts?: { ignore?: boolean }
  ) {
    spawnSync('chmod', ['-R', 'a+rwX', dir]);
    const pairs = [
      ...env.env,
      ...Object.entries(env.secretEnv).map(([k, v]) => `${k}=${v}`),
      'PIP_CACHE_DIR=/tmp/pip-cache',
      'UV_CACHE_DIR=/tmp/uv-cache',
    ];
    const r = await docker([
      'run',
      '--rm',
      '-w',
      '/workspace/target-repo',
      '-v',
      `${dir}:/workspace/target-repo`,
      ...pairs.flatMap((e) => ['-e', e]),
      IMAGE,
      'sh',
      '-c',
      `${script}\ns=$?; find /workspace/target-repo -user "$(id -u)" -exec chmod a+rwX {} + 2>/dev/null; exit $s`,
    ]);
    if (r.code !== 0 && !opts?.ignore) {
      throw new Error(`${script} failed:\n${r.err}\n${r.out}`);
    }
    return r;
  }

  const PIP_IMPORT = 'python -c "import demo_lib; print(demo_lib.VERSION)"';
  const UV_VENV = 'uv venv --quiet /tmp/venv';
  const UV_IMPORT = '/tmp/venv/bin/python -c "import demo_lib; print(demo_lib.VERSION)"';

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
    upstream = await startUpstream({ host: gatewayIp, token: UPSTREAM_TOKEN, wheels: WHEELS });
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

  it('puts the index URLs, which carry the token, in secretEnv and not in plain env', async () => {
    const a = await activate(null);
    expect(Object.keys(a.secretEnv).sort()).toEqual([
      'PIP_INDEX_URL',
      'UV_DEFAULT_INDEX',
      'UV_INDEX_URL',
    ]);
    for (const v of Object.values(a.secretEnv)) {
      const url = new URL(v);
      expect(url.password).toBe(a.reg.token);
      expect(url.pathname).toBe(`/pypi/${REGISTRY_ID}/simple/`);
    }
    expect(a.env.some((e) => e.startsWith('PIP_TRUSTED_HOST='))).toBe(true);
    // Nothing in the plain env carries the token or a userinfo `@`.
    expect(a.env.some((e) => e.includes(a.reg.token) || e.includes('@'))).toBe(false);
    await a.reg.release();
  });

  it('pip installs a pinned wheel in lockfile mode, with only the upstream credential reaching the upstream', async () => {
    const dir = newProject();
    writeFileSync(path.join(dir, 'requirements.txt'), 'demo-lib==1.0\n');
    const a = await activate('demo-lib==1.0\n');
    const r = await client(
      dir,
      a,
      `pip install --user --no-input -r requirements.txt && ${PIP_IMPORT}`
    );
    expect(r.out.trim().split('\n').pop()).toBe('1.0');

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((q) => q.auth === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
    expect(upstream.requests.every((q) => !q.auth?.includes(a.reg.token))).toBe(true);
    expect(upstream.requests.some((q) => q.path === `/packages/demo-lib/${demo1.filename}`)).toBe(
      true
    );
    expect(upstream.requests.some((q) => q.path.includes(demo2.filename))).toBe(false);
    expect(upstream.requests.some((q) => q.path.includes('other'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('uv installs a pinned wheel in lockfile mode, with only the upstream credential reaching the upstream', async () => {
    const dir = newProject();
    writeFileSync(path.join(dir, 'requirements.txt'), 'demo-lib==1.0\n');
    const a = await activate('demo-lib==1.0\n');
    const r = await client(
      dir,
      a,
      `${UV_VENV} && uv pip install --python /tmp/venv/bin/python -r requirements.txt && ${UV_IMPORT}`
    );
    expect(r.out.trim().split('\n').pop()).toBe('1.0');

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((q) => q.auth === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
    expect(upstream.requests.every((q) => !q.auth?.includes(a.reg.token))).toBe(true);
    expect(upstream.requests.some((q) => q.path === `/packages/demo-lib/${demo1.filename}`)).toBe(
      true
    );
    expect(upstream.requests.some((q) => q.path.includes(demo2.filename))).toBe(false);
    expect(upstream.requests.some((q) => q.path.includes('other'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('pip refuses a version and a project outside the allowlist, and the upstream never serves their files', async () => {
    const dir = newProject();
    const a = await activate('demo-lib==1.0\n');

    const version = await client(dir, a, 'pip install --no-input demo-lib==2.0', { ignore: true });
    expect(version.code).not.toBe(0);
    expect(`${version.err}${version.out}`).toMatch(/No matching distribution found/);
    expect(a.denials).toEqual([]); // the 2.0 file is filtered out of the index, never requested

    const project = await client(dir, a, 'pip install --no-input other-lib', { ignore: true });
    expect(project.code).not.toBe(0);
    expect(`${project.err}${project.out}`).toMatch(/No matching distribution found/);
    expect(a.denials).toContainEqual(expect.objectContaining({ name: 'other-lib' }));

    expect(upstream.requests.some((q) => q.path.startsWith('/packages/'))).toBe(false);
    expect(upstream.requests.some((q) => q.path.includes('other'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('uv refuses a version and a project outside the allowlist, and the upstream never serves their files', async () => {
    const dir = newProject();
    const a = await activate('demo-lib==1.0\n');
    const install = (spec: string) =>
      client(dir, a, `${UV_VENV} && uv pip install --python /tmp/venv/bin/python ${spec}`, {
        ignore: true,
      });

    const version = await install('demo-lib==2.0');
    expect(version.code).not.toBe(0);
    expect(`${version.err}${version.out}`).toMatch(/demo-lib/);
    expect(a.denials).toEqual([]);

    const project = await install('other-lib');
    expect(project.code).not.toBe(0);
    expect(a.denials).toContainEqual(expect.objectContaining({ name: 'other-lib' }));

    expect(upstream.requests.some((q) => q.path.startsWith('/packages/'))).toBe(false);
    expect(upstream.requests.some((q) => q.path.includes('other'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('pip installs any project in open mode', async () => {
    const dir = newProject();
    const a = await activate(null);
    const r = await client(
      dir,
      a,
      'pip install --user --no-input other-lib && python -c "import other_lib; print(other_lib.VERSION)"'
    );
    expect(r.out.trim().split('\n').pop()).toBe('1.0');
    expect(upstream.requests.some((q) => q.path === `/packages/other-lib/${other.filename}`)).toBe(
      true
    );
    await a.reg.release();
  }, 300_000);

  it('uv installs any project in open mode', async () => {
    const dir = newProject();
    const a = await activate(null);
    const r = await client(
      dir,
      a,
      `${UV_VENV} && uv pip install --python /tmp/venv/bin/python other-lib && /tmp/venv/bin/python -c "import other_lib; print(other_lib.VERSION)"`
    );
    expect(r.out.trim().split('\n').pop()).toBe('1.0');
    await a.reg.release();
  }, 300_000);

  describe('a file on another origin over plain http', () => {
    let second: FakeUpstream;
    let split: FakeUpstream;

    beforeAll(async () => {
      // Serves the wheels with no auth check; the index names it as the file host.
      second = await startUpstream({ host: gatewayIp, wheels: WHEELS });
      split = await startUpstream({
        fileOrigin: () => second.origin,
        host: gatewayIp,
        token: UPSTREAM_TOKEN,
        wheels: WHEELS,
      });
    }, 30_000);

    afterAll(() => {
      second?.close();
      split?.close();
    });

    it('is refused, so pip fails and the second origin receives no request', async () => {
      second.requests.length = 0;
      split.requests.length = 0;
      const dir = newProject();
      const a = await activate(null, split.origin);
      const r = await client(dir, a, 'pip install --no-input demo-lib==1.0', { ignore: true });
      expect(r.code).not.toBe(0);
      expect(split.requests.some((q) => q.path === '/simple/demo-lib/')).toBe(true);
      expect(second.requests).toEqual([]);
      await a.reg.release();
    }, 300_000);

    it('is refused, so uv fails and the second origin receives no request', async () => {
      second.requests.length = 0;
      split.requests.length = 0;
      const dir = newProject();
      const a = await activate(null, split.origin);
      const r = await client(
        dir,
        a,
        `${UV_VENV} && uv pip install --python /tmp/venv/bin/python demo-lib==1.0`,
        { ignore: true }
      );
      expect(r.code).not.toBe(0);
      expect(second.requests).toEqual([]);
      await a.reg.release();
    }, 300_000);
  });
});
