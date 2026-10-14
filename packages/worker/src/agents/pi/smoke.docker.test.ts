import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runSmoke, type SmokeOptions, scriptedModel } from './smoke.js';

/**
 * The Pi smoke tool against a real container: the scripted `--mock` model, the
 * built-in scanner patterns (no database), the report, the trace file and the
 * container's removal. No API key or network beyond the image.
 *
 * Needs Docker and the `node:24-alpine` image; `PI_DOCKER_TEST_IMAGE` names
 * another image with a POSIX shell.
 *
 *   PI_DOCKER_TEST=1 yarn vitest run packages/worker/src/agents/pi/smoke.docker.test.ts
 */
const enabled = process.env.PI_DOCKER_TEST === '1';
const IMAGE = process.env.PI_DOCKER_TEST_IMAGE || 'node:24-alpine';

const run = promisify(execFile);
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-smoke-test-'));
  dirs.push(dir);
  return dir;
}

async function options(overrides: Partial<SmokeOptions> = {}): Promise<SmokeOptions> {
  const work = await tempDir();
  const repo = path.join(work, 'src-repo');
  await run('mkdir', ['-p', repo]);
  await writeFile(path.join(repo, 'README.md'), '# A tiny repository\n');
  return {
    deadlineSeconds: 120,
    dir: repo,
    image: IMAGE,
    maxSteps: 8,
    mock: true,
    model: 'anthropic/claude-sonnet-5-5',
    noDbScanners: true,
    prompt: 'go',
    traceFile: path.join(work, 'trace.json'),
    ...overrides,
  };
}

async function leftoverContainers(): Promise<string> {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', 'name=workspace-smoke-']);
  return stdout.trim();
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

describe.skipIf(!enabled)('the Pi smoke tool against a real container', () => {
  it('runs the scripted turn end to end, reports it, writes the trace and removes the container', async () => {
    const opts = await options();

    const { report } = await runSmoke(opts);

    expect(report.error).toBeUndefined();
    expect(report.scannerSource).toBe('built-in patterns (--no-db-scanners)');
    expect(report.toolCalls.map((c) => [c.name, c.decision])).toEqual([
      ['write', 'ok'],
      ['bash', 'ok'],
    ]);
    expect(report.modelCalls).toHaveLength(3);
    expect(report.modelCalls.every((m) => m.inputTokens === 1000 && m.outputTokens === 50)).toBe(
      true
    );
    expect(report.costUsd).toBeGreaterThan(0);
    expect(report.text).toBe('Wrote SMOKE.md and confirmed it with cat.');
    expect(report.diffStat).toContain('SMOKE.md');
    expect(report.diffStat).not.toContain('README.md');

    const trace = JSON.parse(await readFile(opts.traceFile as string, 'utf8'));
    expect(trace.diff).toContain('+A mock repository written by the Pi smoke run.');
    expect(trace.toolCalls).toHaveLength(2);
    expect(await leftoverContainers()).toBe('');
  }, 120_000);

  it('applies the built-in sensitive-file and shell patterns to the turn', async () => {
    const opts = await options({
      languageModel: scriptedModel([
        {
          calls: [
            { input: { content: 'SECRET=1\n', path: '.env' }, name: 'write' },
            { input: { command: 'echo token > .env' }, name: 'bash' },
            { input: { content: 'ok\n', path: 'fine.txt' }, name: 'write' },
          ],
        },
        { text: 'done' },
      ]),
    });

    const { report } = await runSmoke(opts);

    expect(report.toolCalls.map((c) => c.decision)).toEqual(['blocked', 'blocked', 'ok']);
    expect(report.diffStat).toContain('fine.txt');
    expect(report.diffStat).not.toContain('.env');
    expect(await leftoverContainers()).toBe('');
  }, 120_000);

  it('leaves no container when setup fails', async () => {
    const opts = await options({ dir: '/nonexistent/pi-smoke' });

    await expect(runSmoke(opts)).rejects.toThrow();

    expect(await leftoverContainers()).toBe('');
  }, 60_000);

  it('never runs the copied-back .git: a planted fsmonitor and hook have no host effect', async () => {
    const opts = await options();
    const marker = path.join(path.dirname(opts.traceFile as string), 'host-ran-fsmonitor');
    const hookMarker = path.join(path.dirname(opts.traceFile as string), 'host-ran-hook');
    const plant =
      `cd .git && printf '[core]\\n\\tfsmonitor = "touch ${marker}; false"\\n' >> config && ` +
      `printf '#!/bin/sh\\ntouch ${hookMarker}\\n' > hooks/pre-commit && { chmod +x hooks/pre-commit || true; }`;
    opts.languageModel = scriptedModel([
      { calls: [{ input: { command: plant }, name: 'bash' }] },
      { calls: [{ input: { content: 'ok\n', path: 'fine.txt' }, name: 'write' }] },
      { text: 'done' },
    ]);

    const { report } = await runSmoke(opts);

    // The plant must have run in the container, or the host checks below prove nothing.
    expect(report.toolCalls[0]?.decision).toBe('ok');
    await expect(access(marker)).rejects.toThrow();
    await expect(access(hookMarker)).rejects.toThrow();
    expect(report.diffStat).toContain('fine.txt');
    expect(report.diffStat).not.toContain('.git');
  }, 120_000);

  it("diffs against a baseline of its own: a dirty --dir's earlier changes are not the agent's, and its repository is untouched", async () => {
    const opts = await options();
    const repo = opts.dir as string;
    const host = (args: string[]) =>
      run('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: 'a@b.c',
          GIT_AUTHOR_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@b.c',
          GIT_COMMITTER_NAME: 'a',
        },
      });
    await host(['init', '-q']);
    await host(['add', '-A']);
    await host(['commit', '-q', '-m', 'init']);
    await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted\n');
    const before = (await host(['status', '--porcelain'])).stdout;

    const { report } = await runSmoke(opts);

    expect(report.diffStat).toContain('SMOKE.md');
    expect(report.diffStat).not.toContain('dirty.txt');
    expect((await host(['status', '--porcelain'])).stdout).toBe(before);
  }, 120_000);

  it('leaves .env files out of the container unless asked, but keeps templates', async () => {
    const listing = async (includeEnv: boolean) => {
      const opts = await options({ includeEnv });
      await writeFile(path.join(opts.dir as string, '.env'), 'SECRET=1\n');
      await writeFile(path.join(opts.dir as string, '.env.example'), 'SECRET=\n');
      opts.languageModel = scriptedModel([
        { calls: [{ input: { command: 'ls -A' }, name: 'bash' }] },
        { text: 'done' },
      ]);
      const { trace } = await runSmoke(opts);
      return String(
        (trace as { toolCalls: { outputJson: unknown }[] }).toolCalls[0]?.outputJson
      ).split('\n');
    };

    const without = await listing(false);
    expect(without).toContain('.env.example');
    expect(without).not.toContain('.env');
    expect(await listing(true)).toContain('.env');
  }, 120_000);

  it('removes a container that was created but failed to start', async () => {
    const opts = await options({ containerCommand: ['/no-such-binary'] });

    await expect(runSmoke(opts)).rejects.toThrow();

    expect(await leftoverContainers()).toBe('');
  }, 60_000);

  it('removes the container and the temporary files on SIGINT, then exits 130', async () => {
    const opts = await options();
    const signals = new EventEmitter();
    const exit = vi.fn();
    opts.signals = signals;
    opts.exit = exit;
    opts.languageModel = scriptedModel([
      { calls: [{ input: { command: 'sleep 300' }, name: 'bash' }] },
      { text: 'done' },
    ]);
    const runDirs = async () =>
      (await run('ls', [tmpdir()])).stdout
        .split('\n')
        .filter((n) => n.startsWith('pi-smoke-') && !n.startsWith('pi-smoke-test-'));
    const before = await runDirs();
    setTimeout(() => signals.emit('SIGINT'), 5000);

    const started = Date.now();
    await runSmoke(opts).catch(() => undefined);

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(exit).toHaveBeenCalledWith(130);
    expect(await leftoverContainers()).toBe('');
    expect((await runDirs()).filter((n) => !before.includes(n))).toEqual([]);
  }, 120_000);

  it('exits and removes the container when a second signal follows the first', async () => {
    const opts = await options();
    const signals = new EventEmitter();
    const exit = vi.fn();
    opts.signals = signals;
    opts.exit = exit;
    opts.languageModel = scriptedModel([
      { calls: [{ input: { command: 'sleep 300' }, name: 'bash' }] },
      { text: 'done' },
    ]);
    setTimeout(() => {
      signals.emit('SIGINT');
      signals.emit('SIGTERM');
    }, 5000);

    await runSmoke(opts).catch(() => undefined);

    expect(exit).toHaveBeenCalledWith(130);
    expect(exit).toHaveBeenCalledWith(143);
    expect(await leftoverContainers()).toBe('');
  }, 120_000);

  it('cannot be pointed at a host directory by a symlink at the checkout path', async () => {
    const opts = await options();
    const hostDir = path.join(path.dirname(opts.traceFile as string), 'host-secret-dir');
    await mkdir(hostDir);
    await writeFile(path.join(hostDir, 'host-secret.txt'), 'HOST-SECRET-CONTENT\n');
    opts.languageModel = scriptedModel([
      {
        calls: [
          {
            input: {
              command: `cd /workspace && rm -rf target-repo && ln -s ${hostDir} target-repo`,
            },
            name: 'bash',
          },
        ],
      },
      { text: 'done' },
    ]);

    const { report, trace } = await runSmoke(opts);

    expect(report.toolCalls[0]?.error ?? '').not.toContain('not found');
    const everything = JSON.stringify({ report, trace });
    expect(everything).not.toContain('host-secret.txt');
    expect(everything).not.toContain('HOST-SECRET-CONTENT');
    expect(await leftoverContainers()).toBe('');
  }, 120_000);

  describe('a real SIGINT to the process', () => {
    const smokeDirs = async () =>
      (await run('ls', [tmpdir()])).stdout
        .split('\n')
        .filter((n) => n.startsWith('pi-smoke-') && !n.startsWith('pi-smoke-test-'));

    /** Runs the harness and sends SIGINT once its output contains `when`, plus `delayMs`. */
    async function interruptedRun(when: string, delayMs: number) {
      const opts = await options();
      const before = await smokeDirs();
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          path.resolve(import.meta.dirname, '../../../scripts/piSmokeSignalHarness.ts'),
        ],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          env: {
            ...process.env,
            PI_SMOKE_HARNESS_DIR: opts.dir,
            PI_SMOKE_HARNESS_IMAGE: IMAGE,
          },
        }
      );
      let output = '';
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      let sent = false;
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (!sent && output.includes(when)) {
          sent = true;
          setTimeout(() => child.kill('SIGINT'), delayMs);
        }
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      // The child's output rides in every assertion message, so a CI failure says why.
      return { before, code, output, sent };
    }

    it('mid-turn removes the container and the temporary directory, and exits 130', async () => {
      const { before, code, output, sent } = await interruptedRun('Running the turn', 3000);

      expect(sent, output).toBe(true);
      expect(output).toContain('SIGINT: removing the container');
      expect(code, output).toBe(130);
      expect(await leftoverContainers()).toBe('');
      expect((await smokeDirs()).filter((n) => !before.includes(n))).toEqual([]);
    }, 120_000);

    it('while the container is starting leaves no running container', async () => {
      const { before, code, output, sent } = await interruptedRun(
        'Starting a workspace container',
        0
      );

      expect(sent, output).toBe(true);
      expect(code, output).toBe(130);
      expect(await leftoverContainers()).toBe('');
      expect((await smokeDirs()).filter((n) => !before.includes(n))).toEqual([]);
    }, 120_000);
  });
});
