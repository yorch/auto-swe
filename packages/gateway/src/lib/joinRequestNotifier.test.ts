import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postSlackMessage: vi.fn(async (..._args: unknown[]) => '1.2' as string | null),
  resolveSetting: vi.fn(async (..._args: unknown[]) => true as boolean),
  sendEach: vi.fn(
    async (_kind: string, messages: ReadonlyArray<{ to: string }>) =>
      ({
        configured: true,
        delivered: messages.map((m) => m.to),
        failed: 0,
      }) as { configured: boolean; delivered: string[]; failed: number }
  ),
  slackToken: vi.fn(async (..._args: unknown[]) => 'xoxb-test' as string | null),
}));

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: mocks.resolveSetting }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveBetterAuthConfig: () => ({ clientOrigin: 'https://app.example.com/' }),
  resolveSlackBotTokenForSlackChannel: mocks.slackToken,
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_r: string, _m: string[], fn: () => unknown) => fn(),
}));
vi.mock('@auto-swe/shared/permissions', () => ({
  orgRolesAtLeast: () => ['ADMIN'],
  teamRolesAtLeast: () => ['LEAD', 'ADMIN'],
}));
vi.mock('./slack.js', () => ({ postSlackMessage: mocks.postSlackMessage }));
vi.mock('./notificationEmail.js', async (orig) => ({
  ...(await orig<typeof import('./notificationEmail.js')>()),
  sendNotificationEmailsEach: mocks.sendEach,
}));

import {
  type DeliveryOutcome,
  deliverJoinRequestNotification,
  type OutboxRow,
  reachedKey,
  resetDeliveryWarningsForTests,
} from './joinRequestNotifier.js';

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

function makePrisma(
  req: unknown,
  people: {
    reviewers?: Array<string | null>;
    admins?: Array<string | null>;
  } = {}
) {
  return {
    organizationMembership: {
      findMany: vi.fn(async () => (people.admins ?? []).map((email) => ({ user: { email } }))),
    },
    teamJoinRequest: { findUnique: vi.fn(async () => req) },
    teamMembership: {
      findMany: vi.fn(async () => (people.reviewers ?? []).map((email) => ({ user: { email } }))),
    },
  };
}

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    attempts: 0,
    audience: 'TEAM_CHANNEL',
    event: 'CREATED',
    id: 'n1',
    reached: [],
    requestId: 'r1',
    ...overrides,
  };
}

const deliver = (prisma: ReturnType<typeof makePrisma>, r: OutboxRow, deps = {}) =>
  deliverJoinRequestNotification(prisma as never, r, deps);

function sent(): Array<{ to: string; subject: string; text: string; html: string }> {
  return mocks.sendEach.mock.calls.flatMap(
    (c) => c[1] as unknown as Array<{ to: string; subject: string; text: string; html: string }>
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.resolveSetting.mockResolvedValue(true);
  mocks.slackToken.mockResolvedValue('xoxb-test');
  mocks.postSlackMessage.mockResolvedValue('1.2');
  mocks.sendEach.mockImplementation(async (_kind, messages) => ({
    configured: true,
    delivered: messages.map((m) => m.to),
    failed: 0,
  }));
  resetDeliveryWarningsForTests();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('TEAM_CHANNEL', () => {
  it('posts one Slack message without the requester email and with mentions defused', async () => {
    const out = await deliver(makePrisma(request()), row(), { slackApiBase: 'http://127.0.0.1:1' });
    expect(out.kind).toBe('delivered');
    expect(mocks.postSlackMessage).toHaveBeenCalledTimes(1);
    const [opts, token, seam] = mocks.postSlackMessage.mock.calls[0] as unknown as [
      { channel: string; text: string },
      string,
      { apiBase?: string },
    ];
    expect(token).toBe('xoxb-test');
    expect(seam).toEqual({ apiBase: 'http://127.0.0.1:1' });
    expect(opts.channel).toBe('C123');
    expect(opts.text).not.toContain(REQUESTER_EMAIL);
    expect(opts.text).not.toContain('<!channel>');
    expect(opts.text).not.toContain('<script>');
    expect(opts.text).toContain('&lt;!channel&gt;');
    expect(opts.text).toContain(
      '<https://app.example.com/teams/payments/members|Review the request>'
    );
    expect(mocks.sendEach).not.toHaveBeenCalled();
  });

  it('skips a team that lost its channel, and one with no bot token (one warning)', async () => {
    const noChannel = request();
    (noChannel.team as { slackNotifyChannel: string | null }).slackNotifyChannel = null;
    expect(await deliver(makePrisma(noChannel), row())).toMatchObject({
      code: 'no_recipients',
      kind: 'skipped',
    });
    mocks.slackToken.mockResolvedValue(null);
    expect(await deliver(makePrisma(request()), row())).toMatchObject({
      code: 'transport_not_configured',
      kind: 'skipped',
    });
    await deliver(makePrisma(request()), row());
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
    expect(
      vi.mocked(console.warn).mock.calls.filter((c) => /Slack/.test(String(c[0])))
    ).toHaveLength(1);
  });

  it('fails with slack_error when Slack does not accept the post', async () => {
    mocks.postSlackMessage.mockResolvedValue(null);
    expect(await deliver(makePrisma(request()), row())).toMatchObject({
      code: 'slack_error',
      kind: 'failed',
    });
  });
});

describe('TEAM_REVIEWERS', () => {
  const reviewerRow = () => row({ audience: 'TEAM_REVIEWERS' });

  it('emails the active leads and admins, deduplicated, naming the requester only by name', async () => {
    const prisma = makePrisma(request(), {
      reviewers: ['lead@example.com', 'LEAD@example.com', null, 'admin@example.com'],
    });
    const out = await deliver(prisma, reviewerRow());
    expect(out.kind).toBe('delivered');
    // The lookup is by the shared helper's roles, active users only, the request's own team.
    expect(prisma.teamMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: { in: ['LEAD', 'ADMIN'] }, teamId: 'team-1', user: { isActive: true } },
      })
    );
    const msgs = sent();
    expect(msgs.map((m) => m.to)).toEqual(['lead@example.com', 'admin@example.com']);
    const [first] = msgs;
    expect(first?.subject).toBe('Ann <!channel> asked to join Pay <b>ments</b>');
    expect(first?.text).toContain('https://app.example.com/teams/payments/members');
    for (const m of msgs) {
      expect(m.text + m.html + m.subject).not.toContain(REQUESTER_EMAIL);
    }
    expect(first?.html).toContain('Pay &lt;b&gt;ments&lt;/b&gt;');
    expect(first?.html).not.toContain('<script>');
  });

  it('keeps a line break in a name out of the subject', async () => {
    const req = request();
    (req.user as { name: string }).name = 'Ann\r\nBcc: x@evil.example';
    await deliver(makePrisma(req, { reviewers: ['lead@example.com'] }), reviewerRow());
    expect(sent()[0]?.subject).not.toMatch(/[\r\n]/);
  });

  it('caps the recipients at twenty', async () => {
    const reviewers = Array.from({ length: 30 }, (_, i) => `lead${i}@example.com`);
    await deliver(makePrisma(request(), { reviewers }), reviewerRow());
    expect(sent()).toHaveLength(20);
  });

  it('skips a team with no active reviewer', async () => {
    expect(await deliver(makePrisma(request(), { reviewers: [] }), reviewerRow())).toMatchObject({
      code: 'no_recipients',
      kind: 'skipped',
    });
  });
});

describe('REQUESTER', () => {
  it('emails only the requester on APPROVED, escaped, with a web link', async () => {
    const out = await deliver(
      makePrisma(request({ status: 'APPROVED' })),
      row({ audience: 'REQUESTER', event: 'APPROVED' })
    );
    expect(out.kind).toBe('delivered');
    const msgs = sent();
    expect(msgs.map((m) => m.to)).toEqual([REQUESTER_EMAIL]);
    expect(msgs[0]?.html).toContain('Pay &lt;b&gt;ments&lt;/b&gt;');
    expect(msgs[0]?.html).toContain('welcome &lt;!here&gt;');
    expect(msgs[0]?.html).not.toContain('<b>ments');
    expect(msgs[0]?.text).toContain('https://app.example.com/teams/payments');
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it('says a rejection was not approved, and a cross-organization approval is waiting', async () => {
    await deliver(
      makePrisma(request({ status: 'REJECTED' })),
      row({ audience: 'REQUESTER', event: 'REJECTED' })
    );
    expect(sent()[0]?.text).toContain('was not approved');
    await deliver(
      makePrisma(request({ status: 'PENDING_ORG' })),
      row({ audience: 'REQUESTER', event: 'PENDING_ORG' })
    );
    expect(sent()[1]?.subject).toContain('is waiting for Acme');
  });

  it('skips a requester with no address', async () => {
    const req = request({ status: 'APPROVED' });
    (req.user as { email: string | null }).email = null;
    expect(
      await deliver(makePrisma(req), row({ audience: 'REQUESTER', event: 'APPROVED' }))
    ).toMatchObject({ code: 'no_recipients', kind: 'skipped' });
  });
});

describe('ORG_ADMINS', () => {
  const adminRow = () => row({ audience: 'ORG_ADMINS', event: 'PENDING_ORG' });

  it('emails each active admin with an address, once, with the organization link', async () => {
    const out = await deliver(
      makePrisma(request({ status: 'PENDING_ORG' }), {
        admins: ['a@example.com', 'A@example.com', null],
      }),
      adminRow()
    );
    expect(out.kind).toBe('delivered');
    const msgs = sent();
    expect(msgs.map((m) => m.to)).toEqual(['a@example.com']);
    expect(msgs[0]?.text).toContain('https://app.example.com/admin/organizations/org-1');
    expect(msgs[0]?.html).not.toContain('<b>');
    expect(msgs[0]?.text).not.toContain(REQUESTER_EMAIL);
  });

  it('caps the fan-out and logs the truncation', async () => {
    const admins = Array.from({ length: 25 }, (_, i) => `admin${i}@example.com`);
    await deliver(makePrisma(request({ status: 'PENDING_ORG' }), { admins }), adminRow());
    expect(sent()).toHaveLength(20);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('more than'));
  });
});

describe('skips', () => {
  it('skips with notifications_disabled, resolved with team context, and sends nothing', async () => {
    mocks.resolveSetting.mockResolvedValue(false);
    expect(await deliver(makePrisma(request()), row())).toMatchObject({
      code: 'notifications_disabled',
      kind: 'skipped',
    });
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
    expect(mocks.sendEach).not.toHaveBeenCalled();
    expect(mocks.resolveSetting).toHaveBeenCalledWith('teams.joinRequestNotifications', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  const stale: Array<[string, OutboxRow, Record<string, unknown>]> = [
    ['a created notice for a request already decided', row(), { status: 'APPROVED' }],
    [
      'an approval notice for a request that is not approved',
      row({ audience: 'REQUESTER', event: 'APPROVED' }),
      { status: 'PENDING_TEAM' },
    ],
    [
      'a rejection notice for an approved request',
      row({ audience: 'REQUESTER', event: 'REJECTED' }),
      { status: 'APPROVED' },
    ],
    [
      'a notice for a request the platform closed',
      row({ audience: 'REQUESTER', event: 'REJECTED' }),
      { closeReason: 'TEAM_DEACTIVATED', status: 'REJECTED' },
    ],
  ];
  for (const [name, r, overrides] of stale) {
    it(`skips ${name}`, async () => {
      expect(await deliver(makePrisma(request(overrides)), r)).toMatchObject({
        code: 'request_state_changed',
        kind: 'skipped',
      });
      expect(mocks.postSlackMessage).not.toHaveBeenCalled();
      expect(mocks.sendEach).not.toHaveBeenCalled();
    });
  }

  it('skips a request that is gone', async () => {
    expect(await deliver(makePrisma(null), row())).toMatchObject({
      code: 'request_state_changed',
      kind: 'skipped',
    });
  });

  it('skips an inactive requester, team or organization', async () => {
    const inactive = (mutate: (r: ReturnType<typeof request>) => void) => {
      const r = request({ status: 'REJECTED' });
      mutate(r);
      return r;
    };
    const reqRow = row({ audience: 'REQUESTER', event: 'REJECTED' });
    for (const r of [
      inactive((x) => {
        x.user.isActive = false;
      }),
      inactive((x) => {
        x.team.isActive = false;
      }),
      inactive((x) => {
        x.team.organization.isActive = false;
      }),
    ]) {
      expect(await deliver(makePrisma(r), reqRow)).toMatchObject({
        code: 'party_inactive',
        kind: 'skipped',
      });
    }
    expect(mocks.sendEach).not.toHaveBeenCalled();
  });
});

describe('email transport', () => {
  const reviewerRow = (reached: unknown = []) => row({ audience: 'TEAM_REVIEWERS', reached });

  it('skips with transport_not_configured, and warns once per process', async () => {
    mocks.sendEach.mockResolvedValue({ configured: false, delivered: [], failed: 0 });
    const prisma = makePrisma(request(), { reviewers: ['lead@example.com'] });
    expect(await deliver(prisma, reviewerRow())).toMatchObject({
      code: 'transport_not_configured',
      kind: 'skipped',
    });
    await deliver(prisma, reviewerRow());
    expect(
      vi.mocked(console.warn).mock.calls.filter((c) => /no email transport/.test(String(c[0])))
    ).toHaveLength(1);
  });

  it('records each recipient it reaches by a hash, never the address, and reports a partial failure', async () => {
    mocks.sendEach.mockImplementation(async (_k, messages) =>
      messages[0]?.to === 'b@example.com'
        ? { configured: true, delivered: [], failed: 1 }
        : { configured: true, delivered: messages.map((m) => m.to), failed: 0 }
    );
    const persisted: string[][] = [];
    const out = (await deliver(
      makePrisma(request(), { reviewers: ['a@example.com', 'b@example.com', 'c@example.com'] }),
      reviewerRow(),
      { persistReached: async (r: string[]) => void persisted.push(r) }
    )) as Extract<DeliveryOutcome, { kind: 'failed' }>;
    expect(out).toMatchObject({ code: 'transport_error', kind: 'failed' });
    expect(out.reached).toEqual([reachedKey('a@example.com'), reachedKey('c@example.com')]);
    expect(JSON.stringify(out.reached)).not.toContain('example.com');
    expect(persisted).toEqual([
      [reachedKey('a@example.com')],
      [reachedKey('a@example.com'), reachedKey('c@example.com')],
    ]);
  });

  it('never resends to a recipient already reached', async () => {
    const out = await deliver(
      makePrisma(request(), { reviewers: ['a@example.com', 'b@example.com'] }),
      reviewerRow([reachedKey('A@example.com')])
    );
    expect(out.kind).toBe('delivered');
    expect(sent().map((m) => m.to)).toEqual(['b@example.com']);
    expect((out as { reached: string[] }).reached).toHaveLength(2);
  });

  it('is delivered without sending when everyone was already reached', async () => {
    const out = await deliver(
      makePrisma(request(), { reviewers: ['a@example.com'] }),
      reviewerRow([reachedKey('a@example.com')])
    );
    expect(out.kind).toBe('delivered');
    expect(mocks.sendEach).not.toHaveBeenCalled();
  });
});
