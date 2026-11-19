import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  agentKeys: vi.fn(),
  authorize: vi.fn(),
  engineer: vi.fn(),
  release: vi.fn(),
  reserve: vi.fn(),
}));
vi.mock('./runPlanService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runPlanService.js')>()),
  authorizeRepository: m.authorize,
  requireActivePlanUser: m.engineer,
}));
vi.mock('./launchableAgents.js', () => ({ launchableAgentKeys: m.agentKeys }));
vi.mock('./runPlanQuotas.js', () => ({
  releaseGenerationSlot: m.release,
  reserveGenerationSlot: m.reserve,
}));

import { runPlanIntentHash, startRunPlan } from './runPlanStart.js';

const USER = {
  exp: 0,
  iat: 0,
  role: 'ENGINEER' as const,
  sub: '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa',
};
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const temporal = {
  getRunPlanJob: vi.fn(),
  startRunPlanGeneration: vi.fn(),
};
const prisma = { runPlan: { findUnique: vi.fn() } };
const fastify = { prisma, temporal } as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.engineer.mockResolvedValue({ ok: true });
  m.authorize.mockResolvedValue({ ok: true, repo: { id: REPO, orgId: 'org-1', teamId: 'team-1' } });
  m.agentKeys.mockResolvedValue(['docsMaintainer']);
  m.reserve.mockResolvedValue({ auditId: 'audit-1', ok: true });
  temporal.getRunPlanJob.mockResolvedValue({ status: 'not_found' });
  temporal.startRunPlanGeneration.mockResolvedValue({ started: true });
  prisma.runPlan.findUnique.mockResolvedValue(null);
});

const args = { idempotencyKey: 'k-1', intent: 'do the thing', repoId: REPO, user: USER };

describe('startRunPlan', () => {
  it('refuses a person who is not an active user before reading the repository', async () => {
    m.engineer.mockResolvedValue({
      code: 'FORBIDDEN',
      message: 'Only an active user can use run plans',
      ok: false,
      status: 403,
    });
    const out = await startRunPlan(fastify, {}, args);
    expect(out).toMatchObject({ code: 'FORBIDDEN', ok: false });
    expect(m.authorize).not.toHaveBeenCalled();
    expect(temporal.startRunPlanGeneration).not.toHaveBeenCalled();
  });

  it('relays a repository refusal and starts nothing', async () => {
    m.authorize.mockResolvedValue({
      code: 'CONNECTION_NOT_FOUND',
      message: 'x',
      ok: false,
      status: 404,
    });
    const out = await startRunPlan(fastify, {}, args);
    expect(out).toMatchObject({ code: 'CONNECTION_NOT_FOUND', ok: false, status: 404 });
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it('refuses an agent that backs a platform mechanism, and one the organization cannot launch', async () => {
    expect(await startRunPlan(fastify, {}, { ...args, agent: 'channelAssistant' })).toMatchObject({
      code: 'AGENT_NOT_LAUNCHABLE',
      status: 400,
    });
    expect(await startRunPlan(fastify, {}, { ...args, agent: 'contentWriter' })).toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    });
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it('starts one job under a key-derived id, recording the source on the reservation', async () => {
    const out = await startRunPlan(fastify, {}, { ...args, source: 'slack' });
    expect(out).toMatchObject({ deduplicated: false, ok: true });
    expect(m.reserve.mock.calls[0]?.[1]).toMatchObject({ mode: 'delivering', source: 'slack' });
    const jobId = (out as { jobId: string }).jobId;
    expect(jobId).toMatch(/^runplan-0a1b2c3d-[0-9a-f]{16}$/);
    const [startedId, input, memo] = temporal.startRunPlanGeneration.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(startedId).toBe(jobId);
    expect(input).toMatchObject({ intent: 'do the thing', mode: 'delivering', teamId: 'team-1' });
    expect(memo).toMatchObject({
      intentHash: runPlanIntentHash(REPO, undefined, 'do the thing'),
      ownerUserId: USER.sub,
    });

    // The same key always names the same job.
    const again = await startRunPlan(fastify, {}, args);
    expect((again as { jobId: string }).jobId).toBe(jobId);
  });

  it('builds an output-only plan on a launchable agent', async () => {
    const out = await startRunPlan(fastify, {}, { ...args, agent: 'docsMaintainer' });
    expect(out).toMatchObject({ ok: true });
    expect(m.reserve.mock.calls[0]?.[1]).toMatchObject({ mode: 'output-only' });
  });

  it('answers a retried key with the earlier job, without a second reservation', async () => {
    temporal.getRunPlanJob.mockResolvedValue({
      memo: {
        intentHash: runPlanIntentHash(REPO, undefined, 'do the thing'),
        mode: 'delivering',
        ownerUserId: USER.sub,
        repoId: REPO,
        teamId: 'team-1',
      },
      status: 'running',
    });
    const out = await startRunPlan(fastify, {}, args);
    expect(out).toMatchObject({ deduplicated: true, ok: true });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(temporal.startRunPlanGeneration).not.toHaveBeenCalled();
  });

  it("refuses a key that names another goal, and another person's job", async () => {
    const memo = (over: Record<string, unknown>) => ({
      memo: {
        intentHash: runPlanIntentHash(REPO, undefined, 'do the thing'),
        mode: 'delivering',
        ownerUserId: USER.sub,
        repoId: REPO,
        teamId: 'team-1',
        ...over,
      },
      status: 'running',
    });
    temporal.getRunPlanJob.mockResolvedValue(memo({}));
    expect(await startRunPlan(fastify, {}, { ...args, intent: 'another goal' })).toMatchObject({
      code: 'IDEMPOTENCY_KEY_MISMATCH',
      status: 422,
    });
    temporal.getRunPlanJob.mockResolvedValue(memo({ ownerUserId: 'someone-else' }));
    expect(await startRunPlan(fastify, {}, args)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
  });

  it('refuses a key whose plan survives its job history', async () => {
    prisma.runPlan.findUnique.mockResolvedValue({ id: 'plan' });
    expect(await startRunPlan(fastify, {}, args)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_MISMATCH',
    });
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it("gives its slot back when it lost the race to start the job, and answers the winner's job", async () => {
    temporal.startRunPlanGeneration.mockResolvedValue({ started: false });
    temporal.getRunPlanJob.mockResolvedValueOnce({ status: 'not_found' }).mockResolvedValueOnce({
      memo: {
        intentHash: runPlanIntentHash(REPO, undefined, 'do the thing'),
        mode: 'delivering',
        ownerUserId: USER.sub,
        repoId: REPO,
        teamId: 'team-1',
      },
      status: 'running',
    });
    const out = await startRunPlan(fastify, {}, args);
    expect(out).toMatchObject({ deduplicated: true, ok: true });
    expect(m.release).toHaveBeenCalledWith(fastify, { auditId: 'audit-1', userId: USER.sub });
  });

  it('relays a quota refusal, and gives the slot back only when the start provably failed', async () => {
    m.reserve.mockResolvedValue({
      code: 'RUN_PLAN_RATE_LIMITED',
      message: 'x',
      ok: false,
      status: 429,
    });
    expect(await startRunPlan(fastify, {}, args)).toMatchObject({ code: 'RUN_PLAN_RATE_LIMITED' });

    m.reserve.mockResolvedValue({ auditId: 'audit-2', ok: true });
    temporal.startRunPlanGeneration.mockRejectedValue(new Error('boom'));
    temporal.getRunPlanJob.mockResolvedValue({ status: 'not_found' });
    await expect(startRunPlan(fastify, {}, args)).rejects.toThrow('boom');
    expect(m.release).toHaveBeenCalledTimes(1);

    m.release.mockClear();
    temporal.getRunPlanJob.mockResolvedValueOnce({ status: 'not_found' }); // before reserve
    temporal.getRunPlanJob.mockResolvedValueOnce({ memo: {}, status: 'running' }); // after failure
    await expect(startRunPlan(fastify, {}, args)).rejects.toThrow('boom');
    expect(m.release).not.toHaveBeenCalled();
  });
});
