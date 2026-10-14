import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisoryWarnings } from './advisoryWarnings.js';

afterEach(() => vi.restoreAllMocks());

describe('advisoryWarnings', () => {
  it('returns the computed value unchanged', async () => {
    const value = ['a finding'];
    expect(await advisoryWarnings('test', async () => value, [])).toBe(value);
    expect(await advisoryWarnings('test', async () => false, true)).toBe(false);
  });

  it.each(['rejection', 'synchronous throw'])('logs and returns fallback on %s', async (kind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback: string[] = [];
    const error = new Error('lookup failed');
    const compute = () => {
      if (kind === 'synchronous throw') {
        throw error;
      }
      return Promise.reject(error);
    };
    expect(await advisoryWarnings('agent catalog', compute, fallback)).toBe(fallback);
    expect(warn).toHaveBeenCalledWith(
      'Failed to compute agent catalog advice; using fallback',
      error
    );
  });
});
