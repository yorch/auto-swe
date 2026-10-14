import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
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
});
