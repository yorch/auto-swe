import type { FastifyInstance, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startRunPlanMock = vi.fn();
vi.mock('../runPlanStart.js', () => ({
  startRunPlan: (...a: unknown[]) => startRunPlanMock(...a),
}));

const postSlackMessageMock = vi.fn(async () => '9.9');
vi.mock('../slack.js', () => ({
  postSlackMessage: (...a: unknown[]) => postSlackMessageMock(...(a as [])),
}));

const respondMock = vi.fn(async () => undefined);
vi.mock('./respond.js', () => ({
  respondToInteraction: (...a: unknown[]) => respondMock(...(a as [])),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: vi.fn(async () => 'xoxb-test'),
  resolveWebUrl: vi.fn(() => 'https://dash.example.com/'),
}));

vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 72 })),
}));

import {
  type SlackRunPlanClaims,
  signSlackRunPlanToken,
  slackRunPlanIntentHash,
} from '@auto-swe/shared/lib/slackRunPlanToken';
import { handleRunPlanGenerateAction, planReviewUrl } from './runPlanActions.js';
import type { SlackInteractivePayload } from './types.js';

const SECRET = 'signing-secret';
const REPO_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = 'runplan-aabbccdd-0123456789abcdef';

const fastify = {} as FastifyInstance;
const request = { log: { error: vi.fn(), warn: vi.fn() } } as unknown as FastifyRequest;
const user = { id: 'user-1', role: 'USER' as const };

function claims(overrides: Partial<SlackRunPlanClaims> = {}): SlackRunPlanClaims {
  const intent = overrides.intent ?? 'add rate limiting <!channel>';
  return {
    agentKey: null,
    channelId: 'C123',
    exp: Date.now() + 60_000,
    intent,
    intentHash: slackRunPlanIntentHash(intent),
    jti: 'ab'.repeat(12),
    mode: 'delivering',
    repoId: REPO_ID,
    slackUserId: 'U1',
    threadTs: '111.222',
    ...overrides,
  };
}

function payload(
  token: string,
  overrides: Partial<SlackInteractivePayload> = {}
): SlackInteractivePayload {
  return {
    actions: [{ action_id: 'run_plan_generate', value: token }],
    channel: { id: 'C123' },
    message: { thread_ts: '111.222', ts: '111.333' },
    response_url: 'https://hooks.slack.test/r',
    type: 'block_actions',
    user: { id: 'U1' },
    ...overrides,
  };
}

const click = (p: SlackInteractivePayload) =>
  handleRunPlanGenerateAction(fastify, request, user, p, SECRET);

/** What the clicker was told, privately. */
const ephemeral = () => respondMock.mock.calls.map((c) => (c as unknown as [unknown, string])[1]);

beforeEach(() => {
  vi.clearAllMocks();
  startRunPlanMock.mockResolvedValue({ deduplicated: false, jobId: JOB_ID, ok: true });
});

describe('handleRunPlanGenerateAction', () => {
  it('starts generation as the clicker with the goal from the token and a key derived from its id', async () => {
    const c = claims();
    const out = await click(payload(signSlackRunPlanToken(c, SECRET)));

    expect(out).toEqual({ data: { action: 'run_plan_generate', ok: true, reason: 'started' } });
    expect(startRunPlanMock).toHaveBeenCalledTimes(1);
    const [, deps, args] = startRunPlanMock.mock.calls[0] as [
      unknown,
      { gate: unknown },
      Record<string, unknown>,
    ];
    expect(deps.gate).toEqual({ mode: 'off', staleAfterHours: 72 });
    expect(args).toMatchObject({
      agent: undefined,
      idempotencyKey: `slack-run-plan:${c.jti}`,
      intent: c.intent,
      repoId: REPO_ID,
      source: 'slack',
      user: { sub: 'user-1' },
    });
    // The acting user is the platform user the Slack id links to, never the channel or a service.
    expect((args.user as { role: string }).role).toBe('USER');
  });

  it('replies privately that it is generating, and posts a Review plan link button in the thread', async () => {
    await click(payload(signSlackRunPlanToken(claims(), SECRET)));

    expect(ephemeral()[0]).toContain('Generating your plan');
    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    const [post] = postSlackMessageMock.mock.calls[0] as unknown as [
      { channel: string; threadTs: string; blocks: Array<{ type: string; elements?: unknown[] }> },
    ];
    expect(post.channel).toBe('C123');
    expect(post.threadTs).toBe('111.222');
    const actions = post.blocks.find((b) => b.type === 'actions');
    expect(actions?.elements).toEqual([
      expect.objectContaining({
        action_id: 'card_link_run_plan_review',
        type: 'button',
        url: `https://dash.example.com/start?mode=plan&job=${JOB_ID}`,
      }),
    ]);
    // Nothing in what the thread sees carries the goal.
    expect(JSON.stringify(post)).not.toContain('rate limiting');
  });

  it('builds the review link from the dashboard base url', () => {
    expect(planReviewUrl('runplan-x')).toBe(
      'https://dash.example.com/start?mode=plan&job=runplan-x'
    );
  });

  it('passes the agent of an output-only plan', async () => {
    const c = claims({ agentKey: 'docsMaintainer', mode: 'output-only' });
    await click(payload(signSlackRunPlanToken(c, SECRET)));
    expect(startRunPlanMock.mock.calls[0]?.[2]).toMatchObject({ agent: 'docsMaintainer' });
  });

  it('refuses a clicker who is not the person the token names', async () => {
    const out = await click(
      payload(signSlackRunPlanToken(claims(), SECRET), { user: { id: 'U2' } })
    );
    expect(startRunPlanMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ data: { ok: false, reason: 'not_creator' } });
    expect(ephemeral()[0]).toContain('Only the person');
  });

  it('refuses an expired token', async () => {
    const out = await click(
      payload(signSlackRunPlanToken(claims({ exp: Date.now() - 1 }), SECRET))
    );
    expect(startRunPlanMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ data: { ok: false, reason: 'expired' } });
    expect(ephemeral()[0]).toContain('expired');
  });

  it('refuses a forged, foreign-signed or malformed token', async () => {
    for (const value of [signSlackRunPlanToken(claims(), 'another-secret'), 'garbage', '']) {
      const out = await click(payload(value));
      expect(out).toMatchObject({ data: { ok: false } });
    }
    expect(startRunPlanMock).not.toHaveBeenCalled();
  });

  it('refuses a click that did not come from the message and thread the token names', async () => {
    const token = signSlackRunPlanToken(claims(), SECRET);
    await click(payload(token, { channel: { id: 'C999' } }));
    await click(payload(token, { message: { thread_ts: '999.000', ts: '999.001' } }));
    expect(startRunPlanMock).not.toHaveBeenCalled();
  });

  it('answers a replayed token with "already used" and posts nothing', async () => {
    startRunPlanMock.mockResolvedValue({ deduplicated: true, jobId: JOB_ID, ok: true });
    const out = await click(payload(signSlackRunPlanToken(claims(), SECRET)));
    expect(out).toMatchObject({ data: { ok: false, reason: 'already_used' } });
    expect(ephemeral()[0]).toContain('already used');
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it('answers a key the job history no longer holds, but a plan does, as already used', async () => {
    startRunPlanMock.mockResolvedValue({
      code: 'IDEMPOTENCY_KEY_MISMATCH',
      message: 'This Idempotency-Key already produced a plan',
      ok: false,
      status: 422,
    });
    const out = await click(payload(signSlackRunPlanToken(claims(), SECRET)));
    expect(out).toMatchObject({ data: { ok: false, reason: 'already_used' } });
  });

  it('relays a refusal (a VIEWER, no repository reach, a quota) privately and starts nothing', async () => {
    for (const refusal of [
      { code: 'FORBIDDEN', message: 'Run plans need the ENGINEER role' },
      { code: 'FORBIDDEN', message: 'You do not have access to this repository.' },
      { code: 'RUN_PLAN_RATE_LIMITED', message: 'You have started the most plan generations' },
    ]) {
      respondMock.mockClear();
      startRunPlanMock.mockResolvedValue({ ...refusal, ok: false, status: 403 });
      const out = await click(payload(signSlackRunPlanToken(claims(), SECRET)));
      expect(out).toMatchObject({ data: { ok: false, reason: refusal.code } });
      expect(ephemeral()[0]).toContain(refusal.message);
    }
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it('escapes a refusal message and never puts the goal in a reply or a log', async () => {
    startRunPlanMock.mockResolvedValue({
      code: 'REPO_HOST_NOT_ALLOWED',
      message: 'host <!channel> not allowed',
      ok: false,
      status: 422,
    });
    await click(payload(signSlackRunPlanToken(claims({ intent: 'secret goal text' }), SECRET)));
    expect(ephemeral()[0]).toContain('&lt;!channel&gt;');
    expect(JSON.stringify(respondMock.mock.calls)).not.toContain('secret goal text');
    expect(JSON.stringify(vi.mocked(request.log.error).mock.calls)).not.toContain('secret goal');
  });

  it('tells the clicker to retry when the start throws, without logging the goal', async () => {
    startRunPlanMock.mockRejectedValue(new Error('temporal down: secret goal text'));
    const out = await click(
      payload(signSlackRunPlanToken(claims({ intent: 'secret goal text' }), SECRET))
    );
    expect(out).toMatchObject({ data: { ok: false, reason: 'start_failed' } });
    expect(JSON.stringify(vi.mocked(request.log.error).mock.calls)).not.toContain('secret goal');
  });

  it('still succeeds when the review link cannot be posted', async () => {
    postSlackMessageMock.mockRejectedValueOnce(new Error('slack down'));
    const out = await click(payload(signSlackRunPlanToken(claims(), SECRET)));
    expect(out).toMatchObject({ data: { ok: true } });
  });
});
