import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { APP_PREVIEW_LAUNCHER, previewStopScript } from '../lib/appPreview.js';
import {
  extractSingleFileFromArchive,
  readSingleFileFromArchive,
} from '../lib/workspaceBackend/kubernetes/safeTar.js';
import { BrowserSession } from './session.js';

const enabled = process.env.BROWSER_DOCKER_TEST === '1';
const IMAGE = process.env.ASW_BROWSER_IMAGE ?? 'asw-executor-node-browser:ci';
let containerName: string | undefined;

function runInContainer(args: string[], input?: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', ...(input === undefined ? [] : ['-i']), containerName ?? '', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `docker exec exited ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

describe.skipIf(!enabled)('browser executor Docker smoke', () => {
  afterEach(() => {
    if (containerName) {
      try {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      } catch {
        // The daemon may already have removed the container.
      }
      containerName = undefined;
    }
  });

  function startContainer(): void {
    containerName = `asw-browser-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '--init',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=512',
        '--memory=4g',
        '--cpus=2',
        IMAGE,
        'sleep',
        'infinity',
      ],
      { stdio: 'ignore' }
    );
  }

  it('meets the executor image contract and carries the browser toolchain', async () => {
    startContainer();
    const contract = [
      'git --version',
      'tar --version',
      'rg --version',
      'sha256sum /dev/null',
      'test "$(id -u)" = 1000',
      'touch /workspace/target-repo/.probe',
      'node -e \'const p=require("playwright");require("node:fs").accessSync(p.chromium.executablePath())\'',
    ];
    for (const command of contract) {
      await expect(runInContainer(['sh', '-c', command])).resolves.toBeDefined();
    }
    // The image is an executor image: a Yarn or pnpm target repo runs its own
    // gates here, so the package managers the Node image provides must exist.
    const toolchain = await runInContainer([
      'sh',
      '-c',
      'node --version && npm --version && yarn --version && pnpm --version',
    ]);
    expect(toolchain).toMatch(/^v\d+/);
    expect(toolchain.match(/\d+\.\d+\.\d+/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('drives Chromium with workspace hardening and collects browser artifacts', async () => {
    startContainer();
    const workspace = {
      copyFileOut: async (filePath: string, maxBytes: number) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-docker-copy-'));
        const archive = path.join(dir, 'file.tar');
        const copiedPath = path.join(dir, path.basename(filePath));
        try {
          await fs.writeFile(
            archive,
            execFileSync('docker', ['cp', `${containerName}:${filePath}`, '-'], {
              maxBuffer: maxBytes + 256 * 1024,
            })
          );
          await extractSingleFileFromArchive(archive, copiedPath, maxBytes);
          const { size } = await fs.stat(copiedPath);
          return {
            cleanup: () => fs.rm(dir, { force: true, recursive: true }),
            path: copiedPath,
            sizeBytes: size,
          };
        } catch (error) {
          await fs.rm(dir, { force: true, recursive: true });
          throw error;
        }
      },
      exec: async (command: string) => runInContainer(['sh', '-c', command]),
      execStdin: async (command: string, stdin: string | Buffer) =>
        runInContainer(['sh', '-c', command], stdin),
      readFile: async (filePath: string, maxBytes: number) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-docker-test-'));
        const archive = path.join(dir, 'file.tar');
        try {
          await fs.writeFile(
            archive,
            execFileSync('docker', ['cp', `${containerName}:${filePath}`, '-'], {
              maxBuffer: maxBytes + 256 * 1024,
            })
          );
          return await readSingleFileFromArchive(archive, maxBytes);
        } finally {
          await fs.rm(dir, { force: true, recursive: true });
        }
      },
    } as unknown as Workspace;

    await runInContainer([
      'sh',
      '-c',
      `node -e ${JSON.stringify(
        'const http=require("node:http");http.createServer((_,r)=>{r.writeHead(200,{"content-type":"text/html"});r.end("<title>Browser smoke</title><main>Phase A page</main>")}).listen(8123,"127.0.0.1")'
      )} >/tmp/browser-page.log 2>&1 &`,
    ]);
    const session = await BrowserSession.start(workspace, {
      allowedHosts: ['127.0.0.1', 'localhost'],
      recordVideo: true,
      trace: true,
      viewport: { height: 480, width: 640 },
    });
    const navigation = await session.call({ cmd: 'goto', url: 'http://127.0.0.1:8123' });
    expect(navigation).toMatchObject({ ok: true, status: 200, title: 'Browser smoke' });
    const snapshot = await session.call({ cmd: 'snapshot' });
    expect(snapshot.aria).toContain('Phase A page');
    const screenshot = await session.call({ cmd: 'screenshot', modelImage: true });
    expect(screenshot.ok).toBe(true);
    const png = await session.readOutFile(String(screenshot.file), 2 * 1024 * 1024);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = await session.readOutFile(String(screenshot.modelFile), 2 * 1024 * 1024);
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegDimensions(jpeg)).toEqual({ height: 480, width: 640 });
    const blockedNavigation = await session.call({ cmd: 'goto', url: 'https://example.com' });
    expect(blockedNavigation.ok).toBe(false);
    const events = await session.call({ cmd: 'events' });
    expect(events.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'blocked', url: expect.stringContaining('example.com') }),
      ])
    );
    const files = await session.close();
    try {
      expect(files.errors).toEqual([]);
      const video = files.video ? await fs.readFile(files.video.path) : Buffer.alloc(0);
      const trace = files.trace ? await fs.readFile(files.trace.path) : Buffer.alloc(0);
      expect(video.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      expect(trace.subarray(0, 2).toString()).toBe('PK');
      const evidenceDir = process.env.ASW_BROWSER_EVIDENCE_DIR;
      if (evidenceDir) {
        await fs.mkdir(evidenceDir, { recursive: true });
        await Promise.all([
          fs.writeFile(path.join(evidenceDir, 'screenshot.png'), png),
          fs.writeFile(path.join(evidenceDir, 'screenshot.model.jpg'), jpeg),
          fs.writeFile(path.join(evidenceDir, 'recording.webm'), video),
          fs.writeFile(path.join(evidenceDir, 'trace.zip'), trace),
          fs.writeFile(
            path.join(evidenceDir, 'events.json'),
            `${JSON.stringify(events, null, 2)}\n`
          ),
        ]);
      }
    } finally {
      await Promise.all([files.video?.cleanup(), files.trace?.cleanup()]);
    }
  }, 180_000);
});

// Keep these cases here so CI's existing browser Docker step runs them.
describe.skipIf(!enabled)('app preview stop (Docker)', () => {
  afterEach(() => {
    if (containerName) {
      try {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      } catch {
        // The daemon may already have removed the container.
      }
      containerName = undefined;
    }
  });

  function containerExec(args: string[]): string {
    return execFileSync('docker', ['exec', containerName ?? '', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function containerExecDetached(args: string[]): void {
    execFileSync('docker', ['exec', '-d', containerName ?? '', ...args], { stdio: 'ignore' });
  }

  function alive(pid: string): boolean {
    try {
      containerExec(['sh', '-c', 'kill -0 "$1"', 'sh', pid]);
      return true;
    } catch {
      return false;
    }
  }

  it('stops scrubbed orphan daemons but preserves live exec processes, old daemons and init', async () => {
    containerName = `asw-preview-stop-${process.pid}`;
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--init',
        '--name',
        containerName,
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=512',
        '--memory=4g',
        '--cpus=2',
        IMAGE,
        'sh',
        '-c',
        'echo $$ >/tmp/keeper.pid; exec sleep infinity',
      ],
      { stdio: 'ignore' }
    );

    containerExec(['sh', '-c', 'setsid sh -c "sleep 300" >/dev/null 2>&1 & echo $! >/tmp/old.pid']);
    containerExec([
      'node',
      '-e',
      APP_PREVIEW_LAUNCHER,
      '--',
      `env -i PATH="$PATH" setsid sh -c 'echo $$ >/tmp/preview.pid; exec sleep 300' >/dev/null 2>&1 & sleep 300`,
      '/tmp/preview.pgid',
      '/tmp/preview.log',
      '/tmp/preview.pgid.mark',
      '/tmp/preview.pgid.since',
    ]);
    containerExecDetached(['sh', '-c', 'sleep 300 & echo $! >/tmp/live.pid; wait']);
    const pid = (file: string) => containerExec(['cat', file]).trim();
    const previewPid = pid('/tmp/preview.pid');
    const livePid = pid('/tmp/live.pid');
    const keeperPid = pid('/tmp/keeper.pid');
    const oldPid = pid('/tmp/old.pid');

    containerExec([
      'node',
      '-e',
      previewStopScript('/tmp/preview.pgid', '/tmp/preview.pgid.mark', '/tmp/preview.pgid.since'),
    ]);
    const deadline = Date.now() + 5000;
    while (alive(previewPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(alive(previewPid)).toBe(false);
    expect(alive(livePid)).toBe(true);
    expect(alive(keeperPid)).toBe(true);
    expect(alive(oldPid)).toBe(true);
  }, 30_000);
});

function jpegDimensions(buffer: Buffer): { height: number; width: number } {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new Error('Invalid JPEG marker');
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (startOfFrame.has(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error('JPEG has no frame dimensions');
}
