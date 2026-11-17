// @vitest-environment jsdom

import type { OrchestrationDetailDto } from '@auto-swe/shared/lib/orchestrationApi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detail, message } from '@/test/orchestrationFixtures';
import { ConversationColumn } from './ConversationColumn';

// The real orchestration hooks run over a stubbed gateway: a click reaches `fetch`.

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

function gateway(post: { status: number; code?: string } = { status: 200 }) {
  const posts: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push(path);
      return new Response(
        JSON.stringify(
          post.status < 400 ? {} : { error: { code: post.code, message: 'raw gateway text' } }
        ),
        { headers: { 'content-type': 'application/json' }, status: post.status }
      );
    }
    return new Response(JSON.stringify({ data: [], meta: { limit: 500, offset: 0, total: 0 } }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  vi.stubGlobal('fetch', spy);
  return posts;
}

function view(d: OrchestrationDetailDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (value: OrchestrationDetailDto) => (
    <QueryClientProvider client={qc}>
      <ConversationColumn detail={value} messages={[]} />
    </QueryClientProvider>
  );
  const utils = render(ui(d));
  return { ...utils, update: (value: OrchestrationDetailDto) => utils.rerender(ui(value)) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('approval decisions', () => {
  it('sends one answer per click and keeps the buttons off until the item leaves the detail', async () => {
    const posts = gateway();
    const d = detail({ pendingApprovals: [approval] });
    const { update } = view(d);
    const approve = screen.getByRole('button', { name: 'Approve this call' });
    await act(async () => {
      fireEvent.click(approve);
      fireEvent.click(approve);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatch(/\/approvals\/ap1$/);
    // Still listed after the request settled: still locked, a further click sends nothing.
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(approve);
    });
    expect(posts).toHaveLength(1);
    // The refetched detail no longer lists it: the card is gone.
    update({ ...d, pendingApprovals: [] });
    expect(screen.queryByRole('button', { name: 'Approve this call' })).toBeNull();
  });

  it('treats a refusal because it was already decided as done, not as an error', async () => {
    gateway({ code: 'APPROVAL_NOT_PENDING', status: 409 });
    view(detail({ pendingApprovals: [approval] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve this call' }));
    });
    expect(await screen.findByText(/Already decided/)).toBeTruthy();
    expect(screen.queryByText('raw gateway text')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Approve this call' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('shows any other failure and lets the launcher try again', async () => {
    const posts = gateway({ code: 'SOMETHING_ELSE', status: 500 });
    view(detail({ pendingApprovals: [approval] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(await screen.findByText('raw gateway text')).toBeTruthy();
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    await waitFor(() => expect(deny.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(deny);
    });
    await waitFor(() => expect(posts).toHaveLength(2));
  });
});

describe('attach decisions', () => {
  const pendingAttach = { candidateRepoId: null, messageId: 'm-att', reason: 'need to edit' };

  it('answers an attach request from the detail alone, and declines once', async () => {
    const posts = gateway();
    view(detail({ pendingAttach }));
    const region = screen.getByRole('region', { name: 'Needs your decision' });
    const decline = within(region).getByRole('button', { name: 'Decline' });
    await act(async () => {
      fireEvent.click(decline);
      fireEvent.click(decline);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatch(/\/attach\/decline$/);
    expect((decline as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads a race on the attach request as already decided', async () => {
    gateway({ code: 'NO_PENDING_ATTACH', status: 409 });
    view(detail({ pendingAttach }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(await screen.findByText(/Already decided/)).toBeTruthy();
    expect(screen.queryByText('raw gateway text')).toBeNull();
  });

  it('is read-only for a viewer', () => {
    gateway();
    view(detail({ canControl: false, pendingApprovals: [approval], pendingAttach }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('region', { name: /Waiting for the launcher/ })).toBeTruthy();
  });
});

describe('transcript rows', () => {
  it('shows each attach request with its own outcome', () => {
    gateway();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ConversationColumn
          detail={detail({ repoAttachedAt: '2026-01-01T00:09:00Z', repoId: 'r1' })}
          messages={[
            message({
              id: 'a1',
              kind: 'ATTACH_REQUEST',
              payload: { reason: 'first', resolution: 'DECLINED' },
            }),
            message({
              id: 'a2',
              kind: 'ATTACH_REQUEST',
              payload: { reason: 'second', resolution: 'ATTACHED' },
            }),
          ]}
        />
      </QueryClientProvider>
    );
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('Attached')).toBeTruthy();
  });
});
