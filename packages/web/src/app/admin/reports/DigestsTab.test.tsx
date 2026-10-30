// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { DigestsTab } from './DigestsTab';

afterEach(() => vi.unstubAllGlobals());

// jsdom implements <dialog> without showModal()/close().
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const SUBSCRIPTION = {
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
};
const DATA = {
  channels: [],
  organizations: [{ id: 'org-1', name: 'Acme' }],
  subscriptions: [SUBSCRIPTION],
  teams: [],
};

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

  it('lists the addresses a rejected create names beside the message', async () => {
    const fetchMock = setupFetchMock({});
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const rejected = method === 'POST' && url.endsWith('/api/v1/report-digests');
      return new Response(
        JSON.stringify(
          rejected
            ? {
                error: 'Recipients must be active users who belong to the subscription scope',
                offendingAddresses: ['outsider@example.test'],
              }
            : { data: { ...DATA, subscriptions: [] } }
        ),
        { headers: { 'content-type': 'application/json' }, status: rejected ? 400 : 200 }
      );
    });
    render(withQuery(<DigestsTab />));
    await screen.findByText('No digest subscriptions.');

    fireEvent.change(screen.getByLabelText('Digest scope'), {
      target: { value: 'ORGANIZATION:org-1' },
    });
    fireEvent.change(screen.getByLabelText('Email recipients'), {
      target: { value: 'outsider@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Recipients must be active users who belong to the subscription scope'
    );
    expect(within(alert).getByText('outsider@example.test').tagName).toBe('LI');
  });

  it('asks for confirmation before deleting a digest', async () => {
    const fetchMock = setupFetchMock({
      '/api/v1/report-digests': () => ({ data: DATA }),
      'DELETE /api/v1/report-digests/digest-1': () => ({}),
    });
    render(withQuery(<DigestsTab />));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    const deletes = () =>
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
      );
    expect(deletes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletes()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' })
    );
    await waitFor(() => expect(deletes()).toHaveLength(1));
  });

  it('explains a known scheduled and test error in words', async () => {
    setupFetchMock({
      '/api/v1/report-digests': () => ({
        data: {
          ...DATA,
          subscriptions: [
            {
              ...SUBSCRIPTION,
              lastError: 'recipients_out_of_scope',
              lastTestError: 'rollup_incomplete',
            },
          ],
        },
      }),
    });
    render(withQuery(<DigestsTab />));

    const alerts = (await screen.findAllByRole('alert')).map((alert) => alert.textContent);
    expect(alerts).toContain(
      'No recipient is still an active member of the digest scope, so nothing was sent.'
    );
    expect(alerts).toContain(
      'Last test delivery failed. The workflow-run rollups for this period are incomplete, so it was not built.'
    );
    expect(screen.queryByText('recipients_out_of_scope')).toBeNull();
    expect(screen.queryByText('rollup_incomplete')).toBeNull();
  });

  it('shows an error code it does not know as it is', async () => {
    setupFetchMock({
      '/api/v1/report-digests': () => ({
        data: { ...DATA, subscriptions: [{ ...SUBSCRIPTION, lastError: 'SOMETHING_NEW' }] },
      }),
    });
    render(withQuery(<DigestsTab />));

    expect((await screen.findByRole('alert')).textContent).toBe('SOMETHING_NEW');
  });
});
