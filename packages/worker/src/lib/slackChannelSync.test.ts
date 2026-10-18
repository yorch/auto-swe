import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, resolveToken } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    configAuditLog: { create: vi.fn(async () => ({})) },
    slackChannel: { findMany: vi.fn(), update: vi.fn((args: unknown) => ({ update: args })) },
    slackChannelMember: {
      createMany: vi.fn((args: unknown) => ({ createMany: args })),
      deleteMany: vi.fn((args: unknown) => ({ deleteMany: args })),
    },
  },
  resolveToken: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma }));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: (...a: unknown[]) => resolveToken(...a),
}));

import { MAX_SYNCED_MEMBERS, syncSlackChannel, syncSlackChannels } from './slackChannelSync.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const CHANNEL = { id: 'chan-1', isPrivate: false, slackChannelId: 'C1' };

/** Answers each Slack method from `answers`, a list of pages for conversations.members. */
function slack(answers: {
  info?: unknown;
  members?: unknown[];
  status?: number;
  throws?: boolean;
}) {
  let page = 0;
  const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (answers.throws) {
      throw new Error('getaddrinfo ENOTFOUND slack.com https://slack.com/api/...');
    }
    if (answers.status) {
      return new Response('', { status: answers.status });
    }
    const body = url.includes('conversations.info')
      ? answers.info
      : (answers.members ?? [])[page++];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('syncSlackChannel', () => {
  it('turns the flag on, audits it, and records the members of a channel Slack calls private', async () => {
    const fetchSpy = slack({
      info: { channel: { is_private: true }, ok: true },
      members: [
        { members: ['U1', 'U2'], ok: true, response_metadata: { next_cursor: 'next' } },
        { members: ['U3', 'U1'], ok: true, response_metadata: { next_cursor: '' } },
      ],
    });
    const outcome = await syncSlackChannel(CHANNEL, 'xoxb-1', NOW);
    expect(outcome).toEqual({ channelId: 'chan-1', madePrivate: true, membersSynced: true });
    expect(prisma.slackChannel.update).toHaveBeenCalledWith({
      data: { isPrivate: true, privacyCheckedAt: NOW },
      where: { id: 'chan-1' },
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: { isPrivate: true, source: 'slack-channel-sync' },
        entityId: 'chan-1',
        entityType: 'SlackChannel',
      }),
    });
    // The list is replaced whole, de-duplicated, in one transaction with its timestamp.
    expect(prisma.slackChannelMember.createMany).toHaveBeenCalledWith({
      data: ['U1', 'U2', 'U3'].map((slackUserId) => ({ channelId: 'chan-1', slackUserId })),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.slackChannel.update).toHaveBeenCalledWith({
      data: { membersSyncedAt: NOW },
      where: { id: 'chan-1' },
    });
    // The second page was asked for with the first page's cursor.
    expect(String(fetchSpy.mock.calls[2]?.[0])).toContain('cursor=next');
    // Every request refuses a redirect.
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error' });
    }
  });

  it('never turns a private flag off, even when Slack says the channel is public', async () => {
    slack({
      info: { channel: { is_private: false }, ok: true },
      members: [{ members: ['U1'], ok: true }],
    });
    const outcome = await syncSlackChannel({ ...CHANNEL, isPrivate: true }, 'xoxb-1', NOW);
    expect(outcome.madePrivate).toBe(false);
    expect(prisma.slackChannel.update).toHaveBeenCalledWith({
      data: { privacyCheckedAt: NOW },
      where: { id: 'chan-1' },
    });
    expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
    // Still private here, so its members are still synced.
    expect(outcome.membersSynced).toBe(true);
  });

  it('drops the member list of a public channel and asks Slack for no members', async () => {
    const fetchSpy = slack({ info: { channel: { is_private: false }, ok: true } });
    const outcome = await syncSlackChannel(CHANNEL, 'xoxb-1', NOW);
    expect(outcome).toEqual({ channelId: 'chan-1', madePrivate: false, membersSynced: false });
    expect(prisma.slackChannelMember.deleteMany).toHaveBeenCalledWith({
      where: { channelId: 'chan-1' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous list and timestamp when the member list cannot be read', async () => {
    slack({
      info: { channel: { is_private: true }, ok: true },
      members: [{ error: 'missing_scope', ok: false }],
    });
    const outcome = await syncSlackChannel({ ...CHANNEL, isPrivate: true }, 'xoxb-1', NOW);
    expect(outcome).toMatchObject({ error: 'missing_scope', membersSynced: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.slackChannelMember.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a partial list from a channel too large to sync', async () => {
    const page = Array.from({ length: 200 }, (_, i) => `U${i}`);
    const pages = Array.from({ length: MAX_SYNCED_MEMBERS / 200 + 1 }, (_, n) => ({
      members: page.map((id) => `${id}-${n}`),
      ok: true,
      response_metadata: { next_cursor: 'more' },
    }));
    slack({ info: { channel: { is_private: true }, ok: true }, members: pages });
    const outcome = await syncSlackChannel({ ...CHANNEL, isPrivate: true }, 'xoxb-1', NOW);
    expect(outcome).toMatchObject({ error: 'too_many_members', membersSynced: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports a fixed code, never the fetch error text, when Slack cannot be reached', async () => {
    slack({ throws: true });
    const outcome = await syncSlackChannel({ ...CHANNEL, isPrivate: true }, 'xoxb-1', NOW);
    expect(outcome.error).toBe('request_failed');
    expect(prisma.slackChannel.update).not.toHaveBeenCalled();
  });
});

describe('syncSlackChannels', () => {
  it('skips a channel with no token, and keeps going past one that fails', async () => {
    prisma.slackChannel.findMany.mockResolvedValue([
      { id: 'a', isPrivate: false, slackChannelId: 'CA' },
      { id: 'b', isPrivate: false, slackChannelId: 'CB' },
      { id: 'c', isPrivate: false, slackChannelId: 'CC' },
    ]);
    resolveToken.mockImplementation(async (id: string) => (id === 'CA' ? null : 'xoxb-1'));
    slack({ info: { channel: { is_private: false }, ok: true } });
    prisma.slackChannel.update.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    const result = await syncSlackChannels(NOW);
    expect(result).toMatchObject({ checked: 2, failed: 1, skipped: 1 });
    expect(result.channels.map((c) => [c.channelId, c.error])).toEqual([
      ['b', 'database_error'],
      ['c', undefined],
    ]);
    expect(prisma.slackChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } })
    );
  });
});
