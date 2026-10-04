// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyChannelForm } from '@/lib/slackChannelForm';
import { ChannelForm } from './ChannelForm';

vi.mock('@/hooks/useTeams', () => ({
  useTeams: () => ({ data: [{ id: 't1', name: 'Platform' }] }),
}));
vi.mock('@/hooks/useAgentLibrary', () => ({
  useAgentLibrary: () => ({
    data: [{ isActive: true, key: 'channelAssistant', name: 'Channel assistant' }],
  }),
}));

afterEach(cleanup);

const noop = () => undefined;

describe('ChannelForm', () => {
  it('shows the Slack ids only when registering', () => {
    const { rerender } = render(
      <ChannelForm errors={{}} form={emptyChannelForm()} mode="create" onChange={noop} />
    );
    expect(screen.getByLabelText(/Slack channel ID/)).toBeTruthy();
    rerender(<ChannelForm errors={{}} form={emptyChannelForm()} mode="edit" onChange={noop} />);
    expect(screen.queryByLabelText(/Slack channel ID/)).toBeNull();
  });

  it('reads an ambient schedule back in plain language', () => {
    render(
      <ChannelForm
        errors={{}}
        form={{ ...emptyChannelForm(), ambientCron: '0 9 * * 1-5', ambientEnabled: true }}
        mode="edit"
        onChange={noop}
      />
    );
    expect(screen.getByText('Runs: Weekdays at 09:00 UTC')).toBeTruthy();
  });

  it('flags a bad schedule as the person types', () => {
    render(
      <ChannelForm
        errors={{}}
        form={{ ...emptyChannelForm(), reactiveCron: '0 99 * * *', reactiveEnabled: true }}
        mode="edit"
        onChange={noop}
      />
    );
    expect(screen.getByText(/hour must be between 0 and 23/)).toBeTruthy();
  });
});
