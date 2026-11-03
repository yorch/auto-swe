// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TriggersCard } from './TriggersCard';

const template = { id: 'tpl-1', name: 'ci-triage-and-fix', status: 'ACTIVE', team: null };

const event = (over: Record<string, unknown>) => ({
  canManage: true,
  enabled: true,
  id: 'a1',
  kind: 'event',
  lastActivity: null,
  name: 'CI failure',
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  source: 'github.workflow_run.failed',
  team: { id: 't1', name: 'Payments' },
  template: null,
  when: 'GitHub CI failed: any workflow',
  ...over,
});

const schedule = (over: Record<string, unknown>) => ({
  canManage: true,
  cronExpression: '0 6 * * *',
  id: 's1',
  isActive: true,
  name: 'Nightly',
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  schedule: { exists: true, paused: false },
  team: { id: 't1', name: 'Payments' },
  template: { id: 'tpl-1', name: 'ci-triage-and-fix' },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('TriggersCard', () => {
  it('lists only events and schedules that start this template, with manage links', async () => {
    setupFetchMock({
      '/api/v1/automations': () => ({
        data: [
          event({ id: 'a1', name: 'Explicit', template: { id: 'tpl-1', name: 'x' } }),
          event({ id: 'a2', name: 'Source default' }),
          event({ id: 'a3', name: 'Other template', template: { id: 'tpl-2', name: 'y' } }),
        ],
      }),
      '/api/v1/scheduled-work-requests': () => ({
        data: [
          schedule({}),
          schedule({ id: 's2', name: 'Elsewhere', template: { id: 'tpl-2', name: 'y' } }),
        ],
      }),
    });
    render(withQuery(<TriggersCard template={template} webhookConfigured />));

    expect(await screen.findByText('Explicit')).toBeTruthy();
    expect(screen.getByText('Source default')).toBeTruthy();
    expect(screen.getByText('Nightly')).toBeTruthy();
    expect(screen.queryByText('Other template')).toBeNull();
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.getByText('Signed webhook URL exists')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage automations' }).getAttribute('href')).toBe(
      '/admin/automations'
    );
    expect(screen.getByRole('link', { name: 'Manage schedules' }).getAttribute('href')).toBe(
      '/admin/schedules'
    );
  });

  it('says nothing starts it when nothing does', async () => {
    setupFetchMock({
      '/api/v1/automations': () => ({ data: [] }),
      '/api/v1/scheduled-work-requests': () => ({ data: [] }),
    });
    render(withQuery(<TriggersCard template={template} webhookConfigured={false} />));
    expect(await screen.findByText('Nothing starts this template automatically yet.')).toBeTruthy();
  });

  it('does not list default-template automations for a team template or a non-active one', async () => {
    setupFetchMock({
      '/api/v1/automations': () => ({ data: [event({ id: 'a2', name: 'Source default' })] }),
      '/api/v1/scheduled-work-requests': () => ({ data: [] }),
    });
    const teamOwned = { ...template, team: { id: 't1' } };
    const { unmount } = render(
      withQuery(<TriggersCard template={teamOwned} webhookConfigured={false} />)
    );
    expect(await screen.findByText('Nothing starts this template automatically yet.')).toBeTruthy();
    expect(screen.queryByText('Source default')).toBeNull();
    unmount();
    const draft = { ...template, status: 'DRAFT' };
    render(withQuery(<TriggersCard template={draft} webhookConfigured={false} />));
    expect(await screen.findByText('Nothing starts this template automatically yet.')).toBeTruthy();
    expect(screen.queryByText('Source default')).toBeNull();
  });

  it('notes that sources can be switched off in Platform settings', async () => {
    setupFetchMock({
      '/api/v1/automations': () => ({ data: [] }),
      '/api/v1/scheduled-work-requests': () => ({ data: [] }),
    });
    render(withQuery(<TriggersCard template={template} webhookConfigured={false} />));
    expect(
      (await screen.findByRole('link', { name: 'Platform settings' })).getAttribute('href')
    ).toBe('/admin/platform-settings');
    expect(screen.getByText(/fires only while its source is on/)).toBeTruthy();
  });

  it('still shows schedules when the automations request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/v1/automations')
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify({ data: [schedule({})] }), {
              headers: { 'content-type': 'application/json' },
              status: 200,
            })
      )
    );
    render(withQuery(<TriggersCard template={template} webhookConfigured={false} />));
    expect(await screen.findByText('Nightly')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('still shows event automations when the schedules request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/v1/automations')
          ? new Response(JSON.stringify({ data: [event({ id: 'a2', name: 'Source default' })] }), {
              headers: { 'content-type': 'application/json' },
              status: 200,
            })
          : new Response('{}', { status: 500 })
      )
    );
    render(withQuery(<TriggersCard template={template} webhookConfigured={false} />));
    expect(await screen.findByText('Source default')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows an error when the lists cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 }))
    );
    render(withQuery(<TriggersCard template={template} webhookConfigured={false} />));
    expect((await screen.findAllByRole('alert')).length).toBe(2);
  });
});
