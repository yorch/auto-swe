import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// repositories.ts (for `canManageTeamRepos`) needs `Prisma.DbNull` and `Role` from the barrel;
// mock it so the real PrismaClient is never constructed.
const ROLE = vi.hoisted(() => ({ ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' }) as const);
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  Prisma: { DbNull: { __sentinel: 'DbNull' } },
  Role: ROLE,
}));

const hosts = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; url: string },
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () => hosts.result),
}));

import { TOOLS_FILE_PATH } from '@auto-swe/shared/lib/toolsFile';
import { TemporalUnavailableError } from '../lib/temporalErrors.js';
import { contentHashOf, repositoryOnboardingRoutes } from './repositoryOnboarding.js';

interface AuthState {
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  sub: string;
}

const REPO = '11111111-1111-4111-8111-111111111111';
const TEAM = 'aaaaaaaa-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer fake' };
const SHA = 'a'.repeat(64);

const catalogRow = (key: string, version: string, status = 'ACTIVE') => ({
  archs: { amd64: { sha256: SHA, url: `https://example.com/${key}-${version}.tar.gz` } },
  description: null,
  key,
  libc: 'any',
  member: `bin/${key}`,
  status,
  version,
});

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const authState: AuthState = { role: 'ENGINEER', sub: 'user-1' };
  const prisma = {
    configAuditLog: { create: vi.fn() },
    connection: { findFirst: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
    toolCatalogEntry: { findMany: vi.fn() },
  };
  const temporal = { getOnboardingPrStatus: vi.fn(), startOnboardingPrWorkflow: vi.fn() };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  } as unknown as never);
  await app.register(repositoryOnboardingRoutes, { prefix: '/api/v1' });
  await app.ready();
  return { app, authState, prisma, temporal };
}

describe('repository onboarding routes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(() => {
    ctx.authState.role = 'ENGINEER';
    ctx.authState.sub = 'user-1';
    hosts.result = { ok: true };
    for (const model of Object.values(ctx.prisma)) {
      for (const fn of Object.values(model)) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    for (const fn of Object.values(ctx.temporal)) {
      fn.mockReset();
    }
    ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
    ctx.prisma.toolCatalogEntry.findMany.mockResolvedValue([catalogRow('jq', '1.7.1')]);
    ctx.temporal.startOnboardingPrWorkflow.mockResolvedValue(undefined);
  });

  const repoRow = (over: Record<string, unknown> = {}) => ({
    githubApiUrl: null,
    githubUrl: null,
    id: REPO,
    isActive: true,
    teamId: TEAM,
    type: 'git_repo',
    ...over,
  });
  const leadOfOwningTeam = (yes: boolean) =>
    ctx.prisma.teamMembership.findUnique.mockResolvedValue(
      yes ? { role: 'LEAD', team: { isActive: true } } : null
    );

  describe('POST /repositories/:id/onboarding-pr', () => {
    const body = {
      files: [
        { kind: 'tools', tools: [{ key: 'jq' }] },
        { kind: 'prPolicy', sensitivePaths: ['**/auth/**'] },
      ],
    };
    const post = (payload: unknown = body, headers: Record<string, string> = AUTH) =>
      ctx.app.inject({
        headers,
        method: 'POST',
        payload: payload as never,
        url: `/api/v1/repositories/${REPO}/onboarding-pr`,
      });

    it('is 401 without credentials', async () => {
      expect((await post(body, {})).statusCode).toBe(401);
    });

    it('is 403 for an ENGINEER', async () => {
      expect((await post()).statusCode).toBe(403);
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
    });

    it('is 403 for a LEAD whose team only has the repository shared with it', async () => {
      ctx.authState.role = 'LEAD';
      leadOfOwningTeam(false);
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
      expect(ctx.prisma.teamMembership.findUnique.mock.calls[0][0].where).toEqual({
        userId_teamId: { teamId: TEAM, userId: 'user-1' },
      });
    });

    it('is 404 for a repository the caller cannot reach', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      expect((await post()).statusCode).toBe(404);
    });

    it('starts the workflow for a LEAD of the owning team and answers 202', async () => {
      ctx.authState.role = 'LEAD';
      leadOfOwningTeam(true);
      const res = await post();
      expect(res.statusCode).toBe(202);
      const { files, workflowId } = res.json().data;
      expect(files).toEqual([TOOLS_FILE_PATH, '.auto-swe/pr-policy.yml']);
      expect(workflowId).toMatch(new RegExp(`^onboard-${REPO}-[0-9a-f]{16}$`));
      const [id, input] = ctx.temporal.startOnboardingPrWorkflow.mock.calls[0];
      expect(id).toBe(workflowId);
      expect(input).toEqual({
        connectionId: REPO,
        contentHash: workflowId.slice(`onboard-${REPO}-`.length),
        files: body.files,
        proposedById: 'user-1',
      });
    });

    it('lets an ADMIN through without a membership lookup, with a stable id', async () => {
      ctx.authState.role = 'ADMIN';
      const first = (await post()).json().data.workflowId;
      const second = (await post()).json().data.workflowId;
      expect(ctx.prisma.teamMembership.findUnique).not.toHaveBeenCalled();
      expect(first).toBe(second);
      const other = (await post({ files: [{ kind: 'prPolicy' }] })).json().data.workflowId;
      expect(other).not.toBe(first);
    });

    it('writes an audit entry naming the kinds, tools, paths and the workflow', async () => {
      ctx.authState.role = 'ADMIN';
      const { workflowId } = (await post()).json().data;
      const data = ctx.prisma.configAuditLog.create.mock.calls[0][0].data;
      expect(data.entityType).toBe('Connection');
      expect(data.entityId).toBe(REPO);
      expect(data.action).toBe('UPDATE');
      expect(data.afterJson).toEqual({
        onboardingPr: {
          files: ['tools', 'prPolicy'],
          paths: [TOOLS_FILE_PATH, '.auto-swe/pr-policy.yml'],
          tools: [{ key: 'jq' }],
          workflowId,
        },
      });
    });

    it('still answers 202 when the audit write fails after the run started', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.configAuditLog.create.mockRejectedValueOnce(new Error('audit db down'));
      const res = await post();
      expect(res.statusCode).toBe(202);
      expect(ctx.temporal.startOnboardingPrWorkflow).toHaveBeenCalledTimes(1);
    });

    it('hashes to 16 hex digits, the same vector the worker activity asserts', () => {
      expect(contentHashOf([{ content: 'b', path: 'a' }])).toBe('59b271ae1bbcb1d3');
    });

    it('is 400 for a tool the catalog does not have, naming it', async () => {
      ctx.authState.role = 'ADMIN';
      const res = await post({
        files: [{ kind: 'tools', tools: [{ key: 'jq' }, { key: 'nope' }] }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNKNOWN_TOOL');
      expect(res.json().error.message).toContain('nope');
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
    });

    it('is 400, not 500, for a tool key named twice, and starts nothing', async () => {
      ctx.authState.role = 'ADMIN';
      const res = await post({
        files: [{ kind: 'tools', tools: [{ key: 'jq' }, { key: 'jq', version: '1.7.1' }] }],
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
    });

    it('is 400 for a revoked tool', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.toolCatalogEntry.findMany.mockResolvedValue([
        catalogRow('jq', '1.7.1', 'REVOKED'),
      ]);
      const res = await post({
        files: [{ kind: 'tools', tools: [{ key: 'jq', version: '1.7.1' }] }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TOOL_REVOKED');
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
    });

    it('does not read the catalog for a policy-only request', async () => {
      ctx.authState.role = 'ADMIN';
      expect((await post({ files: [{ kind: 'prPolicy' }] })).statusCode).toBe(202);
      expect(ctx.prisma.toolCatalogEntry.findMany).not.toHaveBeenCalled();
    });

    it('is 400 for a connection that is not a git repository', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow({ type: 'mcp' }));
      const res = await post();
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NOT_A_GIT_REPO');
    });

    it('is 400 for an inactive repository', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow({ isActive: false }));
      expect((await post()).json().error.code).toBe('REPO_INACTIVE');
    });

    it('refuses a repository on a host that is not approved', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(
        repoRow({ githubApiUrl: 'https://evil.example/api', githubUrl: 'https://evil.example' })
      );
      hosts.result = { ok: false, url: 'https://evil.example' };
      const res = await post();
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('REPO_HOST_NOT_ALLOWED');
      expect(ctx.temporal.startOnboardingPrWorkflow).not.toHaveBeenCalled();
    });

    it('rejects an unknown field in the body', async () => {
      ctx.authState.role = 'ADMIN';
      expect((await post({ files: [{ kind: 'prPolicy', path: '.github/x' }] })).statusCode).toBe(
        400
      );
    });

    it('is 503 when Temporal is not connected, and writes no audit entry', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.temporal.startOnboardingPrWorkflow.mockRejectedValue(new TemporalUnavailableError());
      const res = await post();
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('TEMPORAL_UNAVAILABLE');
      expect(ctx.prisma.configAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /repositories/:id/onboarding-pr/:workflowId', () => {
    const OWN_RUN = `onboard-${REPO}-abcd1234abcd1234`;
    const get = (workflowId = OWN_RUN) =>
      ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/repositories/${REPO}/onboarding-pr/${workflowId}`,
      });

    it('is 401 without credentials', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/repositories/${REPO}/onboarding-pr/${OWN_RUN}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('is 403 for a member of a team the repository is merely shared with', async () => {
      ctx.prisma.teamMembership.findUnique.mockResolvedValue(null);
      expect((await get()).statusCode).toBe(403);
      expect(ctx.temporal.getOnboardingPrStatus).not.toHaveBeenCalled();
    });

    it('returns the run for an owning-team member', async () => {
      ctx.prisma.teamMembership.findUnique.mockResolvedValue({ role: 'ENGINEER' });
      const status = {
        result: {
          changed: [TOOLS_FILE_PATH],
          pullRequestNumber: 7,
          pullRequestUrl: 'https://github.com/o/r/pull/7',
          skipped: [],
          status: 'opened',
        },
        status: 'completed',
      };
      ctx.temporal.getOnboardingPrStatus.mockResolvedValue(status);
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: status });
      expect(ctx.temporal.getOnboardingPrStatus).toHaveBeenCalledWith(OWN_RUN);
    });

    it('passes a running and a failed state through', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.temporal.getOnboardingPrStatus.mockResolvedValueOnce({ status: 'running' });
      expect((await get()).json()).toEqual({ data: { status: 'running' } });
      ctx.temporal.getOnboardingPrStatus.mockResolvedValueOnce({
        error: 'The onboarding pull request could not be opened',
        status: 'failed',
      });
      expect((await get()).json().data.status).toBe('failed');
    });

    it('is 404 when Temporal does not know the run', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.temporal.getOnboardingPrStatus.mockResolvedValue(null);
      expect((await get()).statusCode).toBe(404);
    });

    it("is 404 for another repository's run id, without asking Temporal", async () => {
      ctx.authState.role = 'ADMIN';
      const res = await get('onboard-99999999-9999-4999-8999-999999999999-abcd1234abcd1234');
      expect(res.statusCode).toBe(404);
      expect(ctx.temporal.getOnboardingPrStatus).not.toHaveBeenCalled();
    });

    it('is 404 for a run id whose first 8 hex match but the rest of the UUID differs', async () => {
      ctx.authState.role = 'ADMIN';
      const res = await get('onboard-11111111-2222-4222-8222-222222222222-abcd1234abcd1234');
      expect(res.statusCode).toBe(404);
      expect(ctx.temporal.getOnboardingPrStatus).not.toHaveBeenCalled();
    });

    it('is 404 for a repository the caller cannot reach', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      expect((await get()).statusCode).toBe(404);
    });

    it('is 503 when Temporal is not connected', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.temporal.getOnboardingPrStatus.mockRejectedValue(new TemporalUnavailableError());
      expect((await get()).statusCode).toBe(503);
    });
  });
});
