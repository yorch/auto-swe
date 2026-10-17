// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import GovernAccessTokensPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const token = (over: Record<string, unknown>) => ({
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  id: 't',
  lastUsedAt: null,
  name: 'token',
  prefix: 'asw_abcd',
  revokedAt: null,
  scopes: [],
  servicePrincipal: null,
  user: { email: 'a@x.com', id: 'u1' },
  ...over,
});

const TOKENS = [
  token({ id: 't1', lastUsedAt: '2026-10-02T00:00:00.000Z', name: 'Zulu CI' }),
  token({ id: 't2', name: 'Alpha CLI' }),
  token({ id: 't3', lastUsedAt: '2026-10-05T00:00:00.000Z', name: 'Mike bot' }),
];

beforeEach(() => {
  setupFetchMock({ '/api/v1/platform/access-tokens': () => ({ data: TOKENS }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The token names in row order. */
function names(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent?.split('asw_')[0] ?? '');
}

describe('GovernAccessTokensPage', () => {
  it('keeps the API order until a heading is clicked, then sorts by it', async () => {
    render(withQuery(<GovernAccessTokensPage />));
    await screen.findByText('Zulu CI');
    expect(names()).toEqual(['Zulu CI', 'Alpha CLI', 'Mike bot']);

    fireEvent.click(screen.getByRole('button', { name: 'Token' }));
    expect(names()).toEqual(['Alpha CLI', 'Mike bot', 'Zulu CI']);
    expect(screen.getByRole('columnheader', { name: /Token/ }).getAttribute('aria-sort')).toBe(
      'ascending'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Token' }));
    expect(names()).toEqual(['Zulu CI', 'Mike bot', 'Alpha CLI']);
  });

  it('sorts a never-used token last whichever way last used is ordered', async () => {
    render(withQuery(<GovernAccessTokensPage />));
    await screen.findByText('Zulu CI');
    fireEvent.click(screen.getByRole('button', { name: 'Last used' }));
    expect(names()).toEqual(['Zulu CI', 'Mike bot', 'Alpha CLI']);
    fireEvent.click(screen.getByRole('button', { name: 'Last used' }));
    expect(names()).toEqual(['Mike bot', 'Zulu CI', 'Alpha CLI']);
  });
});
