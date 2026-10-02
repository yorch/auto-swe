import crypto from 'node:crypto';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import rateLimit from '@fastify/rate-limit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { hashPassword } from 'better-auth/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import authPlugin, { invalidateUserAuthCache, ipRateLimitKey } from '../../plugins/auth.js';
import prismaPlugin from '../../plugins/prisma.js';
import { mcpRoutes } from '../../routes/mcp.js';
import { workflowRunRoutes } from '../../routes/workflowRuns.js';
import { workRequestRoutes } from '../../routes/workRequests.js';
import { initAuth, MCP_RESOURCE } from '../betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from '../betterAuthHandler.js';
import { registerFormBodyParser } from '../formBody.js';
import { mcpOAuthGate } from '../mcpOAuthGate.js';
import { mcpOAuthGateOptions } from '../mcpOAuthGateOptions.js';
import { mcpRouteOptions } from '../mcpRouteOptions.js';
import { resetMcpWriteRateLimit } from '../mcpWriteGuard.js';
import { MCP_BRIDGE_HEADER, mcpBridgePlugin } from './bridge.js';

// The enrichment and the canary read integration config this test does not need.
vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCanaryConfig: vi.fn(async () => ({ enabled: false })),
  resolveFigmaConfig: vi.fn(async () => ({ enabled: false })),
  resolveIssueTrackerConfig: vi.fn(async () => ({ provider: null })),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({ enabled: false, provider: null })),
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));

/**
 * The write tools against the real route plugins, real tokens from the real authorization-code
 * flow, and real Postgres. The point of this file is the concurrency cap: it is a count taken
 * under a lock inside the transaction that inserts the ledger rows, which only a real database,
 * parallel requests and real transactions can exercise.
 *
 * Opt in with `MCP_OAUTH_PG_TEST=1` and a `DATABASE_URL` for a throwaway database that
 * `prisma migrate deploy` has been run against (it creates and deletes rows). Run it on its own:
 * it clears the OAuth tables, as the other MCP suites do.
 *
 *   MCP_OAUTH_PG_TEST=1 DATABASE_URL=... yarn vitest run packages/gateway/src/lib/mcp/writeTools.pg.test.ts
 */
const enabled = process.env.MCP_OAUTH_PG_TEST === '1';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:8080';
const REDIRECT = 'http://127.0.0.1:33333/cb';
const PASSWORD = 'correct horse battery staple';
const MARK = `mcpwrite${Date.now().toString(36)}`;
const SECRET_TEXT = 'SECRET-DESCRIPTION-TEXT';

const b64url = (buf: Buffer) => buf.toString('base64url');

const modernMeta = {
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'pg-test', version: '1.0.0' },
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
};

describe.skipIf(!enabled)('MCP write tools against Postgres', () => {
  let app: FastifyInstance;
  let seq = 0;
  let leaked = '';
  let startDelayMs = 0;
  let beforeReplySend: (() => Promise<void>) | null = null;
  const started: Array<{ id: string; launchedById?: string; budgetTier?: string }> = [];
  const cancelled: string[] = [];

  const call = (
    method: 'GET' | 'POST',
    url: string,
    opts: { cookie?: string; json?: unknown; form?: Record<string, string> } = {}
  ) =>
    app.inject({
      headers: {
        host: HOST,
        origin: ORIGIN,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      method,
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
      remoteAddress: `198.51.100.${(seq++ % 250) + 1}`,
      url,
    });

  async function makeUser(label: string) {
    const email = `${MARK}-${label}@example.test`;
    const user = await prisma.user.create({
      data: { email, emailVerified: true, isActive: true, name: `Name ${label}`, role: 'ENGINEER' },
    });
    await prisma.account.create({
      data: {
        accountId: user.id,
        password: await hashPassword(PASSWORD),
        providerId: 'credential',
        userId: user.id,
      },
    });
    const res = await call('POST', '/api/auth/sign-in/email', {
      json: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    return { cookie, id: user.id };
  }

  /** The authorize step; returns the redirect the client would follow. */
  async function authorize(cookie: string, clientId: string, scope: string, challenge: string) {
    const auth = await call(
      'GET',
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
        response_type: 'code',
        scope,
        state: 's',
      })}`,
      { cookie }
    );
    expect(auth.statusCode, auth.body).toBe(302);
    return new URL(String(auth.headers.location));
  }

  async function registerClient() {
    const reg = await call('POST', '/api/auth/oauth2/register', {
      json: {
        client_name: 'Write Test Client',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT],
        response_types: ['code'],
        scope: 'mcp:read mcp:write offline_access',
        token_endpoint_auth_method: 'none',
      },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    return reg.json().client_id as string;
  }

  /** A token from the real authorization-code flow, with PKCE and consent. */
  async function issueToken(cookie: string, scope: string) {
    const clientId = await registerClient();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    let redirect = await authorize(cookie, clientId, scope, challenge);
    if (!redirect.searchParams.has('code')) {
      const consent = await call('POST', '/api/auth/oauth2/consent', {
        cookie,
        json: { accept: true, oauth_query: redirect.search.slice(1) },
      });
      expect(consent.statusCode, consent.body).toBe(200);
      redirect = new URL(consent.json().url ?? consent.json().redirect_uri);
    }
    const tokens = await call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        code: redirect.searchParams.get('code') as string,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
      },
    });
    expect(tokens.statusCode, tokens.body).toBe(200);
    return { clientId, token: tokens.json().access_token as string };
  }

  const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
    app.inject({
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        'mcp-protocol-version': '2026-07-28',
      },
      method: 'POST',
      payload: JSON.stringify({
        id: ++seq,
        jsonrpc: '2.0',
        method,
        params: { _meta: modernMeta, ...params },
      }),
      remoteAddress: `203.0.113.${(seq % 250) + 1}`,
      url: '/api/v1/mcp',
    });

  async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    const res = await rpc(token, 'tools/call', { arguments: args, name });
    return {
      res,
      result: res.statusCode === 200 ? JSON.parse(res.body).result : null,
    };
  }

  const toolNames = async (token: string) =>
    (JSON.parse((await rpc(token, 'tools/list')).body).result.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();

  async function setSettings(values: Record<string, unknown>) {
    await runUnscoped(
      'test fixture: GLOBAL mcp.* settings have no tenant',
      ['ConfigSetting'],
      async () => {
        await prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } });
        await prisma.configSetting.createMany({
          data: Object.entries(values).map(([key, value]) => ({
            key,
            scope: 'GLOBAL' as const,
            value: value as never,
          })),
        });
      }
    );
    invalidateSettingsCache();
  }
  const settingsOn = (extra: Record<string, unknown> = {}) =>
    setSettings({
      'mcp.enabled': true,
      'mcp.maxConcurrentRuns': 2,
      'mcp.writeCallsPerMinute': 600,
      'mcp.writeToolsEnabled': true,
      ...extra,
    });

  const ids = {} as Record<string, string>;
  const people = {} as Record<
    'alice' | 'bob' | 'carol' | 'dave' | 'erin',
    { cookie: string; id: string; token: string; clientId: string; readToken?: string }
  >;

  /** A fresh ticket id per call, so one test's runs never block another's. */
  const ticket = (label = 'T') => `${label}-${++seq}-${Date.now().toString(36)}`;
  const submitArgs = (over: Record<string, unknown> = {}) => ({
    description: `Add a health endpoint ${SECRET_TEXT}`,
    externalTicketId: ticket(),
    idempotencyKey: crypto.randomUUID(),
    repoId: ids.repo as string,
    ...over,
  });
  const submit = (token: string, over: Record<string, unknown> = {}) =>
    callTool(token, 'submit_work_request', submitArgs(over));

  /** The caller's runs that count against the cap. */
  const inFlight = (userId: string) =>
    prisma.activeWorkflow.count({
      where: {
        currentStatus: { notIn: ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] },
        workRequest: { requestedById: userId },
      },
    });

  /** Free a user's slots between tests. */
  const clearRuns = async () => {
    const wfs = {
      repoId: { in: [ids.repo, ids.poorRepo] },
      temporalWorkflowId: { startsWith: 'eng-' },
    };
    await prisma.workflowRun.deleteMany({ where: { workflowId: { startsWith: `eng-${MARK}` } } });
    await prisma.workflowRun.deleteMany({ where: { workflowId: { startsWith: `${MARK}-run` } } });
    await prisma.activeWorkflow.deleteMany({ where: wfs });
    await prisma.runInput.deleteMany({
      where: { connectionId: { in: [ids.repo, ids.poorRepo] } },
    });
    await prisma.configAuditLog.deleteMany({ where: { entityType: 'McpToolCall' } });
  };

  async function fixtures() {
    await runUnscoped(
      'test fixture: tenants',
      ['Team', 'TeamMembership', 'Connection', 'WorkflowTemplate', 'ConnectionTeamShare'],
      async () => {
        for (const [key, budget] of [
          ['', null],
          ['poor', 100],
        ] as const) {
          const org = await prisma.organization.create({
            data: {
              monthlyBudgetUsdCents: budget,
              name: `${MARK} org ${key}`,
              slug: `${MARK}-org${key}`,
            },
          });
          const team = await prisma.team.create({
            data: { name: `${MARK} Team ${key}`, orgId: org.id, slug: `${MARK}-team${key}` },
          });
          const repo = await prisma.connection.create({
            data: {
              organizationName: `acme${MARK}${key}`,
              repoName: `api${key}`,
              teamId: team.id,
              type: 'git_repo',
            },
          });
          await prisma.workflowTemplate.create({
            data: {
              activeVersion: 1,
              isDefault: true,
              name: `${MARK} default ${key}`,
              status: 'ACTIVE',
              teamId: team.id,
            },
          });
          ids[`org${key}`] = org.id;
          ids[`team${key}`] = team.id;
          ids[key ? 'poorRepo' : 'repo'] = repo.id;
        }
        const shared = await prisma.team.create({
          data: { name: `${MARK} Shared`, orgId: ids.org, slug: `${MARK}-shared` },
        });
        ids.sharedTeam = shared.id;
        await prisma.connectionTeamShare.create({
          data: { connectionId: ids.repo as string, teamId: shared.id },
        });
      }
    );
    await prisma.orgMonthlyUsage.create({
      data: {
        costUsdAccrued: 5,
        orgId: ids.orgpoor as string,
        yearMonth: new Date().toISOString().slice(0, 7),
      },
    });

    for (const who of ['alice', 'bob', 'carol', 'dave', 'erin'] as const) {
      const user = await makeUser(who);
      people[who] = { ...user, clientId: '', token: '' };
    }
    await runUnscoped('test fixture: memberships', ['TeamMembership'], async () => {
      const member = (who: keyof typeof people, teamId: string) =>
        prisma.teamMembership.create({ data: { teamId, userId: people[who].id } });
      await member('alice', ids.team as string);
      await member('alice', ids.teampoor as string);
      await member('bob', ids.team as string); // team member, but not in the org
      await member('carol', ids.sharedTeam as string); // sees the repo through a share only
      await member('dave', ids.team as string);
    });
    for (const who of ['alice', 'dave'] as const) {
      await prisma.organizationMembership.create({
        data: { orgId: ids.org as string, userId: people[who].id },
      });
    }
    await prisma.organizationMembership.create({
      data: { orgId: ids.orgpoor as string, userId: people.alice.id },
    });
    await prisma.organizationMembership.create({
      data: { orgId: ids.org as string, userId: people.carol.id },
    });
    for (const who of Object.keys(people) as Array<keyof typeof people>) {
      const issued = await issueToken(people[who].cookie, 'mcp:read mcp:write offline_access');
      people[who].token = issued.token;
      people[who].clientId = issued.clientId;
    }
    // A second, read-only grant for alice, through another client.
    people.alice.readToken = (await issueToken(people.alice.cookie, 'mcp:read')).token;
  }

  async function cleanup() {
    await runUnscoped(
      'test fixture cleanup',
      [
        'Team',
        'TeamMembership',
        'Connection',
        'WorkflowTemplate',
        'ConfigSetting',
        'ConnectionTeamShare',
      ],
      async () => {
        const repos = {
          connection: { team: { slug: { startsWith: MARK } } },
        };
        await prisma.workflowRun.deleteMany({ where: { workRequest: repos } });
        await prisma.workflowRun.deleteMany({ where: { workflowId: { startsWith: MARK } } });
        await prisma.activeWorkflow.deleteMany({
          where: { repository: { team: { slug: { startsWith: MARK } } } },
        });
        await prisma.runInput.deleteMany({ where: repos });
        await prisma.orgMonthlyUsage.deleteMany({
          where: { organization: { slug: { startsWith: MARK } } },
        });
        await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: MARK } } });
        await prisma.teamMembership.deleteMany({ where: { team: { slug: { startsWith: MARK } } } });
        await prisma.connectionTeamShare.deleteMany({
          where: { team: { slug: { startsWith: MARK } } },
        });
        await prisma.connection.deleteMany({ where: { team: { slug: { startsWith: MARK } } } });
        await prisma.team.deleteMany({ where: { slug: { startsWith: MARK } } });
        await prisma.organizationMembership.deleteMany({
          where: { organization: { slug: { startsWith: MARK } } },
        });
        await prisma.organization.deleteMany({ where: { slug: { startsWith: MARK } } });
        await prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } });
      }
    );
    await prisma.configAuditLog.deleteMany({ where: { entityType: 'McpToolCall' } });
    await prisma.oauthAccessToken.deleteMany();
    await prisma.oauthRefreshToken.deleteMany();
    await prisma.oauthConsent.deleteMany();
    await prisma.oauthClient.deleteMany();
    await prisma.user.deleteMany({ where: { email: { startsWith: MARK } } });
  }

  beforeAll(async () => {
    await initAuth();
    await cleanup();
    await settingsOn();
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('onRoute', (routeOptions) => {
      if (!routeOptions.schema?.response) {
        routeOptions.schema = { ...routeOptions.schema, response: { 200: z.any() } };
      }
    });
    registerFormBodyParser(app);
    await app.register(rateLimit, {
      keyGenerator: ipRateLimitKey,
      max: 100_000,
      timeWindow: '1 minute',
    });
    // Lets a test act at the moment a reply is about to be sent.
    app.addHook('onSend', async () => {
      await beforeReplySend?.();
    });
    await app.register(prismaPlugin);
    app.decorate('temporal', {
      cancelWorkflow: async (id: string) => {
        cancelled.push(id);
      },
      startRunnableWorkflow: async (
        id: string,
        input: { request: { launchedById?: string; budgetTier?: string } }
      ) => {
        if (startDelayMs) {
          await new Promise((r) => setTimeout(r, startDelayMs));
        }
        started.push({
          budgetTier: input.request.budgetTier,
          id,
          launchedById: input.request.launchedById,
        });
      },
    } as unknown as never);
    await app.register(authPlugin);
    await app.register(mcpOAuthGate, mcpOAuthGateOptions());
    registerBetterAuthRoutes(app, createBetterAuthHandler());
    const options = mcpRouteOptions();
    await app.register(mcpBridgePlugin, { verifier: options.verifier });
    app.addHook('onRequest', async (request) => {
      const header = request.headers[MCP_BRIDGE_HEADER];
      if (typeof header === 'string' && app.mcpBridge?.accepts(header)) {
        leaked = header;
      }
    });
    await app.register(mcpRoutes, options);
    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
    await app.ready();
    await fixtures();
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  beforeEach(async () => {
    await settingsOn();
    resetMcpWriteRateLimit();
    startDelayMs = 0;
    beforeReplySend = null;
    started.length = 0;
    cancelled.length = 0;
    await clearRuns();
  });

  /** The same submit asked of REST, as the same user, with an API token. */
  const restSubmit = (userId: string, body: Record<string, unknown>) =>
    app.inject({
      headers: {
        authorization: `Bearer ${app.auth.signAccessToken({ role: 'ENGINEER', sub: userId })}`,
      },
      method: 'POST',
      payload: body,
      remoteAddress: `192.0.2.${(seq++ % 250) + 1}`,
      url: '/api/v1/work-requests',
    });

  describe('which tools exist', () => {
    it('lists the write tools for a write grant, and not for a read-only one', async () => {
      expect(await toolNames(people.alice.token)).toEqual(
        expect.arrayContaining(['cancel_run', 'submit_work_request'])
      );
      expect(await toolNames(people.alice.readToken as string)).toHaveLength(5);
    });

    it('answers a read token that calls a write tool with 403 insufficient_scope for mcp:write', async () => {
      const { res } = await submit(people.alice.readToken as string);
      expect(res.statusCode).toBe(403);
      expect(String(res.headers['www-authenticate'])).toContain('error="insufficient_scope"');
      expect(String(res.headers['www-authenticate'])).toContain('scope="mcp:write"');
      expect(await prisma.runInput.count({ where: { connectionId: ids.repo } })).toBe(0);
    });

    it('hides the write tools the moment writes are switched off, and starts nothing if one is called', async () => {
      await settingsOn({ 'mcp.writeToolsEnabled': false });
      const names = await toolNames(people.alice.token);
      expect(names).not.toContain('submit_work_request');
      expect(names).not.toContain('cancel_run');
      const { result, res } = await submit(people.alice.token);
      expect(res.statusCode).toBe(200);
      expect(result?.isError ?? JSON.parse(res.body).error).toBeTruthy();
      expect(started).toEqual([]);
    });

    it('a fresh deployment with no write setting exposes no write tool and refuses mcp:write consent', async () => {
      // Only `mcp.enabled`: every other mcp.* key is absent, so the registry defaults apply.
      await setSettings({ 'mcp.enabled': true });
      expect(await toolNames(people.alice.token)).toHaveLength(5);
      const clientId = await registerClient();
      const challenge = b64url(crypto.createHash('sha256').update('v'.repeat(43)).digest());
      const refused = await call(
        'GET',
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          client_id: clientId,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          redirect_uri: REDIRECT,
          resource: MCP_RESOURCE,
          response_type: 'code',
          scope: 'mcp:read mcp:write',
          state: 's',
        })}`,
        { cookie: people.alice.cookie }
      );
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error).toBe('invalid_scope');
    });
  });

  describe('submit_work_request', () => {
    it('launches a run as the caller, at the STANDARD tier', async () => {
      const args = submitArgs();
      const { result } = await callTool(people.alice.token, 'submit_work_request', args);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.status).toBe('started');
      const input = await prisma.runInput.findUniqueOrThrow({
        include: { activeWorkflows: true },
        where: { id: result.structuredContent.workRequestId },
      });
      expect(input.requestedById).toBe(people.alice.id);
      expect(input.activeWorkflows).toHaveLength(1);
      expect(input.activeWorkflows[0].budgetTier).toBe('STANDARD');
      expect(input.idempotencyKey).toBe(args.idempotencyKey);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ budgetTier: 'STANDARD', launchedById: people.alice.id });
    });

    it('answers a retry with the same key with the same run, and starts only one', async () => {
      const args = submitArgs();
      const first = await callTool(people.alice.token, 'submit_work_request', args);
      const second = await callTool(people.alice.token, 'submit_work_request', args);
      expect(second.result.structuredContent).toEqual({
        ...first.result.structuredContent,
        status: 'already_submitted',
      });
      expect(started).toHaveLength(1);
    });

    it('stops after answering a replay: the handler does not go on to launch', async () => {
      const args = submitArgs();
      await callTool(people.alice.token, 'submit_work_request', args);
      expect(started).toHaveLength(1);
      // Just before the replay's answer goes out, remove what the replay found, as if the run and
      // its key were gone by the time a handler that carried on past its reply looked again.
      beforeReplySend = async () => {
        beforeReplySend = null;
        await prisma.activeWorkflow.deleteMany({ where: { repoId: ids.repo } });
        await prisma.runInput.deleteMany({ where: { connectionId: ids.repo } });
      };
      const replay = await callTool(people.alice.token, 'submit_work_request', args);
      expect(replay.result.structuredContent.status).toBe('already_submitted');
      await new Promise((r) => setTimeout(r, 300));
      expect(started).toHaveLength(1);
      expect(await prisma.runInput.count({ where: { connectionId: ids.repo } })).toBe(0);
    });

    it('treats a second key for a ticket already in flight as a non-error "already running"', async () => {
      const externalTicketId = ticket();
      await submit(people.alice.token, { externalTicketId });
      const { result } = await submit(people.alice.token, { externalTicketId });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ status: 'already_running' });
      expect(started).toHaveLength(1);
    });

    it('surfaces authorizeLaunch refusals as REST gives them', async () => {
      // A team member who is not in the org, and a user with no access to the repository.
      for (const who of ['bob', 'erin'] as const) {
        const args = submitArgs();
        const viaRest = await restSubmit(people[who].id, {
          description: args.description,
          externalTicketId: args.externalTicketId,
          repoIds: [args.repoId],
        });
        const { result } = await callTool(people[who].token, 'submit_work_request', args);
        expect(result.isError, who).toBe(true);
        expect(result.content[0].text, who).toBe(
          viaRest.statusCode === 403
            ? 'You are not permitted to do that.'
            : viaRest.statusCode === 404
              ? 'Repository not found.'
              : 'unexpected'
        );
        expect(JSON.stringify(result)).not.toContain(SECRET_TEXT);
      }
      expect(started).toEqual([]);
    });

    it('surfaces an org over its monthly budget as a 402 message', async () => {
      const { result } = await submit(people.alice.token, { repoId: ids.poorRepo });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('monthly budget');
      expect(started).toEqual([]);
    });

    it('refuses a budgetTier, an extra key and a missing idempotency key before any route', async () => {
      for (const over of [
        { budgetTier: 'LARGE' },
        { requestedById: people.bob.id },
        { idempotencyKey: undefined },
      ]) {
        const { result, res } = await submit(people.alice.token, over);
        expect(result?.isError ?? JSON.parse(res.body).error, JSON.stringify(over)).toBeTruthy();
      }
      expect(await prisma.runInput.count({ where: { connectionId: ids.repo } })).toBe(0);
    });

    it('does not fail the tool when the audit row cannot be written', async () => {
      const spy = vi
        .spyOn(prisma.configAuditLog, 'create')
        .mockRejectedValue(new Error('audit table unavailable'));
      try {
        const { result } = await submit(people.alice.token);
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.status).toBe('started');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(started).toHaveLength(1);
    });
  });

  describe('the audit row', () => {
    it('has the actor, the consent, the client and a digest, and none of the description text', async () => {
      const args = submitArgs();
      const { result } = await callTool(people.alice.token, 'submit_work_request', args);
      const rows = await prisma.configAuditLog.findMany({ where: { entityType: 'McpToolCall' } });
      expect(rows).toHaveLength(1);
      const consent = await prisma.oauthConsent.findFirstOrThrow({
        where: { clientId: people.alice.clientId, userId: people.alice.id },
      });
      expect(rows[0]).toMatchObject({
        action: 'CREATE',
        actorId: people.alice.id,
        entityId: consent.id,
      });
      expect(rows[0].afterJson).toMatchObject({
        oauthClientId: people.alice.clientId,
        status: 201,
        tool: 'submit_work_request',
        workRequestId: result.structuredContent.workRequestId,
      });
      expect((rows[0].afterJson as { inputDigest: string }).inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows[0])).not.toContain(SECRET_TEXT);
    });
  });

  describe('the concurrency cap', () => {
    it('never lets parallel bridged submits for one user exceed it', async () => {
      startDelayMs = 40;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => submit(people.alice.token))
      );
      const statuses = results.map((r) => r.result?.structuredContent?.status ?? 'refused');
      expect(
        statuses.filter((s) => s === 'started'),
        JSON.stringify(results.map((r) => r.result))
      ).toHaveLength(2);
      for (const r of results.filter((x) => x.result.isError)) {
        expect(r.result.content[0].text).toContain('maximum number of runs');
      }
      expect(await inFlight(people.alice.id)).toBe(2);
      expect(started).toHaveLength(2);
    });

    it('is per user: another user is unaffected while alice is at the cap', async () => {
      await Promise.all([submit(people.alice.token), submit(people.alice.token)]);
      expect((await submit(people.alice.token)).result.isError).toBe(true);
      expect((await submit(people.dave.token)).result.structuredContent.status).toBe('started');
    });

    it('counts runs the user launched from the web, and refuses the third in-flight run', async () => {
      const web = await restSubmit(people.alice.id, {
        description: 'from the dashboard',
        externalTicketId: ticket('WEB'),
        repoIds: [ids.repo],
      });
      expect(web.statusCode, web.body).toBe(201);
      expect((await submit(people.alice.token)).result.structuredContent.status).toBe('started');
      const third = await submit(people.alice.token);
      expect(third.result.isError).toBe(true);
      expect(third.result.content[0].text).toContain('maximum number of runs');
      expect(await inFlight(people.alice.id)).toBe(2);
    });

    it('counts ActiveWorkflow, not WorkflowRun', async () => {
      // A submitted run has an ActiveWorkflow and, until the worker gets to it, no WorkflowRun:
      // two such runs fill the cap. And a WorkflowRun alone, with no ledger row, is not counted.
      await submit(people.alice.token);
      await submit(people.alice.token);
      expect(
        await prisma.workflowRun.count({
          where: { workRequest: { requestedById: people.alice.id } },
        })
      ).toBe(0);
      expect((await submit(people.alice.token)).result.isError).toBe(true);
      await clearRuns();
      const input = await prisma.runInput.create({
        data: {
          description: 'x',
          externalTicketId: ticket('WR'),
          requestedById: people.alice.id,
          requestPayload: '{}',
        },
      });
      const template = await prisma.workflowTemplate.findFirstOrThrow({
        where: { name: { startsWith: MARK } },
      });
      for (const n of [1, 2]) {
        await prisma.workflowRun.create({
          data: {
            specSnapshot: {},
            status: 'RUNNING',
            templateId: template.id,
            templateVersion: 1,
            workflowId: `${MARK}-run-${n}`,
            workRequestId: input.id,
          },
        });
      }
      expect((await submit(people.alice.token)).result.structuredContent.status).toBe('started');
    });

    it('frees a slot when a run reaches a terminal status, and when it is cancelled', async () => {
      const a = await submit(people.alice.token);
      await submit(people.alice.token);
      expect((await submit(people.alice.token)).result.isError).toBe(true);
      await prisma.activeWorkflow.updateMany({
        data: { currentStatus: 'COMPLETED' },
        where: { workRequestId: a.result.structuredContent.workRequestId },
      });
      expect((await submit(people.alice.token)).result.structuredContent.status).toBe('started');
    });

    it('honours a change of the setting on the next call', async () => {
      await settingsOn({ 'mcp.maxConcurrentRuns': 1 });
      await submit(people.alice.token);
      expect((await submit(people.alice.token)).result.isError).toBe(true);
      await settingsOn({ 'mcp.maxConcurrentRuns': 3 });
      expect((await submit(people.alice.token)).result.structuredContent.status).toBe('started');
    });

    it('does not apply to a replay of a run that already started', async () => {
      const args = submitArgs();
      await callTool(people.alice.token, 'submit_work_request', args);
      await submit(people.alice.token);
      expect((await submit(people.alice.token)).result.isError).toBe(true);
      const replay = await callTool(people.alice.token, 'submit_work_request', args);
      expect(replay.result.structuredContent.status).toBe('already_submitted');
    });

    it('does not apply to REST: the dashboard can still launch past the cap', async () => {
      await Promise.all([submit(people.alice.token), submit(people.alice.token)]);
      const web = await restSubmit(people.alice.id, {
        description: 'from the dashboard',
        externalTicketId: ticket('WEB'),
        repoIds: [ids.repo],
      });
      expect(web.statusCode, web.body).toBe(201);
    });
  });

  describe('forgery test 9: a leaked bridge secret plus a write token', () => {
    const forged = (
      token: string,
      body: Record<string, unknown>,
      key: string | null = 'forged-key-1'
    ) =>
      app.inject({
        headers: {
          authorization: `Bearer ${token}`,
          [MCP_BRIDGE_HEADER]: leaked,
          ...(key ? { 'idempotency-key': key } : {}),
        },
        method: 'POST',
        payload: body,
        remoteAddress: '203.0.113.200',
        url: '/api/v1/work-requests',
      });
    const body = () => ({
      description: 'forged',
      externalTicketId: ticket('F'),
      repoIds: [ids.repo],
    });

    it('gets no more than the tool: the cap, the tier and the key hold in the route', async () => {
      await submit(people.alice.token); // makes sure the secret has been seen
      expect(leaked).toMatch(/^[0-9a-f]{64}$/);
      await clearRuns();
      expect((await forged(people.alice.token, { ...body(), budgetTier: 'EPIC' })).statusCode).toBe(
        422
      );
      expect((await forged(people.alice.token, body(), null)).statusCode).toBe(422);
      expect((await forged(people.alice.token, body(), 'forged-a-1')).statusCode).toBe(201);
      expect((await forged(people.alice.token, body(), 'forged-a-2')).statusCode).toBe(201);
      const capped = await forged(people.alice.token, body(), 'forged-a-3');
      expect(capped.statusCode, capped.body).toBe(429);
      expect(capped.json().error.code).toBe('MCP_RUN_CAP_REACHED');
      expect(await inFlight(people.alice.id)).toBe(2);
    });

    it('with a read-only token earns nothing', async () => {
      await submit(people.alice.token);
      await clearRuns();
      const res = await forged(people.alice.readToken as string, body());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE');
      expect(await prisma.runInput.count({ where: { connectionId: ids.repo } })).toBe(0);
    });
  });

  describe('cancel_run', () => {
    async function runFor(userId: string, launchedById: string | null) {
      const input = await prisma.runInput.create({
        data: {
          connectionId: ids.repo as string,
          description: 'x',
          externalTicketId: ticket('C'),
          requestedById: userId,
          requestPayload: '{}',
        },
      });
      const workflowId = `${MARK}-run-${++seq}`;
      const template = await prisma.workflowTemplate.findFirstOrThrow({
        where: { name: { startsWith: MARK }, teamId: ids.team },
      });
      const run = await prisma.workflowRun.create({
        data: {
          launchedById,
          specSnapshot: {},
          status: 'RUNNING',
          templateId: template.id,
          templateVersion: 1,
          workflowId,
          workRequestId: input.id,
        },
      });
      await prisma.activeWorkflow.create({
        data: {
          currentStatus: 'IMPLEMENTING',
          repoId: ids.repo as string,
          temporalWorkflowId: workflowId,
          workRequestId: input.id,
        },
      });
      return { runId: run.id, workflowId };
    }

    it('cancels a run the caller may control, and frees the slot', async () => {
      const { runId, workflowId } = await runFor(people.dave.id, people.dave.id);
      const { result } = await callTool(people.dave.token, 'cancel_run', { runId });
      expect(result.structuredContent).toEqual({ runId, status: 'CANCELLED' });
      expect(cancelled).toEqual([workflowId]);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        'CANCELLED'
      );
      expect(await inFlight(people.dave.id)).toBe(0);
    });

    it('refuses a shared-team non-owner exactly as REST does', async () => {
      const { runId } = await runFor(people.dave.id, people.dave.id);
      const viaRest = await app.inject({
        headers: {
          authorization: `Bearer ${app.auth.signAccessToken({ role: 'ENGINEER', sub: people.carol.id })}`,
        },
        method: 'POST',
        url: `/api/v1/workflow-runs/${runId}/cancel`,
      });
      expect(viaRest.statusCode).toBe(404);
      const { result } = await callTool(people.carol.token, 'cancel_run', { runId });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Run not found.');
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        'RUNNING'
      );
      expect(cancelled).toEqual([]);
    });

    it('answers a run that is not running with a fixed message', async () => {
      const { runId } = await runFor(people.dave.id, people.dave.id);
      await callTool(people.dave.token, 'cancel_run', { runId });
      const again = await callTool(people.dave.token, 'cancel_run', { runId });
      expect(again.result.isError).toBe(true);
      expect(again.result.content[0].text).toContain('not running');
    });

    it('is audited, and refused for a read token with the step-up challenge', async () => {
      const { runId } = await runFor(people.dave.id, people.dave.id);
      await callTool(people.dave.token, 'cancel_run', { runId });
      const row = await prisma.configAuditLog.findFirstOrThrow({
        where: { actorId: people.dave.id, entityType: 'McpToolCall' },
      });
      expect(row.afterJson).toMatchObject({ runId, status: 200, tool: 'cancel_run' });
      const { res } = await callTool(people.alice.readToken as string, 'cancel_run', { runId });
      expect(res.statusCode).toBe(403);
      expect(String(res.headers['www-authenticate'])).toContain('scope="mcp:write"');
    });
  });

  it('refuses a deactivated user mid-way: the write token stops at the next call', async () => {
    await prisma.user.update({ data: { isActive: false }, where: { id: people.erin.id } });
    invalidateUserAuthCache(people.erin.id);
    const { res } = await submit(people.erin.token);
    expect(res.statusCode).toBe(401);
    expect(started).toEqual([]);
  });
});
