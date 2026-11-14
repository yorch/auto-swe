// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { GitHubApproverAppCard } from './GitHubApproverAppCard';

const PATH = '/api/v1/integrations/github-approver-app';

const configured = {
  appId: '77',
  appSlug: 'approver-bot',
  configured: true,
  privateKeyLastFour: 'WXYZ',
  retiredAppSlugs: [] as string[],
  updatedAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  stubDialogPrototype();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubApproverAppCard', () => {
  it('shows the configured App and only the last four of the key', async () => {
    setupFetchMock({ [`GET ${PATH}`]: () => configured });
    render(withQuery(<GitHubApproverAppCard />));
    expect(await screen.findByDisplayValue('approver-bot')).toBeTruthy();
    expect(screen.getByText(/Set \(…WXYZ\)/)).toBeTruthy();
    expect(screen.getByText('Configured')).toBeTruthy();
  });

  it('lists retired slugs only when there are some', async () => {
    setupFetchMock({
      [`GET ${PATH}`]: () => ({ ...configured, retiredAppSlugs: ['old-bot', 'older-bot'] }),
    });
    render(withQuery(<GitHubApproverAppCard />));
    const note = await screen.findByTestId('gh-approver-retired');
    expect(note.textContent).toContain('old-bot, older-bot');
  });

  it('shows no retired-slug note when none are kept', async () => {
    setupFetchMock({ [`GET ${PATH}`]: () => configured });
    render(withQuery(<GitHubApproverAppCard />));
    await screen.findByLabelText('App slug');
    expect(screen.queryByTestId('gh-approver-retired')).toBeNull();
  });

  it('saves only the fields that changed and never sends a blank key', async () => {
    const spy = setupFetchMock({
      [`GET ${PATH}`]: () => configured,
      [`PUT ${PATH}`]: () => configured,
    });
    render(withQuery(<GitHubApproverAppCard />));
    const slug = await screen.findByLabelText('App slug');
    fireEvent.change(slug, { target: { value: 'New-Bot' } });
    fireEvent.click(screen.getByText('Save approver App'));
    await waitFor(() => expect(bodyOf(spy, PATH, 'PUT')).toEqual({ appSlug: 'new-bot' }));
  });

  it('removes the App only after confirming', async () => {
    const spy = setupFetchMock({
      [`GET ${PATH}`]: () => configured,
      [`DELETE ${PATH}`]: () => ({}),
    });
    render(withQuery(<GitHubApproverAppCard />));
    await screen.findByLabelText('App slug');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(spy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(spy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
  });
});
