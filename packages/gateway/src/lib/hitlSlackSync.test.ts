import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveToken } = vi.hoisted(() => ({ resolveToken: vi.fn() }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: resolveToken,
}));

import { buildOutcomeText, escapeSlackMrkdwn, syncSlackHumanStepOutcome } from './hitlSlackSync.js';

const HEADER = '*[JIRA-1]* *Approval required:* Approve plan';

describe('escapeSlackMrkdwn', () => {
  it('neutralises control characters so a comment cannot mention or link', () => {
    expect(escapeSlackMrkdwn('<!channel> a & <http://x|y>')).toBe(
      '&lt;!channel&gt; a &amp; &lt;http://x|y&gt;'
    );
  });
});

describe('buildOutcomeText', () => {
  it('shows who approved and quotes the escaped comment line by line', () => {
    const text = buildOutcomeText(
      HEADER,
      { action: 'approve', comment: 'Looks <good>\nship it', userId: 'u1' },
      'Dana'
    );
    expect(text).toBe(
      `${HEADER}\n:white_check_mark: *Approved* by Dana\n> Looks &lt;good&gt;\n> ship it`
    );
  });

  it('shows a rejection with its reason', () => {
    expect(
      buildOutcomeText(HEADER, { action: 'reject', comment: 'No', userId: 'u1' }, 'Dana')
    ).toBe(`${HEADER}\n:x: *Rejected* by Dana\n> No`);
  });

  it('shows a decision option and omits an empty comment', () => {
    expect(
      buildOutcomeText(
        HEADER,
        { action: 'select', comment: '  ', userId: 'u1', value: 'ship' },
        'Dana'
      )
    ).toBe(`${HEADER}\n:white_check_mark: *Decided* by Dana: ship`);
  });

  it('names every approver of a multi-approver step, attributing each note', () => {
    const text = buildOutcomeText(
      HEADER,
      { action: 'approve', comment: 'Ship it', userId: 'u2' },
      'Eli',
      [
        { comment: 'Looks right', name: 'Dana' },
        { name: 'Eli' },
        { comment: 'Fine <by me>', name: 'Fay' },
      ]
    );
    expect(text).toBe(
      `${HEADER}\n:white_check_mark: *Approved* by Dana, Eli, Fay\n> *Dana:* Looks right\n> *Fay:* Fine &lt;by me&gt;`
    );
  });

  it('clips a very long comment', () => {
    const text = buildOutcomeText(
      HEADER,
      { action: 'approve', comment: 'x'.repeat(2000), userId: 'u1' },
      'Dana'
    );
    expect(text.length).toBeLessThan(HEADER.length + 600);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('syncSlackHumanStepOutcome', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  const log = { warn: vi.fn() };
  const prisma = {
    humanApproval: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    workflowHumanStep: { findUnique: vi.fn() },
  };
  const run = (userId = 'u1') =>
    syncSlackHumanStepOutcome({ log, prisma: prisma as never }, 'step-1', {
      action: 'approve',
      comment: 'Ship it',
      userId,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });
    resolveToken.mockResolvedValue('xoxb-test');
    prisma.humanApproval.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ email: 'd@x.test', name: 'Dana' });
    prisma.workflowHumanStep.findUnique.mockResolvedValue({
      slackMessage: { channel: 'C1', text: HEADER, ts: '5.5' },
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('edits the announcement in place, dropping the buttons', async () => {
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://slack.com/api/chat.update');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ channel: 'C1', ts: '5.5' });
    expect(body.text).toContain('*Approved* by Dana');
    expect(body.text).toContain('> Ship it');
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].type).toBe('section');
  });

  it('reads the approvals so a multi-approver step shows all of them', async () => {
    prisma.humanApproval.findMany.mockResolvedValue([
      { resolvedByUser: { email: 'a@x.test', name: 'Ann' }, value: { comment: 'ok' } },
      { resolvedByUser: { email: 'd@x.test', name: 'Dana' }, value: null },
    ]);
    await run();
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.text).toContain('*Approved* by Ann, Dana');
    expect(body.text).toContain('> *Ann:* ok');
  });

  it('does nothing for a step that never posted to Slack', async () => {
    prisma.workflowHumanStep.findUnique.mockResolvedValue({ slackMessage: null });
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without a bot token', async () => {
    resolveToken.mockResolvedValue(null);
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when Slack or the database fails', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(run()).resolves.toBeUndefined();
    prisma.workflowHumanStep.findUnique.mockRejectedValue(new Error('db'));
    await expect(run()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
