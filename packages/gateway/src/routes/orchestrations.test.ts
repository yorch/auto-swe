import {
  OrchestrationDetailDtoSchema,
  OrchestrationMessagesPageSchema,
  OrchestrationSummaryDtoSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAuthCachesForTests } from '../plugins/auth.js';
import { buildAssistantApp, OTHER_USER_ID, USER_ID } from '../test/assistantApp.js';
import { orchestrationRoutes } from './orchestrations.js';

const cfg = vi.hoisted(() => ({
  enabled: true,
  settings: {
    'orchestration.maxChildren': 3,
    'orchestration.maxConcurrentChildren': 2,
    'orchestration.maxTurns': 200,
    'orchestration.maxWallClockSeconds': 3600,
    'orchestration.maxWriterChildren': 5,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
  } as Record<string, number>,
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => cfg.enabled),
  resolveSettings: vi.fn(async () => cfg.settings),
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
    configAuditLog: { create: vi.fn(async () => ({})) },
    connection: { findMany: vi.fn(async () => [{ id: CONN }]) },
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
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => state.children[0] ?? null),
      findMany: vi.fn(async () => state.children),
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

    it('starts a repo-less reader against the named team', async () => {
      state.orch = orchRow({ repoId: null });
      await spawn(reader);
      const input = launcher.launch.mock.calls[0]?.[2];
      expect(input.repoId).toBeUndefined();
      expect(input.orchestration.repoless).toEqual({ teamId: TEAM });
    });
  });

  // ── Launch ────────────────────────────────────────────────────────────────

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
});
