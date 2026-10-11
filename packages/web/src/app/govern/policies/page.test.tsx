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

  it('warns that auto external or mass communication skips human approval', () => {
    setupFetchMock({
      '/api/v1/platform/autonomy-policies': () => ({ data: [] }),
      '/api/v1/platform/teams': () => ({ data: [] }),
      '/api/v1/platform/workflow-templates': () => ({ data: [] }),
    });
    render(withQuery(<AutonomyPoliciesPage />));
    const heading = screen.getByText('Auto means no policy approval');
    const callout = heading.closest('[role="note"]');
    expect(callout).not.toBeNull();
    expect(heading.closest('[role="status"], [role="alert"]')).toBeNull();
    expect(callout?.textContent).toMatch(
      /External communication or Mass communication to Auto lets a run send messages outside the team, or to many people, with no policy approval/
    );
    expect(callout?.textContent).toMatch(
      /a global policy covers every run that no team or template policy matches/
    );
    expect(screen.getByRole('link', { name: /Review the decision log/ }).getAttribute('href')).toBe(
      '/docs/autonomy-policies#5-the-decision-log'
    );
  });
});
