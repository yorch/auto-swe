// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import TeamsPage from './page';

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ user: { role: 'USER', sub: 'me' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the server says the person holds: a platform capability, or one in organization `o1`. */
const answer = (opts: { admin?: boolean; orgCapabilities?: readonly string[] }) => ({
  organizations: opts.orgCapabilities
    ? [
        {
          capabilities: opts.orgCapabilities.map((key) => ({ authority: 'org-admin', key })),
          name: 'Acme',
          orgId: 'o1',
          role: '',
        },
      ]
    : [],
  platformCapabilities: opts.admin ? ['platform.users.manage'] : [],
  platformRole: '',
  teams: [],
});

describe('team creation gate', () => {
  it.each([
    ['a platform admin', { admin: true }, true],
    ['an org admin', { orgCapabilities: ['org.teams.create'] }, true],
    ['an org member', { orgCapabilities: ['org.read'] }, false],
    ['a person in no organization', {}, false],
  ] as const)('%s: creation=%s', async (_who, perms, allowed) => {
    const organizations = { data: 'orgCapabilities' in perms ? [{ id: 'o1', name: 'Acme' }] : [] };
    setupFetchMock({
      '/api/v1/me/permissions': () => answer(perms),
      '/api/v1/platform/organizations': () => organizations,
      '/api/v1/platform/organizations/budget-alerts': () => organizations,
      '/api/v1/teams': () => ({ data: [] }),
    });
    render(withQuery(<TeamsPage />));
    await screen.findByText('No teams yet');
    if (allowed) {
      expect((await screen.findAllByRole('button', { name: 'New team' })).length).toBeGreaterThan(
        0
      );
    } else {
      // Let the permissions answer before asserting that nothing was offered.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
    }
  });
});
