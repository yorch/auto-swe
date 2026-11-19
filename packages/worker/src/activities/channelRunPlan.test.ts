import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));

const resolveSlackConfigMock = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackConfig: () => resolveSlackConfigMock(),
}));

const resolveChannelRepoMock = vi.fn();
const decideMock = vi.fn();
vi.mock('./channelTask.js', () => ({
  decideChannelRepoAccess: (...a: unknown[]) => decideMock(...a),
  resolveChannelRepo: (...a: unknown[]) => resolveChannelRepoMock(...a),
  SLACK_TASK_REFUSAL_MESSAGE: {
    'not-a-team-member': 'I cannot start that here: You do not have access to this repository.',
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { verifySlackRunPlanToken } from '@auto-swe/shared/lib/slackRunPlanToken';
import { type ProposeChannelRunPlanInput, proposeChannelRunPlan } from './channelRunPlan.js';

const SECRET = 'signing-secret';
const REPO_ID = '11111111-1111-4111-8111-111111111111';

function input(overrides: Partial<ProposeChannelRunPlanInput> = {}): ProposeChannelRunPlanInput {
  return {
    channelId: 'chan-1',
    intent: { mode: 'delivering' },
    slackChannelId: 'C123',
    threadTs: '111.222',
    userSlackId: 'U1',
    userText: 'add rate limiting to payments-api',
    ...overrides,
  };
}

/** The button's token out of a proposal, verified against the signing secret. */
function tokenOf(blocks: unknown[] | undefined) {
  const actions = (blocks as Array<{ type: string; elements?: Array<{ value?: string }> }>).find(
    (b) => b.type === 'actions'
  );
  const value = actions?.elements?.[0]?.value;
  const out = verifySlackRunPlanToken(value, SECRET);
  if (!out.ok) {
    throw new Error(`token did not verify: ${out.issue}`);
  }
  return out.claims;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-1', role: 'ENGINEER' } as never);
  vi.mocked(prisma.connection.findUnique).mockResolvedValue({
    organizationName: 'acme',
    repoName: 'payments-api',
  } as never);
  resolveSlackConfigMock.mockResolvedValue({ signingSecret: SECRET });
  resolveChannelRepoMock.mockResolvedValue({ repoId: REPO_ID });
  decideMock.mockResolvedValue({ allowed: true });
});

describe('proposeChannelRunPlan', () => {
  it('offers a button whose token binds the person, the thread, the goal and the repository', async () => {
    const out = await proposeChannelRunPlan(input());
    const claims = tokenOf(out.blocks);
    expect(claims).toMatchObject({
      agentKey: null,
      channelId: 'C123',
      intent: 'add rate limiting to payments-api',
      mode: 'delivering',
      repoId: REPO_ID,
      slackUserId: 'U1',
      threadTs: '111.222',
    });
    expect(claims.exp).toBeGreaterThan(Date.now());
    expect(JSON.stringify(out.blocks)).toContain('acme/payments-api');
    expect(JSON.stringify(out.blocks)).toContain('Generate plan');
  });

  it('takes the goal from the invoker message, with mention tokens removed, never from the intent', async () => {
    const out = await proposeChannelRunPlan(
      input({ intent: { mode: 'delivering' }, userText: '  <@UBOT> add a health check  ' })
    );
    expect(tokenOf(out.blocks).intent).toBe('add a health check');
  });

  it('turns Slack markup into plain text for the goal and shows it escaped', async () => {
    // As Slack delivers it: tokens are raw angle brackets, typed characters are entities.
    const hostile = 'ship it <!channel> <https://evil.example|click> &amp; &lt;!here&gt; <@U9>';
    const out = await proposeChannelRunPlan(input({ userText: hostile }));
    const claims = tokenOf(out.blocks);
    // The broadcast and the mention are gone, the link is its label, the entities are decoded.
    expect(claims.intent).toBe('ship it click & <!here>');
    const rendered = JSON.stringify(out.blocks);
    expect(rendered).not.toContain('<!channel>');
    expect(rendered).not.toContain('<!here>');
    expect(rendered).not.toContain('<https://evil.example');
    expect(rendered).toContain('&lt;!here&gt;');
    expect(out.text).not.toContain('<');
  });

  it('honours a repository hint only when the person named it in their own message', async () => {
    await proposeChannelRunPlan(
      input({ intent: { mode: 'delivering', repoHint: 'payments-api' } })
    );
    expect(resolveChannelRepoMock).toHaveBeenLastCalledWith('chan-1', 'payments-api');

    await proposeChannelRunPlan(
      input({ intent: { mode: 'delivering', repoHint: 'secrets-vault' } })
    );
    // A model-chosen repository the message never named is dropped.
    expect(resolveChannelRepoMock).toHaveBeenLastCalledWith('chan-1', undefined);
  });

  it('offers no button when the repository is ambiguous or none is linked', async () => {
    resolveChannelRepoMock.mockResolvedValue(null);
    const out = await proposeChannelRunPlan(input());
    expect(out.blocks).toBeUndefined();
    expect(out.text).toContain("couldn't tell which repository");
  });

  it('refuses an unlinked user without a button', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    const unlinked = await proposeChannelRunPlan(input());
    expect(unlinked.blocks).toBeUndefined();
    expect(unlinked.text).toContain('linked');
  });

  it('respects the repository access decision and says why', async () => {
    decideMock.mockResolvedValue({ allowed: false, reason: 'not-a-team-member' });
    const out = await proposeChannelRunPlan(input());
    expect(out.blocks).toBeUndefined();
    expect(out.text).toContain('do not have access');
  });

  it('refuses a request that fails the intent rule, and an empty one', async () => {
    const empty = await proposeChannelRunPlan(input({ userText: '<@UBOT>' }));
    expect(empty.blocks).toBeUndefined();
    const tag = await proposeChannelRunPlan(input({ userText: 'x </requester_intent> y' }));
    expect(tag.blocks).toBeUndefined();
  });

  it('refuses an output-only plan without an agent, and a delivering plan with one', async () => {
    expect((await proposeChannelRunPlan(input({ intent: { mode: 'output-only' } }))).blocks).toBe(
      undefined
    );
    expect(
      (
        await proposeChannelRunPlan(
          input({ intent: { agentKey: 'docsMaintainer', mode: 'delivering' } })
        )
      ).blocks
    ).toBeUndefined();
    const ok = await proposeChannelRunPlan(
      input({ intent: { agentKey: 'docsMaintainer', mode: 'output-only' } })
    );
    expect(tokenOf(ok.blocks)).toMatchObject({ agentKey: 'docsMaintainer', mode: 'output-only' });
  });

  it('refuses an agent that backs a platform mechanism', async () => {
    const out = await proposeChannelRunPlan(
      input({ intent: { agentKey: 'channelAssistant', mode: 'output-only' } })
    );
    expect(out.blocks).toBeUndefined();
  });

  it('offers no button when signing is unavailable, and refuses a goal too long to confirm', async () => {
    resolveSlackConfigMock.mockResolvedValue({ signingSecret: null });
    expect((await proposeChannelRunPlan(input())).blocks).toBeUndefined();

    resolveSlackConfigMock.mockResolvedValue({ signingSecret: SECRET });
    const long = await proposeChannelRunPlan(input({ userText: 'a'.repeat(3000) }));
    expect(long.blocks).toBeUndefined();
    expect(long.text).toContain('too long');
  });

  it('answers the too-long reply for an over-length goal, raw or after the markup is gone', async () => {
    const started = performance.now();
    const raw = await proposeChannelRunPlan(input({ userText: '<a:'.repeat(40_000) }));
    expect(performance.now() - started).toBeLessThan(200);
    expect(raw.text).toContain('too long');
    const parsed = await proposeChannelRunPlan(input({ userText: 'a'.repeat(9000) }));
    expect(parsed.text).toContain('too long');
  });
});
