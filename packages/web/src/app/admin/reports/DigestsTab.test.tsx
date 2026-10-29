// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { DigestsTab } from './DigestsTab';

afterEach(() => vi.unstubAllGlobals());

describe('DigestsTab', () => {
  it('renders only the manageable scopes and registered channels supplied by the API', async () => {
    setupFetchMock({
      'GET /api/v1/report-digests': () => ({
        data: {
          channels: [{ id: 'channel-1', name: 'general', orgId: 'org-1', teamId: null }],
          organizations: [{ id: 'org-1', name: 'Acme' }],
          subscriptions: [],
          teams: [{ id: 'team-1', name: 'Platform', orgId: 'org-1' }],
        },
      }),
    });
    render(withQuery(<DigestsTab />));

    expect(await screen.findByText('No digest subscriptions.')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Organization: Acme' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Team: Platform' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Digest scope'), {
      target: { value: 'ORGANIZATION:org-1' },
    });
    expect(screen.getByRole('option', { name: 'general' })).toBeTruthy();
  });
});
