// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { EventEndpointsCard } from './EventEndpointsCard';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const BASE = '/api/v1/teams/t1/event-endpoints';

afterEach(() => vi.unstubAllGlobals());

function pick(trigger: RegExp, option: string) {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('NewEndpointForm', () => {
  it('requires a type pointer after a fixed-type preset is switched to a field in the body', async () => {
    const fetchSpy = setupFetchMock({
      [`GET ${BASE}`]: () => ({ data: { canManage: true, endpoints: [] } }),
      [`POST ${BASE}`]: () => ({ data: { id: 'ep-1', secret: 'whsec_once' } }),
    });
    render(withQuery(<EventEndpointsCard team={{ id: 't1', name: 'Platform' }} />));
    fireEvent.click(await screen.findByRole('button', { name: 'New endpoint' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'snyk' } });
    pick(/Start from/, 'Snyk project snapshot');
    pick(/Event type/, 'A field in the body');

    // The preset's pointer is empty: Create stays disabled and the field says why.
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText('Name the field that holds the type, e.g. /type')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Type pointer/), { target: { value: '/kind' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(await screen.findByText('whsec_once')).toBeTruthy();
    expect(bodyOf(fetchSpy, '/event-endpoints')).toMatchObject({
      fixedType: null,
      typePointer: '/kind',
    });
  });
});
