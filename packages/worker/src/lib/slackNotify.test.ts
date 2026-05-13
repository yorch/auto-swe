import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    team: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { notifySlackRunComplete, notifySlackStepFailure } from './slackNotify.js';

const findRun = vi.mocked(prisma.workflowRun.findUnique);
const findTeam = vi.mocked(prisma.team.findUnique);

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
});

describe('notifySlackStepFailure', () => {
  it('no-ops when SLACK_BOT_TOKEN is unset', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    await notifySlackStepFailure({ attempt: 1, nodeId: 'lint', runId: 'r1' });
    expect(fetchCalls).toHaveLength(0);
    expect(findRun).not.toHaveBeenCalled();
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
