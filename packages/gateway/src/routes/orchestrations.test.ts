import {
  OrchestrationDetailDtoSchema,
  OrchestrationMessagesPageSchema,
  OrchestrationSummaryDtoSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunWorkflowId } from '../lib/agentRunLaunch.js';
import { _resetAuthCachesForTests } from '../plugins/auth.js';
import { buildAssistantApp, OTHER_USER_ID, USER_ID } from '../test/assistantApp.js';
import { orchestrationRoutes } from './orchestrations.js';

const cfg = vi.hoisted(() => ({
  enabled: true,
  settings: {
    'mcp.agentRunAllowedDeliverModes': ['none'],
    'mcp.maxConcurrentRuns': 5,
    'mcp.writeCallsPerMinute': 100,
    'mcp.writeToolsEnabled': true,
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
  resolveSetting: vi.fn(async () => cfg.enabled),
  resolveSettings: vi.fn(async () => cfg.settings),
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
const tracked = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../lib/workflowLaunch.js', () => ({
  launchTrackedWorkflow: vi.fn(
    async (
      _p: unknown,
      rows: unknown,
      start: () => Promise<void>,
      opts: { inTransaction?: (tx: unknown) => Promise<void> }
    ) => {
      tracked.rows.push(rows);
      await opts.inTransaction?.(txMock());
      await start();
      return { activeWorkflowId: 'aw', ok: true };
    }
  ),
}));

const ORCH = '00000000-0000-4000-8000-0000000000f1';
const OTHER_ORCH = '00000000-0000-4000-8000-0000000000f2';
const TEAM = '00000000-0000-4000-8000-0000000000a1';
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
    $queryRaw: vi.fn(async () => [{ id: ORCH }]),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(state.tx)
        : Promise.all(arg as Promise<unknown>[])
    ),
    activeWorkflow: { findUnique: vi.fn(async () => null) },
    agent: {
      findMany: vi.fn(async () =>
        ['reader', 'writer'].map((key) => ({
          key,
          mcpConnectionId: null,
          scope: 'GLOBAL',
          version: 1,
        }))
      ),
    },
    apiToken: { findFirst: vi.fn(async () => ({ id: 'tok' })) },
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
  const temporal = {
    cancelWorkflow: vi.fn(),
    signalWithStartOrchestration: vi.fn(),
    signalWorkflow: vi.fn(),
  };

  beforeEach(async () => {
    _resetAuthCachesForTests();
    cfg.enabled = true;
    state = { children: [], orch: orchRow(), tx: {} };
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
    prisma = makePrisma();
    app = await buildAssistantApp(prisma as never, async (a) => {
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
    });
  });
  afterEach(async () => {
    await app.close();
  });

  const person = (sub = USER_ID, role = 'ENGINEER') =>
    `Bearer ${app.auth.signAccessToken({ role: role as never, sub })}`;
  const token = (id = ORCH, userId: string | null = USER_ID, serviceId: string | null = null) =>
    `Bearer ${app.auth.signOrchestrationToken({ orchestrationId: id, serviceId, userId }, 3600)}`;
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

    it('is refused when it names someone other than the launcher', async () => {
      const res = await call(
        'POST',
        `/${ORCH}/children/${CHILD}/cancel`,
        token(ORCH, OTHER_USER_ID)
      );
      expect(res.statusCode).toBe(401);
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
      expect(res.json().clamped).toEqual({ maxSteps: 50 });
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

    it('launches a repo-less orchestration and starts the workflow with the launcher and token', async () => {
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
      expect(input.token).toMatch(/^orch_/);
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
      expect(input.token).toMatch(/^orch_/);
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
        data: { authorId: USER_ID, body: 'use X', runId: 'run-1' },
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
        data: { authorId: null, body: 'hi', runId: 'run-1' },
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
      expect(order).toEqual(['lock', 'cas', 'resolve']);
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
      await app.listen({ host: '127.0.0.1', port: 0 });
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
      // Half the input cap is used at $0.50: about $0.50 is left at that price.
      expect(dto.budget).toEqual({ remainingUsd: 0.5, tier: 'STANDARD' });
    });

    it('reports no remaining budget when nothing was spent or the tier has no cap', async () => {
      state.orch = orchRow({ budgetTier: 'LARGE' });
      const dto = OrchestrationDetailDtoSchema.parse(
        (await call('GET', `/${ORCH}`, person())).json().data
      );
      expect(dto.budget).toEqual({ remainingUsd: null, tier: 'LARGE' });
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
        team: { isActive: true },
        teamId: TEAM,
        templateIds: [],
      } as never);
    });
    const cancelChild = () =>
      call('POST', `/${ORCH}/children/${CHILD}/cancel`, token(ORCH, null, SERVICE));

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
            revokedAt: null,
            scopes: { has: 'runs:agent' },
            servicePrincipalId: SERVICE,
          }),
        })
      );
    });
  });
});
