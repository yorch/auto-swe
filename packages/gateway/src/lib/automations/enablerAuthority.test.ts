import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ allowed: true }));

vi.mock('@auto-swe/shared/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/permissions')>()),
  can: vi.fn(async () =>
    m.allowed
      ? { allowed: true, authority: 'team-role' }
      : { allowed: false, code: 'FORBIDDEN', missing: 'team.automations.manage', reason: 'no' }
  ),
}));

import { can } from '@auto-swe/shared/permissions';
import { checkEnablerAuthority, ENABLER_REASONS } from './enablerAuthority.js';

type UserRow = { isActive: boolean; role: string } | null;

function prismaWith(user: UserRow) {
  const findUnique = vi.fn(async () => user);
  return { findUnique, prisma: { user: { findUnique } } as never };
}

beforeEach(() => {
  m.allowed = true;
  vi.mocked(can).mockClear();
});

describe('checkEnablerAuthority', () => {
  it('refuses an automation nobody is recorded as having switched on', async () => {
    const { findUnique, prisma } = prismaWith(null);
    await expect(checkEnablerAuthority(prisma, null, 'team-1')).resolves.toEqual({
      ok: false,
      reason: ENABLER_REASONS.none,
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(can).not.toHaveBeenCalled();
  });

  it('refuses a person who no longer exists, without asking what they could manage', async () => {
    const { prisma } = prismaWith(null);
    await expect(checkEnablerAuthority(prisma, 'user-1', 'team-1')).resolves.toEqual({
      ok: false,
      reason: ENABLER_REASONS.inactive,
    });
    expect(can).not.toHaveBeenCalled();
  });

  it('refuses a deactivated person even when they would hold the capability', async () => {
    const { prisma } = prismaWith({ isActive: false, role: 'MEMBER' });
    await expect(checkEnablerAuthority(prisma, 'user-1', 'team-1')).resolves.toEqual({
      ok: false,
      reason: ENABLER_REASONS.inactive,
    });
    expect(can).not.toHaveBeenCalled();
  });

  it('accepts an active person who holds the capability on the managing team', async () => {
    const { prisma } = prismaWith({ isActive: true, role: 'MEMBER' });
    await expect(checkEnablerAuthority(prisma, 'user-1', 'team-9')).resolves.toEqual({ ok: true });
    expect(can).toHaveBeenCalledWith(
      prisma,
      { id: 'user-1', kind: 'user', role: 'MEMBER' },
      'team.automations.manage',
      { teamId: 'team-9' }
    );
  });

  it('refuses an active person who no longer holds it', async () => {
    m.allowed = false;
    const { prisma } = prismaWith({ isActive: true, role: 'MEMBER' });
    await expect(checkEnablerAuthority(prisma, 'user-1', 'team-1')).resolves.toEqual({
      ok: false,
      reason: ENABLER_REASONS.notLead,
    });
  });
});
