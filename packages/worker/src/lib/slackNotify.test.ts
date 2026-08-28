import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: async () => process.env.SLACK_BOT_TOKEN ?? null,
  resolveSlackConfig: async () => ({
    botToken: process.env.SLACK_BOT_TOKEN ?? null,
    clientId: null,
    clientSecret: null,
    signingSecret: null,
  }),
  resolveWebUrl: () => 'http://localhost:3000',
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    runInput: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import {
  fetchThreadReplies,
  notifySlackHumanStep,
  notifySlackPrReady,
  notifySlackRunComplete,
  notifySlackStepFailure,
  postSlackThreadMessageReturningTs,
  updateSlackMessage,
} from './slackNotify.js';

const findRun = vi.mocked(prisma.workflowRun.findUnique);
const findTeam = vi.mocked(prisma.team.findUnique);
const findWorkRequest = vi.mocked(prisma.runInput.findUnique);

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  fetchCalls = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    fetchCalls.push({ body: init?.body ? JSON.parse(init.body) : null, url });
    return { json: async () => ({ ok: true, ts: '1.0' }) } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLACK_BOT_TOKEN;
  findRun.mockReset();
  findTeam.mockReset();
  findWorkRequest.mockReset();
});

describe('notifySlackStepFailure', () => {
  it('no-ops when no bot token resolves', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    // Per-workspace token resolution depends on the resolved channel, so the
    // channel is looked up first; the post is still skipped when no token resolves.
    findRun.mockResolvedValue({
      template: { name: 'x' },
      workflowId: 'wf-1',
      workRequest: { activeWorkflows: [], externalTicketId: 'JIRA-1', slackChannelId: 'C1' },
    } as never);
    await notifySlackStepFailure({ attempt: 1, nodeId: 'lint', runId: 'r1' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('throttles to first attempt only', async () => {
    await notifySlackStepFailure({ attempt: 2, nodeId: 'lint', runId: 'r1' });
    expect(fetchCalls).toHaveLength(0);
    expect(findRun).not.toHaveBeenCalled();
  });

  it('posts to the originating Slack channel when set on WorkRequest', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default-engineering' },
      workflowId: 'eng-acme-x-JIRA-7',
      workRequest: {
        activeWorkflows: [],
        externalTicketId: 'JIRA-7',
        slackChannelId: 'C123',
        slackMessageTs: '1700.5',
      },
    } as never);
    await notifySlackStepFailure({
      attempt: 1,
      error: 'lint failed',
      nodeId: 'runLint',
      runId: 'r1',
    });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; thread_ts?: string; text: string };
    expect(body.channel).toBe('C123');
    expect(body.thread_ts).toBe('1700.5');
    expect(body.text).toContain('JIRA-7');
    expect(body.text).toContain('runLint');
    expect(body.text).toContain('default-engineering');
  });

  it('falls back to team.slackNotifyChannel when no originating channel', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default-engineering' },
      workflowId: 'eng-acme-x-JIRA-8',
      workRequest: {
        activeWorkflows: [
          { repository: { teamId: 'team-1' }, temporalWorkflowId: 'eng-acme-x-JIRA-8' },
        ],
        externalTicketId: 'JIRA-8',
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: 'C999' } as never);
    await notifySlackStepFailure({ attempt: 1, nodeId: 'runTests', runId: 'r1' });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; thread_ts?: string };
    expect(body.channel).toBe('C999');
    expect(body.thread_ts).toBeUndefined();
  });

  it('routes to the correct team for cross-repo epics with multiple activeWorkflows', async () => {
    // Two activeWorkflows under one WorkRequest (epic decomposition). The
    // notifier must match the run's workflowId to pick the right team — not
    // arbitrary first row.
    findRun.mockResolvedValue({
      template: { name: 'default-engineering' },
      workflowId: 'eng-acme-y-JIRA-9',
      workRequest: {
        activeWorkflows: [
          { repository: { teamId: 'team-other' }, temporalWorkflowId: 'eng-acme-x-JIRA-9' },
          { repository: { teamId: 'team-target' }, temporalWorkflowId: 'eng-acme-y-JIRA-9' },
        ],
        externalTicketId: 'JIRA-9',
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: 'C-target' } as never);
    await notifySlackStepFailure({ attempt: 1, nodeId: 'runTests', runId: 'r1' });
    expect(findTeam).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'team-target' } })
    );
    expect(fetchCalls).toHaveLength(1);
  });

  it('silently skips when no channel is resolvable', async () => {
    findRun.mockResolvedValue({
      template: { name: 'x' },
      workflowId: 'wf-zzz',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-zzz' }],
        externalTicketId: 'JIRA-9',
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: null } as never);
    await notifySlackStepFailure({ attempt: 1, nodeId: 'runTests', runId: 'r1' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('swallows DB errors without throwing', async () => {
    findRun.mockRejectedValue(new Error('db down'));
    await expect(
      notifySlackStepFailure({ attempt: 1, nodeId: 'runTests', runId: 'r1' })
    ).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('notifySlackPrReady (phase 7)', () => {
  it('no-ops when no bot token resolves', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    // Channel is resolved first (per-workspace token depends on it); the post is
    // still skipped when no token resolves.
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [],
      externalTicketId: 'JIRA-1',
      slackChannelId: 'C-origin',
      slackMessageTs: '1700.5',
    } as never);
    await notifySlackPrReady({
      prNumber: 1,
      prUrl: 'https://github.com/pr/1',
      workRequestId: 'wr-1',
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it('posts to originating channel with PR link', async () => {
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [],
      externalTicketId: 'JIRA-42',
      slackChannelId: 'C-origin',
      slackMessageTs: '1700.5',
    } as never);

    await notifySlackPrReady({
      prNumber: 7,
      prUrl: 'https://github.com/acme/svc/pull/7',
      workRequestId: 'wr-1',
    });

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; thread_ts?: string; text: string };
    expect(body.channel).toBe('C-origin');
    expect(body.thread_ts).toBe('1700.5');
    expect(body.text).toContain('JIRA-42');
    expect(body.text).toContain('#7');
    expect(body.text).toContain('https://github.com/acme/svc/pull/7');
  });

  it('falls back to team channel when no originating channel', async () => {
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [{ repository: { teamId: 'team-1' } }],
      externalTicketId: 'JIRA-43',
      slackChannelId: null,
      slackMessageTs: null,
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: 'C-team' } as never);

    await notifySlackPrReady({
      prNumber: 8,
      prUrl: 'https://github.com/acme/svc/pull/8',
      workRequestId: 'wr-2',
    });

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; thread_ts?: string };
    expect(body.channel).toBe('C-team');
    expect(body.thread_ts).toBeUndefined();
  });

  it('silently skips when no channel is resolvable', async () => {
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [{ repository: { teamId: 'team-1' } }],
      externalTicketId: 'JIRA-44',
      slackChannelId: null,
      slackMessageTs: null,
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: null } as never);

    await notifySlackPrReady({
      prNumber: 9,
      prUrl: 'https://github.com/acme/svc/pull/9',
      workRequestId: 'wr-3',
    });

    expect(fetchCalls).toHaveLength(0);
  });
});

describe('notifySlackRunComplete (phase 8)', () => {
  it('skips when team has not opted in (slackNotifySuccess=false)', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default' },
      workflowId: 'wf-1',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-1' }],
        externalTicketId: 'JIRA-100',
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({
      slackNotifyChannel: 'C-team',
      slackNotifySuccess: false,
    } as never);
    await notifySlackRunComplete({ runId: 'r1', status: 'SUCCESS' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('posts to the originating channel when opt-in is true', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default' },
      workflowId: 'wf-2',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-2' }],
        externalTicketId: 'JIRA-200',
        slackChannelId: 'C-origin',
        slackMessageTs: '1700.5',
      },
    } as never);
    findTeam.mockResolvedValue({
      slackNotifyChannel: null,
      slackNotifySuccess: true,
    } as never);
    await notifySlackRunComplete({ runId: 'r1', status: 'SUCCESS' });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; thread_ts?: string; text: string };
    expect(body.channel).toBe('C-origin');
    expect(body.text).toContain('SUCCESS');
    expect(body.text).toContain('JIRA-200');
  });

  it('falls back to team channel when no originating channel + opt-in is true', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default' },
      workflowId: 'wf-3',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-3' }],
        externalTicketId: 'JIRA-300',
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({
      slackNotifyChannel: 'C-fallback',
      slackNotifySuccess: true,
    } as never);
    await notifySlackRunComplete({ runId: 'r1', status: 'FAILED' });
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { channel: string; text: string };
    expect(body.channel).toBe('C-fallback');
    expect(body.text).toContain('FAILED');
  });

  it('no-ops without SLACK_BOT_TOKEN', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    await notifySlackRunComplete({ runId: 'r1', status: 'SUCCESS' });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('postSlackThreadMessageReturningTs / updateSlackMessage (Phase 4 live-progress)', () => {
  it('posts a threaded message and returns the Slack ts', async () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ body: init?.body ? JSON.parse(init.body) : null, url });
      return { json: async () => ({ ok: true, ts: '171.42' }) } as unknown as Response;
    }) as typeof fetch;

    const result = await postSlackThreadMessageReturningTs('C1', '100.1', 'working…');

    expect(result).toEqual({ ts: '171.42' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    const body = fetchCalls[0]?.body as { channel: string; thread_ts: string; text: string };
    expect(body.channel).toBe('C1');
    expect(body.thread_ts).toBe('100.1');
    expect(body.text).toBe('working…');
  });

  it('throws when Slack returns ok but no ts', async () => {
    globalThis.fetch = (async () =>
      ({ json: async () => ({ ok: true }) }) as unknown as Response) as typeof fetch;

    await expect(postSlackThreadMessageReturningTs('C1', '100.1', 'x')).rejects.toThrow(
      /no message ts/
    );
  });

  it('throws on a missing bot token', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    await expect(postSlackThreadMessageReturningTs('C1', '100.1', 'x')).rejects.toThrow(
      /no Slack bot token/
    );
  });

  it('updateSlackMessage edits in place via chat.update', async () => {
    await updateSlackMessage('C1', '171.42', 'the final answer');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://slack.com/api/chat.update');
    const body = fetchCalls[0]?.body as { channel: string; ts: string; text: string };
    expect(body.channel).toBe('C1');
    expect(body.ts).toBe('171.42');
    expect(body.text).toBe('the final answer');
  });

  it('updateSlackMessage throws on a {ok:false} response', async () => {
    globalThis.fetch = (async () =>
      ({
        json: async () => ({ error: 'message_not_found', ok: false }),
      }) as unknown as Response) as typeof fetch;

    await expect(updateSlackMessage('C1', '1.0', 'x')).rejects.toThrow(/message_not_found/);
  });
});

describe('fetchThreadReplies (thread-history context)', () => {
  it('returns messages oldest→newest on a successful call', async () => {
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push({ body: null, url });
      return {
        json: async () => ({
          messages: [
            { text: 'first', user: 'U1' },
            { text: 'second', user: 'U2' },
          ],
          ok: true,
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const out = await fetchThreadReplies('C1', '100.1', 10);

    expect(out).toEqual([
      { text: 'first', user: 'U1' },
      { text: 'second', user: 'U2' },
    ]);
    // Hits conversations.replies with the channel + ts + limit as query params.
    expect(fetchCalls[0]?.url).toContain('https://slack.com/api/conversations.replies');
    expect(fetchCalls[0]?.url).toContain('channel=C1');
    expect(fetchCalls[0]?.url).toContain('ts=100.1');
    expect(fetchCalls[0]?.url).toContain('limit=10');
  });

  it('maps a bot message (no user) onto its bot_id', async () => {
    globalThis.fetch = (async () =>
      ({
        json: async () => ({ messages: [{ bot_id: 'B9', text: 'from the bot' }], ok: true }),
      }) as unknown as Response) as typeof fetch;

    const out = await fetchThreadReplies('C1', '100.1');
    expect(out).toEqual([{ text: 'from the bot', user: 'B9' }]);
  });

  it('returns [] (never throws) on an unauthorized {ok:false} response (missing scope)', async () => {
    globalThis.fetch = (async () =>
      ({
        json: async () => ({ error: 'missing_scope', ok: false }),
      }) as unknown as Response) as typeof fetch;

    await expect(fetchThreadReplies('C1', '100.1')).resolves.toEqual([]);
  });

  it('returns [] on a thrown / hung fetch', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    await expect(fetchThreadReplies('C1', '100.1')).resolves.toEqual([]);
  });

  it('returns [] when no bot token is configured', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const out = await fetchThreadReplies('C1', '100.1');
    expect(out).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('notifySlackHumanStep (Block Kit resolve buttons)', () => {
  interface Button {
    type: string;
    action_id: string;
    text: { type: string; text: string };
    value?: string;
    url?: string;
    style?: string;
  }

  function mockChannelResolution() {
    findRun.mockResolvedValue({
      template: { name: 'default-engineering' },
      workflowId: 'eng-acme-x-JIRA-1',
      workRequest: {
        activeWorkflows: [],
        externalTicketId: 'JIRA-1',
        slackChannelId: 'C123',
        slackMessageTs: null,
      },
    } as never);
  }

  function postedBlocks(): { text: string; buttons: Button[] } {
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as { text: string; blocks: Array<Record<string, unknown>> };
    expect(Array.isArray(body.blocks)).toBe(true);
    const actions = body.blocks.find((b) => b.type === 'actions') as { elements: Button[] };
    expect(actions).toBeDefined();
    return { buttons: actions.elements, text: body.text };
  }

  function resolveButtons(buttons: Button[]): Button[] {
    return buttons.filter((b) => b.action_id.startsWith('hitl_resolve'));
  }

  it('APPROVAL: attaches Approve/Reject buttons with {stepId, action} values + inbox link', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      kind: 'APPROVAL',
      runId: 'r1',
      stepId: 'step-1',
      title: 'Approve plan',
    });

    const { buttons } = postedBlocks();
    const resolve = resolveButtons(buttons);
    expect(resolve).toHaveLength(2);

    const approve = resolve.find((b) => b.text.text === 'Approve');
    expect(approve?.style).toBe('primary');
    expect(JSON.parse(approve?.value ?? '{}')).toEqual({ action: 'approve', stepId: 'step-1' });

    const reject = resolve.find((b) => b.text.text === 'Reject');
    expect(reject?.style).toBe('danger');
    expect(JSON.parse(reject?.value ?? '{}')).toEqual({ action: 'reject', stepId: 'step-1' });

    // Inbox link button always present.
    const inbox = buttons.find((b) => b.action_id === 'open_inbox');
    expect(inbox?.url).toContain('/inbox');
  });

  it('DECISION: one select button per option, label truncated, value carried verbatim', async () => {
    mockChannelResolution();
    const longLabel = 'x'.repeat(200);
    await notifySlackHumanStep({
      kind: 'DECISION',
      options: [
        { label: 'Ship it', value: 'ship' },
        { label: longLabel, value: 'hold' },
      ],
      runId: 'r1',
      stepId: 'step-2',
      title: 'Pick a path',
    });

    const { buttons } = postedBlocks();
    const resolve = resolveButtons(buttons);
    expect(resolve).toHaveLength(2);
    expect(JSON.parse(resolve[0]?.value ?? '{}')).toEqual({
      action: 'select',
      stepId: 'step-2',
      value: 'ship',
    });
    // Long labels are truncated to Slack's 75-char button text limit; the
    // option VALUE must stay intact (it's what the workflow receives).
    expect(resolve[1]?.text.text.length).toBeLessThanOrEqual(75);
    expect(JSON.parse(resolve[1]?.value ?? '{}').value).toBe('hold');
  });

  it('DECISION: skips a button whose value payload would exceed Slack 2000-char cap', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      kind: 'DECISION',
      options: [
        { label: 'Fine', value: 'ok' },
        { label: 'Huge', value: 'y'.repeat(3000) },
      ],
      runId: 'r1',
      stepId: 'step-3',
      title: 'Pick',
    });

    const { buttons } = postedBlocks();
    const resolve = resolveButtons(buttons);
    expect(resolve).toHaveLength(1);
    expect(JSON.parse(resolve[0]?.value ?? '{}').value).toBe('ok');
  });

  it('INPUT: stays link-only (no resolve buttons), inbox button present', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      kind: 'INPUT',
      runId: 'r1',
      stepId: 'step-4',
      title: 'Provide credentials note',
    });

    const { buttons } = postedBlocks();
    expect(resolveButtons(buttons)).toHaveLength(0);
    expect(buttons.find((b) => b.action_id === 'open_inbox')).toBeDefined();
  });

  it('REVIEW: stays link-only (free-form submit payload)', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      kind: 'REVIEW',
      runId: 'r1',
      stepId: 'step-5',
      title: 'Review the diff',
    });

    const { buttons } = postedBlocks();
    expect(resolveButtons(buttons)).toHaveLength(0);
  });

  it('degrades to link-only when stepId is unknown', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({ kind: 'APPROVAL', runId: 'r1', title: 'Approve plan' });

    const { buttons, text } = postedBlocks();
    expect(resolveButtons(buttons)).toHaveLength(0);
    expect(buttons.find((b) => b.action_id === 'open_inbox')).toBeDefined();
    // Plain-text fallback keeps the inbox link for clients that drop blocks.
    expect(text).toContain('/inbox');
  });
});
