import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: async () => process.env.SLACK_BOT_TOKEN ?? null,
  resolveSlackConfig: async () => ({
    botToken: process.env.SLACK_BOT_TOKEN ?? null,
    clientId: null,
    clientSecret: null,
    signingSecret: null,
  }),
  resolveWebUrl: () => process.env.TEST_WEB_URL ?? 'http://localhost:3000',
}));

vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  approvedRepositoryHosts: async () =>
    (process.env.TEST_REPO_HOSTS ?? '').split(',').filter(Boolean),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    runInput: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    workflowHumanStep: { update: vi.fn() },
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
  postSlackChannelMessage,
  postSlackThreadMessage,
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
  delete process.env.TEST_WEB_URL;
  delete process.env.TEST_REPO_HOSTS;
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
      template: { name: 'ticket-to-merge' },
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
    expect(body.text).toContain('ticket-to-merge');
  });

  it('falls back to team.slackNotifyChannel when no originating channel', async () => {
    findRun.mockResolvedValue({
      template: { name: 'ticket-to-merge' },
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
      template: { name: 'ticket-to-merge' },
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

  it('posts a card with the run stats and an Open run link, keeping the text fallback', async () => {
    findRun.mockResolvedValue({
      costUsdAccrued: 0.42,
      endedAt: new Date('2026-06-01T00:03:12Z'),
      startedAt: new Date('2026-06-01T00:00:00Z'),
      template: { name: 'default' },
      workflowId: 'wf-card',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-card' }],
        externalTicketId: 'JIRA-210',
        slackChannelId: 'C-origin',
        slackMessageTs: '1700.5',
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: null, slackNotifySuccess: true } as never);

    await notifySlackRunComplete({ runId: 'run 1', status: 'FAILED' });

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body as {
      text: string;
      thread_ts?: string;
      blocks: Array<{
        type: string;
        fields?: Array<{ text: string }>;
        elements?: Array<{ url: string }>;
      }>;
    };
    expect(body.thread_ts).toBe('1700.5');
    expect(body.text).toContain('JIRA-210');
    expect(body.text).toContain('FAILED');
    expect(body.blocks.map((b) => b.type)).toEqual(['section', 'section', 'actions']);
    expect(body.blocks[1]?.fields?.map((f) => f.text)).toEqual([
      '*Status*\nFAILED',
      '*Duration*\n3m 12s',
      '*Cost*\n$0.42',
    ]);
    // The run id is path-encoded, and the link stays on the dashboard host.
    expect(body.blocks[2]?.elements?.[0]?.url).toBe('http://localhost:3000/runs/run%201');
  });

  it('still posts a card when the run row has no timing or cost', async () => {
    findRun.mockResolvedValue({
      template: { name: 'default' },
      workflowId: 'wf-bare',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-bare' }],
        externalTicketId: 'JIRA-211',
        slackChannelId: 'C-origin',
        slackMessageTs: null,
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: null, slackNotifySuccess: true } as never);

    await notifySlackRunComplete({ runId: 'r2', status: 'SUCCESS' });

    const body = fetchCalls[0]?.body as { blocks: Array<{ fields?: Array<{ text: string }> }> };
    expect(body.blocks[1]?.fields?.map((f) => f.text)).toEqual(['*Status*\nSUCCESS']);
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
      template: { name: 'ticket-to-merge' },
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

  it('escapes Slack control characters in the title and description of any step', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      description: 'see <https://evil.example|the docs> & <@U123>',
      kind: 'INPUT',
      runId: 'r1',
      title: '<!channel> agent needs input',
    });
    const body = fetchCalls[0]?.body as { text: string };
    expect(body.text).toContain('&lt;!channel&gt; agent needs input');
    expect(body.text).toContain('see &lt;https://evil.example|the docs&gt; &amp; &lt;@U123&gt;');
    expect(body.text).not.toContain('<!channel>');
    expect(body.text).not.toContain('<https://evil.example');
    // The inbox link the notifier adds itself is still a link.
    expect(body.text).toMatch(/<https?:\/\/[^>|]*\/approvals\|Open approvals/);
  });

  it('records where the step message landed so its resolution can edit it', async () => {
    mockChannelResolution();
    const update = vi.mocked(prisma.workflowHumanStep.update);
    update.mockReset();
    globalThis.fetch = (async () =>
      ({
        json: async () => ({ channel: 'C123', ok: true, ts: '99.1' }),
      }) as unknown as Response) as typeof fetch;
    await notifySlackHumanStep({
      kind: 'APPROVAL',
      runId: 'r1',
      stepId: 'step-1',
      title: 'Approve plan',
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        slackMessage: {
          channel: 'C123',
          text: '*[JIRA-1]* *Approval required:* Approve plan',
          ts: '99.1',
        },
      },
      where: { id: 'step-1' },
    });
  });

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
    expect(inbox?.url).toContain('/approvals');
  });

  it('APPROVAL: adds a Request changes button between Approve and Reject only with the marker', async () => {
    mockChannelResolution();
    await notifySlackHumanStep({
      kind: 'APPROVAL',
      options: [{ label: 'Request changes', value: 'request_changes' }],
      runId: 'r1',
      stepId: 'step-1',
      title: 'Approve plan',
    });
    const { buttons } = postedBlocks();
    const resolve = resolveButtons(buttons);
    expect(resolve.map((b) => b.text.text)).toEqual(['Approve', 'Request changes', 'Reject']);
    const rc = resolve[1];
    expect(rc?.style).toBeUndefined();
    expect(JSON.parse(rc?.value ?? '{}')).toEqual({
      action: 'request_changes',
      stepId: 'step-1',
    });

    // No marker -> the two-button shape is unchanged.
    fetchCalls.length = 0;
    await notifySlackHumanStep({
      kind: 'APPROVAL',
      runId: 'r1',
      stepId: 'step-1',
      title: 'Approve plan',
    });
    expect(resolveButtons(postedBlocks().buttons)).toHaveLength(2);
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
    expect(text).toContain('/approvals');
  });
});

describe('text from outside the platform is escaped before it goes into a notice', () => {
  const EVIL = '<!channel> <@U999> <https://evil.example|click> & co';
  const ESC = '&lt;!channel&gt; &lt;@U999&gt; &lt;https://evil.example|click&gt; &amp; co';

  function firstBody<T>(): T {
    const call = fetchCalls[0];
    if (!call) {
      throw new Error('expected a Slack call');
    }
    return call.body as T;
  }

  function runWith(overrides: {
    ticket?: string;
    template?: string;
    slackMessageTs?: string | null;
  }) {
    findRun.mockResolvedValue({
      template: { name: overrides.template ?? 'default' },
      workflowId: 'wf-esc',
      workRequest: {
        activeWorkflows: [{ repository: { teamId: 'team-1' }, temporalWorkflowId: 'wf-esc' }],
        externalTicketId: overrides.ticket ?? 'JIRA-1',
        slackChannelId: 'C-origin',
        slackMessageTs: overrides.slackMessageTs ?? null,
      },
    } as never);
    findTeam.mockResolvedValue({ slackNotifyChannel: null, slackNotifySuccess: true } as never);
  }

  it('step failure: ticket, template, node id and error text', async () => {
    runWith({ template: EVIL, ticket: EVIL });
    await notifySlackStepFailure({ attempt: 1, error: EVIL, nodeId: EVIL, runId: 'r1' });

    const text = firstBody<{ text: string }>().text;
    expect(text).not.toMatch(/<[!@h]/);
    expect(text.split(ESC)).toHaveLength(5);
  });

  it('step failure: cuts a long error before escaping, never inside an entity', async () => {
    runWith({});
    await notifySlackStepFailure({
      attempt: 1,
      error: '&'.repeat(1000),
      nodeId: 'lint',
      runId: 'r1',
    });

    const text = firstBody<{ text: string }>().text;
    expect(text).not.toMatch(/&(?!amp;)/);
  });

  it('PR ready: the ticket is escaped and the PR link is left as it is', async () => {
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [],
      externalTicketId: EVIL,
      slackChannelId: 'C-origin',
      slackMessageTs: '1700.5',
    } as never);
    await notifySlackPrReady({
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      workRequestId: 'wr-1',
    });

    const text = firstBody<{ text: string }>().text;
    expect(text).toContain(ESC);
    expect(text).not.toMatch(/<[!@h]/);
    expect(text).toContain('https://github.com/o/r/pull/7');
  });

  it('human step: ticket, title and description, in the text and in the stored header', async () => {
    runWith({ ticket: EVIL });
    const update = vi.mocked(prisma.workflowHumanStep.update);
    update.mockReset();
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      fetchCalls.push({ body: init?.body ? JSON.parse(init.body) : null, url });
      return {
        json: async () => ({ channel: 'C-origin', ok: true, ts: '5.5' }),
      } as unknown as Response;
    }) as typeof fetch;

    await notifySlackHumanStep({
      description: EVIL,
      kind: 'APPROVAL',
      runId: 'r1',
      stepId: 'step-esc',
      title: EVIL,
    });

    const body = fetchCalls[0]?.body as {
      text: string;
      blocks: Array<{ text?: { text: string } }>;
    };
    // Only the platform's own "Open approvals" link remains as markup.
    const markup = body.text.match(/<[^>]*>/g) ?? [];
    expect(markup).toEqual(['<http://localhost:3000/approvals|Open approvals →>']);
    expect(body.blocks[0]?.text?.text).toContain(ESC);
    const stored = update.mock.calls[0]?.[0] as { data: { slackMessage: { text: string } } };
    expect(stored.data.slackMessage.text).not.toMatch(/<[!@h]/);
    expect(stored.data.slackMessage.text.split(ESC)).toHaveLength(4);
  });

  it('run complete (plain-text fallback when no card can be built): ticket and template', async () => {
    process.env.TEST_WEB_URL = 'not a url';
    runWith({ template: EVIL, ticket: EVIL });
    await notifySlackRunComplete({ runId: 'r1', status: 'SUCCESS' });

    const body = fetchCalls[0]?.body as { text: string; blocks?: unknown[] };
    expect(body.blocks).toBeUndefined();
    expect(body.text).not.toMatch(/<[!@h]/);
    expect(body.text.split(ESC)).toHaveLength(3);
  });
});

describe('broadcast mentions in model-written text are defused at the Slack writers', () => {
  const MODEL =
    'Done. <!channel> please look, cc <!subteam^S1|@oncall> and <@U123>: <https://x.example|doc>';
  const SAFE =
    'Done. &lt;!channel&gt; please look, cc &lt;!subteam^S1|@oncall&gt; and <@U123>: <https://x.example|doc>';

  function lastBody(): { text: string } {
    const call = fetchCalls.at(-1);
    if (!call) {
      throw new Error('expected a Slack call');
    }
    return call.body as { text: string };
  }

  it('thread reply', async () => {
    await postSlackThreadMessage('C1', '100.1', MODEL);
    expect(fetchCalls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(lastBody().text).toBe(SAFE);
  });

  it('thread reply that returns its ts (the placeholder path)', async () => {
    await postSlackThreadMessageReturningTs('C1', '100.1', MODEL);
    expect(lastBody().text).toBe(SAFE);
  });

  it('top-level channel post (digest, interjection, nudge)', async () => {
    await postSlackChannelMessage('C1', MODEL);
    expect(lastBody().text).toBe(SAFE);
  });

  it('in-place edit of the placeholder', async () => {
    await updateSlackMessage('C1', '171.42', MODEL);
    expect(fetchCalls[0]?.url).toBe('https://slack.com/api/chat.update');
    expect(lastBody().text).toBe(SAFE);
  });

  it('the fallback text that rides with blocks', async () => {
    await postSlackThreadMessage('C1', '100.1', MODEL, [{ type: 'divider' }]);
    expect(lastBody().text).toBe(SAFE);
  });

  it('a notice built by fixed code (no broadcast in it) is unchanged', async () => {
    process.env.TEST_WEB_URL = 'not a url'; // no dashboard link: the plain one-line notice
    findRun.mockResolvedValue({
      template: { name: 'tmpl' },
      workflowId: 'wf-ok',
      workRequest: {
        activeWorkflows: [],
        externalTicketId: 'JIRA-9',
        slackChannelId: 'C1',
        slackMessageTs: null,
      },
    } as never);
    await notifySlackStepFailure({ attempt: 1, error: 'boom', nodeId: 'lint', runId: 'r1' });
    expect(lastBody().text).toBe('*[JIRA-9]* `tmpl` → step `lint` failed (attempt 1): boom');
  });
});

describe('step-failure and PR-ready notices as cards', () => {
  interface Posted {
    text: string;
    blocks?: Array<{
      type: string;
      text?: { text: string };
      fields?: Array<{ text: string }>;
      elements?: Array<{ url: string; text: { text: string } }>;
    }>;
  }
  const posted = (): Posted => {
    const call = fetchCalls[0];
    if (!call) {
      throw new Error('expected a Slack call');
    }
    return call.body as Posted;
  };

  function failingRun() {
    findRun.mockResolvedValue({
      template: { name: 'ticket-to-merge' },
      workflowId: 'wf-card',
      workRequest: {
        activeWorkflows: [],
        externalTicketId: 'JIRA-7',
        slackChannelId: 'C123',
        slackMessageTs: '1700.5',
      },
    } as never);
  }

  it('step failure: step, attempt, the error and an Open run link', async () => {
    failingRun();
    await notifySlackStepFailure({
      attempt: 1,
      error: 'lint failed',
      nodeId: 'runLint',
      runId: 'r 1',
    });

    const body = posted();
    expect(body.text).toContain('JIRA-7');
    expect(body.text).toContain('runLint');
    expect(body.blocks?.map((b) => b.type)).toEqual(['section', 'section', 'section', 'actions']);
    expect(body.blocks?.[1]?.fields?.map((f) => f.text)).toEqual([
      '*Step*\nrunLint',
      '*Attempt*\n1',
    ]);
    expect(body.blocks?.[2]?.text?.text).toBe('```\nlint failed\n```');
    expect(body.blocks?.[3]?.elements?.[0]?.url).toBe('http://localhost:3000/runs/r%201');
  });

  it('step failure without an error text has no code block', async () => {
    failingRun();
    await notifySlackStepFailure({ attempt: 1, nodeId: 'runLint', runId: 'r1' });
    expect(posted().blocks?.map((b) => b.type)).toEqual(['section', 'section', 'actions']);
  });

  it('PR ready: an Open PR button when the PR is on an approved host', async () => {
    process.env.TEST_REPO_HOSTS = 'github.com';
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [],
      externalTicketId: 'JIRA-5',
      slackChannelId: 'C-origin',
      slackMessageTs: '1700.5',
    } as never);
    await notifySlackPrReady({
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      workRequestId: 'wr-1',
    });

    const body = posted();
    expect(body.text).toContain('JIRA-5');
    expect(body.blocks?.map((b) => b.type)).toEqual(['section', 'actions']);
    expect(body.blocks?.[1]?.elements?.[0]).toMatchObject({
      text: { text: 'Open PR' },
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('PR ready: a PR on an unapproved host keeps the plain line with its link', async () => {
    process.env.TEST_REPO_HOSTS = 'github.com';
    findWorkRequest.mockResolvedValue({
      activeWorkflows: [],
      externalTicketId: 'JIRA-5',
      slackChannelId: 'C-origin',
      slackMessageTs: '1700.5',
    } as never);
    await notifySlackPrReady({
      prNumber: 7,
      prUrl: 'https://ghe.unlisted.example/o/r/pull/7',
      workRequestId: 'wr-1',
    });

    const body = posted();
    expect(body.blocks).toBeUndefined();
    expect(body.text).toBe(
      ':eyes: *[JIRA-5]* PR #7 is ready for review: https://ghe.unlisted.example/o/r/pull/7'
    );
  });
});
