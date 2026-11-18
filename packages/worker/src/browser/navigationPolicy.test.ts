import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { navigationRefusal } from './navigationPolicy.js';

const REFUSED = [
  'file:///etc/passwd',
  'chrome://settings',
  'view-source:https://example.com/',
  'javascript:alert(1)',
  'ftp://example.com/x',
  'data:text/html,<script>1</script>',
  'blob:https://example.com/0000',
  'not a url',
];
const ALLOWED = ['http://localhost:3000/', 'https://example.com/a?b=1', 'about:blank'];

describe('navigationRefusal', () => {
  it.each(REFUSED)('refuses %s', (url) => {
    expect(navigationRefusal(url)).toEqual(expect.any(String));
  });
  it.each(ALLOWED)('allows %s', (url) => {
    expect(navigationRefusal(url)).toBeNull();
  });
});

/**
 * The driver is the check that holds when a caller skips the tool layer. It runs here for real,
 * against a stand-in `playwright` that records every `page.goto`.
 */
describe('the browser driver refuses the same URLs itself', () => {
  let dir: string;
  const driverPath = () => path.join(dir, 'driver.mjs');
  const socket = () => path.join(dir, 's.sock');

  const node = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, args, { cwd: dir });
      let stdout = '';
      child.stdout.on('data', (c) => {
        stdout += c;
      });
      child.on('close', (code) => resolve({ code, stdout }));
    });
  const call = async (command: object) =>
    JSON.parse(
      (await node([driverPath(), 'call', '--socket', socket(), JSON.stringify(command)])).stdout
    ) as { error?: string; ok: boolean };
  const gotos = async () =>
    (await readFile(path.join(dir, 'gotos.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'driver-nav-'));
    await mkdir(path.join(dir, 'node_modules', 'playwright'), { recursive: true });
    await writeFile(
      path.join(dir, 'node_modules', 'playwright', 'index.js'),
      `const fs = require('node:fs');
const page = {
  on() {}, video: () => null, title: async () => 't', url: () => 'about:blank',
  goto: async (u) => { fs.appendFileSync(${JSON.stringify(path.join(dir, 'gotos.log'))}, u + '\\n'); return { status: () => 200 }; },
  setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
};
const context = { route: async () => {}, newPage: async () => page, close: async () => {}, tracing: {} };
exports.chromium = { launch: async () => ({ newContext: async () => context, close: async () => {} }) };
`
    );
    await writeFile(driverPath(), await readFile(new URL('./driver.mjs', import.meta.url), 'utf8'));
    const child = spawn(
      process.execPath,
      [
        driverPath(),
        'serve',
        '--socket',
        socket(),
        '--out',
        path.join(dir, 'out'),
        '--config',
        JSON.stringify({ allowedHosts: ['example.com'], scratch: true }),
      ],
      { cwd: dir, detached: true, stdio: 'ignore' }
    );
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (
        await readFile(socket()).then(
          () => true,
          (e: NodeJS.ErrnoException) => e.code !== 'ENOENT'
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(async () => {
    await call({ cmd: 'close' }).catch(() => {});
    await rm(dir, { force: true, recursive: true });
  });

  it.each(REFUSED)('refuses %s and never calls page.goto', async (url) => {
    const out = await call({ cmd: 'goto', url });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/scheme|valid/);
    expect(await gotos()).not.toContain(url);
  });

  it.each(ALLOWED)('still navigates to %s', async (url) => {
    expect((await call({ cmd: 'goto', url })).ok).toBe(true);
    expect(await gotos()).toContain(url);
  });
});
