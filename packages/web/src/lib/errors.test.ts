import { describe, expect, it } from 'vitest';
import { errMsg } from './errors.js';

describe('errMsg', () => {
  it('returns the message of an Error', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });
  it('returns the fallback for a non-Error', () => {
    expect(errMsg('nope', 'Failed to save')).toBe('Failed to save');
    expect(errMsg(undefined)).toBe('Request failed');
  });
});
