import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    appInstallationId: '123',
    authMode: 'app',
    baseUrl: 'https://github.com',
  }),
}));

import { installationOrganizationProblem } from './installationOrganization.js';

describe('installation organization scope', () => {
  it.each([
    [null, 'org-a', false],
    ['org-a', 'org-a', false],
    ['org-a', 'org-b', true],
  ])('linked org %s and target org %s', async (organizationId, orgId, expected) => {
    const db = {
      gitHubInstallation: { findUnique: vi.fn().mockResolvedValue({ organizationId }) },
      team: { findUnique: vi.fn().mockResolvedValue({ orgId }) },
    };
    expect(await installationOrganizationProblem(db as never, 'installation', 'team')).toBe(
      expected
    );
  });
  it('does not scope a connection without an installation', async () => {
    expect(await installationOrganizationProblem({} as never, null, 'team')).toBe(false);
  });
  it('cannot bypass a linked singleton App by omitting the installation id', async () => {
    const db = {
      gitHubInstallation: { findUnique: vi.fn().mockResolvedValue({ organizationId: 'org-a' }) },
      team: { findUnique: vi.fn().mockResolvedValue({ orgId: 'org-b' }) },
    };
    expect(
      await installationOrganizationProblem(db as never, null, 'team', {
        githubApiUrl: null,
        githubUrl: null,
      })
    ).toBe(true);
    expect(db.gitHubInstallation.findUnique).toHaveBeenCalledWith({
      where: { host_installationId: { host: '', installationId: '123' } },
    });
    db.team.findUnique.mockResolvedValue({ orgId: 'org-a' });
    expect(
      await installationOrganizationProblem(db as never, null, 'team', {
        githubApiUrl: null,
        githubUrl: null,
      })
    ).toBe(false);
  });
  it('does not apply the instance singleton scope to another host', async () => {
    expect(
      await installationOrganizationProblem({} as never, null, 'team', {
        githubApiUrl: 'https://other.host/api/v3',
        githubUrl: 'https://other.host',
      })
    ).toBe(false);
  });
});
