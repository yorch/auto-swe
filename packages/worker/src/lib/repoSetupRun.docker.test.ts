/**
 * Workspace setup against real tools: a real executor container, a git server over HTTPS (git's
 * own `http-backend`), a small LFS server and the filesystem artifact store. Covers what the unit
 * suite's fake host cannot: that same-host submodules fetch with their own credential, that LFS
 * objects land in the checkout and in a submodule, that a cache saved by one workspace restores in
 * the next, and that the secret scan catches a step that wrote a secret to disk.
 *
 * The workspace driver is replaced by plain `docker exec` (secrets travel as `-e NAME` from the
 * client's environment, as the driver delivers them), and the database by in-memory tables. Needs
 * a Docker daemon, `git` and `openssl` on the host, and an executor image:
 *
 *   docker build -f defaults/Dockerfile.node -t asw-executor-node:ci defaults
 *   REPO_SETUP_DOCKER_TEST=1 yarn vitest run packages/worker/src/lib/repoSetupRun.docker.test.ts
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type RepoSetup, RepoSetupSchema } from '@auto-swe/shared/lib/repoSetup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CapturedResult } from './execUtils.js';
import type { RepoSetupHost } from './repoSetupRun.js';
import { keeperPidProbeScript } from './workspaceBackend/docker.js';

const enabled = process.env.REPO_SETUP_DOCKER_TEST === '1';
const IMAGE = process.env.REPO_SETUP_TEST_IMAGE ?? 'asw-executor-node:ci';
const GIT_HOST_NAME = 'git.test';
const TOKEN = 'npm_e2e_secret_value_0123456789';

const tables = vi.hoisted(() => {
  const table = () => {
    const rows = new Map<string, Record<string, unknown>>();
    const keyOf = (where: Record<string, unknown>) => String(where.id ?? where.cacheKey);
    return {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data };
        rows.set(String(data.id ?? data.cacheKey), row);
        return row;
      },
      delete: async ({ where }: { where: Record<string, unknown> }) => {
        rows.delete(keyOf(where));
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        rows.get(keyOf(where)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.get(keyOf(where));
        if (!row) {
          throw new Error('not found');
        }
        return row;
      },
      rows,
      update: async ({ data, where }: { data: object; where: Record<string, unknown> }) => {
        const row = { ...rows.get(keyOf(where)), ...data };
        rows.set(keyOf(where), row);
        return row;
      },
      updateMany: async ({ data, where }: { data: object; where: Record<string, unknown> }) => {
        const row = rows.get(keyOf(where));
        if (!row) {
          return { count: 0 };
        }
        rows.set(keyOf(where), { ...row, ...data });
        return { count: 1 };
      },
      upsert: async (args: { create: Record<string, unknown>; update: object; where: object }) => {
        const key = keyOf(args.where as Record<string, unknown>);
        const row = rows.has(key) ? { ...rows.get(key), ...args.update } : args.create;
        rows.set(key, row);
        return row;
      },
    };
  };
  return { workflowArtifact: table(), workspaceSetupCache: table() };
});

vi.mock('@auto-swe/shared/db', () => ({ prisma: tables }));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: async (key: string) => (key === 'workspace.setupCacheMaxMb' ? 64 : undefined),
}));
vi.mock('./config/contextLookup.js', () => ({ currentRequestContext: async () => ({}) }));

const work = mkdtempSync(path.join(tmpdir(), 'asw-repo-setup-'));
const storeDir = path.join(work, 'artifacts');
process.env.ARTIFACT_FS_DIR = storeDir;
process.env.ARTIFACT_WRITE_BACKEND = 'fs';

function sh(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const git = (cwd: string, ...args: string[]) =>
  sh(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    {
      cwd,
    }
  );

/** An LFS object: its pointer file and the bytes the server holds for it. */
function lfsObject(content: string) {
  const body = Buffer.from(content);
  const oid = crypto.createHash('sha256').update(body).digest('hex');
  return {
    body,
    oid,
    pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${body.length}\n`,
  };
}

const libObject = lfsObject('submodule lfs payload\n');
const mainObject = lfsObject('top-level lfs payload\n');
const lfsStore = new Map([
  [libObject.oid, libObject.body],
  [mainObject.oid, mainObject.body],
]);

const headerFor = (repo: string) =>
  `Authorization: Basic ${Buffer.from(`x-access-token:tok-${repo}`).toString('base64')}`;

/** Requests the servers saw: repository and whether it carried that repository's credential. */
const seen: Array<{ repo: string; kind: 'git' | 'lfs'; authed: boolean }> = [];

let server: https.Server;
let port = 0;
let caPem = '';
const urlOf = (repo: string) => `https://${GIT_HOST_NAME}:${port}/acme/${repo}.git`;

function makeRepos() {
  const bare = path.join(work, 'git', 'acme');
  mkdirSync(bare, { recursive: true });
  const lib = path.join(work, 'src-lib');
  mkdirSync(lib);
  git(lib, 'init', '-q');
  writeFileSync(path.join(lib, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(path.join(lib, 'data.bin'), libObject.pointer);
  git(lib, 'add', '.');
  git(lib, 'commit', '-qm', 'lib');
  git(work, 'clone', '-q', '--bare', lib, path.join(bare, 'lib.git'));

  const main = path.join(work, 'src-main');
  mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(path.join(main, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(path.join(main, 'asset.bin'), mainObject.pointer);
  writeFileSync(path.join(main, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
  git(main, 'config', '-f', '.gitmodules', 'submodule.lib.url', '../lib.git');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'main');
  git(work, 'clone', '-q', '--bare', main, path.join(bare, 'main.git'));
  for (const repo of ['lib', 'main']) {
    git(path.join(bare, `${repo}.git`), 'config', 'http.receivepack', 'false');
  }
}

function makeCert() {
  const key = path.join(work, 'key.pem');
  const cert = path.join(work, 'cert.pem');
  sh('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${GIT_HOST_NAME}`,
    '-addext',
    `subjectAltName=DNS:${GIT_HOST_NAME}`,
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  caPem = readFileSync(cert, 'utf8');
  return { cert: caPem, key: readFileSync(key, 'utf8') };
}

/** Smart HTTP through `git http-backend` (CGI), plus the LFS batch API and object downloads. */
function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'https://x');
  const object = /^\/lfs-objects\/([0-9a-f]{64})$/.exec(url.pathname);
  if (object?.[1]) {
    const body = lfsStore.get(object[1]);
    res.writeHead(body ? 200 : 404).end(body);
    return;
  }
  const repo = /^\/acme\/([a-z]+)\.git\//.exec(url.pathname)?.[1] ?? '';
  const authed = req.headers.authorization === headerFor(repo).slice('Authorization: '.length);
  if (url.pathname.endsWith('/info/lfs/objects/batch')) {
    seen.push({ authed, kind: 'lfs', repo });
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      if (!authed) {
        res.writeHead(401).end();
        return;
      }
      const { objects } = JSON.parse(raw) as { objects: Array<{ oid: string; size: number }> };
      res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' }).end(
        JSON.stringify({
          objects: objects.map((o) => ({
            ...o,
            actions: {
              download: { href: `https://${GIT_HOST_NAME}:${port}/lfs-objects/${o.oid}` },
            },
          })),
          transfer: 'basic',
        })
      );
    });
    return;
  }
  seen.push({ authed, kind: 'git', repo });
  if (!authed) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }).end();
    return;
  }
  const cgi = spawn('git', ['http-backend'], {
    env: {
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: path.join(work, 'git'),
      PATH: process.env.PATH,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let headersDone = false;
  cgi.stdout.on('data', (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      return;
    }
    headersDone = true;
    let status = 200;
    for (const line of head.subarray(0, end).toString().split('\r\n')) {
      const [name, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (name?.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10);
      } else if (name) {
        res.setHeader(name, value);
      }
    }
    res.writeHead(status);
    res.write(head.subarray(end + 4));
  });
  cgi.on('close', () => res.end());
}

const containers: string[] = [];
const keepers = new Map<string, number>();

/** A fresh workspace container, trusting the test CA, with `/workspace` owned by its user. */
function startContainer(): string {
  const name = `asw-repo-setup-${process.pid}-${containers.length}`;
  sh('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--add-host=${GIT_HOST_NAME}:host-gateway`,
    '--tmpfs',
    '/workspace:exec,uid=1000,gid=1000,mode=0755',
    // Not the image's WORKDIR, which docker would create in the tmpfs as root.
    '--workdir',
    '/workspace',
    '--entrypoint',
    'sleep',
    IMAGE,
    'infinity',
  ]);
  containers.push(name);
  sh(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      '0',
      '-w',
      '/',
      name,
      'sh',
      '-c',
      'cat >> /etc/ssl/certs/ca-certificates.crt',
    ],
    {
      input: caPem,
    }
  );
  // Probed while the keeper is still the only child of docker-init, as the workspace backend does.
  keepers.set(
    name,
    Number(sh('docker', ['exec', name, 'sh', '-c', keeperPidProbeScript()]).toString().trim())
  );
  return name;
}

function dockerExec(
  container: string,
  script: string,
  opts: { workdir?: string; secretEnv?: Record<string, string>; input?: Buffer } = {}
): Promise<CapturedResult> {
  const secretEnv = opts.secretEnv ?? {};
  const args = ['exec', '-i', '-w', opts.workdir ?? '/workspace'];
  for (const name of Object.keys(secretEnv)) {
    args.push('-e', name);
  }
  args.push(container, 'sh', '-c', script);
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      { encoding: 'utf8', env: { ...process.env, ...secretEnv }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({
          exitCode: err ? (typeof code === 'number' ? code : 1) : 0,
          stderr,
          stdout,
        } as CapturedResult);
      }
    );
    child.stdin?.end(opts.input);
  });
}

async function readBack(container: string, file: string, maxBytes: number): Promise<Buffer> {
  const out = execFileSync('docker', ['exec', '-w', '/', container, 'cat', file], {
    maxBuffer: maxBytes + 1,
  });
  if (out.length > maxBytes) {
    throw new RangeError('too large');
  }
  return out;
}

function hostFor(container: string): RepoSetupHost {
  const must = async (result: Promise<CapturedResult>) => {
    const r = await result;
    if (r.exitCode !== 0) {
      throw new Error(`exit ${r.exitCode}: ${r.stderr}${r.stdout}`);
    }
    return r.stdout;
  };
  return {
    capture: (command, opts) =>
      dockerExec(container, command, {
        workdir: '/workspace/target-repo',
        ...(opts.secretEnv ? { secretEnv: opts.secretEnv } : {}),
      }),
    git: async (dir, subcommand, authHeader) => {
      const { gitAuthSecretEnv, gitWithAuthHeader } = await import('../activities/workspace.js');
      const secretEnv = gitAuthSecretEnv(authHeader);
      return must(
        dockerExec(
          container,
          `cd '${dir}' && ${gitWithAuthHeader(subcommand, Boolean(authHeader))}`,
          {
            ...(secretEnv ? { secretEnv } : {}),
          }
        )
      );
    },
    mintCredential: async (_org, repo) => ({ authHeader: headerFor(repo), cleanUrl: urlOf(repo) }),
    readFile: (file, maxBytes) => readBack(container, file, maxBytes),
    redact: (text) => text.split(TOKEN).join('***'),
    root: (command) => must(dockerExec(container, command)),
    stdin: async (command, body) => {
      await must(dockerExec(container, command, { input: body }));
    },
    sweepProcesses: async () => {
      const { killStrayProcessesScript } = await import('../activities/workspace.js');
      await must(dockerExec(container, killStrayProcessesScript(keepers.get(container) ?? 0)));
    },
  };
}

/** Clone the top-level repository the way the workspace does, with LFS smudging off. */
async function cloneWorkspace(container: string): Promise<RepoSetupHost> {
  const host = hostFor(container);
  await host.git('/workspace', `clone -q ${urlOf('main')} target-repo`, headerFor('main'));
  return host;
}

const baseSetup = {
  cache: { keyFiles: ['package-lock.json'], paths: ['node_modules'] },
  lfs: true,
  secrets: ['NPM_TOKEN'],
  steps: [
    {
      name: 'install',
      run: [
        'mkdir -p node_modules/dep',
        'cp asset.bin node_modules/dep/asset.bin',
        '{ [ -f node_modules/dep/stamp ] || hostname > node_modules/dep/stamp; }',
        'printf "//registry.test/:_authToken=%s\\n" "$NPM_TOKEN" > ~/.npmrc',
        'test -n "$NPM_TOKEN"',
      ].join(' && '),
    },
  ],
  submodules: true,
};

describe.skipIf(!enabled)('workspace setup in a real container', () => {
  let setup: typeof import('./repoSetupRun.js');

  beforeAll(async () => {
    makeRepos();
    const tls = makeCert();
    server = https.createServer(tls, handle);
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    port = (server.address() as AddressInfo).port;
    setup = await import('./repoSetupRun.js');
  }, 120_000);

  afterAll(async () => {
    for (const name of containers) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // Already gone.
      }
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    // A git or LFS child of the server can still be finishing a request into `work`.
    rmSync(work, { force: true, maxRetries: 5, recursive: true });
  });

  const inputs = () => ({
    cleanUrl: urlOf('main'),
    gitHost: `${GIT_HOST_NAME}:${port}`,
    image: IMAGE,
    teamId: null,
  });

  it('fetches the submodule and LFS objects, then saves the cache and restores it in the next workspace', async () => {
    const definition: RepoSetup = RepoSetupSchema.parse({ ...baseSetup, cleanup: ['~/.npmrc'] });
    const first = startContainer();
    const host = await cloneWorkspace(first);

    const fetched = await setup.runSetupGitPhase(host, definition, inputs(), headerFor('main'));
    expect(fetched).toEqual({ lfs: true, submodules: 1 });
    expect((await host.root('cat /workspace/target-repo/asset.bin')).toString()).toBe(
      mainObject.body.toString()
    );
    expect((await host.root('cat /workspace/target-repo/lib/data.bin')).toString()).toBe(
      libObject.body.toString()
    );
    // Each repository's traffic carried that repository's own credential.
    expect(seen.filter((s) => s.repo === 'lib' && s.authed).map((s) => s.kind)).toEqual(
      expect.arrayContaining(['git', 'lfs'])
    );
    expect(seen.some((s) => s.repo === 'main' && s.kind === 'lfs' && s.authed)).toBe(true);

    const ran = await setup.runSetupStepsPhase(host, definition, inputs(), { NPM_TOKEN: TOKEN });
    expect(ran.cache).toBe('saved');
    expect((await host.capture('test -e ~/.npmrc', { timeoutMs: 10_000 })).exitCode).not.toBe(0);
    expect(tables.workspaceSetupCache.rows.size).toBe(1);
    expect(readdirSync(storeDir, { recursive: true }).length).toBeGreaterThan(1);

    const stamp = await host.root('cat /workspace/target-repo/node_modules/dep/stamp');

    // The next workspace restores the first one's node_modules: its stamp is the first's.
    const next = await cloneWorkspace(startContainer());
    await setup.runSetupGitPhase(next, definition, inputs(), headerFor('main'));
    const restored = await setup.runSetupStepsPhase(next, definition, inputs(), {
      NPM_TOKEN: TOKEN,
    });
    expect(restored.cache).toBe('hit');
    expect(await next.root('cat /workspace/target-repo/node_modules/dep/stamp')).toBe(stamp);
  }, 300_000);

  it('fails setup, naming the file and not the value, when a step leaves a secret on disk', async () => {
    const definition = RepoSetupSchema.parse(baseSetup);
    const container = startContainer();
    const host = await cloneWorkspace(container);
    await setup.runSetupGitPhase(host, definition, inputs(), headerFor('main'));
    const before = tables.workspaceSetupCache.rows.size;

    const failure = await setup
      .runSetupStepsPhase(host, definition, inputs(), { NPM_TOKEN: TOKEN })
      .then(
        () => null,
        (err: Error) => err
      );
    expect(failure?.message).toMatch(/left a secret value in ~\/\.npmrc/);
    expect(failure?.message).not.toContain(TOKEN);
    expect(tables.workspaceSetupCache.rows.size).toBe(before);
  }, 300_000);

  it('catches a base64-encoded value left in /tmp', async () => {
    const definition = RepoSetupSchema.parse({
      ...baseSetup,
      cache: undefined,
      cleanup: ['~/.npmrc'],
      steps: [{ name: 'leak', run: 'printf "u:%s" "$NPM_TOKEN" | base64 -w0 > /tmp/auth' }],
    });
    const host = await cloneWorkspace(startContainer());
    await setup.runSetupGitPhase(host, definition, inputs(), headerFor('main'));
    const failure = await setup
      .runSetupStepsPhase(host, definition, inputs(), { NPM_TOKEN: TOKEN })
      .then(
        () => null,
        (err: Error) => err
      );
    expect(failure?.message).toMatch(/left a secret value in \/tmp\/auth/);
    expect(failure?.message).not.toContain(TOKEN);
  }, 300_000);

  it('stops a process a step left running with a secret, and keeps the workspace alive', async () => {
    const definition = RepoSetupSchema.parse({
      ...baseSetup,
      cache: undefined,
      steps: [{ name: 'daemon', run: 'nohup sleep 4242 >/dev/null 2>&1 &' }],
    });
    const host = await cloneWorkspace(startContainer());
    await setup.runSetupGitPhase(host, definition, inputs(), headerFor('main'));
    await setup.runSetupStepsPhase(host, definition, inputs(), { NPM_TOKEN: TOKEN });
    const left = await host.root(
      'for d in /proc/[0-9]*; do tr "\\0" " " < "$d/cmdline" 2>/dev/null; echo; done'
    );
    expect(left).not.toContain('sleep 4242');
    expect(left).toContain('sleep infinity');
  }, 300_000);
});
