/**
 * What real uv and pip WRITE to disk and print when the PyPI index URL they were given carries the
 * proxy's workspace token. A project's `uv.lock`, a compiled requirements file, `pip freeze` and
 * error text are all things an agent commits or shows; this suite records, per tool and command,
 * whether the token, the proxy's `host:port` or the upstream's host reach them. Needs a Docker
 * daemon:
 *
 *   PYPI_PROXY_DOCKER_TEST=1 PYPI_PROXY_TEST_IMAGE=<image> \
 *     yarn vitest run packages/worker/src/lib/registryProxy/pypiLock.docker.test.ts
 *
 * On Docker Desktop the bridge gateway is not the host; set `CLAUDE_CODE_TEST_HOST_ADDRESS` to the
 * host's LAN address.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
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

/** Every regular file under `dir` (skipping virtualenvs) with its text. */
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.venv' || name === '__pycache__') {
        continue;
      }
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out[path.relative(dir, full)] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!enabled)('what uv and pip write when the index URL carries credentials', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-lock-'));
  const demo1 = buildWheel('demo-lib', '1.0');
  const WHEELS = [demo1];
  let upstream: FakeUpstream;
  let proxy: RegistryProxy;
  let gatewayIp = '';
  let counter = 0;

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

  const registry = (): ResolvedRegistry => ({
    allowPrivateNetwork: true,
    authKind: 'bearer',
    ecosystem: 'pypi',
    id: REGISTRY_ID,
    isDefault: false,
    name: 'pypi',
    scopes: [],
    token: UPSTREAM_TOKEN,
    upstreamUrl: `${upstream.origin}/simple`,
  });

  async function activate(design: 'A' | 'B') {
    const reg = await proxy.register({ onDenied: () => {}, registries: [registry()] });
    reg.setAllowlist(new Map([[REGISTRY_ID, null]]));
    const port = await proxy.listen();
    const proxyUrl = `http://${gatewayIp}:${port}`;
    const full = registryWorkspaceEnv(
      [{ ecosystem: 'pypi', id: REGISTRY_ID, scopes: [] }],
      proxyUrl,
      reg.token
    );
    const split = splitRegistryWorkspaceEnv(full);
    if (design === 'B') {
      const index = `http://token:${reg.token}@${gatewayIp}:${port}/pypi/${REGISTRY_ID}/simple/`;
      for (const k of ['PIP_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_INDEX_URL']) {
        split.secretEnv[k] = index;
      }
    }
    return { ...split, hostPort: `${gatewayIp}:${port}`, reg };
  }

  function newProject(files: Record<string, string> = {}): string {
    counter += 1;
    const dir = path.join(work, `proj-${counter}`);
    mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) {
      writeFileSync(path.join(dir, n), c);
    }
    return dir;
  }

  async function client(
    dir: string,
    env: { env: string[]; secretEnv: Record<string, string> },
    script: string
  ) {
    spawnSync('chmod', ['-R', 'a+rwX', dir]);
    const pairs = [
      ...env.env,
      ...Object.entries(env.secretEnv).map(([k, v]) => `${k}=${v}`),
      'PIP_CACHE_DIR=/tmp/pip-cache',
      'UV_CACHE_DIR=/tmp/uv-cache',
    ];
    return docker([
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
  }

  const PYPROJECT =
    '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = ["demo-lib==1.0"]\n';

  const cases: Array<{ name: string; files?: Record<string, string>; script: string }> = [
    {
      name: 'a: uv init --bare, uv add',
      script: 'uv init --bare --quiet && uv add demo-lib==1.0',
    },
    {
      files: { 'pyproject.toml': PYPROJECT },
      name: 'b: uv lock, uv sync --frozen',
      script: 'uv lock && uv sync --frozen',
    },
    {
      files: { 'requirements.in': 'demo-lib==1.0\n' },
      name: 'c: uv pip compile',
      script: 'uv pip compile requirements.in -o requirements.txt',
    },
    {
      name: 'd: pip install, freeze, config',
      script:
        'pip install --user --no-input demo-lib==1.0; pip freeze --user; pip config list; pip download --no-deps -d /tmp/dl demo-lib==1.0; pip list --user -v',
    },
    { name: 'd2: pip failure text', script: 'pip install --no-input no-such-lib' },
    {
      name: 'e: uv failure text',
      script: 'uv venv --quiet /tmp/v && uv pip install --python /tmp/v/bin/python no-such-lib',
    },
  ];

  for (const design of ['A', 'B'] as const) {
    for (const c of cases) {
      it(`design ${design} / ${c.name}`, async () => {
        const dir = newProject(c.files);
        const a = await activate(design);
        const r = await client(dir, a, c.script);
        const tree = readTree(dir);
        const all = `${r.out}\n${r.err}\n${Object.values(tree).join('\n')}`;
        const report = {
          case: c.name,
          code: r.code,
          design,
          files: Object.keys(tree),
          proxyHostPort: all.includes(a.hostPort),
          token: all.includes(a.reg.token),
          upstreamPort: all.includes(`${upstream.port}`),
        };
        console.log(`REPORT ${JSON.stringify(report)}`);
        for (const [n, t] of Object.entries(tree)) {
          console.log(`FILE ${design} ${c.name} :: ${n}\n${t}`);
        }
        console.log(`OUT ${design} ${c.name}\n${r.out}\nERR\n${r.err}`);
        console.log(
          `UPSTREAM ${design} ${c.name} ${JSON.stringify(upstream.requests.map((q) => q.path))}`
        );
        await a.reg.release();
        expect(true).toBe(true);
      }, 300_000);
    }
  }
});
