// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { AccessTokensSection } from './AccessTokensSection';

beforeEach(stubDialogPrototype);
afterEach(() => vi.unstubAllGlobals());

describe('AccessTokensSection', () => {
  it('lists existing tokens and shows the empty-state copy when there are none', async () => {
    setupFetchMock({
      '/api/v1/auth/tokens': () => ({ data: [] }),
    });

    render(withQuery(<AccessTokensSection />));

    await waitFor(() => {
      expect(screen.getByText(/no tokens yet/i)).toBeTruthy();
    });
  });

  it('mints a token and reveals the plaintext exactly once', async () => {
    const spy = setupFetchMock({
      // List endpoint — must return an array even though we'll mint right after
      'GET /api/v1/auth/tokens': () => ({ data: [] }),
      'POST /api/v1/auth/tokens': () => ({
        data: {
          createdAt: new Date().toISOString(),
          expiresAt: null,
          id: 't-new',
          name: 'laptop',
          prefix: 'ats_abc123',
          token: 'ats_FULL_PLAINTEXT_xxxxxxxx',
        },
      }),
    });

    render(withQuery(<AccessTokensSection />));

    fireEvent.click(screen.getByRole('button', { name: /new token/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'laptop' } });
    // Default expiresInDays is 90 — leave it
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    // The reveal modal opens with the plaintext
    await waitFor(() => {
      expect(screen.getByText('ats_FULL_PLAINTEXT_xxxxxxxx')).toBeTruthy();
    });

    expect(bodyOf(spy, '/api/v1/auth/tokens', 'POST')).toEqual({
      expiresInDays: 90,
      name: 'laptop',
    });
  });
});
