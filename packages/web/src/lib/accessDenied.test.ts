import { describe, expect, it } from 'vitest';
import { deniedHref, deniedMessage } from './accessDenied';

describe('access denied notice', () => {
  it('names the lowest role the page admits', () => {
    expect(deniedHref('/studio/skills', ['ADMIN'])).toBe('/?denied=%2Fstudio%2Fskills&need=ADMIN');
    expect(deniedHref('/govern/baselines', ['LEAD', 'ADMIN'])).toContain('need=LEAD');
  });

  it('explains which page needs which role', () => {
    expect(deniedMessage('/govern/users', 'ADMIN')).toBe(
      'You need the administrator role to open Users. Ask an administrator if you think you should have access.'
    );
  });

  it('ignores missing or off-site paths', () => {
    expect(deniedMessage(null, 'ADMIN')).toBeNull();
    expect(deniedMessage('//evil.example', 'ADMIN')).toBeNull();
    expect(deniedMessage('https://evil.example', null)).toBeNull();
  });
});
