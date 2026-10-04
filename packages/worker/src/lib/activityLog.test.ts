import { afterEach, describe, expect, it, vi } from 'vitest';

const { store, info } = vi.hoisted(() => ({
  info: vi.fn(),
  store: { current: undefined as unknown },
}));

vi.mock('@temporalio/activity', () => ({
  asyncLocalStorage: { getStore: () => store.current },
  log: { error: vi.fn(), info, warn: vi.fn() },
}));

import { auditLog } from './activityLog.js';

afterEach(() => {
  vi.restoreAllMocks();
  info.mockClear();
  store.current = undefined;
});

describe('auditLog', () => {
  it('writes the line to stdout and, inside an activity, to the Temporal logger', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    store.current = {};

    auditLog('[bash:audit] container=c cmd="ls"');

    expect(out).toHaveBeenCalledWith('[bash:audit] container=c cmd="ls"');
    expect(info).toHaveBeenCalledWith('[bash:audit] container=c cmd="ls"', { audit: true });
  });

  it('is only the stdout line outside an activity', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});

    auditLog('[mcp:audit] x');

    expect(out).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });
});
