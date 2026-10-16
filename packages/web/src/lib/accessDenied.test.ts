import { describe, expect, it } from 'vitest';
import { deniedHref, deniedMessage, deniedReasonHref } from './accessDenied';

describe('access denied notice', () => {
  it('names the lowest role the page admits', () => {
    expect(deniedHref('/skills', ['ADMIN'])).toBe('/?denied=%2Fskills&need=ADMIN');
    expect(deniedHref('/admin/baselines', ['LEAD', 'ADMIN'])).toContain('need=LEAD');
  });

  it('explains which page needs which role', () => {
    expect(deniedMessage('/admin/users', 'ADMIN')).toBe(
      'You need the administrator role to open Users. Ask an administrator if you think you should have access.'
    );
  });

  it('ignores missing or off-site paths', () => {
    expect(deniedMessage(null, 'ADMIN')).toBeNull();
    expect(deniedMessage('//evil.example', 'ADMIN')).toBeNull();
    expect(deniedMessage('https://evil.example', null)).toBeNull();
  });

  it('words the usage and inactive reasons without naming a role', () => {
    expect(deniedMessage('/admin/usage', null, 'usage')).toBe(
      'You need access to usage data to open LLM usage. Ask an administrator if you think you should have access.'
    );
    expect(deniedMessage('/admin/usage', null, 'inactive')).toMatch(/waiting for approval/);
    expect(deniedReasonHref('/admin/usage', 'inactive')).toBe(
      '/?denied=%2Fadmin%2Fusage&reason=inactive'
    );
  });

  it('says nothing when the denied page is Home', () => {
    expect(deniedMessage('/', 'ADMIN')).toBeNull();
  });

  it('falls back to "this page" for a path no page claims', () => {
    expect(deniedMessage('/no/such/page', 'ADMIN')).toContain('to open this page.');
  });
});
