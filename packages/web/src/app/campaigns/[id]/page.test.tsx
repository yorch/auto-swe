// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
const useCampaign = vi.fn();
const action = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  pause: vi.fn(),
  remove: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  takeover: vi.fn(),
}));
const mutation = vi.hoisted(() => (fn: ReturnType<typeof vi.fn>) => () => ({
  isPending: false,
  mutateAsync: fn,
}));
vi.mock('@/hooks/useCampaigns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCampaigns')>()),
  useCampaign: (...args: unknown[]) => useCampaign(...args),
  useCancelCampaign: mutation(action.cancel),
  useConfirmCampaign: mutation(action.confirm),
  usePauseCampaign: mutation(action.pause),
  useRemoveCampaignTarget: mutation(action.remove),
  useResumeCampaign: mutation(action.resume),
  useRetryCampaignTarget: mutation(action.retry),
  useTakeOverCampaign: mutation(action.takeover),
}));
vi.mock('@/hooks/useRuns', () => ({
  useRunsForWorkRequest: () => ({
    data: [{ id: 'run-legacy', workflowId: 'campaign-c1-conn-3' }],
    isSuccess: true,
  }),
}));
vi.mock('@/hooks/useWorkViews', () => ({
  usePullRequests: () => ({ data: [{ id: 'pr-9', repository: { id: 'conn-1' } }] }),
}));
// `led`: the server says the caller holds `team.launch.multi-repo` on the campaign's owning team.
const auth = vi.hoisted(() => ({
  led: false,
  user: { email: 'lead@acme.test', role: 'USER', sub: 'someone-else' } as {
    email: string;
    role: string;
    sub: string;
  },
}));
vi.mock('@/hooks/useCan', () => ({ useCan: () => auth.led }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (s: { user: typeof auth.user }) => unknown) => select({ user: auth.user }),
}));

import CampaignDetailPage from './page';

const AGO = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function target(over: Record<string, unknown>) {
  return {
    attempts: [],
    blockedReason: null,
    brief: null,
    childWorkflowId: null,
    connectionId: null,
    delivery: null,
    dependsOn: [],
    evidence: null,
    failureReason: null,
    finishedAt: null,
    lastCheckedAt: null,
    lastCheckedSha: null,
    liveStatus: null,
    path: null,
    position: 0,
    prNumber: null,
    prUrl: null,
    regressions: 0,
    staleSince: null,
    startedAt: null,
    verification: null,
    ...over,
  };
}

const CAMPAIGN = {
  budgetUsd: null,
  cancelledAt: null,
  cancelledById: null,
  completedAt: null,
  counts: {
    blocked: 1,
    cancelled: 0,
    merged: 0,
    needsAttention: 1,
    pending: 0,
    prOpened: 1,
    running: 0,
    satisfied: 1,
    skipped: 0,
    total: 4,
  },
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: { id: 'creator', name: 'Ada' },
  createdById: 'creator',
  description: 'Raise lodash everywhere',
  expiresAt: null,
  gate: 'OPENED',
  hiddenTargetCount: 2,
  id: 'c1',
  launchedById: 'creator',
  launcherChangedAt: null,
  maxOpenPullRequests: null,
  maxParallel: 3,
  name: 'Raise lodash',
  orgId: 'o1',
  ownerTeam: { id: 't1', name: 'Payments' },
  ownerTeamId: 't1',
  pausedReason: null,
  plan: 'UNIFORM',
  proposals: [],
  recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
  recipeRef: 'npm-dependency@2',
  rescanIntervalHours: null,
  scopeId: null,
  scopeKind: null,
  staleAfterDays: null,
  state: 'ACTIVE',
  targets: [
    target({
      attempts: [
        {
          childWorkflowId: 'campaign-c1-conn-1',
          failureReason: null,
          finishedAt: AGO(70),
          id: 'a1',
          n: 1,
          outcome: 'PR_OPENED',
          path: 'RECIPE',
          runId: 'run-1',
          startedAt: AGO(72),
          verification: 'PASSED',
        },
      ],
      connectionId: 'conn-1',
      delivery: {
        ciStatus: 'SUCCESS',
        isDraft: true,
        mergedAt: null,
        openedAt: AGO(24 * 12),
        prNumber: 12,
        prUrl: 'https://github.com/acme/api/pull/12',
        status: 'OPEN',
      },
      id: 't-api',
      position: 0,
      repoLabel: 'acme/api',
      staleSince: AGO(24 * 5),
      state: 'PR_OPENED',
    }),
    target({
      attempts: [
        {
          childWorkflowId: 'campaign-c1-conn-2',
          failureReason: 'tests failed',
          finishedAt: AGO(30),
          id: 'a2',
          n: 1,
          outcome: 'FAILED',
          path: 'AGENT',
          runId: null,
          startedAt: AGO(31),
          verification: 'FAILED',
        },
        {
          childWorkflowId: 'campaign-c1-conn-2b',
          failureReason: 'tests failed again',
          finishedAt: AGO(2),
          id: 'a3',
          n: 2,
          outcome: 'FAILED',
          path: 'AGENT',
          runId: 'run-2',
          startedAt: AGO(3),
          verification: 'FAILED',
        },
      ],
      failureReason: 'tests failed again',
      id: 't-web',
      position: 1,
      repoLabel: 'acme/web',
      state: 'NEEDS_ATTENTION',
    }),
    target({
      blockedReason: {
        kind: 'waiting-upstream',
        text: 'Waits for acme/api to be reviewed.',
        upstreamId: 't-api',
        upstreamLabel: 'acme/api',
      },
      dependsOn: ['t-api'],
      id: 't-docs',
      position: 2,
      repoLabel: 'acme/docs',
      state: 'BLOCKED',
    }),
    target({
      evidence: { kind: 'initial' },
      id: 't-old',
      lastCheckedAt: AGO(1),
      position: 3,
      repoLabel: 'acme/old',
      state: 'NOT_AFFECTED',
    }),
  ],
  templateId: 'tpl',
  templateVersion: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  workflowKind: 'RECONCILER',
  workRequestId: 'wr1',
};

const PARAMS = Promise.resolve({ id: '0b1c2d3e-0000-4000-8000-000000000001' });

function show(campaign: Record<string, unknown> = CAMPAIGN) {
  useCampaign.mockReturnValue({ data: campaign, error: null, isLoading: false, refetch: vi.fn() });
}

async function renderPage() {
  await act(async () => {
    render(
      withQuery(
        <Suspense fallback={null}>
          <CampaignDetailPage params={PARAMS} />
        </Suspense>
      )
    );
  });
}

/** Click the primary button of the open dialog (the one that is not the page's own trigger). */
async function confirmDialog(name: string) {
  const dialog = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name }));
  });
}

afterEach(() => {
  cleanup();
  useCampaign.mockReset();
  for (const fn of Object.values(action)) {
    fn.mockReset();
  }
  auth.led = false;
  auth.user = { email: 'lead@acme.test', role: 'USER', sub: 'someone-else' };
});

describe('Campaign detail page: targets', () => {
  it('groups targets by what the reader needs, in order', async () => {
    show();
    await renderPage();
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Needs attention (1)',
      'In review (1)',
      'Running or blocked (1)',
      'Satisfied (1)',
    ]);
    const attention = screen.getByRole('region', { name: /Needs attention/ });
    expect(within(attention).getByText('acme/web')).toBeTruthy();
    // Once on the row, once in the attempt that failed.
    expect(within(attention).getAllByText('tests failed again')).toHaveLength(2);
  });

  it('links each repository to its latest run and its draft to the review page', async () => {
    show();
    await renderPage();
    expect(screen.getByRole('link', { name: 'acme/api' }).getAttribute('href')).toBe('/runs/run-1');
    expect(screen.getByRole('link', { name: 'acme/web' }).getAttribute('href')).toBe('/runs/run-2');
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
      '/pull-requests/pr-9'
    );
    // No run is known for the blocked repository, so it is plain text.
    expect(screen.queryByRole('link', { name: 'acme/docs' })).toBeNull();
  });

  it('finds a legacy attempt’s run through the work request', async () => {
    show({
      ...CAMPAIGN,
      targets: [
        target({
          attempts: [
            {
              childWorkflowId: 'campaign-c1-conn-3',
              failureReason: null,
              finishedAt: null,
              id: 'a',
              n: 1,
              outcome: null,
              path: null,
              runId: null,
              startedAt: AGO(1),
              verification: null,
            },
          ],
          id: 't-legacy',
          repoLabel: 'acme/legacy',
          state: 'RUNNING',
        }),
      ],
    });
    await renderPage();
    expect(screen.getByRole('link', { name: 'acme/legacy' }).getAttribute('href')).toBe(
      '/runs/run-legacy'
    );
  });

  it('shows delivery detail and the age of a stale pull request', async () => {
    show();
    await renderPage();
    const delivery = screen.getByTestId('delivery');
    expect(delivery.textContent).toMatch(/#12 · Open · Draft · CI success · opened/);
    expect(delivery.textContent).toMatch(/Stale: open since/);
    expect(delivery.querySelectorAll('time').length).toBe(2);
  });

  it('names what a blocked target waits for and links to it', async () => {
    show();
    await renderPage();
    const reason = screen.getByTestId('blocked-reason');
    expect(reason.textContent).toContain('Waiting for an upstream repository.');
    expect(reason.textContent).toContain('Waits for acme/api to be reviewed.');
    expect(screen.queryByText('Waits for acme/api', { exact: true })).toBeNull();
  });

  it('adds the upstream’s name when the gateway’s text does not carry it', async () => {
    show({
      ...CAMPAIGN,
      targets: [
        target({
          blockedReason: {
            kind: 'upstream-failed',
            text: 'An upstream repository needs attention.',
            upstreamId: 't-api',
            upstreamLabel: 'acme/api',
          },
          id: 't-docs',
          repoLabel: 'acme/docs',
          state: 'BLOCKED',
        }),
        target({ id: 't-api', position: 1, repoLabel: 'acme/api', state: 'NEEDS_ATTENTION' }),
      ],
    });
    await renderPage();
    const link = within(screen.getByTestId('blocked-reason')).getByRole('link', {
      name: 'acme/api',
    });
    expect(link.getAttribute('href')).toBe('#target-t-api');
  });

  it('keeps the attempts history of a target, newest last', async () => {
    show();
    await renderPage();
    const row = screen.getByRole('region', { name: /Needs attention/ });
    expect(within(row).getByText('Attempts (2)')).toBeTruthy();
    const items = within(row)
      .getAllByText(/^Attempt \d$/)
      .map((e) => e.textContent);
    expect(items).toEqual(['Attempt 1', 'Attempt 2']);
    expect(within(row).getByText('tests failed')).toBeTruthy();
  });

  it('reads a retired target state as the state that replaced it', async () => {
    show();
    await renderPage();
    const satisfied = screen.getByRole('region', { name: /Satisfied/ });
    // The group's heading and the row's badge.
    expect(within(satisfied).getAllByText('Satisfied', { exact: false }).length).toBeGreaterThan(1);
    expect(
      within(satisfied).getByText(/Already satisfied before the campaign started/)
    ).toBeTruthy();
  });

  it('shows progress as satisfied over total and counts hidden repositories', async () => {
    show();
    await renderPage();
    const meter = screen.getByRole('progressbar', { name: 'Repositories satisfied' });
    expect(meter.getAttribute('aria-valuenow')).toBe('1');
    expect(meter.getAttribute('aria-valuemax')).toBe('4');
    expect(screen.getByTestId('campaign-hidden-targets').textContent).toMatch(/2 repositories/);
  });

  it('lists repositories discovery found but the launcher may not start in, with the reason', async () => {
    show({
      ...CAMPAIGN,
      proposals: [
        {
          connectionId: 'conn-9',
          createdAt: AGO(5),
          decidedAt: null,
          id: 'p1',
          reason: 'The launcher does not lead the team that owns this repository.',
          repoLabel: 'acme/billing',
        },
      ],
    });
    await renderPage();
    expect(screen.getByText('Found, not started')).toBeTruthy();
    expect(screen.getByText('acme/billing')).toBeTruthy();
    expect(screen.getByText(/does not lead the team that owns/)).toBeTruthy();
  });
});

describe('Campaign detail page: banners', () => {
  it('says why a paused campaign is paused', async () => {
    show({ ...CAMPAIGN, pausedReason: 'launcher-unavailable', state: 'PAUSED' });
    await renderPage();
    expect(screen.getByText('This campaign is paused')).toBeTruthy();
    expect(screen.getByText(/no longer available: their account was deactivated/)).toBeTruthy();
  });

  it('explains monitoring', async () => {
    show({ ...CAMPAIGN, rescanIntervalHours: 24, state: 'MONITORING' });
    await renderPage();
    expect(screen.getAllByText('Monitoring')).toHaveLength(2);
    expect(screen.getByText(/Every known repository satisfies the goal/).textContent).toMatch(
      /every 24 hours/
    );
  });
});

describe('Campaign detail page: cancel', () => {
  it('hides cancel from someone who may not cancel', async () => {
    show();
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Cancel campaign' })).toBeNull();
  });

  it('lets the creator cancel after confirming', async () => {
    stubDialogPrototype();
    auth.user = { email: 'a@acme.test', role: 'USER', sub: 'creator' };
    action.cancel.mockResolvedValue({});
    show();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel campaign' }));
    expect(action.cancel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel campaign' }).at(-1) as Element);
    });
    expect(action.cancel).toHaveBeenCalledTimes(1);
  });

  it('lets whoever holds the capability on the owning team cancel, and re-send a cancel', async () => {
    auth.led = true;
    show();
    await renderPage();
    expect(screen.getByRole('button', { name: 'Cancel campaign' })).toBeTruthy();
    cleanup();
    show({ ...CAMPAIGN, state: 'CANCELLING' });
    await renderPage();
    expect(screen.getByRole('button', { name: 'Send cancel again' })).toBeTruthy();
  });

  it('offers no action once the campaign is final', async () => {
    auth.led = true;
    show({ ...CAMPAIGN, state: 'COMPLETED' });
    await renderPage();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /pause|resume|take over|retry|remove/i })
    ).toBeNull();
  });

  it('offers a legacy campaign cancel but none of the tracked-campaign actions', async () => {
    auth.led = true;
    show({
      ...CAMPAIGN,
      counts: { ...CAMPAIGN.counts, prOpened: 3 },
      state: 'RUNNING',
      targets: [target({ id: 't-fail', repoLabel: 'acme/web', state: 'FAILED' })],
      workflowKind: 'LEGACY',
    });
    await renderPage();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel campaign' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    // A legacy FAILED row reads as needing attention.
    expect(
      within(screen.getByRole('region', { name: /Needs attention/ })).getByText('acme/web')
    ).toBeTruthy();
  });
});

describe('Campaign detail page: pause, resume, take over', () => {
  it('shows pause to someone who may manage the campaign, not to anyone else', async () => {
    show();
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    cleanup();
    auth.led = true;
    show();
    await renderPage();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('pauses after a confirmation', async () => {
    stubDialogPrototype();
    auth.led = true;
    action.pause.mockResolvedValue({});
    show();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(action.pause).not.toHaveBeenCalled();
    await confirmDialog('Pause campaign');
    expect(action.pause).toHaveBeenCalledTimes(1);
  });

  it('resumes a paused campaign after a confirmation', async () => {
    stubDialogPrototype();
    auth.user = { email: 'a@acme.test', role: 'USER', sub: 'creator' };
    action.resume.mockResolvedValue({});
    show({ ...CAMPAIGN, pausedReason: 'manual', state: 'PAUSED' });
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await confirmDialog('Resume campaign');
    expect(action.resume).toHaveBeenCalledTimes(1);
  });

  it('shows the gateway’s refusal in the dialog', async () => {
    stubDialogPrototype();
    auth.led = true;
    action.pause.mockRejectedValue(
      new ApiError('Campaign is not active', 409, 'CAMPAIGN_NOT_ACTIVE')
    );
    show();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await confirmDialog('Pause campaign');
    expect(within(screen.getByRole('dialog')).getByText('Campaign is not active')).toBeTruthy();
  });

  it('offers take over to a lead who is not the launcher, saying who it runs as and what is skipped', async () => {
    stubDialogPrototype();
    auth.led = true;
    action.takeover.mockResolvedValue({});
    show({ ...CAMPAIGN, pausedReason: 'launcher-unavailable', state: 'PAUSED' });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('you (lead@acme.test)');
    expect(dialog.textContent).toMatch(/Repositories you cannot reach are skipped/);
    await confirmDialog('Take over campaign');
    expect(action.takeover).toHaveBeenCalledTimes(1);
  });

  it('never offers take over to the current launcher, nor to a creator who leads nothing', async () => {
    auth.led = true;
    auth.user = { email: 'a@acme.test', role: 'USER', sub: 'creator' };
    show();
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    cleanup();
    auth.led = false;
    auth.user = { email: 'b@acme.test', role: 'USER', sub: 'creator' };
    show({ ...CAMPAIGN, launchedById: 'someone-else-entirely' });
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });
});

describe('Campaign detail page: per-target actions', () => {
  it('offers retry only for a target that needs a person, and remove for one still in play', async () => {
    auth.led = true;
    show();
    await renderPage();
    expect(screen.getByRole('button', { name: 'Retry acme/web' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry acme/api' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove acme/api' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove acme/docs' })).toBeTruthy();
    // Satisfied is final: nothing to remove.
    expect(screen.queryByRole('button', { name: 'Remove acme/old' })).toBeNull();
  });

  it('hides target actions from someone who may not manage the campaign', async () => {
    show();
    await renderPage();
    expect(screen.queryByRole('button', { name: /^(Retry|Remove) / })).toBeNull();
  });

  it('retries a target after a confirmation that says which one', async () => {
    stubDialogPrototype();
    auth.led = true;
    action.retry.mockResolvedValue({});
    show();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Retry acme/web' }));
    expect(action.retry).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('acme/web');
    await confirmDialog('Retry repository');
    expect(action.retry).toHaveBeenCalledWith('t-web');
  });

  it('removes a target after a confirmation that says nothing on the host is touched', async () => {
    stubDialogPrototype();
    auth.led = true;
    action.remove.mockResolvedValue({});
    show();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme/docs' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/Nothing on the host is touched/);
    await confirmDialog('Remove repository');
    expect(action.remove).toHaveBeenCalledWith('t-docs');
  });
});

describe('Campaign detail page: planning', () => {
  const PLANNING = {
    ...CAMPAIGN,
    counts: {
      ...CAMPAIGN.counts,
      blocked: 0,
      needsAttention: 0,
      pending: 2,
      prOpened: 0,
      satisfied: 0,
      total: 2,
    },
    plan: 'PLANNED',
    state: 'PLANNING',
    targets: [
      target({
        brief: 'Move the auth client to v2.',
        id: 't-auth',
        position: 0,
        repoLabel: 'acme/auth',
        state: 'PENDING',
      }),
      target({
        brief: 'Update the web app to call v2.',
        dependsOn: ['t-auth'],
        id: 't-web',
        position: 1,
        repoLabel: 'acme/web',
        state: 'PENDING',
      }),
    ],
  };

  it('shows the planner’s briefs and the order between repositories', async () => {
    show(PLANNING);
    await renderPage();
    expect(screen.getByText('Move the auth client to v2.')).toBeTruthy();
    expect(screen.getByText('Update the web app to call v2.')).toBeTruthy();
    expect(screen.getByText(/Starts first/)).toBeTruthy();
    const after = screen.getByText(/Starts after/);
    expect(within(after).getByRole('link', { name: 'acme/auth' }).getAttribute('href')).toBe(
      '#target-t-auth'
    );
    expect(screen.getAllByText('Awaiting confirmation')).toHaveLength(2);
    expect(screen.getByText(/Nothing starts until the person who started this/)).toBeTruthy();
  });

  it('lets the launcher confirm, and explains why editing is not available', async () => {
    stubDialogPrototype();
    auth.user = { email: 'a@acme.test', role: 'USER', sub: 'creator' };
    action.confirm.mockResolvedValue({});
    show(PLANNING);
    await renderPage();
    const edit = screen.getByRole('button', {
      name: 'Edit before confirming',
    }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    const reason = document.getElementById(edit.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toMatch(/not available yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and start' }));
    expect(action.confirm).not.toHaveBeenCalled();
    await confirmDialog('Confirm and start');
    expect(action.confirm).toHaveBeenCalledTimes(1);
  });

  it('leaves confirmation to the launcher', async () => {
    auth.led = true;
    show(PLANNING);
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Confirm and start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit before confirming' })).toBeNull();
    expect(
      screen.getByText(/Only the person who started this campaign can confirm it/)
    ).toBeTruthy();
    // A lead may still cancel a plan they do not want.
    expect(screen.getByRole('button', { name: 'Cancel campaign' })).toBeTruthy();
  });
});

describe('Campaign detail page: loading', () => {
  it('says not found for a campaign the gateway does not show', async () => {
    useCampaign.mockReturnValue({
      data: undefined,
      error: new ApiError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND'),
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText('Campaign not found')).toBeTruthy();
  });

  it('offers a retry when the campaign fails to load', async () => {
    const refetch = vi.fn();
    useCampaign.mockReturnValue({
      data: undefined,
      error: new Error('gateway down'),
      isLoading: false,
      refetch,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
