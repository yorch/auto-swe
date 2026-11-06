import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ToolCatalogEntry, toolInstallScript } from './toolInstall.js';

/**
 * `toolInstallScript` run in a real container hardened the way a workspace is: a non-root user,
 * every capability dropped, no privilege escalation, and a writable, exec-capable `/workspace`.
 * Opt in with TOOL_INSTALL_DOCKER_TEST=1; needs a Docker daemon and `alpine:3.22` (the image the
 * other Docker suites use).
 *
 * `file://` is not an option here (busybox `wget` cannot fetch it, and the executor images have no
 * `curl` guarantee), so the archive is served over loopback by `nc` from inside the container:
 * the same `wget` path a real download takes, with no network. The archive is built in the container
 * too, so its checksum is computed by the tools the script itself uses.
 */
const enabled = process.env.TOOL_INSTALL_DOCKER_TEST === '1';
const IMAGE = 'alpine:3.22';
const CONTAINER = `tool-install-it-${Math.random().toString(16).slice(2, 8)}`;
const PORT = 8089;

const sh = (script: string) =>
  spawnSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });

const entry = (url: string, sha256: string): ToolCatalogEntry => ({
  archs: { amd64: { sha256, url }, arm64: { sha256, url } },
  key: 'faketool',
  libc: 'any',
  member: 'faketool',
  status: 'ACTIVE',
  version: '1.0.0',
});

let archiveSha = '';
const archiveUrl = `http://127.0.0.1:${PORT}/faketool.tar.gz`;

describe.skipIf(!enabled)('toolInstallScript in a hardened container', () => {
  beforeAll(() => {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        CONTAINER,
        '--init',
        '--user',
        '1000:1000',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        // exec must be explicit: Docker mounts a tmpfs noexec unless told otherwise.
        '--tmpfs',
        '/workspace:exec,uid=1000,gid=1000,mode=755',
        IMAGE,
        'sleep',
        'infinity',
      ],
      { stdio: 'pipe' }
    );
    const prep = sh(
      [
        'set -eu',
        'mkdir -p /workspace/srv/src',
        "printf '#!/bin/sh\\necho faketool ok\\n' > /workspace/srv/src/faketool",
        'chmod 755 /workspace/srv/src/faketool',
        'tar -czf /workspace/srv/faketool.tar.gz -C /workspace/srv/src faketool',
        'sha256sum /workspace/srv/faketool.tar.gz | cut -d" " -f1',
      ].join('\n')
    );
    expect(prep.status, prep.stderr).toBe(0);
    archiveSha = prep.stdout.trim();
    expect(archiveSha).toMatch(/^[0-9a-f]{64}$/);
    // `docker exec -d` leaves the server running after the exec returns.
    execFileSync(
      'docker',
      [
        'exec',
        '-d',
        CONTAINER,
        'sh',
        '-c',
        // busybox in this image has no httpd applet: answer every connection with the same
        // canned HTTP response (headers, then the archive) using `nc`.
        'cd /workspace/srv; ' +
          'size=$(wc -c < faketool.tar.gz); ' +
          'printf "HTTP/1.0 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n" "$size" > response; ' +
          'cat faketool.tar.gz >> response; ' +
          `while :; do nc -l -p ${PORT} < response >/dev/null 2>>/workspace/httpd.log; done`,
      ],
      { stdio: 'pipe' }
    );
    // The exec returns before httpd has bound its port; wait until it answers.
    const ready = sh(
      `for i in $(seq 1 50); do wget -q -O /dev/null ${archiveUrl} && exit 0; sleep 0.1; done; exit 1`
    );
    expect(ready.status, `${ready.stderr}\n${sh('cat /workspace/httpd.log').stdout}`).toBe(0);
  }, 120_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'pipe' });
  });

  it('runs as a non-root user with no capabilities', () => {
    const out = sh('id -u; grep CapEff /proc/self/status');
    expect(out.stdout.split('\n')[0]).toBe('1000');
    expect(out.stdout).toMatch(/CapEff:\s+0+$/m);
  });

  it('installs the pinned archive into /workspace/.tools/bin and leaves nothing else', () => {
    const install = sh(toolInstallScript([entry(archiveUrl, archiveSha)]));
    expect(install.status, install.stderr).toBe(0);

    const run = sh('/workspace/.tools/bin/faketool');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('faketool ok\n');

    expect(sh('ls -A /workspace/.tools').stdout.trim()).toBe('bin');
    expect(sh('ls -A /workspace/.tools/bin').stdout.trim()).toBe('faketool');
  });

  it('refuses a wrong checksum with exit 1 and no leftovers', () => {
    sh('rm -rf /workspace/.tools');
    const install = sh(toolInstallScript([entry(archiveUrl, '0'.repeat(64))]));
    expect(install.status).toBe(1);
    expect(install.stderr).toContain('faketool@1.0.0: checksum mismatch');
    expect(sh('ls -A /workspace/.tools/bin').stdout.trim()).toBe('');
    expect(sh('ls -A /workspace/.tools').stdout.trim()).toBe('bin');
  });

  it('extracts a dash-leading member with busybox tar instead of reading it as an option', () => {
    // A second archive under a hostile member name, served by a second canned-response server.
    const prep = sh(
      [
        'set -eu',
        'mkdir -p /workspace/srv2/src',
        "printf '#!/bin/sh\\necho dash ok\\n' > /workspace/srv2/src/-evil",
        'chmod 755 /workspace/srv2/src/-evil',
        'tar -czf /workspace/srv2/dash.tar.gz -C /workspace/srv2/src -- -evil',
        'sha256sum /workspace/srv2/dash.tar.gz | cut -d" " -f1',
      ].join('\n')
    );
    expect(prep.status, prep.stderr).toBe(0);
    const sha = prep.stdout.trim();
    execFileSync(
      'docker',
      [
        'exec',
        '-d',
        CONTAINER,
        'sh',
        '-c',
        'cd /workspace/srv2; ' +
          'size=$(wc -c < dash.tar.gz); ' +
          'printf "HTTP/1.0 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n" "$size" > response; ' +
          'cat dash.tar.gz >> response; ' +
          `while :; do nc -l -p ${PORT + 1} < response >/dev/null 2>&1; done`,
      ],
      { stdio: 'pipe' }
    );
    const ready = sh(
      `for i in $(seq 1 50); do wget -q -O /dev/null http://127.0.0.1:${PORT + 1}/d && exit 0; sleep 0.1; done; exit 1`
    );
    expect(ready.status, ready.stderr).toBe(0);
    sh('rm -rf /workspace/.tools');
    const install = sh(
      toolInstallScript([
        {
          ...entry(`http://127.0.0.1:${PORT + 1}/dash.tar.gz`, sha),
          key: 'dash',
          member: '-evil',
        },
      ])
    );
    expect(install.status, install.stderr).toBe(0);
    expect(sh('/workspace/.tools/bin/dash').stdout).toBe('dash ok\n');
  });

  it('exits 75 (retryable) when the download cannot be reached', () => {
    const install = sh(
      toolInstallScript([entry('http://127.0.0.1:1/faketool.tar.gz', archiveSha)])
    );
    expect(install.status).toBe(75);
    expect(install.stderr).toContain('download failed');
  });
});
