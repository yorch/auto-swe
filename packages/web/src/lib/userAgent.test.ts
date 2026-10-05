import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './userAgent';

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome · macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0',
      'Edge · Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox · Linux'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari · iOS',
    ],
    ['curl/8.4.0', 'curl'],
    ['', 'Unknown device'],
  ])('reads %s', (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });
});
