// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/hooks/useSlackChannels', () => ({
  useSlackChannel: (id: string) => ({
    data: { id, isActive: true, name: 'general', workspace: { name: 'Acme' } },
    error: null,
    isError: false,
    isLoading: false,
  }),
}));
vi.mock('@/components/slackChannels/ChannelSettingsTab', async () => {
  const { useState } = await import('react');
  return {
    ChannelSettingsTab: () => {
      const [value, setValue] = useState('');
      return <input aria-label="Draft" onChange={(e) => setValue(e.target.value)} value={value} />;
    },
  };
});
vi.mock('@/components/slackChannels/ChannelMemoryTab', () => ({
  ChannelMemoryTab: () => <p>memory tab</p>,
}));
vi.mock('@/components/slackChannels/ChannelOpenItemsTab', () => ({
  ChannelOpenItemsTab: () => <p>open items tab</p>,
}));
vi.mock('@/components/slackChannels/ChannelActivityTab', () => ({
  ChannelActivityTab: () => <p>activity tab</p>,
}));

import SlackChannelDetailPage from './page';

beforeEach(() => resetNavigation('', `/govern/slack-channels/${ID}`));

// `use()` needs a promise whose identity is stable across renders.
const PARAMS = Promise.resolve({ id: ID });

const renderPage = () =>
  act(async () => {
    render(
      withQuery(
        <Suspense fallback={null}>
          <SlackChannelDetailPage params={PARAMS} />
        </Suspense>
      )
    );
  });

describe('SlackChannelDetailPage tabs', () => {
  it('keeps an unsaved settings draft while another tab is open, and puts the tab in the URL', async () => {
    await renderPage();
    const draft = (await screen.findByLabelText('Draft')) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'half-typed' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(nav.replace.at(-1)).toContain('tab=memory');
    expect(await screen.findByText('memory tab')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('half-typed');
  });

  it('opens the tab named in the URL', async () => {
    resetNavigation('tab=activity', `/govern/slack-channels/${ID}`);
    await renderPage();
    expect(await screen.findByText('activity tab')).toBeTruthy();
  });
});
