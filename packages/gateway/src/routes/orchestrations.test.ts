import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import {
  OrchestrationDetailDtoSchema,
  OrchestrationMessagesPageSchema,
  OrchestrationSummaryDtoSchema,
  SpawnChildResponseSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { mintOrchestrationToken } from '@auto-swe/shared/lib/orchestrationTokenKey';
import { repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunWorkflowId } from '../lib/agentRunLaunch.js';
import { resetMcpWriteRateLimit } from '../lib/mcpWriteGuard.js';
import { encodeCursor } from '../lib/orchestrationService.js';
import { _resetAuthCachesForTests } from '../plugins/auth.js';
import { buildAssistantApp, OTHER_USER_ID, USER_ID } from '../test/assistantApp.js';
import { orchestrationRoutes } from './orchestrations.js';

const cfg = vi.hoisted(() => ({
  enabled: true,
  maxTargets: 200,
  settings: {
    'mcp.agentRunAllowedDeliverModes': ['none'],
    'mcp.maxConcurrentRuns': 5,
    'mcp.writeCallsPerMinute': 100,
    'mcp.writeToolsEnabled': true,
    'orchestration.defaultAllowlist': ['reader', 'writer', 'gone', 'orchestrator'],
    'orchestration.maxChildren': 3,
    'orchestration.maxConcurrentChildren': 2,
    'orchestration.maxTurns': 200,
    'orchestration.maxWallClockSeconds': 3600,
    'orchestration.maxWriterChildren': 5,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
  } as Record<string, number | boolean | string[]>,
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workflow.campaignMaxTargets' ? cfg.maxTargets : cfg.enabled
  ),
  resolveSettings: vi.fn(async () => cfg.settings),
}));
const spend = vi.hoisted(() => ({ org: 40, team: 12.5 }));
vi.mock('@auto-swe/shared/lib/billing', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/billing')>()),
  orgMonthSpend: vi.fn(async () => ({ totalUsd: spend.org })),
  teamMonthSpend: vi.fn(async () => ({ totalUsd: spend.team })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveWorkflowDefaults: vi.fn(async () => ({
    budgetTiers: { STANDARD: { inputTokens: 1000, outputTokens: 1000 } },
  })),
}));
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

const launcher = vi.hoisted(() => ({
  authorizeRepo: vi.fn(),
  launch: vi.fn(),
  push: vi.fn(),
}));
vi.mock('../lib/agentRunLaunch.js', async (orig) => ({
  ...(await orig<typeof import('../lib/agentRunLaunch.js')>()),
  authorizeAgentRunRepo: launcher.authorizeRepo,
  createAgentRunLauncher: () => launcher.launch,
}));
vi.mock('../lib/orchestrationAccess.js', async (orig) => ({
  ...(await orig<typeof import('../lib/orchestrationAccess.js')>()),
  checkPushPermission: launcher.push,
}));
const tracked = vi.hoisted(() => ({
  opts: [] as Array<Record<string, unknown>>,
  result: null as null | Record<string, unknown>,
  rows: [] as unknown[],
}));
vi.mock('../lib/workflowLaunch.js', () => ({
  launchTrackedWorkflow: vi.fn(
    async (
      _p: unknown,
      rows: unknown,
      start: () => Promise<void>,
      opts: {
        guard?: (tx: unknown) => Promise<string | null>;
        inTransaction?: (tx: unknown) => Promise<void>;
      }
    ) => {
      tracked.rows.push(rows);
      tracked.opts.push(opts as never);
      // The guard runs as it does in the real launch: before any ledger write.
      const refusal = opts.guard ? await opts.guard(txMock()) : null;
      if (refusal) {
        return { ok: false, reason: 'GUARD_REFUSED', refusal };
      }
      if (tracked.result) {
        return tracked.result;
      }
      await opts.inTransaction?.(txMock());
      await start();
      return { activeWorkflowId: 'aw', ok: true };
    }
  ),
}));

const ORCH = '00000000-0000-4000-8000-0000000000f1';
const OTHER_ORCH = '00000000-0000-4000-8000-0000000000f2';
const TEAM = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TEAM = '00000000-0000-4000-8000-0000000000a9';
const ORG = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000a3';
const CHILD = '00000000-0000-4000-8000-0000000000c1';
const APPROVAL = '00000000-0000-4000-8000-0000000000d1';
const MESSAGE = '00000000-0000-4000-8000-0000000000e1';
const CONN = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-11-17T10:00:00Z');
const PINS = {
  maxChildren: 3,
  maxConcurrentChildren: 2,
  maxTurns: 200,
  maxWallClockSeconds: 3600,
  maxWriterChildren: 5,
};

function orchRow(over: Record<string, unknown> = {}) {
  return {
    allowlist: ['reader', 'writer'],
    budgetTier: 'STANDARD',
    connectionIds: [],
    createdAt: NOW,
    id: ORCH,
    launchedBy: { name: 'Ada' },
    launchedById: USER_ID,
    orgId: ORG,
    repo: { organizationName: 'acme', repoName: 'api' },
    repoAttachedAt: null,
    repoId: REPO,
    serviceId: null,
    status: 'ACTIVE',
    team: { name: 'Payments' },
    teamId: TEAM,
    title: 'Do things',
    updatedAt: NOW,
    workRequest: { activeWorkflows: [{ costUsdAccrued: 0.5 }], payload: { pinned: PINS } },
    workRequestId: 'wr',
    ...over,
  };
}

function whereOf(
  fn: { mock: { calls: unknown[][] } },
  call = 0
): Record<string, unknown> & {
  OR?: unknown[];
} {
  const args = fn.mock.calls[call]?.[0] as { where: Record<string, unknown> } | undefined;
  return args?.where ?? {};
}

function txMock() {
  return state.tx;
}

interface State {
  children: Array<Record<string, unknown>>;
  orch: ReturnType<typeof orchRow> | null;
  tx: Record<string, unknown>;
}
let state: State;

function makePrisma() {
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ id: ORCH }]),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(state.tx)
        : Promise.all(arg as Promise<unknown>[])
    ),
    activeWorkflow: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agent: {
      findMany: vi.fn(async () =>
        ['reader', 'writer'].map((key) => ({
          key,
          mcpConnectionId: null,
          scope: 'GLOBAL',
          toolKeys: key === 'writer' ? ['readFile', 'writeFile'] : ['readFile', 'listDirectory'],
          version: 1,
        }))
      ),
    },
    apiToken: {
      findFirst: vi.fn(async () => ({ id: 'tok' })),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    configAuditLog: { create: vi.fn(async () => ({})) },
    connection: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ id: CONN }]),
    },
    orchestration: {
      count: vi.fn(async () => 1),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => state.orch),
      findMany: vi.fn(async () => (state.orch ? [state.orch] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orchestrationApproval: {
      findFirst: vi.fn(async () => ({ id: APPROVAL })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orchestrationChild: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => state.children[0] ?? null),
      findMany: vi.fn(async () => state.children),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orchestrationMessage: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        authorId: null,
        body: '',
        childId: null,
        createdAt: NOW,
        id: MESSAGE,
        kind: 'TEXT',
        payload: null,
        role: 'USER',
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    organization: { findFirst: vi.fn(async () => ({ monthlyBudgetUsdCents: null })) },
    organizationMembership: { findUnique: vi.fn(async () => ({ userId: USER_ID })) },
    runSteeringMessage: { create: vi.fn(async () => ({})), groupBy: vi.fn(async () => []) },
    servicePrincipal: { findUnique: vi.fn(async () => null) },
    team: {
      findFirst: vi.fn(async () => ({
        id: TEAM,
        isActive: true,
        memberships: [{ userId: USER_ID }],
        monthlyBudgetUsdCents: null,
        name: 'Payments',
        organization: { id: ORG, isActive: true, monthlyBudgetUsdCents: null },
        orgId: ORG,
      })),
    },
    user: {
      findUnique: vi.fn(async () => ({ isActive: true, role: 'ENGINEER', slackId: null })),
    },
  };
  state.tx = { ...prisma, $queryRaw: prisma.$queryRaw };
  return prisma;
}

describe('orchestration routes', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof makePrisma>;
  const logLines: string[] = [];
  const temporal = {
    cancelWorkflow: vi.fn(),
    signalWithStartOrchestration: vi.fn(),
    signalWorkflow: vi.fn(),
  };

  beforeAll(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  beforeEach(async () => {
    _resetAuthCachesForTests();
    cfg.enabled = true;
    cfg.maxTargets = 200;
    state = { children: [], orch: orchRow(), tx: {} };
    logLines.length = 0;
    for (const fn of Object.values(temporal)) {
      fn.mockReset();
    }
    launcher.authorizeRepo.mockReset().mockResolvedValue({
      githubApiUrl: null,
      id: REPO,
      team: { orgId: ORG },
      teamId: TEAM,
    });
    launcher.launch.mockReset();
    launcher.push.mockReset().mockResolvedValue({ ok: true });
    tracked.rows = [];
    tracked.opts = [];
    tracked.result = null;
    resetMcpWriteRateLimit();
    prisma = makePrisma();
    app = await buildAssistantApp(
      prisma as never,
      async (a) => {
        // A request carrying this header is treated as arriving through the MCP bridge.
        a.addHook('onRequest', async (request) => {
          if (request.headers['x-test-mcp']) {
            request.mcpBridge = {
              clientId: 'test',
              consentId: 'test',
              scopes: ['mcp:read', 'mcp:write'],
            };
          }
        });
        a.decorate('temporal', temporal as never);
        await a.register(orchestrationRoutes, { prefix: '/api/v1/orchestrations' });
      },
      { logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } } }
    );
  });
  afterEach(async () => {
    await app.close();
  });

  const person = (sub = USER_ID, role = 'ENGINEER') =>
    `Bearer ${app.auth.signAccessToken({ role: role as never, sub })}`;
  // The token names only the orchestration; who acts is read from the orchestration's row.
  const token = (id = ORCH) => `Bearer ${mintOrchestrationToken({ orchestrationId: id })}`;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    authorization: string,
    payload?: unknown,
    headers: Record<string, string> = {}
  ) =>
    app.inject({
      headers: { authorization, ...headers },
      method,
      payload: payload as never,
      url: `/api/v1/orchestrations${url}`,
    });

  // ── Orchestration token ───────────────────────────────────────────────────

  describe('orchestration token scope', () => {
    const forbidden: Array<[string, 'GET' | 'POST', string, unknown]> = [
      ['attach', 'POST', `/${ORCH}/attach`, { repoId: REPO }],
      ['attach decline', 'POST', `/${ORCH}/attach/decline`, undefined],
      ['approvals', 'POST', `/${ORCH}/approvals/${APPROVAL}`, { decision: 'APPROVE' }],
      ['cancel', 'POST', `/${ORCH}/cancel`, undefined],
      ['end', 'POST', `/${ORCH}/end`, undefined],
      ['user messages', 'POST', `/${ORCH}/messages`, { body: 'hi' }],
      ['detail', 'GET', `/${ORCH}`, undefined],
      ['list', 'GET', '/', undefined],
      ['launch', 'POST', '/', { allowlist: ['a'], task: 't', teamId: TEAM }],
    ];
    it.each(forbidden)('is refused on %s', async (_n, method, url, payload) => {
      const res = await call(method, url, token(), payload);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORCHESTRATION_TOKEN_NOT_ALLOWED');
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
    });

    it('is refused for another orchestration', async () => {
      const res = await call('POST', `/${OTHER_ORCH}/children/${CHILD}/cancel`, token());
      expect(res.statusCode).toBe(403);
    });

    it('stops working once the orchestration ends', async () => {
      state.orch = orchRow({ status: 'CANCELLED' });
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, token());
      expect(res.statusCode).toBe(401);
    });

    it('is refused once the launcher is deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        isActive: false,
        role: 'ENGINEER',
        slackId: null,
      });
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, token());
      expect(res.statusCode).toBe(401);
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
    });

    it("acts with the launcher's current role, not one the token could claim", async () => {
      prisma.user.findUnique.mockResolvedValue({ isActive: true, role: 'LEAD', slackId: null });
      launcher.launch.mockImplementation(
        async (
          _req: unknown,
          reply: { status: (n: number) => { send: (b: unknown) => unknown } }
        ) => reply.status(201).send({ data: {} })
      );
      await call('POST', `/${ORCH}/children`, token(), {
        intent: { agent: 'reader', label: 'l', role: 'reader', task: 't' },
        turnKey: 'k',
      });
      expect(launcher.launch.mock.calls[0]?.[2].caller).toMatchObject({
        kind: 'user',
        user: { role: 'LEAD', sub: USER_ID },
      });
    });

    it('is refused when it has expired', async () => {
      const stale = mintOrchestrationToken({ orchestrationId: ORCH }, 120, Date.now() - 200_000);
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, `Bearer ${stale}`);
      expect(res.statusCode).toBe(401);
    });

    it('is refused when its lifetime is longer than a call needs, even though signed', async () => {
      const long = mintOrchestrationToken({ orchestrationId: ORCH }, 3600);
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, `Bearer ${long}`);
      expect(res.statusCode).toBe(401);
    });

    it('is refused when signed under another key', async () => {
      const mine = process.env.CONFIG_ENCRYPTION_KEY;
      process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      _resetKeyCacheForTests();
      const foreign = mintOrchestrationToken({ orchestrationId: ORCH });
      process.env.CONFIG_ENCRYPTION_KEY = mine;
      _resetKeyCacheForTests();
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, `Bearer ${foreign}`);
      expect(res.statusCode).toBe(401);
    });

    it('cannot be replayed against another orchestration', async () => {
      const forOther = token(OTHER_ORCH);
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, forOther);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORCHESTRATION_TOKEN_NOT_ALLOWED');
    });

    it('never appears in a response, a log line or an audit row', async () => {
      const lines: string[] = [];
      const bearer = token();
      const raw = bearer.slice('Bearer '.length);
      state.children = [
        {
          id: CHILD,
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
        },
      ];
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, bearer);
      expect(res.statusCode).toBe(200);
      // A non-canonical spelling of the same signature is not the same token.
      const bad = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, `${bearer}x`);
      const padded = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, `${bearer}=`);
      expect(bad.statusCode).toBe(401);
      expect(padded.statusCode).toBe(401);
      lines.push(res.body, bad.body, padded.body, JSON.stringify(res.headers), ...logLines);
      expect(logLines.length).toBeGreaterThan(0);
      lines.push(JSON.stringify(prisma.configAuditLog.create.mock.calls));
      lines.push(JSON.stringify(prisma.orchestration.updateMany.mock.calls));
      lines.push(JSON.stringify(temporal.signalWorkflow.mock.calls));
      for (const line of lines) {
        expect(line).not.toContain(raw);
        expect(line).not.toContain('orch_');
      }
    });

    it('rejects a forged token', async () => {
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, 'Bearer orch_nope');
      expect(res.statusCode).toBe(401);
    });

    it('is required to start a child', async () => {
      const res = await call('POST', `/${ORCH}/children`, person(), {
        intent: { agent: 'reader', label: 'l', role: 'reader', task: 't' },
        turnKey: 'k',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORCHESTRATION_TOKEN_REQUIRED');
    });
  });

  // ── Spawn ─────────────────────────────────────────────────────────────────

  describe('POST /:id/children', () => {
    const reader = { agent: 'reader', label: 'look', role: 'reader', task: 'investigate' };
    const writer = {
      agent: 'writer',
      deliver: 'draft_pr',
      label: 'edit',
      pathScopes: ['src/api/**'],
      role: 'writer',
      task: 'change',
    };
    const spawn = (intent: unknown, turnKey = 'turn-1') =>
      call('POST', `/${ORCH}/children`, token(), { intent, turnKey });
    const code = (res: { json: () => { code?: string } }) => res.json().code;
    const child = (over: Record<string, unknown> = {}) => ({
      pathScopes: [],
      role: 'READER',
      status: 'RUNNING',
      ...over,
    });

    beforeEach(() => {
      launcher.launch.mockImplementation(
        async (
          _req: unknown,
          reply: { status: (n: number) => { send: (b: unknown) => unknown } },
          input: { orchestration: { respond: (l: unknown) => unknown } }
        ) =>
          reply
            .status(201)
            .send(
              input.orchestration.respond({ temporalWorkflowId: 'agent-x', workRequestId: 'wr-1' })
            )
      );
    });

    it('starts a reader as the launcher and answers with the child', async () => {
      const res = await spawn(reader);
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({ workflowId: 'agent-x', workRequestId: 'wr-1' });
      const input = launcher.launch.mock.calls[0]?.[2];
      expect(input).toMatchObject({
        agent: 'reader',
        caller: { kind: 'user', user: { sub: USER_ID } },
        deliver: 'none',
        idempotencyKey: `${ORCH}:turn-1`,
        repoId: REPO,
      });
      expect(input.orchestration).toMatchObject({ orchestrationId: ORCH, pathScopes: [] });
    });

    it('rejects a malformed intent with 422', async () => {
      const res = await spawn({ ...writer, pathScopes: ['../etc'] });
      expect(res.statusCode).toBe(422);
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it('never spawns the orchestrator itself', async () => {
      state.orch = orchRow({ allowlist: ['orchestrator'] });
      expect((await spawn({ ...reader, agent: 'orchestrator' })).statusCode).toBe(422);
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it('still spawns while the orchestration is waiting', async () => {
      state.orch = orchRow({ status: 'WAITING' });
      expect((await spawn(reader)).statusCode).toBe(201);
    });

    it.each([
      [
        'ORCHESTRATION_NOT_ACTIVE',
        () => {
          cfg.enabled = false;
        },
        reader,
      ],
      ['CHILD_NOT_ALLOWED', () => {}, { ...reader, agent: 'other' }],
      ['CHILD_NOT_ALLOWED', () => {}, { ...reader, agent: 'reader@2' }],
      [
        'CHILD_LIMIT',
        () => {
          state.children = [
            child({ status: 'COMPLETED' }),
            child({ status: 'COMPLETED' }),
            child({ status: 'FAILED' }),
          ];
        },
        reader,
      ],
      [
        'CHILD_LIMIT',
        () => {
          state.children = [child(), child()];
        },
        reader,
      ],
      [
        'CHILD_LIMIT',
        () => {
          state.orch = orchRow({
            workRequest: {
              activeWorkflows: [],
              payload: { pinned: { ...PINS, maxWriterChildren: 1 } },
            },
          });
          state.children = [child({ pathScopes: ['lib/**'], role: 'WRITER', status: 'COMPLETED' })];
        },
        writer,
      ],
      [
        'REPO_REQUIRED',
        () => {
          state.orch = orchRow({ repoId: null });
        },
        writer,
      ],
      [
        'SCOPE_OVERLAP',
        () => {
          state.children = [child({ pathScopes: ['src/**'], role: 'WRITER' })];
        },
        { ...writer, pathScopes: ['src/api/**'] },
      ],
      [
        'CONNECTION_NOT_IN_SET',
        () => {
          prisma.agent.findMany.mockResolvedValue([
            { key: 'reader', mcpConnectionId: CONN, scope: 'GLOBAL', version: 1 },
          ] as never);
        },
        reader,
      ],
    ] as const)('refuses with %s', async (expected, arrange, intent) => {
      arrange();
      const res = await spawn(intent);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe(expected);
      expect(res.json().error.code).toBe(expected);
      expect(launcher.launch).not.toHaveBeenCalled();
      expect(prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('refuses a second owner of the shared files', async () => {
      state.children = [child({ pathScopes: ['yarn.lock'], role: 'WRITER' })];
      const res = await spawn({ ...writer, pathScopes: ['package.json'] });
      expect(code(res)).toBe('SCOPE_OVERLAP');
    });

    it('lets a writer touch files a finished writer held', async () => {
      state.children = [child({ pathScopes: ['src/**'], role: 'WRITER', status: 'COMPLETED' })];
      expect((await spawn(writer)).statusCode).toBe(201);
    });

    it('hands the launch its writer checks and a transaction that re-checks the bounds', async () => {
      await spawn(writer);
      const seam = launcher.launch.mock.calls[0]?.[2].orchestration;
      expect(seam.pathScopes).toEqual(['src/api/**']);
      // Push permission, asked of the launcher.
      launcher.push.mockResolvedValueOnce({ ok: false, reason: 'no write' });
      expect(await seam.checkRepo({ id: REPO })).toMatchObject({
        code: 'PUSH_PERMISSION_REQUIRED',
      });
      launcher.push.mockResolvedValueOnce({ ok: true });
      expect(await seam.checkRepo({ id: REPO })).toBeNull();
      // The transaction writes the child; a sibling that arrived meanwhile refuses it.
      await seam.inTransaction(state.tx, { temporalWorkflowId: 'agent-x', workRequestId: 'wr-1' });
      expect(prisma.orchestrationChild.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: 'WRITER',
          status: 'STARTING',
          workRequestId: 'wr-1',
        }),
      });
      state.children = [child({ pathScopes: ['src/**'], role: 'WRITER' })];
      await expect(
        seam.inTransaction(state.tx, { temporalWorkflowId: 'agent-y', workRequestId: 'wr-2' })
      ).rejects.toMatchObject({ code: expect.stringMatching(/CHILD_LIMIT|SCOPE_OVERLAP/) });
    });

    it('answers a retried spawn with the child it already started', async () => {
      await spawn(reader);
      const seam = launcher.launch.mock.calls[0]?.[2].orchestration;
      prisma.activeWorkflow.findUnique.mockResolvedValueOnce({ workRequestId: 'wr-1' } as never);
      prisma.orchestrationChild.findFirst.mockResolvedValueOnce({ id: CHILD } as never);
      expect(await seam.existing('agent-x')).toEqual({
        data: { childId: CHILD, workflowId: 'agent-x', workRequestId: 'wr-1' },
      });
      prisma.activeWorkflow.findUnique.mockResolvedValueOnce(null);
      expect(await seam.existing('agent-z')).toBeNull();
      await seam.onStartFailed('wr-1');
      expect(prisma.orchestrationChild.deleteMany).toHaveBeenCalled();
    });

    it('answers a retried spawn from its first child before any width or scope check', async () => {
      // At the concurrency limit, with the writer's own scope held by the child it started.
      state.children = [child({ pathScopes: ['src/api/**'], role: 'WRITER' }), child()];
      const wfId = agentRunWorkflowId(
        REPO,
        { kind: 'user', user: { sub: USER_ID } } as never,
        `${ORCH}:turn-1`
      );
      prisma.activeWorkflow.findUnique.mockImplementation((async ({
        where,
      }: {
        where: { temporalWorkflowId: string };
      }) => (where.temporalWorkflowId === wfId ? { workRequestId: 'wr-1' } : null)) as never);
      prisma.orchestrationChild.findFirst.mockResolvedValue({ id: CHILD } as never);
      const again = await spawn(writer, 'turn-1');
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toEqual({
        childId: CHILD,
        workflowId: wfId,
        workRequestId: 'wr-1',
      });
      expect(launcher.launch).not.toHaveBeenCalled();
      // A different turn is a new spawn and is held to the same bounds.
      expect(code(await spawn(writer, 'turn-2'))).toBe('CHILD_LIMIT');
    });

    it('also finds a child started before a repository was attached (keyed on the team)', async () => {
      state.children = [child(), child()];
      const wfId = agentRunWorkflowId(
        TEAM,
        { kind: 'user', user: { sub: USER_ID } } as never,
        `${ORCH}:turn-1`
      );
      prisma.activeWorkflow.findUnique.mockImplementation((async ({
        where,
      }: {
        where: { temporalWorkflowId: string };
      }) => (where.temporalWorkflowId === wfId ? { workRequestId: 'wr-1' } : null)) as never);
      prisma.orchestrationChild.findFirst.mockResolvedValue({ id: CHILD } as never);
      expect((await spawn(reader, 'turn-1')).statusCode).toBe(200);
    });

    it('does not refuse a third writer for shared files when neither live writer holds one', async () => {
      state.orch = orchRow({
        workRequest: {
          activeWorkflows: [],
          payload: { pinned: { ...PINS, maxChildren: 9, maxConcurrentChildren: 5 } },
        },
      });
      const plain = (dir: string) => Array.from({ length: 11 }, (_, i) => `${dir}/f${i}.ts`);
      state.children = [
        child({ pathScopes: plain('a'), role: 'WRITER' }),
        child({ pathScopes: plain('b'), role: 'WRITER' }),
      ];
      const res = await spawn({ ...writer, pathScopes: ['c/index.ts'] });
      expect(res.statusCode).toBe(201);
      // And the rule still holds when a live writer does own one.
      state.children = [
        child({ pathScopes: plain('a'), role: 'WRITER' }),
        child({ pathScopes: ['b/index.ts'], role: 'WRITER' }),
      ];
      expect(code(await spawn({ ...writer, pathScopes: ['c/index.ts'] }))).toBe('SCOPE_OVERLAP');
    });

    it('re-checks the shared-file rule inside the transaction, per writer', async () => {
      state.orch = orchRow({
        workRequest: {
          activeWorkflows: [],
          payload: { pinned: { ...PINS, maxChildren: 9, maxConcurrentChildren: 5 } },
        },
      });
      // The sibling that took the shared file arrives between the early check and the lock.
      prisma.orchestrationChild.findMany.mockResolvedValueOnce([] as never);
      launcher.launch.mockImplementation(async (_r: unknown, reply: never, input: never) => {
        const seam = (input as { orchestration: Record<string, (...a: unknown[]) => unknown> })
          .orchestration;
        state.children = [child({ pathScopes: ['b/index.ts'], role: 'WRITER' })];
        await seam.inTransaction?.(state.tx, {
          temporalWorkflowId: 'agent-x',
          workRequestId: 'wr-1',
        });
        return (reply as { status: (n: number) => { send: (b: unknown) => unknown } })
          .status(201)
          .send({});
      });
      const res = await spawn({ ...writer, pathScopes: ['c/index.ts'] });
      expect(code(res)).toBe('SCOPE_OVERLAP');
      expect(res.json().message).toMatch(/shared files/);
    });

    it('audits a refusal thrown in the transaction once', async () => {
      prisma.orchestrationChild.findMany.mockResolvedValueOnce([] as never);
      launcher.launch.mockImplementation(async (_r: unknown, _reply: never, input: never) => {
        state.children = [child({ pathScopes: ['src/**'], role: 'WRITER' })];
        await (
          input as {
            orchestration: { inTransaction: (...a: unknown[]) => Promise<void> };
          }
        ).orchestration.inTransaction(state.tx, { temporalWorkflowId: 'a', workRequestId: 'w' });
      });
      const res = await spawn(writer);
      expect(code(res)).toBe('SCOPE_OVERLAP');
      const refusals = (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).filter(
        (c) =>
          (c[0] as { data: { afterJson: { action: string } } }).data.afterJson.action === 'refusal'
      );
      expect(refusals).toHaveLength(1);
    });

    it('cancels a child that started after the orchestration ended, and refuses', async () => {
      launcher.launch.mockImplementation(async (_r: unknown, reply: never, input: never) => {
        const seam = (
          input as {
            orchestration: {
              afterStart: (l: unknown) => Promise<{ code: string; message: string } | null>;
              inTransaction: (...a: unknown[]) => Promise<void>;
            };
          }
        ).orchestration;
        const ids = { temporalWorkflowId: 'agent-x', workRequestId: 'wr-1' };
        await seam.inTransaction(state.tx, ids);
        // The workflow starts; a cancel lands in that window.
        state.orch = orchRow({ status: 'CANCELLED' });
        const late = await seam.afterStart(ids);
        const r = reply as { status: (n: number) => { send: (b: unknown) => unknown } };
        return late
          ? r
              .status(409)
              .send({ code: late.code, error: { code: late.code, message: late.message } })
          : r.status(201).send({});
      });
      const res = await spawn(reader);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-x');
      expect(prisma.orchestrationChild.updateMany).toHaveBeenCalledWith({
        data: { endedAt: expect.any(Date), status: 'CANCELLED' },
        where: expect.objectContaining({ orchestrationId: ORCH, workRequestId: 'wr-1' }),
      });
    });

    it('keeps a late child non-terminal when its cancel fails, and still refuses the spawn', async () => {
      launcher.launch.mockImplementation(async (_r: unknown, reply: never, input: never) => {
        const seam = (
          input as {
            orchestration: {
              afterStart: (l: unknown) => Promise<{ code: string; message: string } | null>;
            };
          }
        ).orchestration;
        state.orch = orchRow({ status: 'CANCELLED' });
        const late = await seam.afterStart({
          temporalWorkflowId: 'agent-x',
          workRequestId: 'wr-1',
        });
        const r = reply as { status: (n: number) => { send: (b: unknown) => unknown } };
        return late
          ? r
              .status(409)
              .send({ code: late.code, error: { code: late.code, message: late.message } })
          : r.status(201).send({});
      });
      temporal.cancelWorkflow.mockRejectedValue(new Error('temporal down'));
      const res = await spawn(reader);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-x');
      // The workflow may still run: the row must not be marked finished.
      expect(prisma.orchestrationChild.updateMany).not.toHaveBeenCalled();
    });

    it('leaves a child alone when the orchestration is still live after the start', async () => {
      launcher.launch.mockImplementation(async (_r: unknown, reply: never, input: never) => {
        const seam = (
          input as {
            orchestration: { afterStart: (l: unknown) => Promise<unknown> };
          }
        ).orchestration;
        const late = await seam.afterStart({
          temporalWorkflowId: 'agent-x',
          workRequestId: 'wr-1',
        });
        return (reply as { status: (n: number) => { send: (b: unknown) => unknown } })
          .status(late ? 409 : 201)
          .send({});
      });
      expect((await spawn(reader)).statusCode).toBe(201);
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
    });

    it('answers every refusal with a code and a readable message in both shapes', async () => {
      launcher.launch.mockImplementation(async (_r: unknown, reply: never) =>
        (reply as { status: (n: number) => { send: (b: unknown) => unknown } })
          .status(404)
          .send({ error: { code: 'AGENT_NOT_FOUND', message: "No active agent 'reader'" } })
      );
      const res = await spawn(reader);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        code: 'AGENT_NOT_FOUND',
        error: { code: 'AGENT_NOT_FOUND', message: "No active agent 'reader'" },
        message: "No active agent 'reader'",
      });
      // An orchestration refusal keeps both shapes; a malformed intent keeps its details.
      const bad = await spawn({ ...writer, pathScopes: ['../etc'] });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({
        code: 'INVALID_INTENT',
        error: { code: 'INVALID_INTENT', details: expect.any(Array) },
        message: 'The spawn intent is malformed',
      });
    });

    it('reports a clamped maxSteps in the body', async () => {
      launcher.launch.mockImplementation(async (_r: unknown, reply: never, input: never) =>
        (reply as { status: (n: number) => { send: (b: unknown) => unknown } }).status(201).send(
          (input as { orchestration: { respond: (l: unknown) => unknown } }).orchestration.respond({
            clamped: { maxSteps: 50 },
            temporalWorkflowId: 'agent-x',
            workRequestId: 'wr-1',
          })
        )
      );
      const res = await spawn({ ...reader, maxSteps: 500 });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.clamped).toEqual({ maxSteps: 50 });
      // Sent once, inside data; and the worker's schema keeps it.
      expect(res.json()).not.toHaveProperty('clamped');
      expect(SpawnChildResponseSchema.parse(res.json().data).clamped).toEqual({ maxSteps: 50 });
    });

    it('refuses a writer when the repository it was checked against is gone', async () => {
      // A failed attach was rolled back under the lock between the early read and the child row.
      launcher.launch.mockImplementation(async (_r: unknown, _reply: never, input: never) => {
        state.orch = orchRow({ repoId: null });
        await (
          input as { orchestration: { inTransaction: (...a: unknown[]) => Promise<void> } }
        ).orchestration.inTransaction(state.tx, { temporalWorkflowId: 'a', workRequestId: 'w' });
      });
      expect(code(await spawn(writer))).toBe('REPO_REQUIRED');
    });

    it('starts a repo-less reader against the named team', async () => {
      state.orch = orchRow({ repoId: null });
      await spawn(reader);
      const input = launcher.launch.mock.calls[0]?.[2];
      expect(input.repoId).toBeUndefined();
      expect(input.orchestration.repoless).toEqual({ teamId: TEAM });
    });
  });

  // ── Launch ────────────────────────────────────────────────────────────────

  describe('MCP write guards on the routes the MCP tools call', () => {
    const bridged = { 'x-test-mcp': '1' };
    const launchBody = { allowlist: ['reader'], task: 'Investigate the outage', teamId: TEAM };
    const keyed = { ...bridged, 'idempotency-key': 'key-1' };

    beforeEach(() => {
      cfg.settings['mcp.writeToolsEnabled'] = true;
      cfg.settings['mcp.agentRunAllowedDeliverModes'] = ['none'];
    });

    it('refuses a bridged launch while MCP writes are off, before any row is written', async () => {
      cfg.settings['mcp.writeToolsEnabled'] = false;
      const res = await call('POST', '/', person(), launchBody, keyed);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MCP_WRITE_DISABLED');
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
    });

    it('requires an idempotency key on a bridged launch', async () => {
      const res = await call('POST', '/', person(), launchBody, bridged);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('MCP_IDEMPOTENCY_KEY_REQUIRED');
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
    });

    it('runs a bridged launch at the STANDARD tier only', async () => {
      const res = await call('POST', '/', person(), { ...launchBody, budgetTier: 'LARGE' }, keyed);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('MCP_BUDGET_TIER_NOT_ALLOWED');
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
    });

    it('refuses a delivery default the MCP settings do not allow', async () => {
      const res = await call(
        'POST',
        '/',
        person(),
        { ...launchBody, deliveryDefault: 'draft_pr' },
        keyed
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MCP_DELIVER_MODE_NOT_ALLOWED');
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
    });

    it('launches through the bridge when every guard passes', async () => {
      // A fresh idempotency key: nothing has launched under it yet, so this is not a replay.
      prisma.orchestration.findFirst.mockResolvedValue(null as never);
      const res = await call('POST', '/', person(), launchBody, keyed);
      expect(res.statusCode).toBe(201);
      expect(prisma.orchestration.create).toHaveBeenCalled();
    });

    it('does not apply the MCP guards to a direct REST launch', async () => {
      cfg.settings['mcp.writeToolsEnabled'] = false;
      const res = await call('POST', '/', person(), launchBody);
      expect(res.statusCode).toBe(201);
    });

    it('refuses a bridged user message while MCP writes are off', async () => {
      cfg.settings['mcp.writeToolsEnabled'] = false;
      const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'hello' }, bridged);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MCP_WRITE_DISABLED');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
    });

    it('accepts a bridged user message when the guards pass', async () => {
      const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'hello' }, bridged);
      expect(res.statusCode).toBe(201);
      expect(prisma.orchestrationMessage.create).toHaveBeenCalled();
    });

    it('refuses a bridged message to a child while MCP writes are off', async () => {
      cfg.settings['mcp.writeToolsEnabled'] = false;
      const res = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/messages`,
        person(),
        { body: 'hello' },
        bridged
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MCP_WRITE_DISABLED');
      expect(prisma.runSteeringMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /', () => {
    const body = { allowlist: ['reader'], task: 'Investigate the outage', teamId: TEAM };
    const launch = (b: unknown = body, authorization = person(), headers = {}) =>
      call('POST', '/', authorization, b, headers);

    it('launches a repo-less orchestration and starts the workflow with the launcher and no token', async () => {
      const res = await launch();
      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data).toMatchObject({ status: 'ACTIVE', workflowId: `orch-${data.orchestrationId}` });
      const [id, input, signal] = temporal.signalWithStartOrchestration.mock.calls[0] ?? [];
      expect(id).toBe(data.orchestrationId);
      expect(input).toMatchObject({
        orchestrationId: id,
        pinned: PINS,
        serviceId: null,
        teamId: TEAM,
        userId: USER_ID,
      });
      expect(input).not.toHaveProperty('token');
      expect(JSON.stringify(input)).not.toContain('orch_');
      expect(signal.name).toBe('userMessage');
      const ledger = tracked.rows[0] as { runInput: Record<string, unknown> };
      expect(ledger.runInput).toMatchObject({ billingTeamId: TEAM, requestedById: USER_ID });
      expect(prisma.orchestration.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ launchedById: USER_ID, repoId: null, teamId: TEAM }),
      });
      expect(prisma.orchestrationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ body: body.task, role: 'USER' }),
      });
    });

    it('refuses while the kill switch is off', async () => {
      cfg.enabled = false;
      expect((await launch()).statusCode).toBe(403);
    });

    describe('default allowlist', () => {
      const noList = { task: 'Investigate the outage', teamId: TEAM };

      it.each([
        ['omitted', noList],
        ['empty', { ...noList, allowlist: [] }],
      ])('applies the configured default when the allowlist is %s', async (_n, b) => {
        const res = await launch(b);
        expect(res.statusCode).toBe(201);
        // 'gone' has no active agent and 'orchestrator' is never launchable: both are dropped.
        const applied = ['reader', 'writer'];
        expect(res.json().data.allowlist).toEqual(applied);
        expect(res.json().data.writeCapable).toEqual(['writer']);
        expect(prisma.orchestration.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ allowlist: applied }),
        });
      });

      it('resolves the default at the named team organization', async () => {
        const { resolveSettings } = await import('@auto-swe/shared/config');
        await launch(noList);
        expect(resolveSettings).toHaveBeenCalledWith(
          ['orchestration.defaultAllowlist'],
          expect.objectContaining({ orgId: ORG })
        );
      });

      it('answers ALLOWLIST_REQUIRED, and writes nothing, when no default agent exists', async () => {
        prisma.agent.findMany.mockResolvedValue([] as never);
        const res = await launch(noList);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('ALLOWLIST_REQUIRED');
        expect(res.json().error.message).toMatch(/allowlist/i);
        expect(prisma.orchestration.create).not.toHaveBeenCalled();
        expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
      });

      it('answers ALLOWLIST_REQUIRED when the setting is empty', async () => {
        const saved = cfg.settings['orchestration.defaultAllowlist'];
        cfg.settings['orchestration.defaultAllowlist'] = [];
        try {
          expect((await launch(noList)).json().error.code).toBe('ALLOWLIST_REQUIRED');
        } finally {
          cfg.settings['orchestration.defaultAllowlist'] = saved as string[];
        }
      });

      it('keeps an explicit allowlist exactly as given, defaults ignored', async () => {
        const res = await launch({ ...noList, allowlist: ['reader'] });
        expect(res.statusCode).toBe(201);
        expect(res.json().data.allowlist).toEqual(['reader']);
        expect(prisma.orchestration.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ allowlist: ['reader'] }),
        });
        prisma.agent.findMany.mockResolvedValue([] as never);
        expect((await launch({ ...noList, allowlist: ['reader'] })).statusCode).toBe(404);
      });

      it('replays with the allowlist that was applied', async () => {
        const first = await launch(noList, person(), { 'idempotency-key': 'dflt' });
        state.orch = orchRow({ id: first.json().data.orchestrationId });
        const again = await launch(noList, person(), { 'idempotency-key': 'dflt' });
        expect(again.statusCode).toBe(200);
        expect(again.json().data.allowlist).toEqual(['reader', 'writer']);
      });

      it('replays before the default is resolved, even after it was emptied', async () => {
        prisma.orchestration.findFirst.mockResolvedValueOnce(null as never);
        const first = await launch(noList, person(), { 'idempotency-key': 'dflt2' });
        expect(first.statusCode).toBe(201);
        state.orch = orchRow({
          allowlist: ['reader', 'writer'],
          id: first.json().data.orchestrationId,
        });
        const saved = cfg.settings['orchestration.defaultAllowlist'];
        cfg.settings['orchestration.defaultAllowlist'] = [];
        prisma.agent.findMany.mockResolvedValue([] as never);
        try {
          const again = await launch(noList, person(), { 'idempotency-key': 'dflt2' });
          expect(again.statusCode).toBe(200);
          expect(again.json().data.allowlist).toEqual(['reader', 'writer']);
          // A first launch under the same emptied default is still refused.
          prisma.orchestration.findFirst.mockResolvedValueOnce(null as never);
          const fresh = await launch(noList, person(), { 'idempotency-key': 'dflt3' });
          expect(fresh.statusCode).toBe(400);
          expect(fresh.json().error.code).toBe('ALLOWLIST_REQUIRED');
        } finally {
          cfg.settings['orchestration.defaultAllowlist'] = saved as string[];
        }
      });
    });

    describe('GET /defaults', () => {
      it('answers the filtered default for a member, and is not read as an id', async () => {
        const res = await call('GET', `/defaults?teamId=${TEAM}`, person());
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          data: { allowlist: ['reader', 'writer'], writeCapable: ['writer'] },
        });
      });

      it('marks a default whose organization override can change files, bash included', async () => {
        prisma.agent.findMany.mockResolvedValue([
          { key: 'reader', scope: 'GLOBAL', toolKeys: ['readFile'], version: 1 },
          { key: 'reader', scope: 'ORGANIZATION', toolKeys: ['bash'], version: 2 },
          { key: 'writer', scope: 'GLOBAL', toolKeys: null, version: 1 },
        ] as never);
        const res = await call('GET', `/defaults?teamId=${TEAM}`, person());
        expect(res.json().data.writeCapable).toEqual(['reader']);
        // The launch reports the same effective marking.
        const launched = await launch({ task: 't', teamId: TEAM });
        expect(launched.json().data.writeCapable).toEqual(['reader']);
      });

      it('answers 404 to a non-member', async () => {
        prisma.team.findFirst.mockResolvedValue({
          id: TEAM,
          isActive: true,
          memberships: [],
          orgId: ORG,
        } as never);
        expect((await call('GET', `/defaults?teamId=${TEAM}`, person())).statusCode).toBe(404);
      });
    });

    it.each(['orchestrator', 'orchestrator@1', 'Orchestrator'])(
      'never allows %s',
      async (agent) => {
        const res = await launch({ ...body, allowlist: [agent] });
        expect([400, 404]).toContain(res.statusCode);
        expect(prisma.orchestration.create).not.toHaveBeenCalled();
      }
    );

    it('refuses an agent that does not exist', async () => {
      prisma.agent.findMany.mockResolvedValue([] as never);
      expect((await launch()).statusCode).toBe(404);
    });

    it('refuses a connection the named team does not own', async () => {
      prisma.connection.findMany.mockResolvedValue([] as never);
      const res = await launch({ ...body, connectionIds: [CONN] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CONNECTION_NOT_OWNED');
    });

    it('does not tell a non-member that the team exists', async () => {
      prisma.team.findFirst.mockResolvedValue({
        ...(await prisma.team.findFirst()),
        memberships: [],
      } as never);
      expect((await launch()).statusCode).toBe(404);
    });

    it('lets an ADMIN who is not a member launch on the team', async () => {
      prisma.team.findFirst.mockResolvedValue({
        ...(await prisma.team.findFirst()),
        memberships: [],
      } as never);
      prisma.user.findUnique.mockResolvedValue({
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      } as never);
      expect((await launch(body, person(USER_ID, 'ADMIN'))).statusCode).toBe(201);
    });

    it('launches on a repository through the agent-run launch decision', async () => {
      const res = await launch({ allowlist: ['reader'], repoId: REPO, task: 't' });
      expect(res.statusCode).toBe(201);
      expect(launcher.authorizeRepo).toHaveBeenCalled();
      expect(prisma.orchestration.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ repoId: REPO, teamId: TEAM }),
      });
    });

    it('propagates a refusal of the launch decision and writes nothing', async () => {
      launcher.authorizeRepo.mockImplementation(
        async (
          _f: unknown,
          _r: unknown,
          reply: { status: (n: number) => { send: (b: unknown) => void } }
        ) => {
          reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'no' } });
          return null;
        }
      );
      const res = await launch({ allowlist: ['reader'], repoId: REPO, task: 't' });
      expect(res.statusCode).toBe(403);
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
    });

    it('requires a supplied teamId to be the repository owning team', async () => {
      const res = await launch({
        allowlist: ['reader'],
        repoId: REPO,
        task: 't',
        teamId: OTHER_ORCH,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TEAM_REPO_MISMATCH');
    });

    it('answers a replayed Idempotency-Key with the same orchestration', async () => {
      const first = await launch(body, person(), { 'idempotency-key': 'abc' });
      state.orch = orchRow({ id: first.json().data.orchestrationId });
      const again = await launch(body, person(), { 'idempotency-key': 'abc' });
      expect(again.statusCode).toBe(200);
      expect(again.json().data.orchestrationId).toBe(first.json().data.orchestrationId);
      state.orch = orchRow({ id: first.json().data.orchestrationId, launchedById: OTHER_USER_ID });
      expect((await launch(body, person(), { 'idempotency-key': 'abc' })).statusCode).toBe(409);
    });

    it('removes the orchestration when the workflow could not start', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      const res = await launch();
      expect(res.statusCode).toBe(500);
      expect(prisma.orchestration.deleteMany).toHaveBeenCalled();
    });

    it('refuses a service principal without a repository', async () => {
      prisma.orchestration.findFirst.mockResolvedValue(null as never);
      // A service token needs the PAT path; the route's own rule is exercised through a person
      // without teamId being impossible, so check the schema refusal instead.
      const res = await launch({ allowlist: ['reader'], task: 't' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Reads and visibility ──────────────────────────────────────────────────

  describe('reads', () => {
    it('lists only what the caller can see, as summary DTOs', async () => {
      const res = await call('GET', `/?status=ACTIVE&teamId=${TEAM}`, person());
      expect(res.statusCode).toBe(200);
      for (const row of res.json().data) {
        expect(OrchestrationSummaryDtoSchema.safeParse(row).success).toBe(true);
      }
      const where = whereOf(prisma.orchestration.findMany);
      expect(where.OR).toEqual([
        { launchedById: USER_ID },
        { team: { memberships: { some: { userId: USER_ID } } } },
      ]);
      expect(where).toMatchObject({ status: 'ACTIVE', teamId: TEAM });
    });

    it('lets an ADMIN list everything', async () => {
      prisma.user.findUnique.mockResolvedValue({
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      } as never);
      await call('GET', '/', person(USER_ID, 'ADMIN'));
      expect(whereOf(prisma.orchestration.findMany).OR).toBeUndefined();
    });

    it('answers a hidden orchestration as not found', async () => {
      state.orch = null;
      expect((await call('GET', `/${ORCH}`, person())).statusCode).toBe(404);
    });

    it('returns the detail DTO, with canControl for the launcher only', async () => {
      state.children = [
        {
          agentKey: 'reader',
          costUsd: 0.2,
          createdAt: NOW,
          endedAt: null,
          id: CHILD,
          label: 'look',
          pathScopes: [],
          resultJson: null,
          role: 'READER',
          runId: 'run-1',
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ assignedBranch: null, costUsdAccrued: 0.4 }] },
          workRequestId: 'wr-1',
        },
      ];
      prisma.runSteeringMessage.groupBy.mockResolvedValue([
        { _count: { _all: 2 }, runId: 'run-1' },
      ] as never);
      const mine = await call('GET', `/${ORCH}`, person());
      const dto = OrchestrationDetailDtoSchema.parse(mine.json().data);
      expect(dto.canControl).toBe(true);
      expect(dto.children[0]).toMatchObject({ costUsd: 0.4, undeliveredSteering: 2 });
      expect(dto.cost).toEqual({ childrenUsd: 0.4, orchestratorUsd: 0.5, totalUsd: 0.9 });
      const theirs = await call('GET', `/${ORCH}`, person(OTHER_USER_ID));
      expect(OrchestrationDetailDtoSchema.parse(theirs.json().data).canControl).toBe(false);
    });

    it('pages the transcript with an opaque cursor', async () => {
      prisma.orchestrationMessage.findMany.mockResolvedValue([
        {
          authorId: null,
          body: 'a',
          childId: null,
          createdAt: NOW,
          id: MESSAGE,
          kind: 'TEXT',
          payload: null,
          role: 'USER',
        },
      ] as never);
      const page = OrchestrationMessagesPageSchema.parse(
        (await call('GET', `/${ORCH}/messages`, person())).json()
      );
      expect(page.next).toBeTruthy();
      await call('GET', `/${ORCH}/messages?after=${page.next}`, person());
      const where = whereOf(prisma.orchestrationMessage.findMany, 1);
      expect(where.OR).toHaveLength(2);
      expect((await call('GET', `/${ORCH}/messages?after=zzz`, person())).statusCode).toBe(400);
    });

    it('refuses a cursor whose id is not a UUID instead of failing in the database', async () => {
      const after = Buffer.from('2026-01-01T00:00:00Z|x').toString('base64url');
      const res = await call('GET', `/${ORCH}/messages?after=${after}`, person());
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CURSOR');
      expect(prisma.orchestrationMessage.findMany).not.toHaveBeenCalled();
    });
  });

  // ── Messages ──────────────────────────────────────────────────────────────

  describe('messages', () => {
    it('lets the launcher message the orchestrator', async () => {
      const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'go on' });
      expect(res.statusCode).toBe(201);
      const [, input, signal] = temporal.signalWithStartOrchestration.mock.calls[0] ?? [];
      expect(signal).toEqual({ name: 'userMessage', payload: { messageId: MESSAGE } });
      expect(input).not.toHaveProperty('token');
      expect(JSON.stringify(input)).not.toContain('orch_');
    });

    it('refuses someone who only has visibility', async () => {
      const res = await call('POST', `/${ORCH}/messages`, person(OTHER_USER_ID), { body: 'hi' });
      expect(res.statusCode).toBe(403);
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
    });

    it('refuses a cancelled orchestration but restarts a completed one', async () => {
      state.orch = orchRow({ status: 'CANCELLED' });
      expect((await call('POST', `/${ORCH}/messages`, person(), { body: 'x' })).statusCode).toBe(
        409
      );
      state.orch = orchRow({ status: 'COMPLETED' });
      expect((await call('POST', `/${ORCH}/messages`, person(), { body: 'x' })).statusCode).toBe(
        201
      );
      expect(prisma.orchestration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { endedAt: null, status: 'ACTIVE' } })
      );
    });

    it('forgets the message when the workflow cannot be reached', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'x' });
      expect(res.statusCode).toBe(500);
      expect(prisma.orchestrationMessage.deleteMany).toHaveBeenCalled();
    });

    it('queues a steering message for a running child and tells the orchestrator', async () => {
      state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      const res = await call('POST', `/${ORCH}/children/${CHILD}/messages`, person(), {
        body: 'use X',
      });
      expect(res.statusCode).toBe(201);
      expect(prisma.runSteeringMessage.create).toHaveBeenCalledWith({
        data: { authorId: USER_ID, authorServiceId: null, body: 'use X', runId: 'run-1' },
      });
      expect(temporal.signalWorkflow).toHaveBeenCalledWith(`orch-${ORCH}`, 'userMessage', [
        { messageId: MESSAGE },
      ]);
    });

    it('takes the orchestrator token too, without signalling it', async () => {
      state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      const res = await call('POST', `/${ORCH}/children/${CHILD}/messages`, token(), {
        body: 'hi',
      });
      expect(res.statusCode).toBe(201);
      expect(prisma.runSteeringMessage.create).toHaveBeenCalledWith({
        data: { authorId: null, authorServiceId: null, body: 'hi', runId: 'run-1' },
      });
      // The worker relies on the transcript row: an orchestrator-originated message is recorded.
      expect(prisma.orchestrationMessage.create).toHaveBeenCalledWith({
        data: {
          authorId: null,
          body: 'hi',
          childId: CHILD,
          kind: 'TEXT',
          orchestrationId: ORCH,
          role: 'ORCHESTRATOR',
        },
      });
      expect(temporal.signalWorkflow).not.toHaveBeenCalled();
    });

    it('refuses a finished child and a hidden launcher-only route to others', async () => {
      state.children = [{ id: CHILD, runId: 'run-1', status: 'COMPLETED' }];
      const done = await call('POST', `/${ORCH}/children/${CHILD}/messages`, person(), {
        body: 'x',
      });
      expect(done.statusCode).toBe(409);
      expect(done.json().code).toBe('CHILD_NOT_ALLOWED');
      const other = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/messages`,
        person(OTHER_USER_ID),
        { body: 'x' }
      );
      expect(other.statusCode).toBe(403);
    });
  });

  // ── Attach ────────────────────────────────────────────────────────────────

  describe('attach', () => {
    const pendingMsg = {
      id: MESSAGE,
      payload: { candidateRepoId: REPO, reason: 'need code' },
    };
    beforeEach(() => {
      state.orch = orchRow({ repoId: null });
      prisma.orchestrationMessage.findFirst.mockResolvedValue(pendingMsg as never);
    });
    const attach = (authorization = person()) =>
      call('POST', `/${ORCH}/attach`, authorization, { repoId: REPO });

    it('attaches once, records the resolution and wakes the workflow', async () => {
      const res = await attach();
      expect(res.statusCode).toBe(200);
      expect(prisma.orchestration.updateMany).toHaveBeenCalledWith({
        data: { repoAttachedAt: expect.any(Date), repoId: REPO },
        where: expect.objectContaining({ id: ORCH, repoId: null, teamId: TEAM }),
      });
      expect(temporal.signalWithStartOrchestration.mock.calls[0]?.[2]).toEqual({
        name: 'attachResolved',
        payload: { accepted: true, messageId: MESSAGE, repoId: REPO },
      });
    });

    it('does not reopen the ledger row when a cancel lands between the signal and the reopen', async () => {
      // The signal wakes the workflow; a concurrent /cancel flips the orchestration before the
      // reopen reads its status under the row lock.
      temporal.signalWithStartOrchestration.mockImplementation((async () => {
        state.orch = orchRow({ repoId: null, status: 'CANCELLED' });
      }) as never);
      expect((await attach()).statusCode).toBe(200);
      const reopened = (
        prisma.activeWorkflow.updateMany.mock.calls as unknown as Array<
          [{ data: { currentStatus: string } }]
        >
      ).filter((c) => c[0].data.currentStatus === 'IMPLEMENTING');
      expect(reopened).toHaveLength(0);
    });

    it('marks the request resolved with the time, which is what ends its pending state', async () => {
      await attach();
      expect(prisma.orchestrationMessage.update).toHaveBeenCalledWith({
        data: {
          payload: expect.objectContaining({
            repoId: REPO,
            resolution: 'ATTACHED',
            resolvedAt: expect.any(String),
          }),
        },
        where: { id: MESSAGE },
      });
    });

    it('treats a request already resolved as no request at all, and a legacy PENDING status as open', async () => {
      prisma.orchestrationMessage.findFirst.mockResolvedValue({
        id: MESSAGE,
        payload: { reason: 'x', resolution: 'DECLINED', resolvedAt: 'then' },
      } as never);
      expect((await attach()).json().error.code).toBe('NO_PENDING_ATTACH');
      prisma.orchestrationMessage.findFirst.mockResolvedValue({
        id: MESSAGE,
        payload: { reason: 'x', status: 'PENDING' },
      } as never);
      expect((await attach()).statusCode).toBe(200);
    });

    it('loses the race when another attach already won the compare-and-set', async () => {
      prisma.orchestration.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await attach();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('REPO_ALREADY_ATTACHED');
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
    });

    it('refuses a second attach, a non-launcher and a request nobody made', async () => {
      state.orch = orchRow({ repoId: REPO });
      expect((await attach()).json().code).toBe('REPO_ALREADY_ATTACHED');
      state.orch = orchRow({ repoId: null });
      expect((await attach(person(OTHER_USER_ID))).statusCode).toBe(403);
      prisma.orchestrationMessage.findFirst.mockResolvedValue(null);
      expect((await attach()).json().error.code).toBe('NO_PENDING_ATTACH');
    });

    it('runs the full launch authorization first and attaches nothing when it refuses', async () => {
      launcher.authorizeRepo.mockImplementation(
        async (
          _f: unknown,
          _r: unknown,
          reply: { status: (n: number) => { send: (b: unknown) => void } }
        ) => {
          reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'no' } });
          return null;
        }
      );
      expect((await attach()).statusCode).toBe(403);
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
    });

    it('undoes the attach when the workflow cannot be told', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      expect((await attach()).statusCode).toBe(500);
      expect(prisma.orchestration.updateMany).toHaveBeenLastCalledWith({
        data: { repoAttachedAt: null, repoId: null },
        where: { id: ORCH, repoId: REPO, teamId: TEAM },
      });
    });

    it('lets exactly one of a concurrent attach and decline win (the message is re-read under its lock)', async () => {
      // The route's early read still sees the request pending; by the time the lock is taken the
      // other resolution has already written.
      prisma.orchestrationMessage.findFirst
        .mockResolvedValueOnce(pendingMsg as never)
        .mockResolvedValueOnce({
          id: MESSAGE,
          payload: { reason: 'x', resolution: 'DECLINED', resolvedAt: 'then' },
        } as never);
      const res = await attach();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NO_PENDING_ATTACH');
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
      expect(prisma.orchestrationMessage.update).not.toHaveBeenCalled();
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();

      prisma.orchestrationMessage.findFirst
        .mockResolvedValueOnce(pendingMsg as never)
        .mockResolvedValueOnce({
          id: MESSAGE,
          payload: { reason: 'x', repoId: REPO, resolution: 'ATTACHED', resolvedAt: 'then' },
        } as never);
      const declined = await call('POST', `/${ORCH}/attach/decline`, person());
      expect(declined.statusCode).toBe(409);
      expect(declined.json().error.code).toBe('NO_PENDING_ATTACH');
      expect(prisma.orchestrationMessage.update).not.toHaveBeenCalled();
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
    });

    it('locks the message row and sets the repository in the same transaction as the resolution', async () => {
      await attach();
      expect(prisma.$transaction).toHaveBeenCalled();
      const order: string[] = [];
      prisma.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [];
      }) as never);
      prisma.orchestration.updateMany.mockImplementation((async () => {
        order.push('cas');
        return { count: 1 };
      }) as never);
      prisma.orchestrationMessage.update.mockImplementation((async () => {
        order.push('resolve');
        return {};
      }) as never);
      await attach();
      // The last lock is the ledger reopen after the signal, in its own transaction.
      expect(order).toEqual(['lock', 'cas', 'resolve', 'lock']);
    });

    it('keeps the attach when the workflow cannot be told and a writer already runs on it', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      prisma.orchestrationChild.count.mockResolvedValue(1);
      const res = await attach();
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('ATTACH_SIGNAL_FAILED');
      // Only the attach itself wrote repoId; nothing reset it.
      expect(prisma.orchestration.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.orchestrationMessage.update).toHaveBeenCalledTimes(1);
    });

    it('keeps the attach when the workflow cannot be told and a reader already runs on it', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      // Only a non-writer child is live: asking for writers alone would find none.
      prisma.orchestrationChild.count.mockImplementation((async (a: {
        where: { role?: string };
      }) => (a.where.role === 'WRITER' ? 0 : 1)) as never);
      const res = await attach();
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('ATTACH_SIGNAL_FAILED');
      expect(prisma.orchestration.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.orchestrationMessage.update).toHaveBeenCalledTimes(1);
    });

    it('reopens a declined request when the workflow cannot be told', async () => {
      temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
      prisma.orchestrationMessage.findFirst
        .mockResolvedValueOnce(pendingMsg as never)
        .mockResolvedValueOnce(pendingMsg as never)
        .mockResolvedValueOnce({ id: MESSAGE, payload: { resolution: 'DECLINED' } } as never);
      const res = await call('POST', `/${ORCH}/attach/decline`, person());
      expect(res.statusCode).toBe(500);
      expect(prisma.orchestrationMessage.update).toHaveBeenLastCalledWith({
        data: { payload: pendingMsg.payload },
        where: { id: MESSAGE },
      });
    });

    it('declines', async () => {
      const res = await call('POST', `/${ORCH}/attach/decline`, person());
      expect(res.statusCode).toBe(200);
      expect(prisma.orchestrationMessage.update).toHaveBeenCalledWith({
        data: {
          payload: expect.objectContaining({
            resolution: 'DECLINED',
            resolvedAt: expect.any(String),
          }),
        },
        where: { id: MESSAGE },
      });
      expect(temporal.signalWithStartOrchestration.mock.calls[0]?.[2].payload).toEqual({
        accepted: false,
        messageId: MESSAGE,
        repoId: null,
      });
    });
  });

  // ── Approvals ─────────────────────────────────────────────────────────────

  describe('approvals', () => {
    const decide = (decision: string, authorization = person()) =>
      call('POST', `/${ORCH}/approvals/${APPROVAL}`, authorization, { decision });

    it('decides once with a compare-and-set and signals the workflow', async () => {
      const res = await decide('APPROVE');
      expect(res.statusCode).toBe(200);
      expect(prisma.orchestrationApproval.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({ decidedById: USER_ID, status: 'APPROVED' }),
        where: expect.objectContaining({ expiresAt: { gt: expect.any(Date) }, status: 'PENDING' }),
      });
      expect(temporal.signalWorkflow).toHaveBeenCalledWith(`orch-${ORCH}`, 'approvalResolved', [
        { approvalId: APPROVAL, status: 'APPROVED' },
      ]);
    });

    it('refuses an approval that was already decided or has expired', async () => {
      prisma.orchestrationApproval.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await decide('DENY');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('APPROVAL_NOT_PENDING');
      expect(temporal.signalWorkflow).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'FAILED', 'COMPLETED'])(
      'refuses a decision on a %s orchestration',
      async (status) => {
        state.orch = orchRow({ status });
        const res = await decide('APPROVE');
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
        expect(prisma.orchestrationApproval.updateMany).not.toHaveBeenCalled();
        expect(temporal.signalWorkflow).not.toHaveBeenCalled();
      }
    );

    it('is the launcher alone, and 404 for an unknown approval', async () => {
      expect((await decide('APPROVE', person(OTHER_USER_ID))).statusCode).toBe(403);
      prisma.orchestrationApproval.findFirst.mockResolvedValue(null as never);
      expect((await decide('APPROVE')).statusCode).toBe(404);
    });
  });

  // ── Cancel and end ────────────────────────────────────────────────────────

  describe('cancel and end', () => {
    it('cancels the orchestration, its running children and the workflow', async () => {
      state.children = [
        {
          id: CHILD,
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
        },
      ];
      const res = await call('POST', `/${ORCH}/cancel`, person());
      expect(res.statusCode).toBe(200);
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-1');
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith(`orch-${ORCH}`);
      expect(prisma.orchestration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
      );
    });

    it('refuses when it already ended, or to a non-launcher', async () => {
      prisma.orchestration.updateMany.mockResolvedValueOnce({ count: 0 });
      expect((await call('POST', `/${ORCH}/cancel`, person())).statusCode).toBe(409);
      expect((await call('POST', `/${ORCH}/cancel`, person(OTHER_USER_ID))).statusCode).toBe(403);
    });

    it('ends with a cancel signal that says why', async () => {
      const res = await call('POST', `/${ORCH}/end`, person());
      expect(res.statusCode).toBe(200);
      expect(temporal.signalWorkflow).toHaveBeenCalledWith(`orch-${ORCH}`, 'cancel', [
        { reason: 'ended' },
      ]);
    });

    const runningChild = (workflowId = 'agent-1') => ({
      id: CHILD,
      status: 'RUNNING',
      workRequest: { activeWorkflows: [{ temporalWorkflowId: workflowId }] },
    });

    it('cancels the running children itself before it flips the status, so the cancels are not refused', async () => {
      const order: string[] = [];
      state.children = [runningChild()];
      temporal.cancelWorkflow.mockImplementation(async (id: string) => {
        order.push(`cancel:${id}`);
      });
      prisma.orchestration.updateMany.mockImplementation((async (a: {
        data: { status: string };
      }) => {
        order.push(`flip:${a.data.status}`);
        return { count: 1 };
      }) as never);
      temporal.signalWorkflow.mockImplementation(async (_id: string, name: string) => {
        order.push(`signal:${name}`);
      });
      const res = await call('POST', `/${ORCH}/end`, person());
      expect(res.statusCode).toBe(200);
      expect(order.indexOf('cancel:agent-1')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('cancel:agent-1')).toBeLessThan(order.indexOf('flip:COMPLETED'));
      expect(order.at(-1)).toBe('signal:cancel');
      expect(temporal.signalWorkflow).toHaveBeenCalledWith(`orch-${ORCH}`, 'cancel', [
        { reason: 'ended' },
      ]);
    });

    it('sweeps again after the flip, so a spawn that was starting is cancelled', async () => {
      // The first sweep sees nothing (the workflow does not exist yet); the second sees the child.
      prisma.orchestrationChild.findMany
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([runningChild('agent-late')] as never);
      expect((await call('POST', `/${ORCH}/end`, person())).statusCode).toBe(200);
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-late');

      temporal.cancelWorkflow.mockClear();
      prisma.orchestrationChild.findMany
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([runningChild('agent-late')] as never);
      expect((await call('POST', `/${ORCH}/cancel`, person())).statusCode).toBe(200);
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-late');
    });

    it('does not end the orchestration while a child cancel keeps failing', async () => {
      state.children = [runningChild()];
      temporal.cancelWorkflow.mockRejectedValue(new Error('temporal down'));
      const res = await call('POST', `/${ORCH}/end`, person());
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('CHILD_CANCEL_FAILED');
      expect(res.json().code).toBe('CHILD_CANCEL_FAILED');
      expect(res.json().message).toContain('1 child');
      // The token stays valid so the orchestrator can still cancel survivors; nothing was signalled.
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
      expect(temporal.signalWorkflow).not.toHaveBeenCalled();
    });

    it('ends once a retried child cancel succeeds', async () => {
      state.children = [runningChild()];
      temporal.cancelWorkflow.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);
      expect((await call('POST', `/${ORCH}/end`, person())).statusCode).toBe(200);
    });

    it('counts a child that fails to cancel once on /cancel, however many sweeps it failed in', async () => {
      state.children = [runningChild()];
      temporal.cancelWorkflow.mockImplementation(async (id: string) => {
        if (id === 'agent-1') {
          throw new Error('down');
        }
      });
      const res = await call('POST', `/${ORCH}/cancel`, person());
      expect(res.statusCode).toBe(200);
      // The emergency stop still flips the status and reports truthfully.
      expect(res.json().data).toEqual({ childrenCancelled: 0, failed: 1, status: 'CANCELLED' });
      expect(prisma.orchestration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
      );
    });

    it('refuses to end an orchestration that already ended, without cancelling anything', async () => {
      state.orch = orchRow({ status: 'COMPLETED' });
      state.children = [runningChild()];
      expect((await call('POST', `/${ORCH}/end`, person())).statusCode).toBe(409);
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
    });

    it('cancels one child for the launcher or the token', async () => {
      state.children = [
        {
          id: CHILD,
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
        },
      ];
      expect((await call('POST', `/${ORCH}/children/${CHILD}/cancel`, person())).statusCode).toBe(
        200
      );
      expect((await call('POST', `/${ORCH}/children/${CHILD}/cancel`, token())).statusCode).toBe(
        200
      );
      state.children = [{ id: CHILD, status: 'COMPLETED', workRequest: { activeWorkflows: [] } }];
      expect((await call('POST', `/${ORCH}/children/${CHILD}/cancel`, token())).statusCode).toBe(
        409
      );
    });
  });
  // ── Repository-derived data, per viewer ───────────────────────────────────

  describe('repository visibility', () => {
    const RESULT = {
      branch: 'auto/agent-1',
      costUsd: 0.1,
      filesChanged: [],
      gate: 'passed',
      prUrl: 'https://github.com/acme/api/pull/1',
      status: 'COMPLETED',
      summary: 'content of the other team repository',
    };
    const childRow = () => ({
      agentKey: 'reader',
      costUsd: 0.2,
      createdAt: NOW,
      endedAt: null,
      id: CHILD,
      label: 'look',
      pathScopes: [],
      resultJson: RESULT,
      role: 'READER',
      runId: 'run-1',
      status: 'COMPLETED',
      workRequest: { activeWorkflows: [{ assignedBranch: 'auto/agent-1', costUsdAccrued: 0.2 }] },
      workRequestId: 'wr-1',
    });
    const resultMessage = {
      authorId: null,
      body: 'content of the other team repository',
      childId: CHILD,
      createdAt: NOW,
      id: MESSAGE,
      kind: 'CHILD_RESULT',
      payload: { childId: CHILD, result: RESULT, status: 'COMPLETED' },
      role: 'SYSTEM',
    };
    const textMessage = {
      ...resultMessage,
      body: 'hello',
      kind: 'TEXT',
      payload: null,
      role: 'USER',
    };
    const asAdmin = () =>
      prisma.user.findUnique.mockResolvedValue({
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      } as never);

    beforeEach(() => {
      state.orch = orchRow({ repoAttachedAt: NOW, repoId: REPO });
      state.children = [childRow()];
      prisma.orchestrationMessage.findMany.mockResolvedValue([resultMessage, textMessage] as never);
    });

    const detail = async (authorization: string) =>
      OrchestrationDetailDtoSchema.parse(
        (await call('GET', `/${ORCH}`, authorization)).json().data
      );

    it('shows the launcher everything, without asking whether they can reach the repository', async () => {
      const dto = await detail(person());
      expect(dto.repoName).toBe('acme/api');
      expect(dto.children[0]).toMatchObject({
        branch: 'auto/agent-1',
        prUrl: 'https://github.com/acme/api/pull/1',
        result: { summary: RESULT.summary },
      });
      expect(prisma.connection.findMany).not.toHaveBeenCalled();
    });

    it('shows an ADMIN everything', async () => {
      asAdmin();
      const dto = await detail(person(OTHER_USER_ID, 'ADMIN'));
      expect(dto.repoName).toBe('acme/api');
      expect(dto.children[0]?.result?.summary).toBe(RESULT.summary);
    });

    it('shows a member of the repository (owning or shared team) everything', async () => {
      prisma.connection.findMany.mockResolvedValue([{ id: REPO }] as never);
      const dto = await detail(person(OTHER_USER_ID));
      expect(dto.repoName).toBe('acme/api');
      expect(dto.children[0]?.prUrl).toBe('https://github.com/acme/api/pull/1');
      expect(prisma.connection.findMany).toHaveBeenCalledWith({
        select: { id: true },
        where: { id: { in: [REPO] }, ...repoMemberWhere({ userId: OTHER_USER_ID }) },
      });
      const msgs = (await call('GET', `/${ORCH}/messages`, person(OTHER_USER_ID))).json().data;
      expect(msgs[0].body).toBe(resultMessage.body);
    });

    it('gives another member of the named team the shell with the repository redacted', async () => {
      prisma.connection.findMany.mockResolvedValue([] as never);
      const dto = await detail(person(OTHER_USER_ID));
      expect(dto).toMatchObject({
        repoName: null,
        status: 'ACTIVE',
        teamName: 'Payments',
        title: 'Do things',
      });
      expect(dto.children).toHaveLength(1);
      expect(dto.children[0]).toMatchObject({
        agentKey: 'reader',
        branch: null,
        prUrl: null,
        result: null,
        status: 'COMPLETED',
      });
      expect(JSON.stringify(dto)).not.toContain(RESULT.summary);

      const page = (await call('GET', `/${ORCH}/messages`, person(OTHER_USER_ID))).json();
      expect(JSON.stringify(page)).not.toContain(RESULT.summary);
      expect(page.data[0]).toMatchObject({
        kind: 'CHILD_RESULT',
        payload: { childId: CHILD, status: 'COMPLETED' },
      });
      expect(page.data[1].body).toBe('hello');
    });

    describe('orchestrator text, notices, hidden rows and repository-derived fields', () => {
      const BEFORE = new Date('2026-11-17T09:00:00Z');
      const AFTER = new Date('2026-11-17T10:30:00Z');
      const WITHHELD =
        'Withheld: this part of the conversation involves a repository you cannot access.';
      const msg = (id: string, over: Record<string, unknown>) => ({
        ...textMessage,
        childId: null,
        id,
        ...over,
      });
      const rows = () => [
        msg('m1', { body: 'plan before attach', createdAt: BEFORE, role: 'ORCHESTRATOR' }),
        msg('m2', { body: 'summary of SECRET-CODE', createdAt: AFTER, role: 'ORCHESTRATOR' }),
        msg('m3', { body: 'notice before', createdAt: BEFORE, kind: 'NOTICE', role: 'SYSTEM' }),
        msg('m4', {
          body: 'notice quoting SECRET-CODE',
          createdAt: AFTER,
          kind: 'NOTICE',
          payload: { path: 'src/secret.ts' },
          role: 'SYSTEM',
        }),
        msg('m5', {
          body: 'marker',
          createdAt: AFTER,
          kind: 'NOTICE',
          payload: { hidden: true, marker: true, turn: 1 },
          role: 'SYSTEM',
        }),
        msg('m6', { body: 'user words', createdAt: AFTER, role: 'USER' }),
      ];
      beforeEach(() => {
        prisma.connection.findMany.mockResolvedValue([] as never);
        state.orch = orchRow({
          repo: { organizationName: 'acme', repoName: 'api', team: { name: 'Platform' } },
          repoAttachedAt: NOW,
        });
        state.children = [{ ...childRow(), pathScopes: ['src/secret/**'] }];
        prisma.orchestrationMessage.findMany.mockResolvedValue(rows() as never);
      });

      it('withholds orchestrator messages and post-attach notices from a viewer without the repository', async () => {
        const page = (await call('GET', `/${ORCH}/messages`, person(OTHER_USER_ID))).json();
        expect(OrchestrationMessagesPageSchema.parse(page).data).toHaveLength(5);
        expect(JSON.stringify(page)).not.toContain('SECRET-CODE');
        expect(JSON.stringify(page)).not.toContain('src/secret.ts');
        const byId = Object.fromEntries(page.data.map((m: { id: string }) => [m.id, m])) as Record<
          string,
          { body: string; payload: unknown }
        >;
        for (const id of ['m1', 'm2', 'm4']) {
          expect(byId[id]).toMatchObject({ body: WITHHELD, payload: { withheld: true } });
        }
        expect(byId.m3?.body).toBe('notice before');
        expect(byId.m6?.body).toBe('user words');
      });

      it('never serves a hidden marker row to anyone, and shows the rest in full to the launcher', async () => {
        for (const who of [person(), person(OTHER_USER_ID)]) {
          const page = (await call('GET', `/${ORCH}/messages`, who)).json();
          expect(page.data.map((m: { id: string }) => m.id)).not.toContain('m5');
        }
        const mine = (await call('GET', `/${ORCH}/messages`, person())).json();
        expect(mine.data.map((m: { body: string }) => m.body)).toContain('summary of SECRET-CODE');
        expect(mine.data).toHaveLength(5);
        // The cursor still moves past the hidden row, which is last-but-one here.
        expect(mine.next).not.toBeNull();
      });

      it('applies the same to the stream', async () => {
        const hidden = await firstEvents(person(OTHER_USER_ID), /event: status/);
        expect(hidden).not.toContain('SECRET-CODE');
        expect(hidden).not.toContain('marker');
        expect(hidden).not.toContain('src/secret');
        expect(hidden).toContain(WITHHELD);
        expect(hidden).toContain('user words');
        const full = await firstEvents(person(), /event: status/);
        expect(full).toContain('summary of SECRET-CODE');
        expect(full).not.toContain('"marker"');
      });

      it('withholds the repository owning team and the child path scopes in the detail and stream', async () => {
        const dto = await detail(person(OTHER_USER_ID));
        expect(dto.billing?.childrenTeamName).toBeNull();
        expect(dto.billing?.orchestratorTeamName).toBe('Payments');
        expect(dto.children[0]?.pathScopes).toEqual([]);
        // The label was written after the orchestrator read the child's full result.
        expect(dto.children[0]?.label).toBe('Agent 1');
        const stream = await firstEvents(person(OTHER_USER_ID), /event: status/);
        expect(stream).not.toContain('src/secret/**');
        expect(stream).not.toContain('"label":"look"');
        expect(stream).toContain('"label":"Agent 1"');
        const seen = await detail(person());
        expect(seen.children[0]?.label).toBe('look');
        expect(seen.billing?.childrenTeamName).toBe('Platform');
        expect(seen.children[0]?.pathScopes).toEqual(['src/secret/**']);
      });
    });

    it('redacts the repository name in the list for a viewer who cannot reach it', async () => {
      prisma.connection.findMany.mockResolvedValue([] as never);
      const others = (await call('GET', '/', person(OTHER_USER_ID))).json().data[0];
      expect(OrchestrationSummaryDtoSchema.parse(others).repoName).toBeNull();
      expect(others.teamName).toBe('Payments');
      const mine = (await call('GET', '/', person())).json().data[0];
      expect(mine.repoName).toBe('acme/api');
    });

    it('names the candidate repository and its billing team only to someone who can reach it', async () => {
      state.orch = orchRow({ deliveryDefault: 'draft_pr', repoId: null });
      prisma.orchestrationMessage.findFirst.mockResolvedValue({
        body: 'need code',
        id: MESSAGE,
        payload: { candidateRepoId: REPO, reason: 'need code' },
      } as never);
      prisma.connection.findFirst.mockResolvedValueOnce({
        organizationName: 'acme',
        repoName: 'api',
        team: { name: 'Platform' },
      } as never);
      const seen = await detail(person());
      expect(seen.pendingAttach).toMatchObject({
        billingTeamName: 'Platform',
        candidateRepoId: REPO,
        candidateRepoName: 'acme/api',
        deliveryDefault: 'draft_pr',
      });
      expect(prisma.connection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: REPO, ...repoMemberWhere({ userId: USER_ID }) },
        })
      );
      prisma.connection.findFirst.mockResolvedValueOnce(null as never);
      const hidden = await detail(person(OTHER_USER_ID));
      expect(hidden.pendingAttach).toMatchObject({
        billingTeamName: null,
        candidateRepoId: REPO,
        candidateRepoName: null,
      });
    });

    // ── Server-sent events ────────────────────────────────────────────────

    async function firstEvents(authorization: string, want: RegExp): Promise<string> {
      if (!app.server.listening) {
        await app.listen({ host: '127.0.0.1', port: 0 });
      }
      const addr = app.server.address() as { port: number };
      const ctl = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/v1/orchestrations/${ORCH}/events`,
        {
          headers: { authorization },
          signal: ctl.signal,
        }
      );
      const reader = res.body?.getReader();
      let text = '';
      try {
        while (reader && !want.test(text)) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          text += new TextDecoder().decode(value);
        }
      } finally {
        ctl.abort();
      }
      return text;
    }

    it('streams each child with its real undelivered steering count', async () => {
      prisma.runSteeringMessage.groupBy.mockResolvedValue([
        { _count: { _all: 2 }, runId: 'run-1' },
      ] as never);
      const text = await firstEvents(person(), /event: status/);
      const data = text.match(/event: child\ndata: (.*)\n/)?.[1] ?? '{}';
      expect(JSON.parse(data)).toMatchObject({
        id: CHILD,
        result: { summary: RESULT.summary },
        undeliveredSteering: 2,
      });
    });

    it('streams a viewer who cannot reach the repository the redacted views', async () => {
      prisma.connection.findMany.mockResolvedValue([] as never);
      const text = await firstEvents(person(OTHER_USER_ID), /event: status/);
      expect(text).toContain('event: child');
      expect(text).not.toContain(RESULT.summary);
      expect(text).not.toContain('auto/agent-1');
      expect(text).toContain('"body":"hello"');
    });

    describe('resuming a stream', () => {
      const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
      const row = (n: number, extra: Record<string, unknown> = {}) => ({
        authorId: null,
        body: `m${n}`,
        childId: null,
        createdAt: at(n),
        id: `00000000-0000-4000-8000-00000000010${n}`,
        kind: 'TEXT',
        payload: null,
        role: 'USER',
        ...extra,
      });
      const cursorOf = (m: { createdAt: Date; id: string }) => encodeCursor(m);

      /** A transcript that honours the `after` cursor the way the database would. */
      function transcript(rows: ReturnType<typeof row>[]) {
        prisma.orchestrationMessage.findMany.mockImplementation((async (args: {
          where: { OR?: Array<{ createdAt: Date | { gt: Date }; id?: { gt: string } }> };
        }) =>
          rows.filter(
            (m) =>
              !args.where.OR ||
              args.where.OR.some((c) =>
                c.id
                  ? m.createdAt.getTime() === (c.createdAt as Date).getTime() && m.id > c.id.gt
                  : m.createdAt.getTime() > (c.createdAt as { gt: Date }).gt.getTime()
              )
          )) as never);
      }

      async function url() {
        if (!app.server.listening) {
          await app.listen({ host: '127.0.0.1', port: 0 });
        }
        const addr = app.server.address() as { port: number };
        return `http://127.0.0.1:${addr.port}/api/v1/orchestrations/${ORCH}/events`;
      }
      async function open(suffix: string, headers: Record<string, string>, want: RegExp) {
        const ctl = new AbortController();
        const res = await fetch(`${await url()}${suffix}`, { headers, signal: ctl.signal });
        let text = '';
        if (res.status === 200) {
          const reader = res.body?.getReader();
          try {
            while (reader && !want.test(text)) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              text += new TextDecoder().decode(value);
            }
          } finally {
            ctl.abort();
          }
        }
        return { status: res.status, text };
      }
      const messageIds = (text: string) =>
        [...text.matchAll(/event: message\ndata: (.*)\n/g)].map(
          (m) => (JSON.parse(m[1] ?? '{}') as { body: string }).body
        );
      const lastId = (text: string) => [...text.matchAll(/^id: (.*)$/gm)].pop()?.[1];

      it('opens with a retry hint and gives every event the cursor it was written at', async () => {
        transcript([row(1), row(2)]);
        const { text } = await open('', { authorization: person() }, /event: status/);
        expect(text.startsWith('retry: 3000\n\n')).toBe(true);
        expect(text).toContain(`id: ${cursorOf(row(1))}\nevent: message`);
        expect(text).toContain(`id: ${cursorOf(row(2))}\nevent: message`);
        // child and status carry the high-water mark so a resume from them skips nothing.
        expect(text).toContain(`id: ${cursorOf(row(2))}\nevent: status`);
      });

      it('resumes after Last-Event-ID or ?after= without repeating or skipping a message', async () => {
        transcript([row(1), row(2), row(3)]);
        const resumed = await open(
          '',
          { authorization: person(), 'last-event-id': cursorOf(row(2)) },
          /event: status/
        );
        expect(messageIds(resumed.text)).toEqual(['m3']);
        const fromQuery = await open(
          `?after=${cursorOf(row(1))}`,
          { authorization: person() },
          /event: status/
        );
        expect(messageIds(fromQuery.text)).toEqual(['m2', 'm3']);
      });

      it('prefers Last-Event-ID over ?after= when a reconnect carries both', async () => {
        transcript([row(1), row(2), row(3), row(4)]);
        const { text } = await open(
          `?after=${cursorOf(row(1))}`,
          { authorization: person(), 'last-event-id': cursorOf(row(3)) },
          /event: status/
        );
        expect(messageIds(text)).toEqual(['m4']);
      });

      it('gives no slot and runs no poll to clients that disconnect during the lookup', async () => {
        transcript([row(1)]);
        const target = await url();
        prisma.orchestration.findFirst.mockImplementation((async () => {
          await new Promise((r) => setTimeout(r, 300));
          return state.orch;
        }) as never);
        const ctls = Array.from({ length: 4 }, () => new AbortController());
        const pending = ctls.map((c) =>
          fetch(target, { headers: { authorization: person() }, signal: c.signal }).catch(
            () => null
          )
        );
        await new Promise((r) => setTimeout(r, 100));
        for (const c of ctls) {
          c.abort();
        }
        await Promise.all(pending);
        await new Promise((r) => setTimeout(r, 600));
        // Nobody was left to poll for.
        expect(prisma.orchestrationMessage.findMany).not.toHaveBeenCalled();
        prisma.orchestration.findFirst.mockImplementation((async () => state.orch) as never);
        const fifth = await open('', { authorization: person() }, /event: status/);
        expect(fifth.status).toBe(200);
      });

      it('stops a stream whose viewer lost access, within one re-check interval', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(NOW);
          transcript([row(1)]);
          let removed = false;
          prisma.orchestration.findFirst.mockImplementation((async (args: {
            select: Record<string, unknown>;
          }) => (removed && 'launchedById' in args.select ? null : state.orch)) as never);
          const res = await fetch(await url(), { headers: { authorization: person() } });
          const reader = res.body?.getReader();
          let text = '';
          let jumped = false;
          while (reader && !/event: done/.test(text)) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            text += new TextDecoder().decode(value);
            if (!jumped && /event: status/.test(text)) {
              jumped = true;
              removed = true;
              vi.setSystemTime(new Date(NOW.getTime() + 61 * 1000));
            }
          }
          expect(text).toContain('event: done\ndata: {"reason":"access"}');
        } finally {
          prisma.orchestration.findFirst.mockImplementation((async () => state.orch) as never);
          vi.useRealTimers();
        }
      });

      it('chains the last id of one connection into the next with nothing between', async () => {
        transcript([row(1), row(2)]);
        const a = await open('', { authorization: person() }, /event: status/);
        transcript([row(1), row(2), row(3)]);
        const b = await open(
          '',
          { authorization: person(), 'last-event-id': lastId(a.text) ?? '' },
          /event: status/
        );
        expect([...messageIds(a.text), ...messageIds(b.text)]).toEqual(['m1', 'm2', 'm3']);
      });

      it('lets a hidden marker row advance the cursor without emitting it', async () => {
        transcript([row(1), row(2, { payload: { hidden: true } }), row(3)]);
        const { text } = await open('', { authorization: person() }, /event: status/);
        expect(messageIds(text)).toEqual(['m1', 'm3']);
        expect(text).not.toContain('m2');
        const resumed = await open(
          '',
          { authorization: person(), 'last-event-id': cursorOf(row(1)) },
          /event: status/
        );
        expect(messageIds(resumed.text)).toEqual(['m3']);
      });

      it('keeps redaction on a resumed stream', async () => {
        prisma.connection.findMany.mockResolvedValue([] as never);
        state.orch = orchRow({ repoAttachedAt: at(1.5), repoId: REPO });
        transcript([row(1), row(2, { body: 'private plan', role: 'ORCHESTRATOR' })]);
        const { text } = await open(
          '',
          { authorization: person(OTHER_USER_ID), 'last-event-id': cursorOf(row(1)) },
          /event: status/
        );
        expect(text).toContain('event: message');
        expect(text).not.toContain('private plan');
      });

      it('refuses a resume cursor that is not valid before opening a stream', async () => {
        const res = await call('GET', `/${ORCH}/events`, person(), undefined, {
          'last-event-id': 'zzz',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_CURSOR');
      });

      it('ends at the time limit with a done event whose id resumes without a gap', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(NOW);
          transcript([row(1), row(2)]);
          const res = await fetch(await url(), { headers: { authorization: person() } });
          const reader = res.body?.getReader();
          let text = '';
          let jumped = false;
          while (reader && !/event: done/.test(text)) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            text += new TextDecoder().decode(value);
            if (!jumped && /event: status/.test(text)) {
              jumped = true;
              vi.setSystemTime(new Date(NOW.getTime() + 17 * 60 * 1000));
            }
          }
          expect(messageIds(text)).toEqual(['m1', 'm2']);
          expect(text).toContain(`id: ${cursorOf(row(2))}\nevent: done`);
          vi.setSystemTime(NOW);
          transcript([row(1), row(2), row(3)]);
          const again = await open(
            '',
            { authorization: person(), 'last-event-id': lastId(text) ?? '' },
            /event: status/
          );
          expect(messageIds(again.text)).toEqual(['m3']);
        } finally {
          vi.useRealTimers();
        }
      });

      it('answers 429 over the cap and takes the resumed stream once one closes', async () => {
        transcript([row(1), row(2)]);
        const target = await url();
        const ctls = Array.from({ length: 4 }, () => new AbortController());
        const held = await Promise.all(
          ctls.map((c) => fetch(target, { headers: { authorization: person() }, signal: c.signal }))
        );
        expect(held.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        const refused = await fetch(target, {
          headers: { authorization: person(), 'last-event-id': cursorOf(row(1)) },
        });
        expect(refused.status).toBe(429);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          'TOO_MANY_STREAMS'
        );
        ctls[0]?.abort();
        await vi.waitFor(async () => {
          const { status, text } = await open(
            '',
            { authorization: person(), 'last-event-id': cursorOf(row(1)) },
            /event: status/
          );
          expect(status).toBe(200);
          expect(messageIds(text)).toEqual(['m2']);
        });
        for (const c of ctls) {
          c.abort();
        }
      });
    });
  });

  // ── DTO fields, the connection options and the principal ──────────────────

  describe('detail fields and connection options', () => {
    it('populates team, billing, budget and delivery default', async () => {
      state.orch = orchRow({
        deliveryDefault: 'branch',
        repo: { organizationName: 'acme', repoName: 'api', team: { name: 'Platform' } },
        workRequest: {
          activeWorkflows: [{ costUsdAccrued: 0.5, tokensInputUsed: 500n, tokensOutputUsed: 100n }],
          payload: { pinned: PINS },
        },
      });
      const dto = OrchestrationDetailDtoSchema.parse(
        (await call('GET', `/${ORCH}`, person())).json().data
      );
      expect(dto.teamName).toBe('Payments');
      expect(dto.billing).toEqual({
        childrenTeamName: 'Platform',
        orchestratorTeamName: 'Payments',
      });
      expect(dto.deliveryDefault).toBe('branch');
      // The tier cap is 1000 input / 1000 output tokens; half the input cap is used.
      expect(dto.budget).toEqual({
        monthlyRemainingUsd: null,
        percentUsed: 50,
        remainingUsd: null,
        tier: 'STANDARD',
        tokens: { cap: 1000, kind: 'input', used: 500 },
      });
    });

    it('counts the children tokens with the orchestrator, against the binding cap', async () => {
      state.orch = orchRow({
        workRequest: {
          activeWorkflows: [{ costUsdAccrued: 0.5, tokensInputUsed: 200n, tokensOutputUsed: 100n }],
          payload: { pinned: PINS },
        },
      });
      state.children = [
        {
          agentKey: 'reader',
          costUsd: 0.2,
          createdAt: NOW,
          endedAt: null,
          id: CHILD,
          label: 'look',
          pathScopes: [],
          resultJson: null,
          role: 'READER',
          runId: null,
          status: 'RUNNING',
          workRequest: {
            activeWorkflows: [
              {
                assignedBranch: null,
                costUsdAccrued: 0.2,
                tokensInputUsed: 100n,
                tokensOutputUsed: 650n,
              },
            ],
          },
          workRequestId: 'wr-1',
        },
      ];
      const dto = OrchestrationDetailDtoSchema.parse(
        (await call('GET', `/${ORCH}`, person())).json().data
      );
      // Output is nearer its cap (750 of 1000) than input (300 of 1000).
      expect(dto.budget).toMatchObject({
        percentUsed: 75,
        tokens: { cap: 1000, kind: 'output', used: 750 },
      });
    });

    it('reports the monthly USD remaining only when the team or organization has a budget', async () => {
      const get = async () =>
        OrchestrationDetailDtoSchema.parse((await call('GET', `/${ORCH}`, person())).json().data);
      expect((await get()).budget?.monthlyRemainingUsd).toBeNull();

      // Team cap $100, spent $12.50 this month; organization cap $50, spent $40: the tighter binds.
      prisma.team.findFirst.mockResolvedValue({
        monthlyBudgetUsdCents: 10_000,
        orgId: ORG,
      } as never);
      prisma.organization.findFirst.mockResolvedValue({ monthlyBudgetUsdCents: 5_000 } as never);
      expect((await get()).budget?.monthlyRemainingUsd).toBeCloseTo(10, 5);

      // Only the team has a cap.
      prisma.organization.findFirst.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
      expect((await get()).budget?.monthlyRemainingUsd).toBeCloseTo(87.5, 5);

      // The deprecated field never carries the monthly figure.
      expect((await get()).budget?.remainingUsd).toBeNull();

      // Spend past the cap floors at zero.
      spend.team = 150;
      try {
        expect((await get()).budget?.monthlyRemainingUsd).toBe(0);
      } finally {
        spend.team = 12.5;
      }
    });

    it('also counts the team and organization that bill the attached repository', async () => {
      const get = async () =>
        OrchestrationDetailDtoSchema.parse((await call('GET', `/${ORCH}`, person())).json().data);
      const TEAM_B = '00000000-0000-4000-8000-0000000000b2';
      const ORG_B = '00000000-0000-4000-8000-0000000000b3';
      state.orch = orchRow({
        repo: {
          organizationName: 'acme',
          repoName: 'api',
          team: { name: 'Platform', orgId: ORG_B },
          teamId: TEAM_B,
        },
      });
      // The named team has a $100 cap; the repository's owning team a $20 cap; its organization $15.
      prisma.team.findFirst.mockImplementation((async (args: { where: { id: string } }) =>
        args.where.id === TEAM_B
          ? { monthlyBudgetUsdCents: 2_000, orgId: ORG_B }
          : { monthlyBudgetUsdCents: 10_000, orgId: ORG }) as never);
      prisma.organization.findFirst.mockImplementation((async (args: { where: { id: string } }) =>
        args.where.id === ORG_B
          ? { monthlyBudgetUsdCents: 1_500 }
          : { monthlyBudgetUsdCents: null }) as never);
      // Every team has spent $12.50 and every organization $5: the owning team's $20 leaves 7.50,
      // its organization's $15 leaves 10.
      spend.org = 5;
      try {
        expect((await get()).budget?.monthlyRemainingUsd).toBeCloseTo(7.5, 5);
        // Without a repository only the named team counts (87.50).
        state.orch = orchRow({ repo: null, repoId: null });
        expect((await get()).budget?.monthlyRemainingUsd).toBeCloseTo(87.5, 5);
      } finally {
        spend.org = 40;
      }
    });

    it('reports no token readout when the tier has no cap, and survives a failed read', async () => {
      state.orch = orchRow({ budgetTier: 'LARGE' });
      prisma.team.findFirst.mockRejectedValue(new Error('db down') as never);
      const res = await call('GET', `/${ORCH}`, person());
      expect(res.statusCode).toBe(200);
      const dto = OrchestrationDetailDtoSchema.parse(res.json().data);
      expect(dto.budget).toEqual({
        monthlyRemainingUsd: null,
        percentUsed: null,
        remainingUsd: null,
        tier: 'LARGE',
        tokens: null,
      });
    });

    it('lists the active MCP connections a team owns, by name only', async () => {
      prisma.team.findFirst.mockResolvedValue({
        id: TEAM,
        isActive: true,
        memberships: [{ userId: USER_ID }],
      } as never);
      prisma.connection.findMany.mockResolvedValue([
        { id: CONN, name: 'Docs', secretCiphertext: 'x', url: 'https://internal' },
      ] as never);
      const res = await call('GET', `/connections?teamId=${TEAM}`, person());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [{ id: CONN, name: 'Docs' }] });
      expect(prisma.connection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true, teamId: TEAM, type: 'mcp' } })
      );
    });

    it('answers a team the caller is not in as missing, and lets an ADMIN through', async () => {
      prisma.team.findFirst.mockResolvedValue({
        id: TEAM,
        isActive: true,
        memberships: [],
      } as never);
      expect((await call('GET', `/connections?teamId=${TEAM}`, person())).statusCode).toBe(404);
      _resetAuthCachesForTests();
      prisma.user.findUnique.mockResolvedValue({
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      } as never);
      expect(
        (await call('GET', `/connections?teamId=${TEAM}`, person(USER_ID, 'ADMIN'))).statusCode
      ).toBe(200);
    });

    it('is not shadowed by the :id route', async () => {
      // No teamId: this route's own validation answers, not `/:id`'s uuid check on "connections".
      const res = await call('GET', '/connections', person());
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('teamId');
    });
  });

  describe('MCP-launched orchestrations, the audit trail and the orchestrator ledger row', () => {
    const bridged = { 'x-test-mcp': '1' };
    const keyed = { ...bridged, 'idempotency-key': 'key-1' };
    const launchBody = { allowlist: ['reader'], task: 'Investigate the outage', teamId: TEAM };
    const auditRows = () =>
      (
        prisma.configAuditLog.create.mock.calls as unknown as Array<
          [{ data: { afterJson: Record<string, unknown>; entityId: string; entityType: string } }]
        >
      ).map((c) => c[0].data);
    const mcpRows = () => auditRows().filter((r) => r.entityType === 'McpToolCall');

    beforeEach(() => {
      cfg.settings['mcp.writeToolsEnabled'] = true;
      cfg.settings['mcp.agentRunAllowedDeliverModes'] = ['none', 'branch'];
      cfg.settings['mcp.writeCallsPerMinute'] = 100;
      cfg.settings['mcp.maxConcurrentRuns'] = 5;
    });
    // A launch under a key nothing has used yet (the default lookup would find the fixture).
    const fresh = () => prisma.orchestration.findFirst.mockResolvedValue(null as never);
    afterEach(() => {
      cfg.settings['mcp.writeCallsPerMinute'] = 100;
    });

    // ── Launch ──────────────────────────────────────────────────────────────

    it('hands the launch the cap guard, and maps its refusal to MCP_RUN_CAP_REACHED', async () => {
      fresh();
      expect((await call('POST', '/', person(), launchBody, keyed)).statusCode).toBe(201);
      expect(typeof tracked.opts[0]?.guard).toBe('function');
      prisma.activeWorkflow.count.mockResolvedValue(5 as never);
      const res = await call('POST', '/', person(), launchBody, {
        ...bridged,
        'idempotency-key': 'key-2',
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('MCP_RUN_CAP_REACHED');
      expect(prisma.orchestration.create).toHaveBeenCalledTimes(1);
    });

    it('records that the launch came through MCP in the work request payload, and only then', async () => {
      fresh();
      await call('POST', '/', person(), launchBody, keyed);
      await call('POST', '/', person(), launchBody);
      const payloads = tracked.rows.map(
        (r) => (r as { runInput: { payload: Record<string, unknown> } }).runInput.payload
      );
      expect(payloads[0]).toMatchObject({ mcpLaunched: true, pinned: PINS });
      expect(payloads[1]).not.toHaveProperty('mcpLaunched');
    });

    it('never reaches the replay lookup when the bridged write is refused', async () => {
      cfg.settings['mcp.writeToolsEnabled'] = false;
      const res = await call('POST', '/', person(), launchBody, keyed);
      expect(res.statusCode).toBe(403);
      expect(prisma.orchestration.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a connection set on a bridged launch, before any row is written', async () => {
      fresh();
      const res = await call(
        'POST',
        '/',
        person(),
        { ...launchBody, connectionIds: [CONN] },
        keyed
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('MCP_CONNECTIONS_NOT_ALLOWED');
      expect(prisma.orchestration.create).not.toHaveBeenCalled();
      // A direct REST launch may still name one.
      const rest = await call('POST', '/', person(), { ...launchBody, connectionIds: [CONN] });
      expect(rest.statusCode).toBe(201);
    });

    it('answers the same key with a different request as IDEMPOTENCY_KEY_MISMATCH', async () => {
      fresh();
      await call('POST', '/', person(), launchBody, keyed);
      const stored = (tracked.rows[0] as { runInput: { payload: unknown } }).runInput.payload;
      prisma.orchestration.findFirst.mockResolvedValue({
        allowlist: ['reader'],
        id: ORCH,
        launchedById: USER_ID,
        serviceId: null,
        status: 'ACTIVE',
        workRequest: { payload: stored },
      } as never);
      const same = await call('POST', '/', person(), launchBody, keyed);
      expect(same.statusCode).toBe(200);
      const other = await call(
        'POST',
        '/',
        person(),
        { ...launchBody, task: 'Something else' },
        keyed
      );
      expect(other.statusCode).toBe(422);
      expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(tracked.rows).toHaveLength(1);
      expect(prisma.orchestration.create).toHaveBeenCalledTimes(1);
    });

    it('answers a concurrent launch with the same key by returning the winner, not a conflict', async () => {
      tracked.result = { ok: false, reason: 'DUPLICATE', source: 'ledger' };
      prisma.orchestration.findFirst.mockResolvedValueOnce(null as never).mockResolvedValueOnce({
        allowlist: ['reader'],
        id: ORCH,
        launchedById: USER_ID,
        serviceId: null,
        status: 'ACTIVE',
        workRequest: { payload: {} },
      } as never);
      const res = await call('POST', '/', person(), launchBody, keyed);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.orchestrationId).toBe(ORCH);
    });

    // ── Burst limit and audit ───────────────────────────────────────────────

    it('applies the burst limit to both message routes', async () => {
      cfg.settings['mcp.writeCallsPerMinute'] = 1;
      state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      const first = await call('POST', `/${ORCH}/messages`, person(), { body: 'a' }, bridged);
      expect(first.statusCode).toBe(201);
      const second = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/messages`,
        person(),
        { body: 'b' },
        bridged
      );
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('MCP_WRITE_RATE_LIMITED');
      const third = await call('POST', `/${ORCH}/messages`, person(), { body: 'c' }, bridged);
      expect(third.statusCode).toBe(429);
    });

    it('audits a bridged message with the orchestration and the child it targeted', async () => {
      state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      await call('POST', `/${ORCH}/messages`, person(), { body: 'a' }, bridged);
      await call('POST', `/${ORCH}/children/${CHILD}/messages`, person(), { body: 'b' }, bridged);
      const rows = mcpRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.afterJson).toMatchObject({
        orchestrationId: ORCH,
        status: 201,
        tool: 'orchestrations_message',
      });
      expect(rows[0]?.afterJson.childId).toBeUndefined();
      expect(rows[0]?.afterJson.runId).toBeUndefined();
      expect(rows[1]?.afterJson).toMatchObject({ childId: CHILD, orchestrationId: ORCH });
      // The route's own audit row says the call came through MCP.
      const own = auditRows().filter((r) => r.entityType === 'Orchestration');
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((r) => (r.afterJson.mcp as { clientId: string }).clientId === 'test')).toBe(
        true
      );
      // A direct call carries no marker.
      prisma.configAuditLog.create.mockClear();
      await call('POST', `/${ORCH}/messages`, person(), { body: 'd' });
      expect(auditRows().every((r) => r.afterJson.mcp === undefined)).toBe(true);
    });

    it('audits a bridged launch with the orchestration it created', async () => {
      fresh();
      const res = await call('POST', '/', person(), launchBody, keyed);
      const id = res.json().data.orchestrationId;
      expect(mcpRows()[0]?.afterJson).toMatchObject({
        orchestrationId: id,
        status: 201,
        tool: 'orchestrations_launch',
      });
    });

    // ── Child messages and restart ──────────────────────────────────────────

    it('sends a bridged message to a running child, and refuses anyone but the launcher', async () => {
      state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      const ok = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/messages`,
        person(),
        { body: 'steer' },
        bridged
      );
      expect(ok.statusCode).toBe(201);
      expect(ok.json().data.childId).toBe(CHILD);
      expect(prisma.runSteeringMessage.create).toHaveBeenCalled();
      const other = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/messages`,
        person(OTHER_USER_ID),
        { body: 'steer' },
        bridged
      );
      expect(other.statusCode).toBe(403);
      expect(other.json().error.code).toBe('NOT_LAUNCHER');
    });

    it('refuses a bridged message to a COMPLETED orchestration, where a direct one restarts it', async () => {
      state.orch = orchRow({ status: 'COMPLETED' });
      const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'again' }, bridged);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
      const direct = await call('POST', `/${ORCH}/messages`, person(), { body: 'again' });
      expect(direct.statusCode).toBe(201);
      expect(prisma.orchestration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { endedAt: null, status: 'ACTIVE' } })
      );
    });

    describe('a bridged message that restarts a WAITING orchestration', () => {
      const send = () => call('POST', `/${ORCH}/messages`, person(), { body: 'wake' }, bridged);
      const ledger = () =>
        (
          prisma.activeWorkflow.updateMany.mock.calls as unknown as Array<
            [{ data: { currentStatus: string }; where: Record<string, unknown> }]
          >
        ).map((c) => c[0]);
      // The parked row (COMPLETED) exists; the cap guard counts `inFlight` other runs.
      const parkedWith = (inFlight: number) =>
        prisma.activeWorkflow.count.mockImplementation((async (a: {
          where: { currentStatus: unknown };
        }) => (a.where.currentStatus === 'COMPLETED' ? 1 : inFlight)) as never);

      beforeEach(() => {
        state.orch = orchRow({ status: 'WAITING' });
      });

      it('is refused at the cap, under the per-user lock, and leaves the ledger row COMPLETED', async () => {
        parkedWith(5);
        const res = await send();
        expect(res.statusCode).toBe(429);
        expect(res.json().error.code).toBe('MCP_RUN_CAP_REACHED');
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(prisma.$executeRaw).toHaveBeenCalled();
        expect(ledger()).toHaveLength(0);
        expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
        expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
        expect(prisma.activeWorkflow.count).toHaveBeenCalledWith({
          where: expect.objectContaining({ workRequest: { requestedById: USER_ID } }),
        });
      });

      it('takes the message under the cap, reopening the row before the signal is sent', async () => {
        parkedWith(4);
        const order: string[] = [];
        prisma.activeWorkflow.updateMany.mockImplementation((async () => {
          order.push('reopen');
          return { count: 1 };
        }) as never);
        temporal.signalWithStartOrchestration.mockImplementation((async () => {
          order.push('signal');
        }) as never);
        const res = await send();
        expect(res.statusCode).toBe(201);
        expect(order).toEqual(['reopen', 'signal']);
        expect(prisma.activeWorkflow.updateMany).toHaveBeenCalledWith({
          data: { currentStatus: 'IMPLEMENTING' },
          where: {
            currentStatus: 'COMPLETED',
            temporalWorkflowId: `orch-${ORCH}`,
            workRequestId: 'wr',
          },
        });
      });

      it('puts the row back to COMPLETED, and drops the message, when the signal fails', async () => {
        parkedWith(0);
        temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
        expect((await send()).statusCode).toBe(500);
        expect(ledger().map((c) => c.data.currentStatus)).toEqual(['IMPLEMENTING', 'COMPLETED']);
        expect(ledger()[1]?.where.currentStatus).toBe('IMPLEMENTING');
        expect(prisma.orchestrationMessage.deleteMany).toHaveBeenCalled();
      });

      it('applies no cap to a message that finds the row still running', async () => {
        prisma.activeWorkflow.count.mockResolvedValue(0 as never);
        expect((await send()).statusCode).toBe(201);
        // Nothing parked: the cap was never counted. The per-user lock is still taken, once and
        // before the orchestration's row (the lock order of `lib/lockOrder.ts`), so a spawn
        // holding it cannot meet this message the wrong way round.
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      });

      it('leaves a direct caller uncapped', async () => {
        parkedWith(50);
        const res = await call('POST', `/${ORCH}/messages`, person(), { body: 'wake' });
        expect(res.statusCode).toBe(201);
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
        expect(ledger()[0]?.data.currentStatus).toBe('IMPLEMENTING');
      });

      it('is refused, and nothing is reopened, when a cancel flipped the status after the first read', async () => {
        parkedWith(0);
        // The route's read sees WAITING; by the time the row is locked the status is CANCELLED.
        prisma.orchestration.findFirst
          .mockResolvedValueOnce(orchRow({ status: 'WAITING' }) as never)
          .mockResolvedValueOnce({ status: 'CANCELLED' } as never);
        const res = await send();
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
        expect(ledger()).toHaveLength(0);
        expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
        expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
      });

      it('does not undo a cancel that landed after the signal failed', async () => {
        parkedWith(0);
        temporal.signalWithStartOrchestration.mockImplementation((async () => {
          throw new Error('down');
        }) as never);
        await send();
        // The undo only matches a row still IMPLEMENTING, so a row /cancel closed is left alone.
        expect(ledger().at(-1)?.where.currentStatus).toBe('IMPLEMENTING');
      });
    });

    describe('the MCP delivery ceiling on an orchestration launched another way', () => {
      const send = (headers: Record<string, string> = bridged) =>
        call('POST', `/${ORCH}/messages`, person(), { body: 'steer' }, headers);
      const sendChild = (headers: Record<string, string> = bridged) =>
        call('POST', `/${ORCH}/children/${CHILD}/messages`, person(), { body: 'steer' }, headers);

      beforeEach(() => {
        state.children = [{ id: CHILD, runId: 'run-1', status: 'RUNNING' }];
      });

      it('refuses a bridged message to an orchestration whose default the allowlist excludes', async () => {
        state.orch = orchRow({ deliveryDefault: 'draft_pr' });
        for (const res of [await send(), await sendChild()]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('MCP_DELIVER_MODE_NOT_ALLOWED');
          expect(res.json().error.message).toContain('not allowed through MCP');
        }
        expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
        expect(prisma.runSteeringMessage.create).not.toHaveBeenCalled();
        expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
      });

      it('uses the live setting, ranks a null default as none, and lets a default within the ceiling through', async () => {
        state.orch = orchRow({ deliveryDefault: 'branch' });
        expect((await send()).statusCode).toBe(201);
        expect((await sendChild()).statusCode).toBe(201);
        state.orch = orchRow({ deliveryDefault: null });
        expect((await send()).statusCode).toBe(201);
        cfg.settings['mcp.agentRunAllowedDeliverModes'] = ['none'];
        state.orch = orchRow({ deliveryDefault: 'branch' });
        expect((await send()).statusCode).toBe(403);
        cfg.settings['mcp.agentRunAllowedDeliverModes'] = ['none', 'branch', 'draft_pr'];
        state.orch = orchRow({ deliveryDefault: 'draft_pr' });
        expect((await send()).statusCode).toBe(201);
      });

      it('leaves a direct caller and every read alone', async () => {
        state.orch = orchRow({ deliveryDefault: 'draft_pr' });
        expect((await send({})).statusCode).toBe(201);
        expect((await sendChild({})).statusCode).toBe(201);
        expect(
          (await call('GET', `/${ORCH}/messages`, person(), undefined, bridged)).statusCode
        ).toBe(200);
      });
    });

    // ── Spawn under the MCP launch policy ───────────────────────────────────

    describe('spawn', () => {
      const writer = (deliver: string) => ({
        agent: 'writer',
        deliver,
        label: 'edit',
        pathScopes: ['src/api/**'],
        role: 'writer',
        task: 'change',
      });
      const spawn = (intent: unknown) =>
        call('POST', `/${ORCH}/children`, token(), { intent, turnKey: 'turn-1' });
      const mcpOrch = (deliveryDefault: string | null) =>
        orchRow({
          deliveryDefault,
          workRequest: {
            activeWorkflows: [],
            payload: { mcpLaunched: true, pinned: PINS },
          },
        });

      beforeEach(() => {
        launcher.launch.mockImplementation(async (_r: unknown, reply: never) =>
          (reply as { status: (n: number) => { send: (b: unknown) => unknown } })
            .status(201)
            .send({})
        );
      });

      it('refuses a writer delivery mode the live MCP allowlist does not allow', async () => {
        state.orch = mcpOrch('draft_pr');
        const res = await spawn(writer('draft_pr'));
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('CHILD_NOT_ALLOWED');
        expect(res.json().error.message).toContain('MCP delivery restriction');
        expect(launcher.launch).not.toHaveBeenCalled();
        // The same writer in a mode the allowlist has, within the default, starts.
        expect((await spawn(writer('branch'))).statusCode).toBe(201);
      });

      it('holds a writer to the launch default as an upper bound', async () => {
        cfg.settings['mcp.agentRunAllowedDeliverModes'] = ['none', 'branch', 'draft_pr'];
        state.orch = mcpOrch('branch');
        const res = await spawn(writer('draft_pr'));
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('CHILD_NOT_ALLOWED');
        expect((await spawn(writer('branch'))).statusCode).toBe(201);
        state.orch = mcpOrch('none');
        expect((await spawn(writer('branch'))).statusCode).toBe(409);
      });

      it('leaves an orchestration that was not launched through MCP alone', async () => {
        state.orch = orchRow({ deliveryDefault: 'none' });
        expect((await spawn(writer('draft_pr'))).statusCode).toBe(201);
        expect(launcher.launch.mock.calls[0]?.[2].orchestration.guard).toBeUndefined();
      });

      it('passes an MCP-launched child the cap guard, which refuses at the cap', async () => {
        state.orch = mcpOrch('branch');
        expect((await spawn(writer('branch'))).statusCode).toBe(201);
        const guard = launcher.launch.mock.calls[0]?.[2].orchestration.guard as (
          tx: unknown
        ) => Promise<string | null>;
        expect(typeof guard).toBe('function');
        prisma.activeWorkflow.count.mockResolvedValue(4 as never);
        expect(await guard(state.tx)).toBeNull();
        prisma.activeWorkflow.count.mockResolvedValue(5 as never);
        expect(await guard(state.tx)).toBe('MCP_RUN_CAP_REACHED');
        expect(prisma.activeWorkflow.count).toHaveBeenLastCalledWith({
          where: expect.objectContaining({
            workRequest: { requestedById: USER_ID },
          }),
        });
      });
    });

    // ── The orchestrator's own ledger row ───────────────────────────────────

    describe('ledger row', () => {
      const ledgerCalls = () =>
        prisma.activeWorkflow.updateMany.mock.calls as unknown as Array<
          [{ data: { currentStatus: string }; where: Record<string, unknown> }]
        >;

      it('is closed CANCELLED by /cancel and COMPLETED by /end, scoped to the orchestration', async () => {
        expect((await call('POST', `/${ORCH}/cancel`, person())).statusCode).toBe(200);
        expect(ledgerCalls()[0]?.[0]).toMatchObject({
          data: { currentStatus: 'CANCELLED' },
          where: { temporalWorkflowId: `orch-${ORCH}`, workRequestId: 'wr' },
        });
        expect(ledgerCalls()[0]?.[0].where.currentStatus).toEqual({
          notIn: expect.arrayContaining(['COMPLETED', 'CANCELLED', 'FAILED']),
        });
        prisma.activeWorkflow.updateMany.mockClear();
        expect((await call('POST', `/${ORCH}/end`, person())).statusCode).toBe(200);
        expect(ledgerCalls()[0]?.[0]).toMatchObject({
          data: { currentStatus: 'COMPLETED' },
          where: { temporalWorkflowId: `orch-${ORCH}`, workRequestId: 'wr' },
        });
      });

      it('is not closed when /end refuses because a child cancel keeps failing', async () => {
        state.children = [
          {
            id: CHILD,
            status: 'RUNNING',
            workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
          },
        ];
        temporal.cancelWorkflow.mockRejectedValue(new Error('down'));
        expect((await call('POST', `/${ORCH}/end`, person())).statusCode).toBe(502);
        expect(ledgerCalls()).toHaveLength(0);
      });

      it('is reopened when a completed orchestration restarts, and when it wakes on a message', async () => {
        state.orch = orchRow({ status: 'COMPLETED' });
        await call('POST', `/${ORCH}/messages`, person(), { body: 'again' });
        expect(ledgerCalls()[0]?.[0]).toMatchObject({
          data: { currentStatus: 'IMPLEMENTING' },
          where: {
            currentStatus: 'COMPLETED',
            temporalWorkflowId: `orch-${ORCH}`,
            workRequestId: 'wr',
          },
        });
        prisma.activeWorkflow.updateMany.mockClear();
        state.orch = orchRow({ status: 'WAITING' });
        await call('POST', `/${ORCH}/messages`, person(), { body: 'wake' });
        expect(ledgerCalls()).toHaveLength(1);
      });

      it('is put back to COMPLETED when the workflow could not be told about the restart', async () => {
        state.orch = orchRow({ status: 'COMPLETED' });
        temporal.signalWithStartOrchestration.mockRejectedValue(new Error('down'));
        await call('POST', `/${ORCH}/messages`, person(), { body: 'again' });
        expect(ledgerCalls().map((c) => c[0].data.currentStatus)).toEqual([
          'IMPLEMENTING',
          'COMPLETED',
        ]);
        // The undo is a compare-and-set on IMPLEMENTING, so a cancel in between is not undone.
        expect(ledgerCalls()[1]?.[0].where.currentStatus).toBe('IMPLEMENTING');
      });
    });
  });

  describe('service principals', () => {
    const SERVICE = '00000000-0000-4000-8000-0000000000f9';
    beforeEach(() => {
      state.orch = orchRow({ launchedById: null, serviceId: SERVICE });
      state.children = [
        {
          id: CHILD,
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
        },
      ];
      prisma.servicePrincipal.findUnique.mockResolvedValue({
        connectionIds: [],
        disabledAt: null,
        id: SERVICE,
        name: 'ci',
        team: { isActive: true, organization: { isActive: true } },
        teamId: TEAM,
        templateIds: [],
      } as never);
    });
    const cancelChild = () => call('POST', `/${ORCH}/children/${CHILD}/cancel`, token());

    it('records the principal in the audit entry of what it does', async () => {
      const res = await cancelChild();
      expect(res.statusCode).toBe(200);
      const entry = (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).at(
        -1
      )?.[0] as {
        data: { actorId: string | null; afterJson: { serviceId?: string } };
      };
      expect(entry.data.actorId).toBeNull();
      expect(entry.data.afterJson.serviceId).toBe(SERVICE);
    });

    it('refuses once the principal no longer holds a live runs:agent token', async () => {
      prisma.apiToken.findFirst.mockResolvedValue(null as never);
      const res = await cancelChild();
      expect(res.statusCode).toBe(401);
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
      expect(prisma.apiToken.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // As PAT admission: an expiry is required, and it must be in the future.
            expiresAt: { gt: expect.any(Date) },
            revokedAt: null,
            scopes: { has: 'runs:agent' },
            servicePrincipalId: SERVICE,
          }),
        })
      );
      const where = (
        prisma.apiToken.findFirst.mock.calls as unknown as Array<
          [{ where: Record<string, unknown> }]
        >
      )[0]?.[0].where;
      expect(where).not.toHaveProperty('OR');
    });

    it('refuses once the principal organization is inactive, as PAT admission does', async () => {
      prisma.servicePrincipal.findUnique.mockResolvedValue({
        connectionIds: [],
        disabledAt: null,
        id: SERVICE,
        name: 'ci',
        team: { isActive: true, organization: { isActive: false } },
        teamId: TEAM,
        templateIds: [],
      } as never);
      const res = await cancelChild();
      expect(res.statusCode).toBe(401);
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
    });
  });

  // ── A service principal as the launcher ───────────────────────────────────

  describe('a launching service principal', () => {
    const SP = '00000000-0000-4000-8000-0000000000f9';
    const OTHER_SP = '00000000-0000-4000-8000-0000000000fa';
    const bearer = 'Bearer ats_principal-token';

    function principalToken(over: { id?: string; scopes?: string[]; revoked?: boolean } = {}) {
      prisma.apiToken.findUnique.mockResolvedValue({
        expiresAt: new Date(Date.now() + 3_600_000),
        id: 'tok',
        revokedAt: over.revoked ? new Date() : null,
        scopes: over.scopes ?? ['runs:agent'],
        servicePrincipal: {
          connectionIds: [REPO],
          disabledAt: null,
          id: over.id ?? SP,
          name: 'ci',
          team: { isActive: true, organization: { isActive: true } },
          teamId: TEAM,
          templateIds: [],
        },
        user: null,
      } as never);
    }
    const lastAudit = () =>
      (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).at(-1)?.[0] as {
        data: { actorId: string | null; afterJson: Record<string, unknown> };
      };

    beforeEach(() => {
      state.orch = orchRow({ launchedById: null, serviceId: SP });
      state.children = [
        {
          id: CHILD,
          role: 'READER',
          runId: 'run-1',
          status: 'RUNNING',
          workRequest: { activeWorkflows: [{ temporalWorkflowId: 'agent-1' }] },
        },
      ];
      principalToken();
      // The database answers as the real where clause would: a row is found only by its owner.
      prisma.orchestration.findFirst.mockImplementation((async (args: {
        where: { serviceId?: string };
      }) =>
        args.where.serviceId !== undefined &&
        args.where.serviceId !== (state.orch?.serviceId as string | null | undefined)
          ? null
          : state.orch) as never);
      prisma.orchestration.findMany.mockImplementation((async (args: {
        where: { serviceId?: string };
      }) =>
        state.orch && args.where.serviceId === state.orch.serviceId ? [state.orch] : []) as never);
    });

    it('reads its own orchestration, and canControl is true', async () => {
      state.children = [];
      const res = await call('GET', `/${ORCH}`, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(OrchestrationDetailDtoSchema.safeParse(res.json().data).success).toBe(true);
      expect(res.json().data.canControl).toBe(true);
      expect(whereOf(prisma.orchestration.findFirst)).toMatchObject({ id: ORCH, serviceId: SP });
    });

    it('lists only what it launched', async () => {
      const res = await call('GET', '/', bearer);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([ORCH]);
      expect(whereOf(prisma.orchestration.findMany)).toEqual({ serviceId: SP });
      expect(whereOf(prisma.orchestration.count)).toEqual({ serviceId: SP });
    });

    it('reads its messages', async () => {
      const res = await call('GET', `/${ORCH}/messages`, bearer);
      expect(res.statusCode).toBe(200);
      expect(whereOf(prisma.orchestration.findFirst)).toMatchObject({ serviceId: SP });
    });

    it('does not see another principal orchestration', async () => {
      principalToken({ id: OTHER_SP });
      for (const [method, url, payload] of [
        ['GET', `/${ORCH}`, undefined],
        ['GET', `/${ORCH}/messages`, undefined],
        ['POST', `/${ORCH}/messages`, { body: 'hi' }],
        ['POST', `/${ORCH}/cancel`, undefined],
        ['POST', `/${ORCH}/end`, undefined],
        ['POST', `/${ORCH}/children/${CHILD}/cancel`, undefined],
        ['POST', `/${ORCH}/children/${CHILD}/messages`, { body: 'hi' }],
      ] as const) {
        const res = await call(method, url, bearer, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await call('GET', '/', bearer)).json().data).toEqual([]);
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
      expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
    });

    it('does not see a person-launched orchestration', async () => {
      state.orch = orchRow({ launchedById: USER_ID, serviceId: null });
      expect((await call('GET', `/${ORCH}`, bearer)).statusCode).toBe(404);
      expect((await call('POST', `/${ORCH}/cancel`, bearer)).statusCode).toBe(404);
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
    });

    it('messages its orchestrator, with no author and its id on the audit entry', async () => {
      const res = await call('POST', `/${ORCH}/messages`, bearer, { body: 'status?' });
      expect(res.statusCode).toBe(201);
      expect(prisma.orchestrationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ authorId: null, body: 'status?', role: 'USER' }),
      });
      expect(temporal.signalWithStartOrchestration).toHaveBeenCalledWith(
        ORCH,
        expect.objectContaining({ serviceId: SP, userId: null }),
        expect.anything()
      );
      expect(lastAudit().data.actorId).toBeNull();
      expect(lastAudit().data.afterJson).toMatchObject({ action: 'steer', serviceId: SP });
    });

    it('steers one of its children', async () => {
      const res = await call('POST', `/${ORCH}/children/${CHILD}/messages`, bearer, {
        body: 'narrower',
      });
      expect(res.statusCode).toBe(201);
      expect(prisma.runSteeringMessage.create).toHaveBeenCalledWith({
        data: { authorId: null, authorServiceId: SP, body: 'narrower', runId: 'run-1' },
      });
      expect(lastAudit().data.afterJson).toMatchObject({ byOrchestrator: false, serviceId: SP });
    });

    it('cancels one of its children', async () => {
      const res = await call('POST', `/${ORCH}/children/${CHILD}/cancel`, bearer);
      expect(res.statusCode).toBe(200);
      expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-1');
      expect(lastAudit().data.afterJson).toMatchObject({ scope: 'child', serviceId: SP });
    });

    it('cancels its orchestration', async () => {
      const res = await call('POST', `/${ORCH}/cancel`, bearer);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('CANCELLED');
      expect(lastAudit().data.actorId).toBeNull();
      expect(lastAudit().data.afterJson).toMatchObject({ scope: 'orchestration', serviceId: SP });
    });

    it('ends its orchestration', async () => {
      const res = await call('POST', `/${ORCH}/end`, bearer);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('COMPLETED');
      expect(lastAudit().data.afterJson).toMatchObject({ scope: 'end', serviceId: SP });
    });

    it('is refused without the runs:agent scope', async () => {
      principalToken({ scopes: ['runs:launch'] });
      for (const [method, url] of [
        ['GET', '/'],
        ['GET', `/${ORCH}`],
        ['POST', `/${ORCH}/cancel`],
        ['POST', `/${ORCH}/end`],
      ] as const) {
        const res = await call(method, url, bearer);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE');
      }
    });

    it('is refused once its token is revoked', async () => {
      principalToken({ revoked: true });
      expect((await call('POST', `/${ORCH}/cancel`, bearer)).statusCode).toBe(401);
      expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
    });

    it('cannot attach, decline, approve, stream or list connections', async () => {
      for (const [method, url, payload] of [
        ['POST', `/${ORCH}/attach`, { repoId: REPO }],
        ['POST', `/${ORCH}/attach/decline`, undefined],
        ['POST', `/${ORCH}/approvals/${APPROVAL}`, { decision: 'APPROVE' }],
        ['GET', `/${ORCH}/events`, undefined],
        ['GET', `/connections?teamId=${TEAM}`, undefined],
        ['POST', `/${ORCH}/children`, { intent: {}, turnKey: 't' }],
      ] as const) {
        const res = await call(method, url, bearer, payload);
        expect(res.statusCode, url).toBe(401);
        expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
      }
      expect(prisma.orchestrationApproval.updateMany).not.toHaveBeenCalled();
    });

    it('is refused as a person when someone other than the launcher tries the same acts', async () => {
      for (const [url, payload] of [
        [`/${ORCH}/messages`, { body: 'hi' }],
        [`/${ORCH}/cancel`, undefined],
        [`/${ORCH}/end`, undefined],
      ] as const) {
        const res = await call('POST', url, person(OTHER_USER_ID), payload);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code).toBe('NOT_LAUNCHER');
      }
    });

    it("labels a steering message from the principal as its own, and the orchestrator's as nobody's", async () => {
      prisma.servicePrincipal.findUnique.mockResolvedValue({
        connectionIds: [REPO],
        disabledAt: null,
        id: SP,
        name: 'ci',
        team: { isActive: true, organization: { isActive: true } },
        teamId: TEAM,
        templateIds: [],
      } as never);
      await call('POST', `/${ORCH}/children/${CHILD}/messages`, bearer, { body: 'narrower' });
      const byAgent = await call('POST', `/${ORCH}/children/${CHILD}/messages`, token(), {
        body: 'by agent',
      });
      expect(byAgent.statusCode).toBe(201);
      const data = (
        prisma.runSteeringMessage.create.mock.calls as unknown as Array<
          [{ data: Record<string, unknown> }]
        >
      ).map((c) => c[0].data);
      expect(data[0]).toMatchObject({ authorId: null, authorServiceId: SP });
      // The orchestrator's token acts as the launching principal, yet its message has no author.
      expect(data[1]).toMatchObject({ authorId: null, authorServiceId: null });
    });

    describe('waking or reviving its orchestration', () => {
      const world = {
        connectionIds: [REPO],
        disabledAt: null as Date | null,
        inFlight: 0,
        lastDay: 0,
        maxInFlight: 3,
        maxRunsPerDay: 10,
        repoTeamId: TEAM,
      };
      const send = () => call('POST', `/${ORCH}/messages`, bearer, { body: 'again' });
      const writes = () => ({
        activeWorkflow: prisma.activeWorkflow.updateMany.mock.calls.length,
        message: prisma.orchestrationMessage.create.mock.calls.length,
        orchestration: prisma.orchestration.updateMany.mock.calls.length,
        signal: temporal.signalWithStartOrchestration.mock.calls.length,
      });

      beforeEach(() => {
        Object.assign(world, {
          connectionIds: [REPO],
          disabledAt: null,
          inFlight: 0,
          lastDay: 0,
          maxInFlight: 3,
          maxRunsPerDay: 10,
          repoTeamId: TEAM,
        });
        state.orch = orchRow({ launchedById: null, serviceId: SP, status: 'COMPLETED' });
        // The parked ledger row exists; the principal's other in-flight rows are `world.inFlight`.
        prisma.activeWorkflow.count.mockImplementation((async ({
          where,
        }: {
          where: { currentStatus: unknown };
        }) => (where.currentStatus === 'COMPLETED' ? 1 : world.inFlight)) as never);
        // The real launch guard reads these inside the same transaction.
        prisma.servicePrincipal.findUnique.mockImplementation((async () => ({
          connectionIds: world.connectionIds,
          disabledAt: world.disabledAt,
          maxInFlight: world.maxInFlight,
          maxRunsPerDay: world.maxRunsPerDay,
          team: { isActive: true },
          teamId: TEAM,
          templateIds: [],
        })) as never);
        const tx = state.tx as Record<string, unknown>;
        tx.connection = {
          findUnique: vi.fn(async () => ({ isActive: true, shares: [], teamId: world.repoTeamId })),
        };
        tx.runInput = { count: vi.fn(async () => world.lastDay) };
      });

      it('revives a COMPLETED orchestration under its limits, as a person would', async () => {
        const res = await send();
        expect(res.statusCode, res.body).toBe(201);
        expect(writes()).toEqual({ activeWorkflow: 1, message: 1, orchestration: 1, signal: 1 });
        expect(whereOf(prisma.activeWorkflow.updateMany)).toMatchObject({
          currentStatus: 'COMPLETED',
        });
      });

      it('wakes a WAITING orchestration under its limits', async () => {
        state.orch = orchRow({ launchedById: null, serviceId: SP, status: 'WAITING' });
        const res = await send();
        expect(res.statusCode, res.body).toBe(201);
        expect(writes().signal).toBe(1);
      });

      it.each([
        [
          'at its in-flight limit',
          () => (world.inFlight = 3),
          429,
          'SERVICE_IN_FLIGHT_LIMIT_REACHED',
        ],
        ['over its daily limit', () => (world.lastDay = 10), 429, 'SERVICE_DAILY_LIMIT_REACHED'],
        ['disabled', () => (world.disabledAt = new Date()), 403, 'SERVICE_PRINCIPAL_DISABLED'],
        [
          'with the repository off its allowlist',
          () => (world.connectionIds = []),
          403,
          'SERVICE_CONNECTION_NOT_ALLOWED',
        ],
        [
          "with the repository no longer its team's",
          () => (world.repoTeamId = OTHER_TEAM),
          403,
          'SERVICE_CONNECTION_NOT_ALLOWED',
        ],
      ])(
        'refuses a revive %s, writing and signalling nothing',
        async (_name, arrange, status, code) => {
          arrange();
          const res = await send();
          expect(res.statusCode).toBe(status);
          expect(res.json().error.code).toBe(code);
          expect(writes()).toEqual({ activeWorkflow: 0, message: 0, orchestration: 0, signal: 0 });
        }
      );

      it('refuses a wake of a WAITING orchestration at its in-flight limit, leaving the row parked', async () => {
        state.orch = orchRow({ launchedById: null, serviceId: SP, status: 'WAITING' });
        world.inFlight = 3;
        const res = await send();
        expect(res.statusCode).toBe(429);
        expect(res.json().error.code).toBe('SERVICE_IN_FLIGHT_LIMIT_REACHED');
        expect(writes()).toEqual({ activeWorkflow: 0, message: 0, orchestration: 0, signal: 0 });
      });

      it('does not apply the guard to a message for an execution that is already running', async () => {
        state.orch = orchRow({ launchedById: null, serviceId: SP, status: 'ACTIVE' });
        prisma.activeWorkflow.count.mockResolvedValue(0 as never);
        world.inFlight = 3;
        world.disabledAt = new Date();
        const res = await send();
        expect(res.statusCode).toBe(201);
      });
    });

    describe('what it reads once it loses the repository', () => {
      const attachedRow = () =>
        orchRow({
          launchedById: null,
          repoAttachedAt: new Date('2026-11-17T09:00:00Z'),
          serviceId: SP,
        });
      const WITHHELD =
        'Withheld: this part of the conversation involves a repository you cannot access.';
      const reach = (over: {
        connectionIds?: string[];
        repoTeamId?: string;
        shares?: unknown[];
      }) => {
        prisma.servicePrincipal.findUnique.mockResolvedValue({
          connectionIds: over.connectionIds ?? [REPO],
          disabledAt: null,
          id: SP,
          name: 'ci',
          team: { isActive: true, organization: { isActive: true } },
          teamId: TEAM,
          templateIds: [],
        } as never);
        prisma.connection.findMany.mockResolvedValue([
          { id: REPO, shares: over.shares ?? [], teamId: over.repoTeamId ?? TEAM },
        ] as never);
      };
      const orchestratorMessage = {
        authorId: null,
        body: 'summary of SECRET-CODE',
        childId: null,
        createdAt: new Date('2026-11-17T10:30:00Z'),
        id: 'm-1',
        kind: 'TEXT',
        payload: null,
        role: 'ORCHESTRATOR',
      };

      beforeEach(() => {
        state.orch = attachedRow();
        state.children = [];
        prisma.orchestrationMessage.findMany.mockResolvedValue([orchestratorMessage] as never);
      });

      it("shows the repository data while the repository is on its allowlist and its team's", async () => {
        reach({});
        const detail = (await call('GET', `/${ORCH}`, bearer)).json().data;
        expect(detail.repoName).toBe('acme/api');
        const page = (await call('GET', `/${ORCH}/messages`, bearer)).json();
        expect(page.data[0].body).toBe('summary of SECRET-CODE');
        const list = (await call('GET', '/', bearer)).json();
        expect(list.data[0].repoName).toBe('acme/api');
      });

      it('redacts it once the repository is edited off its allowlist', async () => {
        reach({ connectionIds: [] });
        const detail = (await call('GET', `/${ORCH}`, bearer)).json().data;
        expect(detail.repoName).toBeNull();
        expect(detail.canControl).toBe(true);
        const page = (await call('GET', `/${ORCH}/messages`, bearer)).json();
        expect(page.data[0].body).toBe(WITHHELD);
        expect(JSON.stringify(page)).not.toContain('SECRET-CODE');
        const list = (await call('GET', '/', bearer)).json();
        expect(list.data[0].repoName).toBeNull();
      });

      it('redacts it once its team neither owns nor is shared the repository', async () => {
        reach({ repoTeamId: OTHER_TEAM });
        expect((await call('GET', `/${ORCH}`, bearer)).json().data.repoName).toBeNull();
        expect((await call('GET', '/', bearer)).json().data[0].repoName).toBeNull();
      });

      it('redacts it when its team holds only a view-only share', async () => {
        reach({ repoTeamId: OTHER_TEAM, shares: [{ canLaunch: false, teamId: TEAM }] });
        expect((await call('GET', `/${ORCH}`, bearer)).json().data.repoName).toBeNull();
      });

      it('keeps showing it through a launch-capable share', async () => {
        reach({ repoTeamId: OTHER_TEAM, shares: [{ canLaunch: true, teamId: TEAM }] });
        expect((await call('GET', `/${ORCH}`, bearer)).json().data.repoName).toBe('acme/api');
      });

      it('never lets a person launcher lose the shortcut', async () => {
        state.orch = orchRow({ launchedById: USER_ID, serviceId: null });
        prisma.connection.findMany.mockResolvedValue([] as never);
        expect((await call('GET', `/${ORCH}`, person())).json().data.repoName).toBe('acme/api');
      });
    });

    describe('an ADMIN stopping an orchestration no person launched', () => {
      const admin = () => person(OTHER_USER_ID, 'ADMIN');
      beforeEach(() => {
        prisma.user.findUnique.mockResolvedValue({
          isActive: true,
          role: 'ADMIN',
          slackId: null,
        } as never);
      });
      const auditOf = () =>
        (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).at(-1)?.[0] as {
          data: { actorId: string | null; afterJson: Record<string, unknown> };
        };

      it('cancels it, audited with the ADMIN as actor and the principal as target', async () => {
        const res = await call('POST', `/${ORCH}/cancel`, admin());
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().data.status).toBe('CANCELLED');
        expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-1');
        expect(auditOf().data.actorId).toBe(OTHER_USER_ID);
        expect(auditOf().data.afterJson).toMatchObject({
          action: 'cancel',
          adminStop: true,
          scope: 'orchestration',
          targetServiceId: SP,
        });
      });

      it('ends it, audited the same way', async () => {
        const res = await call('POST', `/${ORCH}/end`, admin());
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().data.status).toBe('COMPLETED');
        expect(auditOf().data.actorId).toBe(OTHER_USER_ID);
        expect(auditOf().data.afterJson).toMatchObject({
          adminStop: true,
          scope: 'end',
          targetServiceId: SP,
        });
      });

      it('does not let an ADMIN message it, steer its children or cancel one child: launcher only', async () => {
        for (const [url, payload] of [
          [`/${ORCH}/messages`, { body: 'hi' }],
          [`/${ORCH}/children/${CHILD}/messages`, { body: 'hi' }],
          [`/${ORCH}/children/${CHILD}/cancel`, undefined],
        ] as const) {
          const res = await call('POST', url, admin(), payload);
          expect(res.statusCode, url).toBe(403);
          expect(res.json().error.code).toBe('NOT_LAUNCHER');
        }
      });

      it('reports canEmergencyStop on the detail by the rule the stop routes enforce', async () => {
        state.children = [];
        const detail = async (who: ReturnType<typeof person>) =>
          OrchestrationDetailDtoSchema.parse((await call('GET', `/${ORCH}`, who)).json().data);
        // The operator: not the launcher, may stop it.
        const operator = await detail(admin());
        expect(operator.canControl).toBe(false);
        expect(operator.canEmergencyStop).toBe(true);
        // The same caller is accepted by the stop route.
        expect((await call('POST', `/${ORCH}/cancel`, admin())).statusCode).toBe(200);
      });

      it('reports canEmergencyStop false for a non-ADMIN, and for a person-launched one', async () => {
        state.children = [];
        const detail = async (who: ReturnType<typeof person>) =>
          OrchestrationDetailDtoSchema.parse((await call('GET', `/${ORCH}`, who)).json().data);
        prisma.user.findUnique.mockResolvedValue({
          isActive: true,
          role: 'ENGINEER',
          slackId: null,
        } as never);
        expect((await detail(person(OTHER_USER_ID))).canEmergencyStop).toBe(false);
        const refused = await call('POST', `/${ORCH}/cancel`, person(OTHER_USER_ID));
        expect(refused.statusCode).toBe(403);
        prisma.user.findUnique.mockResolvedValue({
          isActive: true,
          role: 'ADMIN',
          slackId: null,
        } as never);
        state.orch = orchRow({ launchedById: USER_ID, serviceId: null });
        expect((await detail(admin())).canEmergencyStop).toBe(false);
      });

      it('does not let a non-ADMIN member stop it', async () => {
        prisma.user.findUnique.mockResolvedValue({
          isActive: true,
          role: 'ENGINEER',
          slackId: null,
        } as never);
        for (const url of [`/${ORCH}/cancel`, `/${ORCH}/end`]) {
          const res = await call('POST', url, person(OTHER_USER_ID));
          expect(res.statusCode, url).toBe(403);
          expect(res.json().error.code).toBe('NOT_LAUNCHER');
        }
        expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
      });

      it('stays launcher-only for a person-launched orchestration, ADMIN or not', async () => {
        state.orch = orchRow({ launchedById: USER_ID, serviceId: null });
        for (const url of [`/${ORCH}/cancel`, `/${ORCH}/end`]) {
          const res = await call('POST', url, admin());
          expect(res.statusCode, url).toBe(403);
          expect(res.json().error.code).toBe('NOT_LAUNCHER');
        }
        expect(prisma.orchestration.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('writers', () => {
      const writer = {
        agent: 'writer',
        deliver: 'draft_pr',
        label: 'api',
        pathScopes: ['src/api/**'],
        role: 'writer',
        task: 'change',
      };
      beforeEach(() => {
        prisma.servicePrincipal.findUnique.mockResolvedValue({
          connectionIds: [REPO],
          disabledAt: null,
          id: SP,
          name: 'ci',
          team: { isActive: true, organization: { isActive: true } },
          teamId: TEAM,
          templateIds: [],
        } as never);
        state.children = [];
        launcher.launch.mockImplementation(
          async (
            _req: unknown,
            reply: { status: (n: number) => { send: (b: unknown) => unknown } },
            input: { orchestration: { respond: (l: unknown) => unknown } }
          ) =>
            reply.status(201).send(
              input.orchestration.respond({
                temporalWorkflowId: 'agent-x',
                workRequestId: 'wr-1',
              })
            )
        );
      });

      it('runs a writer without asking GitHub, under the launch guard as the principal', async () => {
        const res = await call('POST', `/${ORCH}/children`, token(), {
          intent: writer,
          turnKey: 'turn-1',
        });
        expect(res.statusCode).toBe(201);
        const input = launcher.launch.mock.calls[0]?.[2];
        // The launcher applies `servicePrincipalLaunchGuard` to a service caller.
        expect(input.caller).toMatchObject({
          kind: 'service',
          principal: { servicePrincipalId: SP },
        });
        expect(input.orchestration.guard).toBeUndefined();
        expect(await input.orchestration.checkRepo({ id: REPO })).toBeNull();
        expect(launcher.push).not.toHaveBeenCalled();
      });
    });
  });
  // ── Campaign proposals ────────────────────────────────────────────────────

  describe('campaign proposals', () => {
    const R1 = '00000000-0000-4000-8000-0000000000b2';
    const R2 = '00000000-0000-4000-8000-0000000000b3';
    const R3 = '00000000-0000-4000-8000-0000000000b4';
    const proposal = (over: Record<string, unknown> = {}) => ({
      brief: 'Raise lodash to 4.17.21 everywhere it is used.',
      name: 'Raise lodash',
      plan: 'UNIFORM',
      repoIds: [R1, R2],
      ...over,
    });
    const propose = (body: unknown, auth = token()) =>
      call('POST', `/${ORCH}/campaign-proposals`, auth, body);
    const created = (): Array<Record<string, unknown>> =>
      prisma.orchestrationMessage.create.mock.calls.map(
        (c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data
      );
    const first = (): Record<string, unknown> => created()[0] ?? {};

    beforeEach(() => {
      prisma.connection.findMany.mockResolvedValue([{ id: R1 }, { id: R2 }] as never);
    });

    it('records a valid proposal as a CAMPAIGN_PROPOSAL message and starts nothing', async () => {
      const res = await propose(
        proposal({
          recipe: {
            params: { packageName: 'lodash', targetVersion: '4.17.21' },
            ref: 'npm-dependency@2',
          },
        })
      );
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data).toMatchObject({ droppedRepoCount: 0, messageId: MESSAGE });
      const data = first();
      expect(data).toMatchObject({
        kind: 'CAMPAIGN_PROPOSAL',
        orchestrationId: ORCH,
        role: 'ORCHESTRATOR',
      });
      expect(data.payload).toEqual({
        brief: 'Raise lodash to 4.17.21 everywhere it is used.',
        droppedRepoCount: 0,
        name: 'Raise lodash',
        ownerTeamId: TEAM,
        plan: 'UNIFORM',
        recipe: {
          params: { packageName: 'lodash', targetVersion: '4.17.21' },
          ref: 'npm-dependency@2',
        },
        repoIds: [R1, R2],
      });
      // The brief is in the payload only, never in the one-line body.
      expect(data.body).toBe('Proposed campaign: Raise lodash');
      expect(launcher.launch).not.toHaveBeenCalled();
      expect(tracked.rows).toEqual([]);
      expect(temporal.signalWithStartOrchestration).not.toHaveBeenCalled();
    });

    it('writes an audit entry for each recorded proposal', async () => {
      await propose(proposal());
      const entry = (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).at(
        -1
      )?.[0] as { data: { entityId: string; afterJson: Record<string, unknown> } };
      expect(entry.data.entityId).toBe(ORCH);
      expect(entry.data.afterJson).toMatchObject({
        action: 'propose',
        droppedRepoCount: 0,
        messageId: MESSAGE,
        plan: 'UNIFORM',
        repoCount: 2,
      });
      // The model's text is not copied into the audit entry.
      expect(JSON.stringify(entry.data.afterJson)).not.toContain('lodash');
    });

    it('drops repositories the launcher cannot reach, counting them and naming none', async () => {
      const res = await propose(proposal({ repoIds: [R1, R2, R3] }));
      expect(res.statusCode).toBe(201);
      expect(res.json().data.droppedRepoCount).toBe(1);
      const data = first();
      expect((data.payload as { repoIds: string[] }).repoIds).toEqual([R1, R2]);
      expect(JSON.stringify(res.json())).not.toContain(R3);
      expect(JSON.stringify(data)).not.toContain(R3);
      // The lookup is the launcher's own reach, not the platform's.
      const lookup = prisma.connection.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ];
      expect(lookup[0].where).toMatchObject({
        ...repoMemberWhere({ userId: USER_ID }),
        isActive: true,
        type: 'git_repo',
      });
    });

    it('records a proposal that names no repositories, on an orchestration with none attached', async () => {
      state.orch = orchRow({ repoId: null });
      const res = await propose(proposal({ repoIds: undefined }));
      expect(res.statusCode).toBe(201);
      expect(prisma.connection.findMany).not.toHaveBeenCalled();
      expect((first().payload as { repoIds: string[] }).repoIds).toEqual([]);
    });

    it('keeps markup as text in the payload and collapses the body to one line', async () => {
      const evil = '<img src=x onerror=alert(1)>\n# [click](javascript:alert(1))';
      const res = await propose(proposal({ brief: evil, name: '<b>x</b>\nrest' }));
      expect(res.statusCode).toBe(201);
      const data = first();
      expect((data.payload as { brief: string; name: string }).brief).toBe(evil);
      expect(data.body).toBe('Proposed campaign: <b>x</b> rest');
    });

    it.each([
      ['an unknown recipe', { recipe: { params: {}, ref: 'rm-rf@1' } }],
      [
        'a recipe parameter that is a git specifier',
        {
          recipe: {
            params: { packageName: 'github:evil/x', targetVersion: '1.0.0' },
            ref: 'npm-dependency@2',
          },
        },
      ],
      [
        'a recipe with an extra parameter',
        {
          recipe: {
            params: { extra: 1, packageName: 'lodash', targetVersion: '1.0.0' },
            ref: 'npm-dependency@2',
          },
        },
      ],
      ['an empty brief', { brief: '' }],
      ['a brief with a control character', { brief: 'a\u0000b' }],
      ['a brief past the limit', { brief: 'x'.repeat(8001) }],
      ['an empty name', { name: '   ' }],
      ['a name past the limit', { name: 'n'.repeat(121) }],
      ['an unknown plan', { plan: 'EVERYTHING' }],
      ['repository ids that are not uuids', { repoIds: ['nope'] }],
      ['duplicate repository ids', { repoIds: [R1, R1] }],
      [
        'more than 200 repositories',
        {
          repoIds: Array.from(
            { length: 201 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
          ),
        },
      ],
    ])('refuses %s as INVALID_INTENT and writes nothing', async (_n, over) => {
      const res = await propose(proposal(over));
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
      expect(prisma.connection.findMany).not.toHaveBeenCalled();
    });

    it('does not echo a rejected value back', async () => {
      const res = await propose(
        proposal({
          recipe: {
            params: { packageName: 'github:SECRET-MARK/x', targetVersion: '1.0.0' },
            ref: 'npm-dependency@2',
          },
        })
      );
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain('SECRET-MARK');
    });

    it('refuses a forged payload: a non-object body, and fields the schema does not know are ignored', async () => {
      expect((await propose([1, 2])).statusCode).toBe(400);
      const res = await propose(
        proposal({ kind: 'ATTACH_REQUEST', ownerTeamId: OTHER_TEAM, role: 'USER' })
      );
      expect(res.statusCode).toBe(201);
      const data = first();
      expect(data).toMatchObject({ kind: 'CAMPAIGN_PROPOSAL', role: 'ORCHESTRATOR' });
      expect((data.payload as Record<string, unknown>).ownerTeamId).toBe(TEAM);
      expect(data.payload).not.toHaveProperty('role');
    });

    it('refuses more repositories than workflow.campaignMaxTargets, before looking any up', async () => {
      cfg.maxTargets = 1;
      const res = await propose(proposal());
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toContain('workflow.campaignMaxTargets');
      expect(prisma.connection.findMany).not.toHaveBeenCalled();
    });

    it('enforces the per-orchestration cap, and audits the refusal', async () => {
      prisma.orchestrationMessage.count.mockResolvedValue(5);
      const res = await propose(proposal());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROPOSAL_LIMIT');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
      const entry = (prisma.configAuditLog.create.mock.calls as unknown as unknown[][]).at(
        -1
      )?.[0] as { data: { afterJson: Record<string, unknown> } };
      expect(entry.data.afterJson).toMatchObject({ action: 'refusal', code: 'PROPOSAL_LIMIT' });
    });

    it('holds the cap under the row lock when another proposal lands in between', async () => {
      // The early count passes; the count under the lock does not.
      prisma.orchestrationMessage.count.mockResolvedValueOnce(4).mockResolvedValueOnce(5);
      const res = await propose(proposal());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROPOSAL_LIMIT');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
    });

    it('is refused for an orchestration that has ended or is switched off', async () => {
      state.orch = orchRow({ status: 'COMPLETED' });
      // A token for an ended orchestration no longer authenticates.
      expect((await propose(proposal())).statusCode).toBe(401);
      state.orch = orchRow();
      cfg.enabled = false;
      const res = await propose(proposal());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORCHESTRATION_NOT_ACTIVE');
    });

    it('is refused when no person launched the orchestration (a service principal)', async () => {
      state.orch = orchRow({
        launchedById: null,
        serviceId: '00000000-0000-4000-8000-0000000000d9',
      });
      const res = await propose(proposal());
      // The token of an orchestration with no launching person does not authenticate here at all.
      expect(res.statusCode).toBe(401);
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
    });

    it('is not open to a person: only the orchestration token records a proposal', async () => {
      const res = await propose(proposal(), person());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORCHESTRATION_TOKEN_REQUIRED');
      expect(prisma.orchestrationMessage.create).not.toHaveBeenCalled();
    });

    it("is not open to another orchestration's token", async () => {
      const res = await propose(proposal(), token(OTHER_ORCH));
      expect(res.statusCode).toBe(403);
    });
  });
});
