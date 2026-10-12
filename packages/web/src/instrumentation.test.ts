import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/docs', () => ({ loadDocSearchIndex: load }));

import { register } from './instrumentation';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('register', () => {
  beforeEach(() => {
    load.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('starts the docs index build on the Node.js runtime, without waiting for it', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    load.mockReturnValue(new Promise(() => {})); // never settles
    expect(register()).toBeUndefined();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('logs once when the index is ready', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    load.mockResolvedValue({ docs: [{}, {}], sections: [{}, {}, {}] });
    register();
    await flush();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/index ready: 2 docs, 3 sections, \d+ ms/);
  });

  it('does not log readiness when the build fails', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    load.mockRejectedValue(new Error('no docs'));
    register();
    await flush();
    expect(info).not.toHaveBeenCalled();
  });

  it('does nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    register();
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it('logs a failed build instead of throwing', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    load.mockRejectedValue(new Error('no docs'));
    expect(() => register()).not.toThrow();
    await flush();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
