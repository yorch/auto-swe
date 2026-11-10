// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { RunEffects } from './RunEffects';

const effect = (over: Record<string, unknown> = {}) => ({
  action: 'create',
  agentKey: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  detail: { number: 7 },
  error: null,
  id: 'e1',
  inputDigest: null,
  kind: 'PULL_REQUEST',
  specNodeId: null,
  status: 'DONE',
  target: 'https://github.com/acme/api/pull/7',
  via: 'activity',
  ...over,
});

function mock(data: unknown[], truncated = false) {
  setupFetchMock({
    'GET /api/v1/workflow-runs/run-1/effects': () => ({ data, truncated }),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunEffects', () => {
  it('lists each effect with its kind, status, linked target and redacted detail', async () => {
    mock([
      effect(),
      effect({
        action: 'push',
        detail: null,
        error: 'remote rejected',
        id: 'e2',
        kind: 'GIT_PUSH',
        status: 'FAILED',
        target: 'auto/JIRA-1',
      }),
    ]);
    render(withQuery(<RunEffects live={false} runId="run-1" />));
    expect(await screen.findByText('Pull request')).toBeTruthy();
    expect(screen.getByText('2 recorded, 1 failed')).toBeTruthy();
    const link = screen.getByText('https://github.com/acme/api/pull/7').closest('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(screen.getByText('{"number":7}')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('remote rejected')).toBeTruthy();
    // A branch is text, not a link.
    expect(screen.getByText('auto/JIRA-1').closest('a')).toBeNull();
  });

  it('shows a sync that wrote nothing as skipped, not as done', async () => {
    mock([effect({ id: 'e3', kind: 'TRACKER', status: 'SKIPPED', target: 'JIRA-1' })]);
    render(withQuery(<RunEffects live={false} runId="run-1" />));
    expect(await screen.findByText('Skipped')).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('renders nothing for a run that changed nothing outside', async () => {
    mock([]);
    const { container } = render(withQuery(<RunEffects live={false} runId="run-1" />));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});
