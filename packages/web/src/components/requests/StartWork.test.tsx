// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

const auth = vi.hoisted(() => ({ role: 'ENGINEER' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: auth.role } }),
}));
vi.mock('@/components/requests/WorkflowLaunchForm', () => ({ WorkflowLaunchForm: () => null }));
vi.mock('@/components/agentRuns/AgentRunForm', () => ({
  AgentRunForm: () => <div>agent form</div>,
}));

import { StartWork } from './StartWork';

function gateway() {
  setupFetchMock({
    'GET /api/v1/epics': () => ({ data: [], meta: { limit: 50, offset: 0, total: 0 } }),
    'GET /api/v1/repositories': () => ({ data: [] }),
    'GET /api/v1/workflow-templates': () => ({ data: [] }),
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StartWork', () => {
  it('disables the epic option below lead and says why', () => {
    auth.role = 'ENGINEER';
    gateway();
    render(withQuery(<StartWork />));
    const radio = screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText('Needs a team lead or administrator.')).toBeTruthy();
  });

  it('starts in the requested mode', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork initialMode="agent" />));
    expect((screen.getByRole('radio', { name: /run an agent/i }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it('warns when the requested workflow cannot be run', async () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork initialTemplateId="missing" />));
    expect(await screen.findByText(/not available to run/i)).toBeTruthy();
  });

  it('shows the what-happens-next aside at every breakpoint', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    const aside = screen.getByLabelText('What happens next');
    expect(aside.className).not.toContain('hidden');
    expect(screen.getByText('Running a workflow')).toBeTruthy();
  });

  it('helps choose between a workflow, an agent and an epic', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    expect(screen.getByText('Not sure?')).toBeTruthy();
    expect(screen.getByText('How auto-swe works')).toBeTruthy();
  });

  it('never promises a draft pull request or a per-repository request in the side rail', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    for (const mode of [/Run a workflow/, /Run an agent/, /multi-repo epic/]) {
      fireEvent.click(screen.getByRole('radio', { name: mode }));
      const text = screen.getByLabelText('What happens next').textContent ?? '';
      // An agent run may deliver a draft pull request by choice; workflows and epics never promise one.
      if (!/Run an agent/.test(String(mode))) {
        expect(text).not.toMatch(/draft/i);
      }
    }
    fireEvent.click(screen.getByRole('radio', { name: /multi-repo epic/ }));
    const epic = screen.getByLabelText('What happens next').textContent ?? '';
    expect(epic).toMatch(/one run per repository/);
    expect(epic).not.toMatch(/draft/i);
  });
});
