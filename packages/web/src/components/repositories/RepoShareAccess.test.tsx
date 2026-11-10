// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RepoShareAccess } from './RepoShareAccess';

const t = (id: string, name: string) => ({ id, name, slug: id });
const repo = {
  id: 'r1',
  shares: [
    { canLaunch: true, team: t('t2', 'Platform') },
    { canLaunch: false, team: t('t3', 'Data') },
  ],
};

describe('RepoShareAccess', () => {
  beforeAll(() => stubDialogPrototype());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows each sharee with a Can launch work switch reflecting canLaunch', () => {
    render(withQuery(<RepoShareAccess repo={repo} />));
    const platform = screen.getByRole('switch', { name: 'Can launch work: Platform' });
    const data = screen.getByRole('switch', { name: 'Can launch work: Data' });
    expect(platform.getAttribute('aria-checked')).toBe('true');
    expect(data.getAttribute('aria-checked')).toBe('false');
  });

  it('defaults a share with no canLaunch to on', () => {
    render(
      withQuery(
        <RepoShareAccess repo={{ id: 'r1', shares: [{ team: t('t2', 'Platform') } as never] }} />
      )
    );
    expect(
      screen.getByRole('switch', { name: 'Can launch work: Platform' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('PATCHes the share when the switch is flipped', async () => {
    const spy = setupFetchMock({ 'PATCH /api/v1/repositories/r1/shares/t2': () => ({ data: {} }) });
    render(withQuery(<RepoShareAccess repo={repo} />));
    fireEvent.click(screen.getByRole('switch', { name: 'Can launch work: Platform' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/repositories/r1/shares/t2', 'PATCH')).toEqual({
        canLaunch: false,
      })
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: 'Can launch work: Platform' })
          .getAttribute('aria-checked')
      ).toBe('false')
    );
  });

  it('revokes by PUTting the remaining teams after a confirmation', async () => {
    const spy = setupFetchMock({ 'PUT /api/v1/repositories/r1/shares': () => ({ data: [] }) });
    const onRevoked = vi.fn();
    render(withQuery(<RepoShareAccess onRevoked={onRevoked} repo={repo} />));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Platform' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke access for Platform?' });
    expect(spy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/repositories/r1/shares', 'PUT')).toEqual({ teamIds: ['t3'] })
    );
    await waitFor(() => expect(onRevoked).toHaveBeenCalledWith('t2'));
    await waitFor(() => expect(screen.queryByText('Platform')).toBeNull());
  });

  it('renders nothing for an unshared repository', () => {
    const { container } = render(withQuery(<RepoShareAccess repo={{ id: 'r1', shares: [] }} />));
    expect(container.textContent).toBe('');
  });
});
