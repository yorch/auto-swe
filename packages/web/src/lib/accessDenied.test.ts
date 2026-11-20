import { describe, expect, it } from 'vitest';
import { deniedHref, deniedMessage, deniedReasonHref } from './accessDenied';

describe('access denied notice', () => {
  it('names what the page needs', () => {
    expect(deniedHref('/skills', 'platform-admin')).toBe('/?denied=%2Fskills&need=platform-admin');
    expect(deniedHref('/admin/baselines', 'org.baselines.read')).toContain(
      'need=org.baselines.read'
    );
  });

  it('explains which page needs the platform admin role', () => {
    expect(deniedMessage('/admin/users', 'platform-admin')).toBe(
      'You need the platform admin role to open Users. Ask an administrator if you think you should have access.'
    );
  });

  it('never echoes the attacker-controllable `need` value', () => {
    expect(deniedMessage('/admin/users', '<script>')).toBe(
      'You need more access to open Users. Ask an administrator if you think you should have access.'
    );
  });

  it('ignores missing or off-site paths', () => {
    expect(deniedMessage(null, 'platform-admin')).toBeNull();
    expect(deniedMessage('//evil.example', 'platform-admin')).toBeNull();
    expect(deniedMessage('https://evil.example', null)).toBeNull();
  });

  it('words the usage and inactive reasons without naming a role', () => {
    expect(deniedMessage('/insights/usage', null, 'usage')).toBe(
      'You need access to usage data to open LLM usage. Ask an administrator if you think you should have access.'
    );
    expect(deniedMessage('/insights/usage', null, 'inactive')).toMatch(/waiting for approval/);
    expect(deniedReasonHref('/insights/usage', 'inactive')).toBe(
      '/?denied=%2Finsights%2Fusage&reason=inactive'
    );
  });

  it('says nothing when the denied page is Home', () => {
    expect(deniedMessage('/', 'platform-admin')).toBeNull();
  });

  it('falls back to "this page" for a path no page claims', () => {
    expect(deniedMessage('/no/such/page', 'platform-admin')).toContain('to open this page.');
  });
});
