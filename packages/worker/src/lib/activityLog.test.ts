import { afterEach, describe, expect, it, vi } from 'vitest';

const { store, info, warn, error } = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  store: { current: undefined as unknown },
  warn: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  asyncLocalStorage: { getStore: () => store.current },
  log: { error, info, warn },
}));

import { auditLog, logError, logWarn } from './activityLog.js';

afterEach(() => {
  vi.restoreAllMocks();
  error.mockClear();
  info.mockClear();
  warn.mockClear();
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

describe('logWarn / logError', () => {
  it('go to the Temporal logger inside an activity', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.current = {};

    logWarn('w', { a: 1 });
    logError('e');

    expect(warn).toHaveBeenCalledWith('w', { a: 1 });
    expect(error).toHaveBeenCalledWith('e', {});
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('fall back to the console outside an activity instead of dropping the message', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    logWarn('unpriced model', { model: 'x/y' });
    logError('catalog unreadable');

    expect(consoleWarn).toHaveBeenCalledWith('unpriced model', { model: 'x/y' });
    expect(consoleError).toHaveBeenCalledWith('catalog unreadable', {});
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
