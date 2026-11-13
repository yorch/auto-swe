import type { PrismaClient } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ policy: vi.fn(), resolve: vi.fn() }));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  resolveUserCredential: m.resolve,
  resolveUserCredentialPolicy: m.policy,
}));

import { CredentialUnreadableError } from '@auto-swe/shared/lib/connectionCredential';
import { ScmProviderMismatchError } from '@auto-swe/shared/lib/githubHostScope';
import { resolveReviewerWrite } from './reviewerCredential.js';

const ARGS = { connectionId: 'conn-1', userId: 'user-1' };
const CREDENTIAL = {
  apiUrl: 'https://api.github.com',
  baseUrl: 'https://github.com',
  token: 'tok-secret',
};

function db(saved: unknown = null) {
  const findUnique = vi.fn().mockResolvedValue(saved);
  return {
    findUnique,
    prisma: { connectionCredential: { findUnique } } as unknown as PrismaClient,
  };
}

beforeEach(() => {
  m.policy.mockReset();
  m.resolve.mockReset();
  m.policy.mockResolvedValue({ enabled: true, hosts: [] });
});

describe('resolveReviewerWrite', () => {
  it("hands over the caller's own saved token when it may be used", async () => {
    m.resolve.mockResolvedValue(CREDENTIAL);
    const { prisma } = db();
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: true,
      credential: CREDENTIAL,
    });
    expect(m.resolve).toHaveBeenCalledWith(prisma, ARGS);
  });

  it('says the switch is off, whether or not a token was saved', async () => {
    m.resolve.mockResolvedValue(null);
    m.policy.mockResolvedValue({ enabled: false, hosts: [] });
    const { findUnique, prisma } = db({ id: 'cred-1' });
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: false,
      reason: 'disabled',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('says no token was saved for this repository', async () => {
    m.resolve.mockResolvedValue(null);
    const { prisma } = db(null);
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: false,
      reason: 'no-token',
    });
  });

  it('says a saved token cannot be used now when one exists but the resolver refused it', async () => {
    m.resolve.mockResolvedValue(null);
    const { findUnique, prisma } = db({ id: 'cred-1' });
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: false,
      reason: 'unusable',
    });
    expect(findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { connectionId_userId: ARGS },
    });
  });

  it('says a token that cannot be decrypted is unreadable', async () => {
    m.resolve.mockRejectedValue(new CredentialUnreadableError(new Error('bad key')));
    const { prisma } = db();
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: false,
      reason: 'unreadable',
    });
  });

  it('reads a repository another provider serves as unusable, not as a server error', async () => {
    m.resolve.mockRejectedValue(new ScmProviderMismatchError('gitlab'));
    const { findUnique, prisma } = db({ id: 'cred-1' });
    expect(await resolveReviewerWrite(prisma, ARGS)).toEqual({
      available: false,
      reason: 'unusable',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lets any other failure through, rather than reading it as a missing token', async () => {
    m.resolve.mockRejectedValue(new Error('connection refused'));
    const { prisma } = db();
    await expect(resolveReviewerWrite(prisma, ARGS)).rejects.toThrow('connection refused');
  });

  it('never carries a token in a refusal', async () => {
    m.resolve.mockResolvedValue(null);
    const { prisma } = db({ id: 'cred-1' });
    expect(JSON.stringify(await resolveReviewerWrite(prisma, ARGS))).not.toContain('tok');
  });
});
