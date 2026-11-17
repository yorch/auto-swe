// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  ATTACH_GRANTS,
  AttachRequestCard,
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

  it('shows the reason, the qualified candidate and what attaching grants', () => {
    render(
      withQuery(
        <AttachRequestCard
          canControl
          detail={detail({ pendingAttach: pending })}
          message={attachMessage}
          onAttach={vi.fn()}
          onDecline={vi.fn()}
        />
      )
    );
    expect(screen.getByText('acme/api')).toBeTruthy();
    for (const grant of ATTACH_GRANTS) {
      expect(screen.getByText(grant)).toBeTruthy();
    }
    expect(screen.getByText(/Delivery default/)).toBeTruthy();
    // The reason is text, never markup.
    expect(screen.getByText('I need to change code <b>now</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('attaches the candidate on confirm and declines on decline', () => {
    const onAttach = vi.fn();
    const onDecline = vi.fn();
    render(
      withQuery(
        <AttachRequestCard
          canControl
          detail={detail({ pendingAttach: pending })}
          message={attachMessage}
          onAttach={onAttach}
          onDecline={onDecline}
        />
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach repository' }));
    expect(onAttach).toHaveBeenCalledWith('repo-1');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('asks for a repository when none is suggested, and will not attach until one is chosen', () => {
    render(
      withQuery(
        <AttachRequestCard
          canControl
          detail={detail({ pendingAttach: { ...pending, candidateRepoId: null } })}
          message={attachMessage}
          onAttach={vi.fn()}
          onDecline={vi.fn()}
        />
      )
    );
    expect(screen.getAllByLabelText(/Repository to attach/).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'Attach repository' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('has no buttons for a viewer or once it is resolved', () => {
    const { rerender } = render(
      withQuery(
        <AttachRequestCard
          canControl={false}
          detail={detail({ canControl: false, pendingAttach: pending })}
          message={attachMessage}
          onAttach={vi.fn()}
          onDecline={vi.fn()}
        />
      )
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      withQuery(
        <AttachRequestCard
          canControl
          detail={detail({ pendingAttach: null, repoAttachedAt: '2026-01-01T00:01:00Z' })}
          message={attachMessage}
          onAttach={vi.fn()}
          onDecline={vi.fn()}
        />
      )
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Attached')).toBeTruthy();
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
  const msg = message({ kind: 'APPROVAL_REQUEST', payload: { approvalId: 'ap1' } });

  it('shows the call, a countdown, and decides on a click', () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:08:00Z') });
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        canControl
        detail={detail({ pendingApprovals: [approval] })}
        message={msg}
        onDecide={onDecide}
      />
    );
    expect(screen.getByText('create_issue')).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.getByText(/alert\(1\)/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('2:00')).toBeTruthy();
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

  it('is disabled after resolution and has no buttons for a viewer', () => {
    const { rerender } = render(
      <ApprovalCard canControl detail={detail()} message={msg} onDecide={vi.fn()} />
    );
    expect(
      (screen.getByRole('button', { name: 'Approve this call' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <ApprovalCard
        canControl={false}
        detail={detail({ canControl: false, pendingApprovals: [approval] })}
        message={msg}
        onDecide={vi.fn()}
      />
    );
    expect(screen.queryByRole('button')).toBeNull();
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
