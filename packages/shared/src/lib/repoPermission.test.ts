import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';

const resolveUserCredentialPolicy = vi.fn();
const resolveUserCredential = vi.fn();
vi.mock('./connectionCredential.js', () => ({
  resolveUserCredential: (...a: unknown[]) => resolveUserCredential(...a),
  resolveUserCredentialPolicy: () => resolveUserCredentialPolicy(),
}));

const fetchOwnRepoPermission = vi.fn();
vi.mock('./githubPermission.js', () => ({
  fetchOwnRepoPermission: (...a: unknown[]) => fetchOwnRepoPermission(...a),
  fetchRepoPermission: vi.fn(),
}));

const { lookupPermissionViaUserCredential } = await import('./repoPermission.js');

const prisma = {} as PrismaClient;
const REPO = {
  githubApiUrl: 'https://ghe.corp/api/v3',
  id: 'conn-1',
  installation: null,
  organizationName: 'acme',
  repoName: 'payments',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['ghe.corp'] });
  resolveUserCredential.mockResolvedValue({
    apiUrl: 'https://ghe.corp/api/v3',
    baseUrl: 'https://ghe.corp',
    token: 'ghp_user',
  });
  fetchOwnRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
});

describe('lookupPermissionViaUserCredential', () => {
  it('asks GitHub with the token, at the host the resolver approved', async () => {
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toEqual({
      ok: true,
      permission: 'write',
    });
    expect(resolveUserCredential).toHaveBeenCalledWith(prisma, {
      connectionId: 'conn-1',
      userId: 'user-1',
    });
    expect(fetchOwnRepoPermission).toHaveBeenCalledWith({
      apiUrl: 'https://ghe.corp/api/v3',
      organizationName: 'acme',
      repoName: 'payments',
      token: 'ghp_user',
    });
  });

  it('returns null — the login path — when the policy cannot be read', async () => {
    // A settings hiccup in this feature must not refuse launches for users who
    // never saved a token; the pre-existing question still gets asked.
    resolveUserCredentialPolicy.mockRejectedValue(new Error('settings store down'));
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it('returns null while the feature is off, or with no usable credential', async () => {
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: false, hosts: [] });
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();

    resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['ghe.corp'] });
    resolveUserCredential.mockResolvedValue(null);
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('reports an unreadable credential as unanswered rather than throwing', async () => {
    // One bad row must not stop a sweep for everyone; the launch gate fails
    // closed on it, and nothing is written to the projection.
    resolveUserCredential.mockRejectedValue(new Error('No CONFIG_ENCRYPTION_KEY for version 3'));
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });
});
