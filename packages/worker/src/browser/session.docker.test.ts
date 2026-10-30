import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { readSingleFileFromArchive } from '../lib/workspaceBackend/kubernetes/safeTar.js';
import { BrowserSession } from './session.js';

const enabled = (() => {
  if (!process.env.ASW_BROWSER_IMAGE) {
    return false;
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
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

  it('drives Chromium with workspace hardening and collects browser artifacts', async () => {
    containerName = `asw-browser-test-${process.pid}`;
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
        process.env.ASW_BROWSER_IMAGE ?? '',
        'sleep',
        'infinity',
      ],
      { stdio: 'ignore' }
    );
    const workspace = {
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
    const screenshot = await session.call({ cmd: 'screenshot' });
    expect(screenshot.ok).toBe(true);
    const png = await session.readOutFile(String(screenshot.file), 2 * 1024 * 1024);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const blockedNavigation = await session.call({ cmd: 'goto', url: 'https://example.com' });
    expect(blockedNavigation.ok).toBe(false);
    const events = await session.call({ cmd: 'events' });
    expect(events.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'blocked', url: expect.stringContaining('example.com') }),
      ])
    );
    const files = await session.close();
    expect(files.video?.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(files.trace?.subarray(0, 2).toString()).toBe('PK');
    const evidenceDir = process.env.ASW_BROWSER_EVIDENCE_DIR;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(evidenceDir, 'screenshot.png'), png),
        fs.writeFile(path.join(evidenceDir, 'recording.webm'), files.video ?? Buffer.alloc(0)),
        fs.writeFile(path.join(evidenceDir, 'trace.zip'), files.trace ?? Buffer.alloc(0)),
        fs.writeFile(path.join(evidenceDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`),
      ]);
    }
  }, 180_000);
});
