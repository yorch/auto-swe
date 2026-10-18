// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlackChannel } from '@/hooks/useSlackChannels';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import { ChannelMemoryTab } from './ChannelMemoryTab';
import { ChannelOpenItemsTab } from './ChannelOpenItemsTab';

const channel = { id: 'chan-1', name: 'general' } as unknown as SlackChannel;

function mock() {
  return setupFetchMock({
    'GET /api/v1/platform/slack-channels/chan-1/memory': () => ({
      data: [
        {
          agentKey: 'channelAssistant',
          consolidatedAt: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          id: 'm1',
          lessonSummary: 'Deploys go out on Tuesdays',
          metadata: null,
          rationale: 'Agreed in standup',
        },
      ],
    }),
    'GET /api/v1/platform/slack-channels/chan-1/open-items': () => ({
      data: [
        {
          channelId: 'chan-1',
          createdAt: '2026-10-01T00:00:00.000Z',
          description: 'Rotate the staging key',
          id: 'o1',
          lastNudgedAt: null,
          ownerUserId: 'U1',
          sourceTs: null,
          status: 'OPEN',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    }),
    'GET /api/v1/users': () => ({ data: [] }),
  });
}

const as = (role: 'ADMIN' | 'ENGINEER') =>
  useAuthStore.setState({ isAuthenticated: true, user: { role, sub: 'me' } });

const paths = (spy: ReturnType<typeof setupFetchMock>) =>
  spy.mock.calls.map(
    ([url]) =>
      String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0]
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('channel tabs for someone who is not an administrator', () => {
  it('shows memory without the edit and delete menu', async () => {
    as('ENGINEER');
    mock();
    render(withQuery(<ChannelMemoryTab channel={channel} />));
    expect(await screen.findByText('Deploys go out on Tuesdays')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Actions for this memory' })).toBeNull();
  });

  it('shows open items without resolve or dismiss, and never asks for the user list', async () => {
    as('ENGINEER');
    const spy = mock();
    render(withQuery(<ChannelOpenItemsTab channel={channel} />));
    expect(await screen.findByText('Rotate the staging key')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(paths(spy)).not.toContain('/api/v1/users');
  });

  it('keeps the controls for an administrator', async () => {
    as('ADMIN');
    mock();
    render(withQuery(<ChannelMemoryTab channel={channel} />));
    expect(await screen.findByRole('button', { name: 'Actions for this memory' })).toBeTruthy();
    cleanup();
    render(withQuery(<ChannelOpenItemsTab channel={channel} />));
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeTruthy();
  });
});
