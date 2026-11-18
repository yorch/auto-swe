// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { mockViewport } from '@/test/matchMedia';
import { child, detail, message } from '@/test/orchestrationFixtures';
import { stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));

const state = vi.hoisted(() => ({
  detail: { data: undefined, error: null, isError: false, isLoading: false } as Record<
    string,
    unknown
  >,
  messages: { data: { messages: [], next: null }, isError: false, isLoading: false } as Record<
    string,
    unknown
  >,
}));
const calls = vi.hoisted(() => ({
  cancelChild: vi.fn(),
  cancelOrch: vi.fn(async () => undefined),
  endOrch: vi.fn(async () => undefined),
  live: undefined as boolean | undefined,
  messageChild: vi.fn(),
  send: vi.fn(),
}));
const stream = vi.hoisted(() => ({ enabled: undefined as boolean | undefined, state: 'idle' }));
const idle = { error: null, isError: false, isPending: false, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@/hooks/useOrchestrations', () => ({
  useAttachRepo: () => idle,
  useCancelChild: () => ({ ...idle, mutate: calls.cancelChild }),
  useCancelOrchestration: () => ({ ...idle, mutateAsync: calls.cancelOrch }),
  useDecideApproval: () => idle,
  useDeclineAttach: () => idle,
  useEndOrchestration: () => ({ ...idle, mutateAsync: calls.endOrch }),
  useMessageChild: () => ({ ...idle, mutate: calls.messageChild }),
  useOrchestration: () => ({ ...state.detail, refetch: vi.fn() }),
  useOrchestrationMessages: (_id: string, live: boolean) => {
    calls.live = live;
    return { ...state.messages, refetch: vi.fn() };
  },
  useSendOrchestrationMessage: () => ({ ...idle, mutate: calls.send }),
}));
vi.mock('@/hooks/useOrchestrationStream', () => ({
  useOrchestrationStream: (_id: string, enabled: boolean) => {
    stream.enabled = enabled;
    return enabled ? stream.state : 'idle';
  },
}));
vi.mock('@/hooks/useRepositories', () => ({
  useRepositories: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/hooks/useRuns', () => ({
  useRunsForWorkRequest: (wr: string) => ({ data: wr === 'wr-ch1' ? [{ id: 'run-77' }] : [] }),
}));
vi.mock('@/hooks/useLatestToolCall', () => ({
  useLatestToolCall: () => ({ data: { id: 'a1', summary: 'bash: ls <b>src</b>', ts: 't' } }),
}));
vi.mock('@/hooks/useWorkViews', () => ({
  usePullRequests: () => ({
    data: [{ ciStatus: 'PASSED', url: 'https://github.com/a/b/pull/9' }],
  }),
}));

import OrchestrationDetailPage from './page';

function setDetail(d: ReturnType<typeof detail>) {
  state.detail = { data: d, error: null, isError: false, isLoading: false };
}

async function renderPage() {
  await act(async () => {
    render(
      withQuery(
        <Suspense fallback={null}>
          <OrchestrationDetailPage params={Promise.resolve({ id: 'o1' })} />
        </Suspense>
      )
    );
  });
}

beforeEach(() => {
  stubDialogPrototype();
  mockViewport(1280);
  state.messages = {
    data: {
      messages: [
        message({ body: 'Plan: <script>x()</script> split in two', id: 'm1' }),
        message({ body: 'rate limited', id: 'm2', kind: 'NOTICE', role: 'SYSTEM' }),
        message({ body: 'go on', id: 'm3', role: 'USER' }),
      ],
      next: 'c',
    },
    isError: false,
    isLoading: false,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrchestrationDetailPage states', () => {
  it('shows a skeleton while loading', async () => {
    state.detail = { data: undefined, error: null, isError: false, isLoading: true };
    await renderPage();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows not found for a 404 and a retry for other errors', async () => {
    state.detail = {
      data: undefined,
      error: new ApiError('gone', 404, null),
      isError: true,
      isLoading: false,
    };
    await renderPage();
    expect(screen.getByText('Orchestration not found')).toBeTruthy();
    cleanup();
    state.detail = { data: undefined, error: new Error('boom'), isError: true, isLoading: false };
    await renderPage();
    expect(screen.getByText('Could not load this orchestration')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('live indicator', () => {
  const labels: Array<[string, string]> = [
    ['live', 'Live'],
    ['reconnecting', 'Reconnecting…'],
    ['polling', 'Updating by polling'],
  ];
  it.each(labels)('says %s in words, in a region that is not announced', async (st, label) => {
    stream.state = st;
    setDetail(detail());
    await renderPage();
    const text = screen.getByText(label);
    expect(text).toBeTruthy();
    expect(text.closest('[aria-live]')?.getAttribute('aria-live')).toBe('off');
    expect(stream.enabled).toBe(true);
  });

  it('is absent, and the stream off, once the orchestration is finished', async () => {
    stream.state = 'live';
    setDetail(detail({ status: 'COMPLETED' }));
    await renderPage();
    expect(screen.queryByText('Live')).toBeNull();
    expect(stream.enabled).toBe(false);
  });
});

describe('launcher view', () => {
  it('shows header, transcript as text, composer, lanes and controls', async () => {
    setDetail(
      detail({
        connections: [{ id: 'c1', name: 'Linear' }],
        repoAttachedAt: '2026-01-01T00:02:00Z',
        repoId: 'repo-1',
        repoName: 'acme/api',
      })
    );
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Fix checkout' })).toBeTruthy();
    expect(screen.getByText('Attached')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.getByText(/orchestrator;/)).toBeTruthy();
    // Transcript: agent text is inert.
    expect(screen.getByText(/Plan: <script>x\(\)<\/script> split in two/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('rate limited')).toBeTruthy();
    expect(screen.getByRole('log').getAttribute('aria-live')).toBe('polite');
    // Composer + buttons.
    expect(screen.getByLabelText('Message to the orchestrator')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel orchestration' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End' })).toBeTruthy();
    // The lane.
    expect(screen.getByRole('heading', { name: 'Find callers' })).toBeTruthy();
    expect(screen.getByText('Reader')).toBeTruthy();
    expect(screen.getByText(/bash: ls <b>src<\/b>/)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: /Open the run/ }).getAttribute('href')).toBe(
      '/runs/run-77'
    );
    expect(calls.live).toBe(true);
  });

  it('sends a message, and messages or cancels a child', async () => {
    setDetail(detail());
    await renderPage();
    fireEvent.change(screen.getByLabelText('Message to the orchestrator'), {
      target: { value: ' hi ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls.send).toHaveBeenCalledWith('hi', expect.anything());

    fireEvent.change(screen.getByLabelText('Message to Find callers'), {
      target: { value: 'narrow it' },
    });
    const lane = screen.getByRole('heading', { name: 'Find callers' }).closest('li') as HTMLElement;
    fireEvent.click(within(lane).getByRole('button', { name: 'Send to Find callers' }));
    expect(calls.messageChild).toHaveBeenCalledWith(
      { body: 'narrow it', childId: 'ch1' },
      expect.anything()
    );
    fireEvent.click(within(lane).getByRole('button', { name: /Cancel/ }));
    expect(calls.cancelChild).toHaveBeenCalledWith('ch1');
  });

  it('confirms before cancelling the orchestration', async () => {
    setDetail(detail());
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel orchestration' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel orchestration' }));
    });
    expect(calls.cancelOrch).toHaveBeenCalledTimes(1);
  });

  it('reports not-delivered steering and writer path scopes', async () => {
    setDetail(
      detail({
        children: [
          child({
            pathScopes: ['src/api/**', 'docs/a.md'],
            role: 'WRITER',
            undeliveredSteering: 2,
          }),
        ],
      })
    );
    await renderPage();
    expect(screen.getByText('Writer')).toBeTruthy();
    expect(screen.getByText('src/api/**, docs/a.md')).toBeTruthy();
    expect(screen.getByText(/2 messages not delivered/)).toBeTruthy();
  });

  it('groups sibling pull requests with CI, linking only https', async () => {
    setDetail(
      detail({
        children: [
          child({
            branch: 'auto/agent-1',
            id: 'w1',
            label: 'API',
            prUrl: 'https://github.com/a/b/pull/9',
            status: 'COMPLETED',
          }),
          child({
            branch: 'auto/agent-2',
            id: 'w2',
            label: 'Web',
            prUrl: 'javascript:alert(1)',
            status: 'COMPLETED',
          }),
        ],
        repoId: 'repo-1',
      })
    );
    await renderPage();
    const group = screen.getByRole('region', { name: 'Pull request group' });
    const links = within(group).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://github.com/a/b/pull/9');
    expect(within(group).getByText('Link unavailable')).toBeTruthy();
    expect(within(group).getByText(/passed/i)).toBeTruthy();
  });
});

describe('read-only viewer', () => {
  it('has no composer, no message box, and no cancel, end or approval buttons', async () => {
    setDetail(
      detail({
        canControl: false,
        pendingApprovals: [
          {
            argumentsDigest: 'd',
            childId: 'ch1',
            connectionId: 'c1',
            connectionName: 'Linear',
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: '2999-01-01T00:00:00Z',
            id: 'ap1',
            status: 'PENDING',
            toolName: 'create_issue',
          },
        ],
      })
    );
    state.messages = {
      data: {
        messages: [message({ id: 'x', kind: 'APPROVAL_REQUEST', payload: { approvalId: 'ap1' } })],
        next: null,
      },
      isError: false,
      isLoading: false,
    };
    await renderPage();
    expect(screen.queryByLabelText('Message to the orchestrator')).toBeNull();
    expect(screen.queryByLabelText('Message to Find callers')).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel|End|Approve|Deny|Send/ })).toBeNull();
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getByText(/Ada is the only one/)).toBeTruthy();
    expect(screen.getAllByText('create_issue').length).toBeGreaterThan(0);
  });
});

describe('finished orchestration', () => {
  it('disables the composer with the reason for a cancelled one and stops polling', async () => {
    setDetail(detail({ children: [child({ status: 'COMPLETED' })], status: 'CANCELLED' }));
    await renderPage();
    const box = screen.getByLabelText('Message to the orchestrator') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/was cancelled/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel orchestration' })).toBeNull();
    expect(calls.live).toBe(false);
  });

  it('keeps a failed one closed too', async () => {
    setDetail(detail({ status: 'FAILED' }));
    await renderPage();
    expect(
      (screen.getByLabelText('Message to the orchestrator') as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect(screen.getByText(/orchestration failed/)).toBeTruthy();
  });

  it('lets the launcher message a completed one, which restarts it', async () => {
    setDetail(detail({ children: [child({ status: 'COMPLETED' })], status: 'COMPLETED' }));
    await renderPage();
    const box = screen.getByLabelText('Message to the orchestrator') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByText('Sending a message restarts this orchestration.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'one more thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls.send).toHaveBeenCalledWith('one more thing', expect.anything());
    expect(calls.live).toBe(false);
  });
});

describe('header', () => {
  it('shows the tier, what is left, and which team each part bills', async () => {
    setDetail(
      detail({
        billing: { childrenTeamName: 'Platform', orchestratorTeamName: 'Payments' },
        budget: {
          monthlyRemainingUsd: 12.5,
          percentUsed: 42,
          remainingUsd: null,
          tier: 'LARGE',
          tokens: { cap: 2_000_000, kind: 'input', used: 840_000 },
        },
      })
    );
    await renderPage();
    const used = screen.getByText('42% of the Large budget used');
    expect(used.getAttribute('title')).toBe(
      '840,000 of 2,000,000 input tokens, the orchestrator and its agents together'
    );
    expect(screen.getByText(/remaining \$12\.50 this month/)).toBeTruthy();
    expect(screen.getByText(/billed to Payments/)).toBeTruthy();
    expect(screen.getByText(/billed to Platform/)).toBeTruthy();
  });

  it('shows the percentage without a monthly figure when no USD budget is set', async () => {
    setDetail(
      detail({
        budget: {
          percentUsed: 7,
          remainingUsd: null,
          tier: 'STANDARD',
          tokens: { cap: 1000, kind: 'output', used: 70 },
        },
      })
    );
    await renderPage();
    expect(screen.getByText('7% of the Standard budget used')).toBeTruthy();
    expect(screen.queryByText(/this month/)).toBeNull();
  });

  it('tolerates an older payload that carries only the tier and an estimate', async () => {
    setDetail(detail({ budget: { remainingUsd: null, tier: 'LARGE' } }));
    await renderPage();
    expect(screen.getByText('Large tier')).toBeTruthy();
    expect(screen.queryByText(/budget used/)).toBeNull();
  });

  it('shows only the tier when the gateway reports no budget or billing', async () => {
    setDetail(detail());
    await renderPage();
    expect(screen.getByText('Standard tier')).toBeTruthy();
    expect(screen.queryByText(/remaining/)).toBeNull();
    expect(screen.queryByText(/billed to/)).toBeNull();
  });
});

describe('decisions', () => {
  const approval = {
    argumentsDigest: 'digest',
    childId: null,
    connectionId: 'c1',
    connectionName: 'Linear',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2999-01-01T00:00:00Z',
    id: 'ap1',
    status: 'PENDING' as const,
    toolName: 'create_issue',
  };

  it('offers a pending approval even when no request message is loaded', async () => {
    setDetail(detail({ pendingApprovals: [approval] }));
    await renderPage();
    const region = screen.getByRole('region', { name: 'Needs your decision' });
    expect(within(region).getByRole('button', { name: 'Approve this call' })).toBeTruthy();
  });

  it('keeps cards and the countdown out of the live log', async () => {
    setDetail(
      detail({
        pendingApprovals: [approval],
        pendingAttach: { candidateRepoId: null, messageId: 'm-att', reason: 'need code' },
      })
    );
    state.messages = {
      data: {
        messages: [
          message({ id: 'm-att', kind: 'ATTACH_REQUEST', payload: { reason: 'need code' } }),
          message({
            id: 'm-ap',
            kind: 'APPROVAL_REQUEST',
            payload: { approvalId: 'ap1', toolName: 'create_issue' },
          }),
        ],
        next: null,
      },
      isError: false,
      isLoading: false,
    };
    await renderPage();
    const log = screen.getByRole('log');
    expect(within(log).queryByRole('button')).toBeNull();
    expect(log.textContent).not.toMatch(/left\)/);
    // The cards are in their own region, outside the live log.
    const region = screen.getByRole('region', { name: 'Needs your decision' });
    expect(log.contains(region)).toBe(false);
    expect(region.contains(log)).toBe(false);
    expect(within(region).getByRole('button', { name: 'Attach repository' })).toBeTruthy();
    // The request stays in the transcript as plain text, once per request.
    expect(within(log).getByText('Approval request')).toBeTruthy();
    expect(within(log).getByText('Repository request')).toBeTruthy();
    expect(region.querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});

describe('narrow layout', () => {
  it('uses tabs for the conversation and the agents', async () => {
    mockViewport(390);
    setDetail(detail());
    await renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Conversation', 'Agents (1)']);
    expect(screen.queryByRole('heading', { name: 'Find callers' })).toBeNull();
    fireEvent.click(tabs[1]);
    expect(screen.getByRole('heading', { name: 'Find callers' })).toBeTruthy();
    // The conversation is hidden, not gone.
    expect(screen.getByLabelText('Message to the orchestrator').closest('[hidden]')).not.toBeNull();
  });

  it('keeps unsent drafts when switching tabs', async () => {
    mockViewport(390);
    setDetail(detail());
    await renderPage();
    fireEvent.change(screen.getByLabelText('Message to the orchestrator'), {
      target: { value: 'half a thought' },
    });
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]);
    fireEvent.change(screen.getByLabelText('Message to Find callers'), {
      target: { value: 'draft for the child' },
    });
    fireEvent.click(tabs[0]);
    expect(
      (screen.getByLabelText('Message to the orchestrator') as HTMLTextAreaElement).value
    ).toBe('half a thought');
    expect((screen.getByLabelText('Message to Find callers') as HTMLInputElement).value).toBe(
      'draft for the child'
    );
  });
});

describe('empty and error transcript', () => {
  it('says so when there are no messages or agents', async () => {
    setDetail(detail({ children: [] }));
    state.messages = { data: { messages: [], next: null }, isError: false, isLoading: false };
    await renderPage();
    expect(screen.getByText('No messages yet')).toBeTruthy();
    expect(screen.getByText('No agents yet')).toBeTruthy();
  });

  it('offers a retry when the transcript cannot load', async () => {
    setDetail(detail());
    state.messages = { data: undefined, error: new Error('x'), isError: true, isLoading: false };
    await renderPage();
    expect(screen.getByText('Could not load the conversation')).toBeTruthy();
  });
});
