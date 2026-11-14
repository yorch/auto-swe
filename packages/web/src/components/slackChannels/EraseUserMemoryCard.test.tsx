// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { EraseUserMemoryCard } from './EraseUserMemoryCard';

const PATH = '/api/v1/platform/slack-channels/memory/erase-user';

beforeEach(() => {
  stubDialogPrototype();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EraseUserMemoryCard', () => {
  it('refuses an id that is not a Slack member id', () => {
    render(withQuery(<EraseUserMemoryCard />));
    fireEvent.change(screen.getByLabelText('Slack user id'), { target: { value: 'bob' } });
    expect(
      (screen.getByRole('button', { name: 'Erase memory' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('erases only after the id is typed again, and shows the count', async () => {
    const spy = setupFetchMock({
      [`POST ${PATH}`]: () => ({ data: { forgotten: 3, restored: 1 } }),
    });
    render(withQuery(<EraseUserMemoryCard />));
    fireEvent.change(screen.getByLabelText('Slack user id'), { target: { value: 'U01ABC23DEF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Erase memory' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Erase memory' })
      .at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type U01ABC23DEF to confirm'), {
      target: { value: 'U01ABC23DEF' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(bodyOf(spy, PATH)).toEqual({ slackUserId: 'U01ABC23DEF' }));
    expect(await screen.findByText(/Forgot 3 memory items/)).toBeTruthy();
  });
});
