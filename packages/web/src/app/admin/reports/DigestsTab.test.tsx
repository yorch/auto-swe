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

  it('shows the server error when Send test is rate limited', async () => {
    const data = {
      channels: [],
      organizations: [{ id: 'org-1', name: 'Acme' }],
      subscriptions: [
        {
          emailRecipients: ['reports@example.test'],
          enabled: true,
          id: 'digest-1',
          lastPeriodStart: null,
          lastTestError: null,
          optedOutEmails: [],
          organization: { id: 'org-1', name: 'Acme' },
          orgId: 'org-1',
          scope: 'ORGANIZATION',
          slackChannel: null,
          slackChannelId: null,
          team: null,
          teamId: null,
        },
      ],
      teams: [],
    };
    const fetchMock = setupFetchMock({});
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const response =
        method === 'POST' && url.includes('/send-test')
          ? {
              body: { error: 'Send-test is limited to once per minute' },
              status: 429,
            }
          : { body: { data }, status: 200 };
      return new Response(JSON.stringify(response.body), {
        headers: { 'content-type': 'application/json' },
        status: response.status,
      });
    });
    render(withQuery(<DigestsTab />));

    fireEvent.click(await screen.findByRole('button', { name: 'Send test' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Send-test is limited to once per minute'
    );
  });
});
