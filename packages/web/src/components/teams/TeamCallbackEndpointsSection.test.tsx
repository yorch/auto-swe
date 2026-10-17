// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import {
  CallbackDeliveriesTable,
  TeamCallbackEndpointsSection,
} from './TeamCallbackEndpointsSection';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const BASE = '/api/v1/teams/t1/callback-endpoints';
const ROW = {
  acceptTemplateWebhookLaunches: false,
  allowPrivateNetwork: false,
  createdAt: '2026-10-01T00:00:00Z',
  disabled: false,
  disabledAt: null,
  events: ['run.completed'],
  id: 'ep-1',
  name: 'ci',
  origin: 'https://hooks.example.com',
  pathPrefix: '/hooks',
  previousSecretExpiresAt: null,
  secretLastFour: 'abcd',
  teamId: 't1',
  updatedAt: '2026-10-01T00:00:00Z',
};

beforeAll(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('TeamCallbackEndpointsSection', () => {
  it('lists endpoints by origin and prefix, never the secret', async () => {
    setupFetchMock({ [`GET ${BASE}`]: () => ({ data: [ROW] }) });
    render(withQuery(<TeamCallbackEndpointsSection isPlatformAdmin={false} teamId="t1" />));
    expect(await screen.findByText('https://hooks.example.com/hooks')).toBeTruthy();
    expect(screen.getByText('…abcd')).toBeTruthy();
  });

  it('creates an endpoint and shows its secret once', async () => {
    const fetchSpy = setupFetchMock({
      [`GET ${BASE}`]: () => ({ data: [] }),
      [`POST ${BASE}`]: () => ({ data: ROW, secret: 'whsec_once' }),
    });
    render(withQuery(<TeamCallbackEndpointsSection isPlatformAdmin={false} teamId="t1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'ci' } });
    fireEvent.change(screen.getByLabelText(/^Origin/), {
      target: { value: 'https://hooks.example.com' },
    });
    // Only a platform admin is offered the private-network option.
    expect(screen.queryByText('Reach a private network')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add endpoint' }).at(-1) as HTMLElement);
    expect(await screen.findByText('whsec_once')).toBeTruthy();
    expect(bodyOf(fetchSpy, '/callback-endpoints')).toMatchObject({
      // Off unless asked for: a webhook token holder is not an identity.
      acceptTemplateWebhookLaunches: false,
      allowPrivateNetwork: false,
      events: ['run.completed'],
      name: 'ci',
      origin: 'https://hooks.example.com',
    });
  });
});

describe('CallbackDeliveriesTable', () => {
  it('gives every row a Run cell, so a delivery with no run keeps its cells under their headings', () => {
    const row = {
      createdAt: '2026-10-01T00:00:00.000Z',
      deliveredAt: null,
      event: 'run.completed' as const,
      status: 'DELIVERED' as const,
      target: null,
    };
    const { container } = render(
      withQuery(
        <CallbackDeliveriesTable
          rows={[
            { ...row, id: 'with-run', workflowRunId: 'run-1' },
            { ...row, id: 'without-run' },
          ]}
          showRun
        />
      )
    );
    const headings = container.querySelectorAll('thead th').length;
    const rows = container.querySelectorAll('tbody tr');
    expect(headings).toBe(5);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll('td')).toHaveLength(headings);
    }
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toBe('/runs/run-1');
  });
});
