// @vitest-environment jsdom

import type { PullRequestCockpit, PullRequestCockpitDraft } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { ReviewPanel } from './ReviewPanel';

const PR = '00000000-0000-4000-8000-0000000000aa';
const HEAD = 'b'.repeat(40);

const draft = (over: Partial<PullRequestCockpitDraft> = {}): PullRequestCockpitDraft => ({
  body: 'use <=',
  createdAt: '2026-11-04T10:00:00.000Z',
  headSha: HEAD,
  id: 'd-1',
  line: 2,
  outdated: false,
  path: 'src/a.ts',
  ...over,
});

function cockpit(
  over: Partial<PullRequestCockpit> = {},
  write: Partial<PullRequestCockpit['write']> = {}
): PullRequestCockpit {
  return {
    changedSinceViewed: [],
    drafts: [],
    evaluation: null,
    files: { headSha: HEAD, items: [], state: 'open', truncated: false, type: 'ok' },
    pull: {
      ciStatus: 'PASSED',
      closedAt: null,
      costUsd: null,
      headSha: HEAD,
      id: PR,
      isDraft: false,
      latestRun: null,
      mergedAt: null,
      openedAt: '2026-11-01T09:00:00.000Z',
      ownerTeam: null,
      prNumber: 7,
      repository: null,
      status: 'OPEN',
      ticketId: null,
      title: null,
      url: null,
      workRequestId: null,
    },
    sinceLastVisit: null,
    viewed: [],
    write: {
      approvalMayNotCount: false,
      available: true,
      feedbackLoopEnabled: true,
      reason: null,
      ...write,
    },
    ...over,
  };
}

type Call = { body: unknown; method: string; url: string };

function gateway(reply: (call: Call) => { body: unknown; status?: number }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: (init?.method ?? 'GET').toUpperCase(),
        url: (typeof input === 'string' ? input : input.toString()).replace(
          /^https?:\/\/[^/]+/,
          ''
        ),
      };
      calls.push(call);
      const { body, status = 200 } = reply(call);
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status,
      });
    })
  );
  return calls;
}

function show(data: PullRequestCockpit) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  return render(
    <QueryClientProvider client={qc}>
      <ReviewPanel data={data} />
    </QueryClientProvider>
  );
}

const sendButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
/** The confirmation that is open; the panel keeps one per action and only one is ever showing. */
const dialog = () => {
  const open = screen
    .getAllByRole('dialog', { hidden: true })
    .filter((candidate) => candidate.hasAttribute('open'));
  if (open.length !== 1) {
    throw new Error(`expected one open dialog, found ${open.length}`);
  }
  return within(open[0] as HTMLElement);
};
const chooseVerdict = (label: RegExp) =>
  fireEvent.click(screen.getByRole('radio', { name: label }));
const writeSummary = (text: string) =>
  fireEvent.change(screen.getByLabelText('Review summary'), { target: { value: text } });
const confirm = (name: string) =>
  fireEvent.click(dialog().getByRole('button', { hidden: true, name }));

beforeEach(() => {
  stubDialogPrototype();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('when it cannot write as the reviewer', () => {
  it.each([
    ['no-token', /save a github token for this repository/i, true],
    ['unusable', /cannot be used now/i, true],
    ['unreadable', /can no longer be read/i, true],
    ['disabled', /is off on this platform/i, false],
  ] as const)(
    'says why (%s), and links to Connections only when saving a token would help',
    (reason, words, link) => {
      show(cockpit({}, { available: false, reason }));
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Open Connections' }) !== null).toBe(link);
      expect(screen.queryByRole('button', { name: /send|approve|request changes/i })).toBeNull();
    }
  );

  it('draws nothing while the files cannot be read', () => {
    const { container } = show(cockpit({ files: { reason: 'failed', type: 'unavailable' } }));
    expect(container.textContent).toBe('');
  });

  it('says a pull request that is no longer open cannot be sent to', () => {
    show(
      cockpit({
        files: { headSha: HEAD, items: [], state: 'closed', truncated: false, type: 'ok' },
      })
    );
    expect(screen.getByText(/is closed on the host, so nothing can be sent/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /send|approve/i })).toBeNull();
  });
});

describe('choosing what to send', () => {
  it('starts as a comment with nothing to send, and says what to do', () => {
    show(cockpit());
    expect(sendButton('Send comments').disabled).toBe(true);
    expect(screen.getByText('Write a comment, or add a comment on a line.')).toBeTruthy();
  });

  it('can send a comment once there is a summary', () => {
    show(cockpit());
    writeSummary('Looks fine.');
    expect(sendButton('Send comments').disabled).toBe(false);
  });

  it('can send line comments alone, and counts the drafts that go with it', () => {
    show(cockpit({ drafts: [draft(), draft({ id: 'd-2', line: 5 })] }));
    expect(sendButton('Send comments').disabled).toBe(false);
    expect(screen.getByText(/2 draft comments/)).toBeTruthy();
  });

  it('needs a summary to request changes, however many line comments there are', () => {
    show(cockpit({ drafts: [draft()] }));
    chooseVerdict(/request changes/i);
    expect(sendButton('Request changes').disabled).toBe(true);
    expect(screen.getByText('Say what needs to change.')).toBeTruthy();
    writeSummary('Please handle the empty list.');
    expect(sendButton('Request changes').disabled).toBe(false);
  });

  it('can approve with nothing written', () => {
    show(cockpit());
    chooseVerdict(/approve/i);
    expect(sendButton('Approve').disabled).toBe(false);
  });

  it('warns that an approval may not count for whoever launched or requested the work', () => {
    show(cockpit({}, { approvalMayNotCount: true }));
    expect(screen.queryByText(/sets your approval aside/)).toBeNull();
    chooseVerdict(/approve/i);
    expect(screen.getByText(/sets your approval aside/)).toBeTruthy();
  });

  it('does not warn anyone else', () => {
    show(cockpit({}, { approvalMayNotCount: false }));
    chooseVerdict(/approve/i);
    expect(screen.queryByText(/sets your approval aside/)).toBeNull();
  });

  it('says requesting changes also asks the agent, only while the loop is on', () => {
    const { unmount } = show(cockpit({}, { feedbackLoopEnabled: true }));
    chooseVerdict(/request changes/i);
    expect(screen.getByText(/also asks the agent to address them/)).toBeTruthy();
    unmount();
    show(cockpit({}, { feedbackLoopEnabled: false }));
    chooseVerdict(/request changes/i);
    expect(screen.queryByText(/also asks the agent to address them/)).toBeNull();
  });
});

describe('drafts that no longer fit', () => {
  const stale = draft({ id: 'd-9', line: 40, outdated: true, path: 'src/old.ts' });

  it('lists them with their place, warns, and holds the review back', () => {
    show(cockpit({ drafts: [draft(), stale] }));
    expect(screen.getByText('Some drafts no longer fit the diff')).toBeTruthy();
    expect(screen.getByText('src/old.ts:40')).toBeTruthy();
    expect(sendButton('Send comments').disabled).toBe(true);
    expect(screen.getByText('Delete or redo the outdated draft comments first.')).toBeTruthy();
  });

  it('does not count them among the comments that will go', () => {
    show(cockpit({ drafts: [draft(), stale] }));
    expect(screen.getByText(/1 draft comment will go/)).toBeTruthy();
  });

  it('lets the reviewer delete one', async () => {
    const calls = gateway(() => ({ body: { data: { deleted: true } } }));
    show(cockpit({ drafts: [stale] }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/v1/pull-requests/${PR}/drafts/d-9`,
    });
  });
});

describe('sending the review', () => {
  const sent = {
    comments: 1,
    draftsKept: false,
    event: 'COMMENT',
    reviewId: 9,
    url: 'https://github.com/acme/api/pull/7#pullrequestreview-9',
  };

  it('asks first, and says it is posted as the reviewer', () => {
    show(cockpit({ drafts: [draft()] }));
    fireEvent.click(sendButton('Send comments'));
    expect(dialog().getByText(/posted on the host as you, with 1 line comment/)).toBeTruthy();
  });

  it('sends the verdict, the summary, the current drafts and the head the page showed', async () => {
    const calls = gateway(() => ({ body: { data: sent } }));
    show(cockpit({ drafts: [draft(), draft({ id: 'd-9', outdated: true })].slice(0, 1) }));
    writeSummary('  Looks fine.  ');
    fireEvent.click(sendButton('Send comments'));
    confirm('Send comments');
    await waitFor(() => expect(screen.getByText('Review sent')).toBeTruthy());
    expect(calls).toEqual([
      {
        body: { body: 'Looks fine.', draftIds: ['d-1'], event: 'COMMENT', headSha: HEAD },
        method: 'POST',
        url: `/api/v1/pull-requests/${PR}/review`,
      },
    ]);
  });

  it('names the review on the host, and clears the summary', async () => {
    gateway(() => ({ body: { data: sent } }));
    show(cockpit({ drafts: [draft()] }));
    writeSummary('Looks fine.');
    fireEvent.click(sendButton('Send comments'));
    confirm('Send comments');
    const link = await screen.findByRole('link', { name: /View it on the host/ });
    expect(link.getAttribute('href')).toBe(sent.url);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect((screen.getByLabelText('Review summary') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/1 line comment went with it/)).toBeTruthy();
  });

  it('links no address that is not http or https', async () => {
    gateway(() => ({ body: { data: { ...sent, url: 'javascript:alert(1)' } } }));
    show(cockpit());
    writeSummary('Looks fine.');
    fireEvent.click(sendButton('Send comments'));
    confirm('Send comments');
    await screen.findByText('Review sent');
    expect(screen.queryByRole('link', { name: /View it on the host/ })).toBeNull();
  });

  it('warns when what it sent could not be cleared, so it is not sent twice', async () => {
    gateway(() => ({ body: { data: { ...sent, draftsKept: true } } }));
    show(cockpit({ drafts: [draft()] }));
    fireEvent.click(sendButton('Send comments'));
    confirm('Send comments');
    expect(await screen.findByText(/could not be cleared here/)).toBeTruthy();
  });

  it('shows the gateway’s reason in the dialog when it is refused, and claims nothing was sent', async () => {
    gateway(() => ({
      body: {
        error: {
          code: 'STALE_HEAD',
          message: 'The pull request has new commits since you opened the page.',
        },
      },
      status: 409,
    }));
    show(cockpit({ drafts: [draft()] }));
    fireEvent.click(sendButton('Send comments'));
    confirm('Send comments');
    expect(await dialog().findByText(/new commits since you opened the page/)).toBeTruthy();
    expect(screen.queryByText('Review sent')).toBeNull();
  });

  it('sends an approval with the approve verdict', async () => {
    const calls = gateway(() => ({ body: { data: { ...sent, comments: 0, event: 'APPROVE' } } }));
    show(cockpit());
    chooseVerdict(/approve/i);
    fireEvent.click(sendButton('Approve'));
    confirm('Approve');
    await screen.findByText('Review sent');
    expect(calls[0]?.body).toEqual({ body: '', draftIds: [], event: 'APPROVE', headSha: HEAD });
  });
});

describe('sending it back to the agent', () => {
  const back = { commentId: 5, url: 'https://github.com/acme/api/pull/7#issuecomment-5' };

  it('says why it cannot while the feedback automations are off, and offers no button', () => {
    show(cockpit({}, { feedbackLoopEnabled: false }));
    expect(screen.getByText(/automations are off for this repository/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull();
  });

  it('asks first, and says it can start a run', () => {
    show(cockpit());
    fireEvent.click(sendButton('Send back'));
    expect(dialog().getByText(/can start a run/)).toBeTruthy();
  });

  it('sends the head and the note, and links the comment', async () => {
    const calls = gateway(() => ({ body: { data: back } }));
    show(cockpit());
    fireEvent.change(screen.getByLabelText('Note for the agent'), {
      target: { value: 'Handle the empty list.' },
    });
    fireEvent.click(sendButton('Send back'));
    confirm('Send back');
    const link = await screen.findByRole('link', { name: /View the comment on the host/ });
    expect(link.getAttribute('href')).toBe(back.url);
    expect(calls).toEqual([
      {
        body: { headSha: HEAD, note: 'Handle the empty list.' },
        method: 'POST',
        url: `/api/v1/pull-requests/${PR}/send-back`,
      },
    ]);
    expect((screen.getByLabelText('Note for the agent') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends no note when none was written', async () => {
    const calls = gateway(() => ({ body: { data: back } }));
    show(cockpit());
    fireEvent.click(sendButton('Send back'));
    confirm('Send back');
    await screen.findByText('Sent back');
    expect(calls[0]?.body).toEqual({ headSha: HEAD });
  });

  it('shows the gateway’s reason in the dialog when it is refused', async () => {
    gateway(() => ({
      body: { error: { code: 'FEEDBACK_LOOP_OFF', message: 'Feedback automations are off.' } },
      status: 409,
    }));
    show(cockpit());
    fireEvent.click(sendButton('Send back'));
    confirm('Send back');
    expect(await dialog().findByText(/Feedback automations are off/)).toBeTruthy();
    expect(screen.queryByText('Sent back')).toBeNull();
  });
});
