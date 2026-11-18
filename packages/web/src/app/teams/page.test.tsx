// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import TeamsPage from './page';

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('team creation gate', () => {
  it.each([
    ['ADMIN', null, true],
    ['ENGINEER', 'ORG_ADMIN', true],
    ['LEAD', 'ORG_ADMIN', true],
    ['LEAD', 'ORG_MEMBER', false],
    ['ENGINEER', null, false],
  ] as const)('platform %s / org %s creation=%s', async (role, orgRole, allowed) => {
    useAuthStore.setState({ user: { role, sub: 'me' } });
    const organizations = { data: orgRole ? [{ id: 'o1', name: 'Acme', role: orgRole }] : [] };
    setupFetchMock({
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
      expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
    }
  });
});
