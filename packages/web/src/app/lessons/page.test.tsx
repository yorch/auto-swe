// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { withQuery } from '@/test/rtl-helpers';
import LessonsRedirect from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
});
afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('LessonsRedirect (non-admin view)', () => {
  it('defines a lesson and links to the concepts doc', () => {
    render(withQuery(<LessonsRedirect />));

    expect(
      screen.getByText(
        'A lesson is what a finished run learned, reused as context on later runs for the same repository.',
        { exact: false }
      )
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /what is a lesson/i }).getAttribute('href')).toBe(
      '/docs/concepts#agents'
    );
  });
});
