// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import AutonomyPoliciesPage from './page';

beforeEach(() => stubDialogPrototype());
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

  it('warns inside the editor when an external class is Auto, and asks before saving it', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/autonomy-policies': () => ({ data: [] }),
      '/api/v1/platform/teams': () => ({ data: [] }),
      '/api/v1/platform/workflow-templates': () => ({ data: [] }),
      'POST /api/v1/platform/autonomy-policies': () => ({ data: {} }),
    });
    render(withQuery(<AutonomyPoliciesPage />));
    fireEvent.click(
      (await screen.findAllByRole('button', { name: /New policy/ }))[0] as HTMLElement
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Loose' } });
    expect(within(dialog).queryByText(/removes the approval step/)).toBeNull();

    // The first rule is External communication: switch its action to Auto.
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Action/ })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('option', { name: 'Auto' }));
    expect(within(dialog).getByText(/removes the approval step/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create policy' }));
    expect(await screen.findByText('Allow messages without approval?')).toBeTruthy();
    // Nothing is sent until the confirmation is accepted.
    expect(
      spy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save with Auto' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      ).toBe(true)
    );
  });
});
