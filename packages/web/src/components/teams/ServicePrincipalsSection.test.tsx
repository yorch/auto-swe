// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ServicePrincipalsSection } from './ServicePrincipalsSection';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const BASE = '/api/v1/teams/t1/service-principals';

const principal = {
  connectionIds: ['r1'],
  createdAt: '2026-10-01T00:00:00Z',
  createdBy: null,
  description: 'Release pipeline',
  disabledAt: null,
  id: 'sp1',
  liveTokenCount: 0,
  maxInFlight: 5,
  maxRunsPerDay: 50,
  name: 'deployer',
  teamId: 't1',
  templateIds: [],
  updatedAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('ServicePrincipalsSection', () => {
  it('lists principals with what they may launch on', async () => {
    setupFetchMock({
      [`GET ${BASE}`]: () => ({ data: [principal] }),
      'GET /api/v1/workflow-templates': () => ({ data: [] }),
    });
    render(
      withQuery(
        <ServicePrincipalsSection repositories={[{ id: 'r1', label: 'acme/api' }]} teamId="t1" />
      )
    );
    expect(await screen.findByText('deployer')).toBeTruthy();
    expect(screen.getByText(/1 repository/)).toBeTruthy();
    expect(screen.getByText('50/day · 5 in flight')).toBeTruthy();
  });

  it('creates a principal with the repositories ticked', async () => {
    const spy = setupFetchMock({
      [`GET ${BASE}`]: () => ({ data: [] }),
      [`POST ${BASE}`]: () => ({ data: principal }),
      'GET /api/v1/workflow-templates': () => ({ data: [] }),
    });
    render(
      withQuery(
        <ServicePrincipalsSection repositories={[{ id: 'r1', label: 'acme/api' }]} teamId="t1" />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: /new principal/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'deployer' } });
    fireEvent.click(within(dialog).getByLabelText('acme/api'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));
    await waitFor(() => {
      expect(bodyOf(spy, BASE)).toMatchObject({ connectionIds: ['r1'], name: 'deployer' });
    });
  });
});
