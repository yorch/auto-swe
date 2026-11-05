import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOL_CATALOG,
  classifyToolInstallFailure,
  resolveToolRequests,
  TOOLS_BIN_DIR,
  type ToolCatalogEntry,
  ToolInstallError,
  toolInstallScript,
  toolsPathEnv,
} from './toolInstall.js';

const SHA = 'a'.repeat(64);

const entry = (overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry => ({
  archs: {
    amd64: { sha256: SHA, url: 'https://example.test/just-amd64.tar.gz' },
    arm64: { sha256: SHA, url: 'https://example.test/just-arm64.tar.gz' },
  },
  key: 'just',
  libc: 'any',
  member: 'just',
  status: 'ACTIVE',
  version: '1.40.0',
  ...overrides,
});

describe('re-exports from the shared catalog', () => {
  it('keeps the names other worker code imports', () => {
    expect(BUILTIN_TOOL_CATALOG.length).toBeGreaterThan(0);
    expect(resolveToolRequests([{ key: 'just' }], [entry()])[0]?.entry.version).toBe('1.40.0');
    expect(() => resolveToolRequests([{ key: 'nope' }], [entry()])).toThrow(ToolInstallError);
  });
});

describe('classifyToolInstallFailure', () => {
  it('marks only the network exit code retryable', () => {
    expect(classifyToolInstallFailure(75, 'just@1: download failed').retryable).toBe(true);
    expect(classifyToolInstallFailure(1, 'just@1: checksum mismatch').retryable).toBe(false);
    expect(classifyToolInstallFailure(null, 'killed').retryable).toBe(false);
  });

  it('names the tool when the message does not', () => {
    expect(classifyToolInstallFailure(1, 'boom', 'just@1').message).toBe('just@1: boom');
    expect(classifyToolInstallFailure(1, 'just@1: boom', 'just@1').message).toBe('just@1: boom');
  });
});

describe('toolsPathEnv', () => {
  it('appends the tools dir after the image directories, never before', () => {
    expect(toolsPathEnv('/usr/local/bin:/usr/bin:/bin')).toBe(
      'PATH=/usr/local/bin:/usr/bin:/bin:/workspace/.tools/bin'
    );
    expect(TOOLS_BIN_DIR).toBe('/workspace/.tools/bin');
  });

  it('falls back to the standard path for an empty, relative or empty-element base path', () => {
    const standard =
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/.tools/bin';
    for (const bad of ['', ':/usr/bin', '/usr/bin::/bin', 'bin:/usr/bin', '/usr/bin:']) {
      expect(toolsPathEnv(bad), JSON.stringify(bad)).toBe(standard);
    }
  });

  it('lets a binary the image provides win over a same-named planted one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tools-path-'));
    try {
      const image = join(root, 'image-bin');
      const tools = join(root, 'tools-bin');
      mkdirSync(image);
      mkdirSync(tools);
      for (const [dir, who] of [
        [image, 'image'],
        [tools, 'planted'],
      ] as const) {
        writeFileSync(join(dir, 'git'), `#!/bin/sh\necho ${who}\n`);
        chmodSync(join(dir, 'git'), 0o755);
      }
      const pair = toolsPathEnv(image).replace(TOOLS_BIN_DIR, tools);
      const out = spawnSync('/bin/sh', ['-c', 'git'], {
        encoding: 'utf8',
        env: { PATH: pair.slice('PATH='.length) },
      });
      expect(out.stdout).toBe('image\n');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe('toolInstallScript', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-install-'));
  });
  afterEach(() => rmSync(dir, { force: true, recursive: true }));

  /** A real `.tar.gz` holding an executable `just`, and a catalog entry that points at it. */
  function fixture(sha256Override?: string, overrides: Partial<ToolCatalogEntry> = {}) {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'just'), '#!/bin/sh\necho just-ok\n');
    const archive = join(dir, 'just.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'just']);
    const sha256 =
      sha256Override ?? createHash('sha256').update(readFileSync(archive)).digest('hex');
    const download = { sha256, url: `https://example.test/file${archive}` };
    return entry({ archs: { amd64: download, arm64: download }, ...overrides });
  }

  // The script's curl insists on https only; a test server speaks http on loopback. This shim is
  // the REAL curl with `--proto`/`--proto-redir` dropped, a 1 s `--max-time`, no retries, and an
  // `https://<host>/path` URL pointed at the loopback server: everything else (status handling,
  // exit codes, timeouts) is curl's own.
  const realCurl = (() => {
    const r = spawnSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  })();
  // The server is a child process: `spawnSync` below blocks this one, which would deadlock a
  // server living in it. `/file/<abs path>` serves that file; `/<code>` answers with that status;
  // `/hang` never answers.
  let server: ChildProcess;
  let port = 0;
  beforeAll(async () => {
    const script = `
      const http = require('node:http');
      const fs = require('node:fs');
      http.createServer((req, res) => {
        if (req.url.startsWith('/hang')) return;
        if (req.url.startsWith('/file/')) {
          res.writeHead(200).end(fs.readFileSync(decodeURIComponent(req.url.slice(5))));
          return;
        }
        const code = Number.parseInt(req.url.split('/')[1], 10);
        res.writeHead(Number.isNaN(code) ? 500 : code).end('nope');
      }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
    `;
    server = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.stdout?.once('data', (chunk: Buffer) => resolve(Number.parseInt(String(chunk), 10)));
    });
  });
  afterAll(() => {
    server.kill();
  });

  function shimDir(): string {
    const shim = join(dir, 'curlshim');
    mkdirSync(shim, { recursive: true });
    writeFileSync(
      join(shim, 'curl'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$CURL_ARGS_LOG"',
        'n=$#',
        'while [ "$n" -gt 0 ]; do',
        '  a=$1; shift; n=$((n - 1))',
        '  case "$a" in',
        '    --proto|--proto-redir) shift; n=$((n - 1)) ;;',
        '    --max-time|--retry) shift; n=$((n - 1)); set -- "$@" "$a" "$([ "$a" = --max-time ] && echo 1 || echo 0)" ;;',
        '    https://*) rest=${a#https://}; set -- "$@" "http://127.0.0.1:$CURL_PORT/${rest#*/}" ;;',
        '    *) set -- "$@" "$a" ;;',
        '  esac',
        'done',
        `exec ${JSON.stringify(realCurl)} "$@"`,
      ].join('\n')
    );
    chmodSync(join(shim, 'curl'), 0o755);
    return shim;
  }

  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    CURL_ARGS_LOG: join(dir, 'curl-args.log'),
    CURL_PORT: String(port),
    PATH: `${shimDir()}${delimiter}${process.env.PATH ?? ''}`,
  });

  const run = (script: string, env: NodeJS.ProcessEnv = baseEnv()) =>
    spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env });

  const httpEntry = (path: string) =>
    entry({
      archs: {
        amd64: { sha256: SHA, url: `https://example.test${path}` },
        arm64: { sha256: SHA, url: `https://example.test${path}` },
      },
    });

  /** Run with an `ldd` shim first on PATH that reports the given libc. */
  function runWithLdd(script: string, output: string) {
    const shim = join(dir, 'shim');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'ldd'), `#!/bin/sh\necho ${JSON.stringify(output)}\n`);
    chmodSync(join(shim, 'ldd'), 0o755);
    const env = baseEnv();
    return run(script, { ...env, PATH: `${shim}${delimiter}${env.PATH ?? ''}` });
  }

  const hostHasMuslLoader = ['/lib', '/usr/lib'].some(
    (d) => existsSync(d) && readdirSync(d).some((f) => f.startsWith('ld-musl-'))
  );

  const itWithCurl = it.skipIf(realCurl === '');

  itWithCurl('is valid sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', toolInstallScript([entry()])]);
  });

  it('installs a checksum-verified executable into <dir>/bin and leaves no temp files', () => {
    const toolsDir = join(dir, 'tools');
    const result = run(toolInstallScript([fixture()], toolsDir));
    expect(result.status).toBe(0);
    expect(execFileSync(join(toolsDir, 'bin', 'just'), { encoding: 'utf8' })).toBe('just-ok\n');
    expect(readdirSync(toolsDir)).toEqual(['bin']);
  });

  it('fails naming the tool on a checksum mismatch with exit 1 (not retryable) and installs nothing', () => {
    const toolsDir = join(dir, 'tools');
    const result = run(toolInstallScript([fixture('b'.repeat(64))], toolsDir));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('auto-swe tool install: just@1.40.0: checksum mismatch');
    expect(existsSync(join(toolsDir, 'bin', 'just'))).toBe(false);
    expect(classifyToolInstallFailure(result.status, result.stderr).retryable).toBe(false);
  });

  it('exits 75 (retryable) when the download is unreachable', () => {
    // Port 1: nothing listens, so curl fails to connect.
    const result = run(toolInstallScript([httpEntry('/200/x')], join(dir, 'tools')), {
      ...baseEnv(),
      CURL_PORT: '1',
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('just@1.40.0: download failed');
    expect(classifyToolInstallFailure(result.status, result.stderr, 'just@1.40.0').retryable).toBe(
      true
    );
  });

  it('fails with exit 1 when the archive lacks the declared member', () => {
    const result = run(toolInstallScript([{ ...fixture(), member: 'other' }], join(dir, 'tools')));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archive has no other');
  });

  it('fails with exit 1 when the entry has no build for the architecture', () => {
    const result = run(toolInstallScript([entry({ archs: {} })], join(dir, 'tools')));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/just@1\.40\.0 has no (amd64|arm64) build/);
  });

  it('refuses a glibc build on a musl container, naming the tool and both libcs', () => {
    const toolsDir = join(dir, 'tools');
    const result = runWithLdd(
      toolInstallScript([fixture(undefined, { libc: 'glibc' })], toolsDir),
      'musl libc (x86_64)'
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('just@1.40.0');
    expect(result.stderr).toContain('glibc');
    expect(result.stderr).toContain('musl');
    expect(existsSync(join(toolsDir, 'bin', 'just'))).toBe(false);
    expect(classifyToolInstallFailure(result.status, result.stderr).retryable).toBe(false);
  });

  it('accepts a musl build on a musl container and an any build anywhere', () => {
    const musl = runWithLdd(
      toolInstallScript([fixture(undefined, { libc: 'musl' })], join(dir, 'a')),
      'musl libc (x86_64)'
    );
    expect(musl.status).toBe(0);
    const any = runWithLdd(
      toolInstallScript([fixture(undefined, { libc: 'any' })], join(dir, 'b')),
      'musl libc (x86_64)'
    );
    expect(any.status).toBe(0);
  });

  it.skipIf(hostHasMuslLoader)(
    'refuses a musl build on a glibc container, naming the tool and both libcs',
    () => {
      const result = runWithLdd(
        toolInstallScript([fixture(undefined, { libc: 'musl' })], join(dir, 'tools')),
        'ldd (GNU libc) 2.39'
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('just@1.40.0');
      expect(result.stderr).toContain('musl');
      expect(result.stderr).toContain('glibc');
    }
  );

  it.skipIf(hostHasMuslLoader)('accepts a glibc build on a glibc container', () => {
    const result = runWithLdd(
      toolInstallScript([fixture(undefined, { libc: 'glibc' })], join(dir, 'tools')),
      'ldd (GNU libc) 2.39'
    );
    expect(result.status).toBe(0);
  });

  it('hardens the download: https only, no downgrade on redirect, bounded time, and wget has a timeout', () => {
    const script = toolInstallScript([entry()]);
    expect(script).toContain('--connect-timeout 20');
    expect(script).toContain('--max-time 240');
    expect(script).toContain('--proto "=https" --proto-redir "=https"');
    expect(script).toContain('wget -q -T 60 -O');
    expect(script).toContain('-w "%{http_code}"');
  });

  it('clears every proxy variable before the first download', () => {
    const script = toolInstallScript([entry()]);
    const line = script.split('\n').find((l) => l.startsWith('unset '));
    expect(line).toBeDefined();
    for (const name of [
      ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
      ...['ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'],
    ]) {
      expect(line?.split(/\s+/)).toContain(name);
    }
    expect(script.indexOf('unset ')).toBeLessThan(script.indexOf('fetch() {'));
  });

  itWithCurl('downloads even when a dead proxy is in the environment', () => {
    const dead = 'http://127.0.0.1:1';
    const result = run(toolInstallScript([fixture()], join(dir, 'tools')), {
      ...baseEnv(),
      ALL_PROXY: dead,
      all_proxy: dead,
      HTTP_PROXY: dead,
      HTTPS_PROXY: dead,
      http_proxy: dead,
      https_proxy: dead,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('passes --globoff so a URL is never a glob pattern', () => {
    expect(toolInstallScript([entry()])).toContain('--globoff');
  });

  itWithCurl('sends one request for a URL with a glob range', () => {
    // Without --globoff curl expands `[1-3]` into three requests and prints three status codes
    // back to back, so the message would read `HTTP 404404404`.
    const result = run(toolInstallScript([httpEntry('/404/file[1-3]')], join(dir, 'tools')));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('just@1.40.0: HTTP 404 from example.test');
  });

  itWithCurl(
    'uses only flags the installed curl understands (not an unknown-option exit 2)',
    () => {
      const r = spawnSync(
        realCurl,
        [
          ...['-sSL', '--globoff', '--retry', '2', '--connect-timeout', '20', '--max-time', '240'],
          ...['--proto', '=https', '--proto-redir', '=https', '-o', '/dev/null'],
          ...['-w', '%{http_code}', 'file:///nonexistent'],
        ],
        { encoding: 'utf8' }
      );
      // 1 = "protocol file not supported": the options parsed, and file:// is refused.
      expect(r.status).toBe(1);
    }
  );

  describe('download failures, through the real curl against a loopback server', () => {
    const runUrl = (path: string) => run(toolInstallScript([httpEntry(path)], join(dir, 'tools')));

    itWithCurl.each([404, 403, 410])('HTTP %i is permanent: exit 1, naming the host', (code) => {
      const result = runUrl(`/${code}/secret/path?token=SECRET`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`just@1.40.0: HTTP ${code} from example.test`);
      expect(classifyToolInstallFailure(result.status, result.stderr).retryable).toBe(false);
    });

    itWithCurl.each([503, 500, 429, 408])('HTTP %i is retryable: exit 75', (code) => {
      const result = runUrl(`/${code}/x`);
      expect(result.status).toBe(75);
      expect(result.stderr).toContain(`just@1.40.0: HTTP ${code} from example.test`);
      expect(classifyToolInstallFailure(result.status, result.stderr).retryable).toBe(true);
    });

    itWithCurl('a stalled server is cut off by the time limit and is retryable', () => {
      const result = runUrl('/hang');
      expect(result.status).toBe(75);
      expect(result.stderr).toContain('just@1.40.0: download failed from example.test');
    });

    itWithCurl('never echoes the URL path, query or userinfo, only the host', () => {
      for (const url of [
        'https://example.test/secret/path?token=SECRET#frag',
        'https://user:hunter2@example.test/secret/path',
      ]) {
        const bad = entry({
          archs: { amd64: { sha256: SHA, url }, arm64: { sha256: SHA, url } },
        });
        const result = run(toolInstallScript([bad], join(dir, 'tools')), {
          ...baseEnv(),
          CURL_PORT: '1',
        });
        expect(result.status).toBe(75);
        expect(result.stderr).toContain('download failed from example.test');
        expect(result.stderr).not.toMatch(/SECRET|secret|hunter2|user:|frag|https:/);
      }
    });
  });

  it('treats every wget failure as retryable (busybox cannot report the HTTP status)', () => {
    const shim = join(dir, 'wgetshim');
    mkdirSync(shim, { recursive: true });
    // No curl on PATH, a wget that fails with exit 8.
    writeFileSync(join(shim, 'wget'), '#!/bin/sh\nexit 8\n');
    chmodSync(join(shim, 'wget'), 0o755);
    const bin = join(dir, 'minimal');
    mkdirSync(bin, { recursive: true });
    for (const tool of ['uname', 'grep', 'mktemp', 'mkdir', 'rm', 'ldd', 'sh', 'cat']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
      if (found.status === 0 && found.stdout.trim()) {
        spawnSync('ln', ['-s', found.stdout.trim(), join(bin, tool)]);
      }
    }
    const result = run(toolInstallScript([httpEntry('/x')], join(dir, 'tools')), {
      ...process.env,
      PATH: `${shim}${delimiter}${bin}`,
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('just@1.40.0: download failed from example.test');
  });

  it('puts -- before the member for tar, mv and chmod', () => {
    const script = toolInstallScript([entry({ member: '-evil' })], join(dir, 'tools'));
    expect(script).toMatch(/tar -xzf "\$tmp\/archive" -C "\$tmp" -- /);
    expect(script).toMatch(/mv -- "\$tmp"\//);
    expect(script).toMatch(/chmod -- 755 /);
  });

  itWithCurl(
    'extracts a member whose name starts with a dash instead of reading it as a tar option',
    () => {
      const src = join(dir, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, '-evil'), '#!/bin/sh\necho dash-ok\n');
      const archive = join(dir, 'dash.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', src, '--', '-evil']);
      const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
      const download = { sha256, url: `https://example.test/file${archive}` };
      const toolsDir = join(dir, 'tools');
      const result = run(
        toolInstallScript(
          [entry({ archs: { amd64: download, arm64: download }, key: 'dash', member: '-evil' })],
          toolsDir
        )
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(execFileSync(join(toolsDir, 'bin', 'dash'), { encoding: 'utf8' })).toBe('dash-ok\n');
    }
  );

  it('quotes a hostile-looking url instead of interpreting it', () => {
    const marker = join(dir, 'pwned');
    const hostile = entry({
      archs: {
        amd64: { sha256: SHA, url: `file://x'; touch ${marker}; '` },
        arm64: { sha256: SHA, url: `file://x'; touch ${marker}; '` },
      },
    });
    run(toolInstallScript([hostile], join(dir, 'tools')));
    expect(existsSync(marker)).toBe(false);
  });
});
