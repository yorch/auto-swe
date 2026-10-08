import { describe, expect, it } from 'vitest';
import { parseRateLimitConfig } from './rateLimitConfig.js';

describe('parseRateLimitConfig', () => {
  it('keeps 200 requests per minute when nothing is set', () => {
    expect(parseRateLimitConfig({})).toEqual({ max: 200, timeWindowMs: 60_000 });
    expect(parseRateLimitConfig({ RATE_LIMIT_MAX: ' ', RATE_LIMIT_WINDOW_SECONDS: '' })).toEqual({
      max: 200,
      timeWindowMs: 60_000,
    });
  });

  it('reads both knobs, the window in seconds', () => {
    expect(
      parseRateLimitConfig({ RATE_LIMIT_MAX: '5000', RATE_LIMIT_WINDOW_SECONDS: '10' })
    ).toEqual({
      max: 5000,
      timeWindowMs: 10_000,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3', '99999999999999999999'])('refuses %s', (bad) => {
    expect(() => parseRateLimitConfig({ RATE_LIMIT_MAX: bad })).toThrow(/RATE_LIMIT_MAX/);
    expect(() => parseRateLimitConfig({ RATE_LIMIT_WINDOW_SECONDS: bad })).toThrow(
      /RATE_LIMIT_WINDOW_SECONDS/
    );
  });
});
