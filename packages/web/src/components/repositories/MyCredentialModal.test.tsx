// @vitest-environment jsdom

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { MyCredentialModal, writeCapabilityNotice } from './MyCredentialModal';

const repo = {
  id: 'r1',
  name: null,
  organizationName: 'acme',
  repoName: 'api',
  team: { id: 't1', name: 'Payments', slug: 'payments' },
  type: 'git_repo',
} as unknown as RepositorySummary;

describe('MyCredentialModal', () => {
  beforeAll(() => stubDialogPrototype());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the modal open and shows the write-capability notice after a save', async () => {
    setupFetchMock({
      'PUT /api/v1/repositories/r1/credential': () => ({
        data: {
          connectionId: 'r1',
          createdAt: '2026-11-01T00:00:00.000Z',
          lastFour: 'abcd',
          permission: 'read',
          updatedAt: '2026-11-01T00:00:00.000Z',
          writeCapability: 'insufficient',
        },
      }),
    });
    const onClose = vi.fn();
    render(
      withQuery(
        <MyCredentialModal
          credential={undefined}
          enabled
          hosts={undefined}
          onClose={onClose}
          repo={repo}
        />
      )
    );
    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));

    expect(await screen.findByText(/does not have the repo scope/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  const saved = (writeCapability: string) => ({
    data: {
      connectionId: 'r1',
      createdAt: '2026-11-01T00:00:00.000Z',
      lastFour: 'abcd',
      permission: 'read',
      updatedAt: '2026-11-01T00:00:00.000Z',
      writeCapability,
    },
  });
  /** Answers the PUT and DELETE in turn from the lists, repeating the last answer. */
  function stubGateway(puts: { body: unknown; status: number }[], deletes = puts) {
    const queues = { DELETE: [...deletes], PUT: [...puts] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase() as 'DELETE' | 'PUT';
        const queue = queues[method];
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return new Response(JSON.stringify(next?.body), {
          headers: { 'content-type': 'application/json' },
          status: next?.status ?? 200,
        });
      })
    );
  }
  const refusal = { body: { error: { code: 'BAD', message: 'GitHub refused it.' } }, status: 400 };
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText(/token/i, { selector: 'input' }), {
      target: { value },
    });

  it('tells the page the token was saved, while keeping the notice in the modal', async () => {
    stubGateway([{ body: saved('insufficient'), status: 200 }]);
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      withQuery(
        <MyCredentialModal
          credential={undefined}
          enabled
          hosts={undefined}
          onClose={onClose}
          onSaved={onSaved}
          repo={repo}
        />
      )
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    type('github_pat_test');
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText(/does not have the repo scope/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(String(onSaved.mock.calls[0]?.[0])).toMatch(/saved/i);
    expect(String(onSaved.mock.calls[0]?.[0])).not.toMatch(/verified/i);
    expect(onClose).not.toHaveBeenCalled();
    // The modal is no longer a place to cancel anything: the token is saved.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The modal's own corner button is named Close too; the footer one carries the word.
    const footer = screen
      .getAllByRole('button', { name: 'Close' })
      .find((button) => button.textContent === 'Close');
    expect(footer).toBeDefined();
    fireEvent.click(footer as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drops the notice when a later save fails, so it never sits beside the error', async () => {
    stubGateway([{ body: saved('insufficient'), status: 200 }, refusal]);
    render(
      withQuery(
        <MyCredentialModal
          credential={undefined}
          enabled
          hosts={undefined}
          onClose={vi.fn()}
          repo={repo}
        />
      )
    );
    type('github_pat_one');
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await screen.findByText(/does not have the repo scope/);
    type('github_pat_two');
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText(/GitHub refused it/)).toBeTruthy();
    expect(screen.queryByText(/does not have the repo scope/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('drops the notice when a removal fails', async () => {
    stubGateway([{ body: saved('unverifiable'), status: 200 }], [refusal]);
    render(
      withQuery(
        <MyCredentialModal
          credential={{
            connectionId: 'r1',
            createdAt: '2026-11-01T00:00:00.000Z',
            lastFour: 'abcd',
            updatedAt: '2026-11-01T00:00:00.000Z',
          }}
          enabled
          hosts={undefined}
          onClose={vi.fn()}
          repo={repo}
        />
      )
    );
    type('github_pat_one');
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await screen.findByText(/could not be checked here/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'Remove your token?' })).getByRole(
        'button',
        { hidden: true, name: 'Remove token' }
      )
    );
    expect(await screen.findAllByText(/GitHub refused it/)).not.toHaveLength(0);
    expect(screen.queryByText(/could not be checked here/)).toBeNull();
  });

  it('maps only the insufficient and unverifiable capabilities to a notice', () => {
    expect(writeCapabilityNotice('insufficient')?.variant).toBe('warning');
    expect(writeCapabilityNotice('unverifiable')?.variant).toBe('info');
    expect(writeCapabilityNotice('ok')).toBeNull();
    expect(writeCapabilityNotice(undefined)).toBeNull();
  });
});
