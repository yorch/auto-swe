import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postSlackMessage: vi.fn(async () => '1.2'),
  resolveSetting: vi.fn(async () => true as boolean),
  sendNotificationEmails: vi.fn(async () => 0),
  slackToken: vi.fn(async () => 'xoxb-test' as string | null),
}));

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: mocks.resolveSetting }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveBetterAuthConfig: () => ({ clientOrigin: 'https://app.example.com/' }),
  resolveSlackBotTokenForSlackChannel: mocks.slackToken,
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_r: string, _m: string[], fn: () => unknown) => fn(),
}));
vi.mock('@auto-swe/shared/permissions', () => ({ orgRolesAtLeast: () => ['ADMIN'] }));
vi.mock('./slack.js', () => ({ postSlackMessage: mocks.postSlackMessage }));
vi.mock('./notificationEmail.js', async (orig) => ({
  ...(await orig<typeof import('./notificationEmail.js')>()),
  sendNotificationEmails: mocks.sendNotificationEmails,
}));

import { MAX_ORG_ADMIN_RECIPIENTS, notifyJoinRequestEvent } from './joinRequestNotifier.js';

const REQUESTER_EMAIL = 'requester@example.com';

function request(overrides: Record<string, unknown> = {}) {
  return {
    closeReason: null,
    message: 'let me in <!channel> <script>x</script>',
    orgDecidedAt: null,
    orgDecisionNote: null,
    status: 'PENDING_TEAM',
    team: {
      id: 'team-1',
      isActive: true,
      name: 'Pay <b>ments</b>',
      organization: { id: 'org-1', isActive: true, name: 'Acme' },
      orgId: 'org-1',
      slackNotifyChannel: 'C123',
      slug: 'payments',
    },
    teamDecisionNote: 'welcome <!here>',
    user: { email: REQUESTER_EMAIL, isActive: true, name: 'Ann <!channel>' },
    ...overrides,
  };
}

function makePrisma(req: unknown, admins: Array<{ email: string | null; isActive: boolean }> = []) {
  return {
    organizationMembership: {
      findMany: vi.fn(async () => admins.map((user) => ({ user }))),
    },
    teamJoinRequest: { findUnique: vi.fn(async () => req) },
  } as never;
}

function sentMessages(): Array<{ to: string; subject: string; text: string; html: string }> {
  const call = mocks.sendNotificationEmails.mock.calls[0] as unknown as [string, never[]];
  return call[1];
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.resolveSetting.mockResolvedValue(true);
  mocks.slackToken.mockResolvedValue('xoxb-test');
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('created', () => {
  it('posts one Slack message without the requester email and with mentions defused', async () => {
    await notifyJoinRequestEvent(makePrisma(request()), { kind: 'created', requestId: 'r1' });
    expect(mocks.postSlackMessage).toHaveBeenCalledTimes(1);
    const [opts, token] = mocks.postSlackMessage.mock.calls[0] as unknown as [
      { channel: string; text: string },
      string,
    ];
    expect(token).toBe('xoxb-test');
    expect(opts.channel).toBe('C123');
    expect(opts.text).not.toContain(REQUESTER_EMAIL);
    expect(opts.text).not.toContain('<!channel>');
    expect(opts.text).not.toContain('<script>');
    expect(opts.text).toContain('&lt;!channel&gt;');
    expect(opts.text).toContain(
      '<https://app.example.com/teams/payments/members|Review the request>'
    );
    expect(mocks.sendNotificationEmails).not.toHaveBeenCalled();
  });

  it('sends nothing without a channel or a Slack token', async () => {
    const noChannel = request();
    (noChannel.team as { slackNotifyChannel: string | null }).slackNotifyChannel = null;
    await notifyJoinRequestEvent(makePrisma(noChannel), { kind: 'created', requestId: 'r1' });
    mocks.slackToken.mockResolvedValue(null);
    await notifyJoinRequestEvent(makePrisma(request()), { kind: 'created', requestId: 'r1' });
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it('swallows a Slack error', async () => {
    mocks.postSlackMessage.mockRejectedValueOnce(new Error('slack down'));
    await expect(
      notifyJoinRequestEvent(makePrisma(request()), { kind: 'created', requestId: 'r1' })
    ).resolves.toBeUndefined();
  });

  it('sends nothing for a request that is no longer pending with the team', async () => {
    await notifyJoinRequestEvent(makePrisma(request({ status: 'APPROVED' })), {
      kind: 'created',
      requestId: 'r1',
    });
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });
});

describe('decided', () => {
  it('emails only the requester on APPROVED, escaped, with a web link', async () => {
    await notifyJoinRequestEvent(makePrisma(request({ status: 'APPROVED' })), {
      kind: 'decided',
      outcome: 'APPROVED',
      requestId: 'r1',
    });
    const msgs = sentMessages();
    expect(msgs.map((m) => m.to)).toEqual([REQUESTER_EMAIL]);
    expect(msgs[0]?.html).toContain('Pay &lt;b&gt;ments&lt;/b&gt;');
    expect(msgs[0]?.html).toContain('welcome &lt;!here&gt;');
    expect(msgs[0]?.html).not.toContain('<b>ments');
    expect(msgs[0]?.text).toContain('https://app.example.com/teams/payments');
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it('emails only the requester on REJECTED', async () => {
    await notifyJoinRequestEvent(makePrisma(request({ status: 'REJECTED' })), {
      kind: 'decided',
      outcome: 'REJECTED',
      requestId: 'r1',
    });
    expect(sentMessages().map((m) => m.to)).toEqual([REQUESTER_EMAIL]);
    expect(sentMessages()[0]?.text).toContain('was not approved');
  });

  it('on PENDING_ORG emails the requester and each active org admin with an email, once', async () => {
    const admins = [
      { email: 'a@example.com', isActive: true },
      { email: 'A@example.com', isActive: true },
      { email: null, isActive: true },
      { email: 'gone@example.com', isActive: false },
      { email: REQUESTER_EMAIL, isActive: true },
    ];
    await notifyJoinRequestEvent(makePrisma(request({ status: 'PENDING_ORG' }), admins), {
      kind: 'decided',
      outcome: 'PENDING_ORG',
      requestId: 'r1',
    });
    const msgs = sentMessages();
    expect(msgs.map((m) => m.to)).toEqual([REQUESTER_EMAIL, 'a@example.com']);
    expect(msgs[1]?.text).toContain('https://app.example.com/admin/organizations/org-1');
    expect(msgs[1]?.html).not.toContain('<b>');
  });

  it('caps the org-admin fan-out and logs the truncation', async () => {
    const admins = Array.from({ length: MAX_ORG_ADMIN_RECIPIENTS + 5 }, (_, i) => ({
      email: `admin${i}@example.com`,
      isActive: true,
    }));
    const prisma = makePrisma(request({ status: 'PENDING_ORG' }), admins);
    await notifyJoinRequestEvent(prisma, {
      kind: 'decided',
      outcome: 'PENDING_ORG',
      requestId: 'r1',
    });
    expect(sentMessages()).toHaveLength(1 + MAX_ORG_ADMIN_RECIPIENTS);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('more than'));
  });

  it('sends nothing when the request is not in the claimed state', async () => {
    await notifyJoinRequestEvent(makePrisma(request({ status: 'PENDING_TEAM' })), {
      kind: 'decided',
      outcome: 'APPROVED',
      requestId: 'r1',
    });
    await notifyJoinRequestEvent(makePrisma(request({ status: 'APPROVED' })), {
      kind: 'decided',
      outcome: 'REJECTED',
      requestId: 'r1',
    });
    expect(mocks.sendNotificationEmails).not.toHaveBeenCalled();
  });

  it('sends nothing for a system-closed request', async () => {
    await notifyJoinRequestEvent(
      makePrisma(request({ closeReason: 'TEAM_DEACTIVATED', status: 'REJECTED' })),
      { kind: 'decided', outcome: 'REJECTED', requestId: 'r1' }
    );
    expect(mocks.sendNotificationEmails).not.toHaveBeenCalled();
  });

  it('skips an inactive requester', async () => {
    const req = request({ status: 'REJECTED' });
    (req.user as { isActive: boolean }).isActive = false;
    await notifyJoinRequestEvent(makePrisma(req), {
      kind: 'decided',
      outcome: 'REJECTED',
      requestId: 'r1',
    });
    expect(sentMessages()).toEqual([]);
  });
});

describe('guards', () => {
  it('sends nothing when teams.joinRequestNotifications is false, resolved with team context', async () => {
    mocks.resolveSetting.mockResolvedValue(false);
    await notifyJoinRequestEvent(makePrisma(request()), { kind: 'created', requestId: 'r1' });
    await notifyJoinRequestEvent(makePrisma(request({ status: 'APPROVED' })), {
      kind: 'decided',
      outcome: 'APPROVED',
      requestId: 'r1',
    });
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
    expect(mocks.sendNotificationEmails).not.toHaveBeenCalled();
    expect(mocks.resolveSetting).toHaveBeenCalledWith('teams.joinRequestNotifications', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('never rejects when the database read fails or the request is gone', async () => {
    const failing = {
      teamJoinRequest: {
        findUnique: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    } as never;
    await expect(
      notifyJoinRequestEvent(failing, { kind: 'created', requestId: 'r1' })
    ).resolves.toBeUndefined();
    await expect(
      notifyJoinRequestEvent(makePrisma(null), { kind: 'created', requestId: 'r1' })
    ).resolves.toBeUndefined();
  });
});
