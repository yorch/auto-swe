// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { child, detail, message } from '@/test/orchestrationFixtures';
import { withQuery } from '@/test/rtl-helpers';

const repos = vi.hoisted(() => ({
  data: [
    {
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'api',
      team: { id: 't2', name: 'Platform', slug: 'platform' },
      type: 'git_repo',
    },
  ],
}));
vi.mock('@/hooks/useRepositories', () => ({
  useRepositories: () => ({ data: repos.data, isLoading: false }),
}));

import {
  ApprovalCard,
  ApprovalRequestRow,
  ATTACH_GRANTS,
  AttachRequestCard,
  AttachRequestRow,
  ChildResultCard,
} from './OrchestrationCards';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AttachRequestCard', () => {
  const attachMessage = message({ id: 'm-attach', kind: 'ATTACH_REQUEST', role: 'ORCHESTRATOR' });
  const pending = {
    candidateRepoId: 'repo-1',
    messageId: 'm-attach',
    reason: 'I need to change code <b>now</b>',
  };
  const card = (
    overrides: Partial<NonNullable<ReturnType<typeof detail>['pendingAttach']>> = {},
    props: Partial<ComponentProps<typeof AttachRequestCard>> = {},
    detailOverrides: Parameters<typeof detail>[0] = {}
  ) => (
    <AttachRequestCard
      canControl
      detail={detail({ pendingAttach: { ...pending, ...overrides }, ...detailOverrides })}
      message={attachMessage}
      onAttach={vi.fn()}
      onDecline={vi.fn()}
      pending={{ ...pending, ...overrides }}
      {...props}
    />
  );

  it('shows the reason, the qualified candidate and what attaching grants', () => {
    render(withQuery(card()));
    expect(screen.getByText('acme/api')).toBeTruthy();
    for (const grant of ATTACH_GRANTS) {
      expect(screen.getByText(grant)).toBeTruthy();
    }
    // The reason is text, never markup.
    expect(screen.getByText('I need to change code <b>now</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('names the billing team and the delivery default in plain language', () => {
    render(
      withQuery(
        card({
          billingTeamName: 'Platform',
          candidateRepoName: 'acme/payments-api',
          deliveryDefault: 'draft_pr',
        })
      )
    );
    expect(screen.getByText('acme/payments-api')).toBeTruthy();
    expect(screen.getByText(/bill under Platform/)).toBeTruthy();
    expect(screen.getByText(/Open a draft pull request for each change/)).toBeTruthy();
    expect(screen.queryByText(/not reported/)).toBeNull();
  });

  it('falls back to the detail’s billing team and delivery default', () => {
    render(
      withQuery(
        card(
          {},
          {},
          {
            billing: { childrenTeamName: 'Payments', orchestratorTeamName: 'Core' },
            deliveryDefault: 'branch',
          }
        )
      )
    );
    expect(screen.getByText(/bill under Payments/)).toBeTruthy();
    expect(screen.getByText(/Push a branch for each change/)).toBeTruthy();
  });

  it('says plainly when the billing team and delivery default were not reported', () => {
    render(withQuery(card({ candidateRepoId: 'unknown-repo' })));
    expect(screen.getByText(/the team was not reported/)).toBeTruthy();
    expect(screen.getByText(/Delivery default: not reported/)).toBeTruthy();
    expect(screen.getByText(/its name is not available to you/)).toBeTruthy();
  });

  it('attaches the candidate on confirm and declines on decline', () => {
    const onAttach = vi.fn();
    const onDecline = vi.fn();
    render(withQuery(card({}, { onAttach, onDecline })));
    fireEvent.click(screen.getByRole('button', { name: 'Attach repository' }));
    expect(onAttach).toHaveBeenCalledWith('repo-1');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('asks for a repository when none is suggested, and will not attach until one is chosen', () => {
    render(withQuery(card({ candidateRepoId: null })));
    expect(screen.getAllByLabelText(/Repository to attach/).length).toBeGreaterThan(0);
    expect(screen.getByText(/none suggested/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Attach repository' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('keeps both buttons off once the answer is sent', () => {
    render(withQuery(card({}, { decided: true })));
    expect(
      (screen.getByRole('button', { name: 'Attach repository' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('has no buttons for a viewer', () => {
    render(withQuery(card({}, { canControl: false }, { canControl: false })));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Waiting for the person who launched this.')).toBeTruthy();
  });
});

describe('AttachRequestRow', () => {
  const row = (payload: Record<string, unknown>, d = detail()) =>
    render(
      <AttachRequestRow
        detail={d}
        message={message({ id: 'm-a', kind: 'ATTACH_REQUEST', payload })}
      />
    );

  it('labels each request by its own resolution, not by the orchestration’s final state', () => {
    // Declined first, then a second request that was attached: the repository IS attached now,
    // yet the first message must still read as declined.
    const attached = detail({ repoAttachedAt: '2026-01-01T00:03:00Z', repoId: 'repo-1' });
    const first = row({ reason: 'first try', resolution: 'DECLINED' }, attached);
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.queryByText('Attached')).toBeNull();
    first.unmount();
    row({ reason: 'second try', resolution: 'ATTACHED' }, attached);
    expect(screen.getByText('Attached')).toBeTruthy();
    expect(screen.queryByText('Declined')).toBeNull();
  });

  it('reads as closed when no resolution was recorded, and as waiting while pending', () => {
    const closed = row({ reason: 'r' }, detail({ repoAttachedAt: '2026-01-01T00:03:00Z' }));
    expect(screen.getByText('Closed')).toBeTruthy();
    closed.unmount();
    render(
      <AttachRequestRow
        detail={detail({ pendingAttach: { candidateRepoId: null, messageId: 'm-a', reason: 'r' } })}
        message={message({ id: 'm-a', kind: 'ATTACH_REQUEST', payload: { reason: 'r' } })}
      />
    );
    expect(screen.getByText('Waiting for an answer')).toBeTruthy();
  });
});

describe('ApprovalCard', () => {
  const approval = {
    argumentsDigest: 'issue: 3 fields <script>alert(1)</script>',
    childId: 'ch1',
    connectionId: 'c1',
    connectionName: 'Linear',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T00:10:00Z',
    id: 'ap1',
    status: 'PENDING' as const,
    toolName: 'create_issue',
  };

  it('shows the call, a static expiry, a hidden countdown, and decides on a click', () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:08:00Z') });
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval} canControl onDecide={onDecide} />);
    expect(screen.getByText('create_issue')).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.getByText(/alert\(1\)/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    // The announced label is the fixed clock time; the ticking value is aria-hidden.
    expect(screen.getByText(/Expires at/)).toBeTruthy();
    const ticking = screen.getByText(/2:00 left/);
    expect(ticking.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Approve this call' }));
    expect(onDecide).toHaveBeenCalledWith('ap1', 'APPROVE');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenCalledWith('ap1', 'DENY');
    act(() => {
      vi.advanceTimersByTime(121_000);
    });
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Approve this call' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('keeps the buttons off once the answer is sent, and has none for a viewer', () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:08:00Z') });
    const { rerender } = render(
      <ApprovalCard approval={approval} canControl decided onDecide={vi.fn()} />
    );
    expect(
      (screen.getByRole('button', { name: 'Approve this call' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ApprovalCard approval={approval} canControl={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ApprovalRequestRow', () => {
  const pendingDto = {
    argumentsDigest: 'd',
    childId: null,
    connectionId: 'c1',
    connectionName: 'Linear',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2999-01-01T00:00:00Z',
    id: 'ap1',
    status: 'PENDING' as const,
    toolName: 'create_issue',
  };
  const msg = (payload: Record<string, unknown>) => message({ kind: 'APPROVAL_REQUEST', payload });
  const payload = {
    approvalId: 'ap1',
    argumentsDigest: 'd',
    connectionName: 'Linear',
    expiresAt: '2026-01-01T00:10:00Z',
    toolName: 'create_issue',
  };

  it('labels a request the detail still lists as waiting', () => {
    render(
      <ApprovalRequestRow
        detail={detail({ pendingApprovals: [pendingDto] })}
        message={msg(payload)}
      />
    );
    expect(screen.getByText('Waiting for approval')).toBeTruthy();
  });

  it('takes the real outcome from the payload, never a stale PENDING', () => {
    for (const [status, label] of [
      ['APPROVED', 'Approved'],
      ['DENIED', 'Denied'],
      ['EXPIRED', 'Expired'],
    ] as const) {
      const view = render(
        <ApprovalRequestRow detail={detail()} message={msg({ ...payload, status })} />
      );
      expect(screen.getByText(label)).toBeTruthy();
      view.unmount();
    }
    // A stored PENDING that the detail no longer lists claims nothing.
    render(
      <ApprovalRequestRow detail={detail()} message={msg({ ...payload, status: 'PENDING' })} />
    );
    expect(screen.queryByText('Waiting for approval')).toBeNull();
    expect(screen.getByText('Resolved')).toBeTruthy();
  });

  it('reads the status the detail carries for a decided request', () => {
    render(
      <ApprovalRequestRow
        detail={detail({ pendingApprovals: [{ ...pendingDto, status: 'DENIED' }] })}
        message={msg(payload)}
      />
    );
    expect(screen.getByText('Denied')).toBeTruthy();
  });
});

describe('ChildResultCard', () => {
  const base = {
    costUsd: 1,
    filesChanged: [{ added: 3, path: 'src/<img onerror=x>.ts', removed: 1 }],
    status: 'COMPLETED' as const,
    summary: 'Done <img src=x onerror=alert(1)> and <script>boom()</script>',
  };

  it('renders every agent string as inert text', () => {
    render(
      <ChildResultCard
        detail={detail({ children: [child()] })}
        message={message({ childId: 'ch1', kind: 'CHILD_RESULT', payload: { result: base } })}
      />
    );
    expect(screen.getByText(/Done <img src=x/)).toBeTruthy();
    fireEvent.click(screen.getByText(/1 file changed/));
    expect(screen.getByText(/src\/<img onerror=x>\.ts/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('links a pull request only when it is https', () => {
    const { unmount } = render(
      <ChildResultCard
        detail={detail()}
        message={message({
          childId: 'ch1',
          kind: 'CHILD_RESULT',
          payload: {
            result: { ...base, branch: 'auto/x', prUrl: 'https://github.com/a/b/pull/4' },
          },
        })}
      />
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/a/b/pull/4');
    expect(screen.getByText('auto/x')).toBeTruthy();
    unmount();
    for (const bad of ['javascript:alert(1)', 'http://github.com/a/b/pull/4']) {
      const view = render(
        <ChildResultCard
          detail={detail()}
          message={message({
            childId: 'ch1',
            kind: 'CHILD_RESULT',
            payload: { result: { ...base, prUrl: bad } },
          })}
        />
      );
      expect(view.queryByRole('link')).toBeNull();
      expect(view.getByText(bad)).toBeTruthy();
      view.unmount();
    }
  });

  it('falls back to the child’s stored result, and says when there is none', () => {
    const stored = child({ result: { ...base, summary: 'stored summary' } });
    const { unmount } = render(
      <ChildResultCard
        detail={detail({ children: [stored] })}
        message={message({ childId: 'ch1', kind: 'CHILD_RESULT', payload: null })}
      />
    );
    expect(screen.getByText('stored summary')).toBeTruthy();
    unmount();
    render(
      <ChildResultCard
        detail={detail()}
        message={message({ childId: 'ch1', kind: 'CHILD_RESULT', payload: null })}
      />
    );
    expect(screen.getByText('The result is not available.')).toBeTruthy();
  });
});
