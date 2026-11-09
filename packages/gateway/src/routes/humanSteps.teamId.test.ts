import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

// The route only uses `Prisma.DbNull` at runtime; mocking the barrel avoids a real PrismaClient.
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: { __sentinel: 'Prisma.DbNull' } } }));
vi.mock('../lib/hitlSlackSync.js', () => ({ syncSlackHumanStepOutcome: vi.fn() }));

import { humanStepListWhere, humanStepMineScope } from '../lib/humanStepFilters.js';
import { runListTeamScope } from '../lib/runTeamScope.js';
import { humanStepRoutes } from './humanSteps.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer fake' };
const TEAM_TERM = { run: runListTeamScope(TEAM) };

async function build(role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    team: { findFirst: vi.fn().mockResolvedValue({ id: TEAM }) },
    workflowHumanStep: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: USER }),
  } as never);
  await app.register(humanStepRoutes, { prefix: '/steps' });
  await app.ready();
  return { app, prisma };
}

describe('GET /human-steps?teamId=', () => {
  it('ANDs the team scope beside the list predicate as its own element, so it only narrows', async () => {
    const { app, prisma } = await build();
    const res = await app.inject({ headers: AUTH, url: `/steps?actionable=true&teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    const { where } = prisma.workflowHumanStep.findMany.mock.calls[0][0];
    const expected = humanStepListWhere({ role: 'ENGINEER', sub: USER }, undefined, {
      actionable: true,
      answeredByMe: false,
      overdue: false,
      status: 'PENDING',
    });
    expect(where.AND).toHaveLength(2);
    // The list predicate carries `new Date()` values, so compare its shape, not its instants.
    expect(Object.keys(where.AND[0]).sort()).toEqual(Object.keys(expected).sort());
    expect(where.AND[0].humanApprovals).toEqual({ none: { resolvedBy: USER } });
    expect(where.AND[1]).toEqual(TEAM_TERM);
    expect(where.run).toBeUndefined();
    await app.close();
  });

  it('keeps count=true and mine=true compatible: each term is its own AND element', async () => {
    const { app, prisma } = await build();
    const res = await app.inject({
      headers: AUTH,
      url: `/steps?actionable=true&count=true&mine=true&teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.total).toBe(3);
    const { where } = prisma.workflowHumanStep.count.mock.calls[0][0];
    expect(where).toEqual(prisma.workflowHumanStep.findMany.mock.calls[0][0].where);
    expect(where.AND).toHaveLength(3);
    expect(where.AND[1]).toEqual(humanStepMineScope({ role: 'ENGINEER', sub: USER }));
    expect(where.AND[2]).toEqual(TEAM_TERM);
    await app.close();
  });

  it('answers 404 TEAM_NOT_FOUND for a non-member and reads nothing', async () => {
    const { app, prisma } = await build();
    prisma.team.findFirst.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, url: `/steps?teamId=${TEAM}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TEAM_NOT_FOUND');
    expect(prisma.workflowHumanStep.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a platform ADMIN name any team without a membership lookup', async () => {
    const { app, prisma } = await build('ADMIN');
    prisma.team.findFirst.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, url: `/steps?teamId=${TEAM}` });
    expect(res.statusCode).toBe(200);
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('adds no term without the parameter', async () => {
    const { app, prisma } = await build();
    await app.inject({ headers: AUTH, url: '/steps' });
    expect(prisma.workflowHumanStep.findMany.mock.calls[0][0].where.AND).toBeUndefined();
    await app.close();
  });
});
