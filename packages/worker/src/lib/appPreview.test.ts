import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { PreviewNotReadyError, startAppPreview } from './appPreview.js';

const config = {
  env: { GREETING: "hello ' preview" },
  readyUrl: 'http://localhost:4173/health',
  start: 'npm run dev',
};

describe('startAppPreview', () => {
  let exec: ReturnType<typeof vi.fn>;
  let workspace: Workspace;

  beforeEach(() => {
    exec = vi.fn(async (command: string) => {
      if (command.includes('fetch(url')) {
        return '';
      }
      if (command.includes('const maxBytes')) {
        return 'password=secret-value\n';
      }
      return '';
    });
    workspace = { exec } as unknown as Workspace;
  });

  it('runs setup with a bounded timeout, starts a process group and returns helpers', async () => {
    const preview = await startAppPreview(
      workspace,
      { ...config, setup: 'npm ci' },
      { timeoutMs: 12_000 }
    );

    expect(preview.baseUrl).toBe('http://localhost:4173');
    expect(exec.mock.calls[0]?.[0]).toBe("sh -c 'npm ci'");
    expect(exec.mock.calls[0]?.[1]).toEqual({
      secretEnv: config.env,
      timeoutMs: 1_080_000,
    });
    expect(exec.mock.calls[1]?.[0]).toContain('nohup sh -c');
    expect(exec.mock.calls[1]?.[0]).toContain('/tmp/.asw/preview.log');
    expect(exec.mock.calls[1]?.[0]).not.toContain(config.env.GREETING);
    expect(exec.mock.calls[1]?.[1]).toEqual({ secretEnv: config.env, timeoutMs: 10_000 });
    expect(exec.mock.calls[2]?.[0]).toContain('fetch(url');
    await expect(preview.logTail(32)).resolves.toBe('password=***\n');
    await preview.stop();
    expect(exec.mock.calls.at(-1)?.[0]).toContain('process.kill(-pgid');
  });

  it('throws PreviewNotReadyError with a redacted log tail and stops the app on timeout', async () => {
    exec.mockImplementation(async (command: string) => {
      if (command.includes('fetch(url')) {
        throw new Error('workspace command timed out');
      }
      if (command.includes('const maxBytes')) {
        return 'ghp_123456789012345678901234567890123456\n';
      }
      return '';
    });

    await expect(startAppPreview(workspace, config, { timeoutMs: 1000 })).rejects.toMatchObject({
      logTail: '***\n',
      name: 'PreviewNotReadyError',
    });
    expect(exec.mock.calls.at(-1)?.[0]).toContain('process.kill(-pgid');
  });

  it('exposes the typed readiness error', () => {
    expect(new PreviewNotReadyError('not ready', 'log')).toMatchObject({
      logTail: 'log',
      name: 'PreviewNotReadyError',
    });
  });
});
