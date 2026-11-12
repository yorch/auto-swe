import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnIfWorkspaceDnsUnreachable } from './workspaceDns.js';

/**
 * The probe is injected so these tests never touch the network; the module's
 * default probe is what a real boot runs, and it is the same `Resolver` path
 * with the same timeout.
 */
describe('warnIfWorkspaceDnsUnreachable', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('WORKSPACE_BACKEND', 'docker');
    vi.stubEnv('WORKSPACE_DNS', '10.0.0.53,10.0.0.54');
    // `logWarn` falls back to the console outside an activity, which is exactly
    // where a boot-time check runs.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('warns once, naming the configured resolvers, when none of them answers', async () => {
    const probe = vi.fn(async (_server: string): Promise<string[]> => {
      throw new Error('query timed out');
    });

    await expect(warnIfWorkspaceDnsUnreachable(probe)).resolves.toBeUndefined();

    expect(probe.mock.calls.map(([server]) => server)).toEqual(['10.0.0.53', '10.0.0.54']);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] ?? [];
    expect(message).toContain('10.0.0.53, 10.0.0.54');
    expect(message).toContain('workspace container');
    expect(message).toContain('apk add');
    expect(message).toContain('WORKSPACE_DNS');
  });

  it('stays silent when at least one resolver answers', async () => {
    const probe = vi.fn(async (server: string) => {
      if (server === '10.0.0.53') {
        throw new Error('query timed out');
      }
      return ['140.82.121.4'];
    });

    await expect(warnIfWorkspaceDnsUnreachable(probe)).resolves.toBeUndefined();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips the probe entirely on a Kubernetes backend', async () => {
    vi.stubEnv('WORKSPACE_BACKEND', 'kubernetes');
    const probe = vi.fn(async () => ['140.82.121.4']);

    await expect(warnIfWorkspaceDnsUnreachable(probe)).resolves.toBeUndefined();

    expect(probe).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws, even when the probe itself breaks', async () => {
    const probe = vi.fn(() => {
      throw new Error('bad probe');
    });

    await expect(warnIfWorkspaceDnsUnreachable(probe)).resolves.toBeUndefined();
  });
});
