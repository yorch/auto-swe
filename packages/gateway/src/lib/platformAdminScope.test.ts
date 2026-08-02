import { isUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { describe, expect, it } from 'vitest';
import { asPlatformAdmin } from './platformAdminScope.js';

/**
 * The non-admin branch is the half that matters. `asPlatformAdmin` exists so the
 * `admin ? {} : tenantFilter` shape can declare its admin branch without
 * disabling the guard for everyone else — and it is one ternary away from
 * exempting every caller.
 */
describe('asPlatformAdmin', () => {
  it('exempts the named models for a platform admin', () => {
    const seen = asPlatformAdmin({ role: 'ADMIN' }, 'admin listing', ['Team'], () =>
      isUnscoped('Team')
    );
    expect(seen).toBe(true);
  });

  it('leaves the guard live for everyone else', () => {
    for (const role of ['USER', 'MAINTAINER', '']) {
      const seen = asPlatformAdmin({ role }, 'admin listing', ['Team'], () => isUnscoped('Team'));
      expect(seen, `role ${role || '(empty)'} must not be exempted`).toBe(false);
    }
  });

  it('exempts only the models it names, even for an admin', () => {
    const seen = asPlatformAdmin({ role: 'ADMIN' }, 'admin listing', ['Team'], () => ({
      memoryItem: isUnscoped('MemoryItem'),
      team: isUnscoped('Team'),
    }));
    expect(seen).toEqual({ memoryItem: false, team: true });
  });

  it('returns the callback result unchanged on both branches', async () => {
    await expect(asPlatformAdmin({ role: 'ADMIN' }, 'r', [], async () => 'admin')).resolves.toBe(
      'admin'
    );
    await expect(asPlatformAdmin({ role: 'USER' }, 'r', [], async () => 'user')).resolves.toBe(
      'user'
    );
  });
});
