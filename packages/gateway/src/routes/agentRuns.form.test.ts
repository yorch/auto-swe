import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  settings: {
    'repoAccess.mode': 'off',
    'repoAccess.staleAfterHours': 24,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
  } as Record<string, number | string>,
  settingsCtx: [] as unknown[],
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: vi.fn(async (keys: string[], ctx: unknown) => {
    // The request's repo-access gate resolves its own keys; record only the agent-run read.
    if (keys.includes('workspace.agentRunMaxSteps')) {
      cfg.settingsCtx.push(ctx);
    }
    return cfg.settings;
  }),
}));

import { AGENT_RUN_MAX_PROMPT_CHARS } from '@auto-swe/shared/lib/agentRun';
import { MAX_DESCRIPTION_LENGTH } from '../lib/ticketId.js';
import { agentRunRoutes } from './agentRuns.js';

const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OWNER = 'owner-user';
const SHARED = 'shared-user';
const OUTSIDER = 'outsider-user';

type Where = Record<string, unknown>;

/**
 * Evaluates the membership predicate `reachableConnections` builds against the
 * fixture repository, so a test fails when a role the predicate should admit (or
 * refuse) is treated the other way, not merely when the query text changes.
 */
function matches(where: unknown, members: { owner: string[]; shared: string[] }): boolean {
  const w = where as Where;
  if (Array.isArray(w.AND)) {
    return (w.AND as Where[]).every((c) => matches(c, members));
  }
  if (Array.isArray(w.OR)) {
    return (w.OR as Where[]).some((c) => matches(c, members));
  }
  const member = (list: string[], team: unknown) =>
    list.includes((((team as Where).memberships as Where).some as { userId: string }).userId);
  if (w.team) {
    return member(members.owner, w.team);
  }
  if (w.shares) {
    return member(members.shared, ((w.shares as Where).some as Where).team);
  }
  // id / isActive / type filters: the fixture is an active git repo with REPO's id.
  return w.id === undefined || w.id === REPO;
}

describe('agent run form support (agents, limits)', () => {
  let app: FastifyInstance;
  let user: { role: string; sub: string };
  let agentRows: Array<Record<string, unknown>>;
  let agentWheres: Array<Record<string, unknown>>;
  let orgMembers: string[];

  beforeEach(async () => {
    cfg.settingsCtx = [];
    cfg.settings['workspace.agentRunMaxConcurrentGlobal'] = 4;
    cfg.settings['workspace.agentRunMaxConcurrentPerTeam'] = 2;
    cfg.settings['workspace.agentRunMaxSteps'] = 50;
    cfg.settings['workspace.agentRunMaxWallClockSeconds'] = 1800;
    user = { role: 'ENGINEER', sub: OWNER };
    agentWheres = [];
    orgMembers = [OWNER, SHARED, OUTSIDER];
    agentRows = [
      {
        description: 'd',
        key: 'contentWriter',
        name: 'Content writer',
        scope: 'GLOBAL',
        version: 3,
      },
      {
        description: 'd',
        key: 'contentWriter',
        name: 'Content writer',
        scope: 'GLOBAL',
        version: 2,
      },
      { description: 'd', key: 'supportResponder', name: 'Support', scope: 'GLOBAL', version: 1 },
    ];

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: user.role, sub: user.sub }),
    } as unknown as never);
    app.decorate('prisma', {
      agent: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          agentWheres.push(args.where);
          return agentRows;
        },
      },
      connection: {
        findFirst: async ({ where }: { where: unknown }) =>
          matches(where, { owner: [OWNER], shared: [SHARED] })
            ? { id: REPO, team: { orgId: 'org-1' }, teamId: 'team-1' }
            : null,
      },
      organizationMembership: {
        findUnique: async ({ where }: { where: { userId_orgId: { userId: string } } }) =>
          orgMembers.includes(where.userId_orgId.userId) ? { role: 'ORG_MEMBER' } : null,
      },
    } as unknown as never);
    app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
    await app.ready();
  });

  afterEach(() => app.close());

  const get = (url: string) =>
    app.inject({ headers: { authorization: 'Bearer t' }, method: 'GET', url });

  describe('GET /agents', () => {
    it('groups versions per key, newest first, with the pinnable GLOBAL versions', async () => {
      const res = await get('/api/v1/agent-runs/agents');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        {
          description: 'd',
          key: 'contentWriter',
          name: 'Content writer',
          pinnableVersions: [3, 2],
          scope: 'GLOBAL',
          version: 3,
        },
        {
          description: 'd',
          key: 'supportResponder',
          name: 'Support',
          pinnableVersions: [1],
          scope: 'GLOBAL',
          version: 1,
        },
      ]);
    });

    it('does not offer a key the launch grammar would refuse', async () => {
      agentRows = [
        { description: null, key: 'has space', name: 'Odd', scope: 'GLOBAL', version: 1 },
        ...agentRows,
      ];
      const keys = (await get('/api/v1/agent-runs/agents'))
        .json()
        .data.map((a: { key: string }) => a.key);
      expect(keys).not.toContain('has space');
      expect(keys).toContain('contentWriter');
    });

    it('bounds the prompt by the same limit as the work request description', () => {
      expect(AGENT_RUN_MAX_PROMPT_CHARS).toBe(MAX_DESCRIPTION_LENGTH);
    });

    it('excludes every non-launchable key in the query itself', async () => {
      await get('/api/v1/agent-runs/agents');
      const keyFilter = (agentWheres[0] as { key: { notIn: string[] } }).key.notIn;
      expect(keyFilter).toEqual(
        expect.arrayContaining([
          'securityReview',
          'evalJudge',
          'channelAssistant',
          'workflowAuthor',
        ])
      );
    });

    it('without a repository asks for GLOBAL rows only', async () => {
      await get('/api/v1/agent-runs/agents');
      expect(agentWheres[0]?.OR).toEqual([
        { channelId: null, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
      ]);
    });

    it('with a repository adds its ORGANIZATION scope and never TEAM scope', async () => {
      const res = await get(`/api/v1/agent-runs/agents?repoId=${REPO}`);
      expect(res.statusCode).toBe(200);
      expect(agentWheres[0]?.OR).toEqual([
        { channelId: null, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
        { orgId: 'org-1', scope: 'ORGANIZATION' },
      ]);
      expect(JSON.stringify(agentWheres[0])).not.toContain('TEAM');
    });

    it('offers an org override as the effective agent and withdraws version pins for it', async () => {
      agentRows = [
        {
          description: 'org',
          key: 'contentWriter',
          name: 'Org writer',
          scope: 'ORGANIZATION',
          version: 9,
        },
        {
          description: 'g',
          key: 'contentWriter',
          name: 'Content writer',
          scope: 'GLOBAL',
          version: 3,
        },
      ];
      const res = await get(`/api/v1/agent-runs/agents?repoId=${REPO}`);
      expect(res.json().data).toEqual([
        {
          description: 'org',
          key: 'contentWriter',
          name: 'Org writer',
          pinnableVersions: [],
          scope: 'ORGANIZATION',
          version: 9,
        },
      ]);
    });

    it('a member of a team the repository is SHARED with gets the same org-scoped list', async () => {
      user = { role: 'ENGINEER', sub: SHARED };
      const res = await get(`/api/v1/agent-runs/agents?repoId=${REPO}`);
      expect(res.statusCode).toBe(200);
      expect(agentWheres[0]?.OR).toContainEqual({ orgId: 'org-1', scope: 'ORGANIZATION' });
    });

    it('answers 404, not 403, for a repository the caller cannot reach', async () => {
      user = { role: 'ENGINEER', sub: OUTSIDER };
      const res = await get(`/api/v1/agent-runs/agents?repoId=${REPO}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CONNECTION_NOT_FOUND');
      expect(agentWheres).toEqual([]);
    });

    it('404s a team member who is not a member of the repository organization, as the launch refuses them', async () => {
      orgMembers = [];
      const res = await get(`/api/v1/agent-runs/agents?repoId=${REPO}`);
      expect(res.statusCode).toBe(404);
      expect(agentWheres).toEqual([]);
    });

    it('an ADMIN reaches a repository of a team they do not belong to', async () => {
      user = { role: 'ADMIN', sub: OUTSIDER };
      expect((await get(`/api/v1/agent-runs/agents?repoId=${REPO}`)).statusCode).toBe(200);
    });

    it('requires ENGINEER', async () => {
      user = { role: 'VIEWER', sub: OWNER };
      expect((await get('/api/v1/agent-runs/agents')).statusCode).toBe(403);
    });

    it('rejects a malformed repoId', async () => {
      expect((await get('/api/v1/agent-runs/agents?repoId=nope')).statusCode).toBe(400);
    });
  });

  describe('GET /limits', () => {
    it('reports ceilings with their hard bounds', async () => {
      const res = await get('/api/v1/agent-runs/limits');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        concurrency: { global: 4, perTeam: 2 },
        enabled: true,
        maxSteps: { ceiling: 50, max: 500, min: 1 },
        maxWallClockSeconds: { ceiling: 1800, max: 14400, min: 60 },
      });
    });

    it('resolves at the repository scope (org and owning team) when given one', async () => {
      user = { role: 'ENGINEER', sub: SHARED };
      await get(`/api/v1/agent-runs/limits?repoId=${REPO}`);
      expect(cfg.settingsCtx).toEqual([{ orgId: 'org-1', teamId: 'team-1' }]);
    });

    it('reports disabled when the global switch or the repository team switch is 0', async () => {
      cfg.settings['workspace.agentRunMaxConcurrentGlobal'] = 0;
      expect((await get('/api/v1/agent-runs/limits')).json().data.enabled).toBe(false);
      cfg.settings['workspace.agentRunMaxConcurrentGlobal'] = 4;
      cfg.settings['workspace.agentRunMaxConcurrentPerTeam'] = 0;
      expect((await get(`/api/v1/agent-runs/limits?repoId=${REPO}`)).json().data.enabled).toBe(
        false
      );
    });

    it('404s a repository the caller cannot reach, without resolving settings', async () => {
      user = { role: 'ENGINEER', sub: OUTSIDER };
      expect((await get(`/api/v1/agent-runs/limits?repoId=${REPO}`)).statusCode).toBe(404);
      expect(cfg.settingsCtx).toEqual([]);
    });

    it('404s a non-org-member team member without resolving settings', async () => {
      orgMembers = [];
      expect((await get(`/api/v1/agent-runs/limits?repoId=${REPO}`)).statusCode).toBe(404);
      expect(cfg.settingsCtx).toEqual([]);
    });

    it('requires ENGINEER', async () => {
      user = { role: 'VIEWER', sub: OWNER };
      expect((await get('/api/v1/agent-runs/limits')).statusCode).toBe(403);
    });
  });
});
