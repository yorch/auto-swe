// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import AutonomyPoliciesPage from './page';

afterEach(() => vi.unstubAllGlobals());

describe('autonomy policies page help', () => {
  it('states the precedence and the built-in rules, and lists every risk class', () => {
    setupFetchMock({
      '/api/v1/platform/autonomy-policies': () => ({ data: [] }),
      '/api/v1/platform/teams': () => ({ data: [] }),
      '/api/v1/platform/workflow-templates': () => ({ data: [] }),
    });
    render(withQuery(<AutonomyPoliciesPage />));
    expect(
      screen.getByText(/template override, then team default, then global default/)
    ).toBeTruthy();
    expect(screen.getByText(/fails closed/)).toBeTruthy();
    for (const label of [
      'Internal read',
      'Internal write',
      'External communication',
      'Mass communication',
      'External write',
    ]) {
      expect(screen.getAllByText(`${label}:`).length).toBeGreaterThan(0);
    }
    expect(
      screen.getAllByRole('link', { name: /About autonomy policies/ })[0]?.getAttribute('href')
    ).toBe('/docs/autonomy-policies');
  });
});
