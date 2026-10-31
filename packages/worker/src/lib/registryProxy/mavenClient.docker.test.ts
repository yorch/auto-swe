/**
 * End-to-end proof that a real `mvn` resolves artifacts through the registry proxy. A fake Maven
 * repository (requiring its own Bearer token) sits on the host; containers built from
 * `defaults/Dockerfile.jvm` reach a real `createRegistryProxy` at the host's address. Needs a
 * Docker daemon:
 *
 *   MAVEN_PROXY_DOCKER_TEST=1 MAVEN_PROXY_TEST_IMAGE=<image> \
 *     yarn vitest run packages/worker/src/lib/registryProxy/mavenClient.docker.test.ts
 *
 * No internet is required, and no Maven plugin is available: the projects are `pom` packaging with
 * a `<build><extensions>` entry, which Maven resolves from the repositories at project load (the
 * artifact's pom and jar are downloaded), and `mvn validate` binds no mojo for that packaging. On
 * Docker Desktop the bridge gateway is not the host; set `CLAUDE_CODE_TEST_HOST_ADDRESS` to the
 * host's LAN address.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRegistryProxy,
  type RegistryProxy,
  type ResolvedRegistry,
  TarballCache,
} from './index.js';
import {
  MAVEN_SETTINGS_PATH,
  registryWorkspaceEnv,
  renderMavenSettings,
  splitRegistryWorkspaceEnv,
} from './render.js';

const enabled = process.env.MAVEN_PROXY_DOCKER_TEST === '1';
const IMAGE = process.env.MAVEN_PROXY_TEST_IMAGE ?? 'asw-executor-jvm:ci';
const UPSTREAM_TOKEN = 'up-token';

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

interface Artifact {
  artifactId: string;
  jar: Buffer;
  pom: string;
  version: string;
}

/** A jar with a manifest and nothing else: no extension descriptor, so Maven only resolves it. */
function buildArtifact(artifactId: string, version: string): Artifact {
  return {
    artifactId,
    jar: buildStoredZip([
      { data: Buffer.from('Manifest-Version: 1.0\r\n\r\n'), name: 'META-INF/MANIFEST.MF' },
    ]),
    pom: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
  <packaging>jar</packaging>
</project>
`,
    version,
  };
}

interface FakeUpstream {
  close(): void;
  origin: string;
  requests: { auth?: string; path: string }[];
}

/** A Maven repository for `example:*`: release poms and jars, and metadata for demo-lib. */
function startUpstream(opts: { artifacts: Artifact[]; host: string }): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const files = new Map<string, Buffer | string>();
  for (const a of opts.artifacts) {
    const base = `/example/${a.artifactId}/${a.version}/${a.artifactId}-${a.version}`;
    files.set(`${base}.pom`, a.pom);
    files.set(`${base}.jar`, a.jar);
  }
  files.set(
    '/example/demo-lib/maven-metadata.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>example</groupId>
  <artifactId>demo-lib</artifactId>
  <versioning>
    <latest>1.0</latest>
    <release>1.0</release>
    <versions><version>1.0</version></versions>
  </versioning>
</metadata>
`
  );
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({ auth: req.headers.authorization, path: url });
    if (req.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const body = files.get(url);
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ close: () => server.close(), origin: `http://${opts.host}:${port}`, requests });
    });
  });
}

const execFileAsync = promisify(execFile);

// Async on purpose: the proxy and upstream are in-process, so a synchronous docker call would
// block the event loop and dead-lock the fetch.
async function docker(
  args: string[],
  input?: string
): Promise<{ code: number; err: string; out: string }> {
  const call = execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) {
    call.child.stdin?.end(input);
  }
  try {
    const { stdout, stderr } = await call;
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

describe('stored zip jars', () => {
  it('builds a jar with a single manifest entry', () => {
    const a = buildArtifact('demo-lib', '1.0');
    expect(a.jar.readUInt32LE(a.jar.length - 22)).toBe(0x06054b50);
    expect(a.jar.readUInt16LE(a.jar.length - 22 + 10)).toBe(1);
  });
});

describe.skipIf(!enabled)('registry proxy against real Maven', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'rp-mvn-'));
  const demo = buildArtifact('demo-lib', '1.0');
  const other = buildArtifact('other-lib', '1.0');
  const DEMO_POM = '/example/demo-lib/1.0/demo-lib-1.0.pom';
  const DEMO_JAR = '/example/demo-lib/1.0/demo-lib-1.0.jar';
  let upstream: FakeUpstream;
  let proxy: RegistryProxy;
  let gatewayIp = '';
  let counter = 0;
  /** Every `docker run` argv, to prove the token is on none of them. */
  const argvLog: string[][] = [];

  /**
   * A fresh registry id per activation: the cache keys on the registry id and the upstream URL, so
   * no case is served from another case's cache.
   */
  async function activate() {
    counter += 1;
    const id = `rMvn${counter}`;
    const registry: ResolvedRegistry = {
      allowPrivateNetwork: true,
      authKind: 'bearer',
      ecosystem: 'maven',
      id,
      isDefault: false,
      name: 'maven',
      scopes: [],
      token: UPSTREAM_TOKEN,
      upstreamUrl: upstream.origin,
    };
    const reg = await proxy.register({ onDenied: () => {}, registries: [registry] });
    reg.setAllowlist(new Map([[id, null]]));
    const proxyUrl = `http://${gatewayIp}:${await proxy.listen()}`;
    const list = [{ ecosystem: 'maven' as const, id, scopes: [] }];
    const full = registryWorkspaceEnv(list, proxyUrl, reg.token);
    const settings = renderMavenSettings(list, proxyUrl, reg.token) ?? '';
    return { ...splitRegistryWorkspaceEnv(full), full, id, proxyUrl, reg, settings };
  }

  function newProject(coordinate: string): string {
    counter += 1;
    const dir = path.join(work, `proj-${counter}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'pom.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>test</groupId>
  <artifactId>app</artifactId>
  <version>1</version>
  <packaging>pom</packaging>
  <build>
    <extensions>
      <extension>
        <groupId>example</groupId>
        <artifactId>${coordinate}</artifactId>
        <version>1.0</version>
      </extension>
    </extensions>
  </build>
</project>
`
    );
    return dir;
  }

  /**
   * Runs `script` (a `sh -c` body) as the image's default user in `dir`, bind-mounted at the
   * workspace path. The settings file is written by the container itself from stdin, mode 600, as
   * the workspace activity does: the token is then on no argv, and the file is readable by its own
   * user whatever the host's uid is. Bind mounts keep host ownership and the host and container
   * users differ on CI, so each side opens up what it wrote: the host before the run, the container
   * after it.
   */
  async function client(
    dir: string,
    a: Awaited<ReturnType<typeof activate>>,
    script: string,
    opts?: { ignore?: boolean }
  ) {
    spawnSync('chmod', ['-R', 'a+rwX', dir]);
    const pairs = [...a.env, ...Object.entries(a.secretEnv).map(([k, v]) => `${k}=${v}`)];
    const args = [
      'run',
      '--rm',
      '-i',
      '-w',
      '/workspace/target-repo',
      '-v',
      `${dir}:/workspace/target-repo`,
      ...pairs.flatMap((e) => ['-e', e]),
      IMAGE,
      'sh',
      '-c',
      `mkdir -p "$(dirname ${MAVEN_SETTINGS_PATH})" && (umask 077 && cat > ${MAVEN_SETTINGS_PATH}) && { ${script}\n}\ns=$?; find /workspace/target-repo -user "$(id -u)" -exec chmod a+rwX {} + 2>/dev/null; exit $s`,
    ];
    argvLog.push(args);
    const r = await docker(args, a.settings);
    if (r.code !== 0 && !opts?.ignore) {
      throw new Error(`${script} failed:\n${r.err}\n${r.out}`);
    }
    return r;
  }

  // -B batch mode, -ntp no transfer progress. The local repository is under /tmp so no run
  // depends on, or fills, another's; `-s` comes from MAVEN_ARGS, which Maven 3.9+ reads.
  const VALIDATE = 'mvn -B -ntp -Dmaven.repo.local=/tmp/m2 validate';

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
    upstream = await startUpstream({ artifacts: [demo, other], host: gatewayIp });
    proxy = createRegistryProxy({
      advertisedUrl: (p) => `http://${gatewayIp}:${p}`,
      cache: new TarballCache(path.join(work, 'cache'), 64 * 1024 * 1024),
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

  // Maven 3.8.1+ blocks an http repository declared in a POM, and the proxy is plain http. A
  // build extension resolving at all, from an http URL, therefore proves the `mirrorOf *` mirror
  // in settings.xml is what Maven used: the blocker never sees a repository of its own.
  it('resolves a build extension through the mirror, with only the upstream credential reaching the upstream', async () => {
    const dir = newProject('demo-lib');
    const a = await activate();
    const r = await client(dir, a, VALIDATE);
    const output = `${r.out}${r.err}`;
    expect(output).toContain('BUILD SUCCESS');
    // The super-POM's central repository did not bypass the mirror.
    expect(output).not.toContain('repo.maven.apache.org');
    // Maven names the URL it fetched from in its checksum warnings: the proxy's, not Central's.
    expect(output).toMatch(/http:\/\/[\d.]+:\d+\/maven\//);

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((q) => q.auth === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
    expect(upstream.requests.every((q) => !q.auth?.includes(a.reg.token))).toBe(true);
    const paths = upstream.requests.map((q) => q.path);
    expect(paths).toContain(DEMO_POM);
    expect(paths).toContain(DEMO_JAR);
    expect(paths.some((p) => p.includes('other-lib'))).toBe(false);
    await a.reg.release();
  }, 300_000);

  it('serves a second build of the same release from the proxy cache', async () => {
    const dir = newProject('demo-lib');
    const a = await activate();
    await client(dir, a, VALIDATE);
    await client(dir, a, VALIDATE);
    const paths = upstream.requests.map((q) => q.path);
    // A release file is immutable, so the second build never reaches the upstream for it. Metadata
    // is not cached; Maven requests none for a pinned version, so none is asserted either way.
    expect(paths.filter((p) => p === DEMO_POM)).toHaveLength(1);
    expect(paths.filter((p) => p === DEMO_JAR)).toHaveLength(1);
    await a.reg.release();
  }, 300_000);

  it('fails the build with a resolution error when the upstream lacks the artifact, and the proxy answers 404', async () => {
    const dir = newProject('missing-lib');
    const a = await activate();
    const r = await client(dir, a, VALIDATE, { ignore: true });
    const output = `${r.out}${r.err}`;
    expect(r.code).not.toBe(0);
    expect(output).toMatch(/Could not find artifact example:missing-lib:jar:1\.0/);
    // A 502 would read "Could not transfer artifact … status code: 502".
    expect(output).not.toMatch(/Could not transfer|502|Bad Gateway/);
    expect(upstream.requests.some((q) => q.path.includes('missing-lib'))).toBe(true);

    const direct = await fetch(
      `${a.proxyUrl}/maven/${a.id}/example/missing-lib/1.0/missing-lib-1.0.pom`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`token:${a.reg.token}`).toString('base64')}`,
        },
      }
    );
    expect(direct.status).toBe(404);
    await a.reg.release();
  }, 300_000);

  it('keeps the token out of plain env and docker argv, and in the settings file only', async () => {
    const a = await activate();
    expect(a.env).toContain(`MAVEN_ARGS=-s ${MAVEN_SETTINGS_PATH}`);
    expect(a.env.filter((e) => e.startsWith('MAVEN_ARGS='))).toHaveLength(1);
    expect(a.env.some((e) => e.includes(a.reg.token))).toBe(false);
    expect(Object.keys(a.secretEnv)).toEqual([]);
    expect(a.settings).toContain(`<password>${a.reg.token}</password>`);
    expect(a.settings).toContain(`<url>${a.proxyUrl}/maven/${a.id}/</url>`);
    expect(a.settings.split(a.reg.token)).toHaveLength(2);

    const dir = newProject('demo-lib');
    const r = await client(dir, a, `stat -c %a ${MAVEN_SETTINGS_PATH}`);
    expect(r.out.trim()).toBe('600');
    expect(argvLog.length).toBeGreaterThan(0);
    expect(argvLog.flat().some((arg) => arg.includes(a.reg.token))).toBe(false);
    await a.reg.release();
  }, 300_000);
});
