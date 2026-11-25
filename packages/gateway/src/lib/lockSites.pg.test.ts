import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { OPEN_JOIN_REQUEST_STATUSES } from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repositoryRoutes } from '../routes/repositories.js';
import { lockOpenJoinRequests, lockServicePrincipal } from './lockOrder.js';
import { lockLauncherRuns } from './mcpWriteGuard.js';
import { lockServiceLaunch, servicePrincipalLaunchGuard } from './servicePrincipals.js';
import { closeOpenJoinRequests } from './teamJoinRequests.js';
import { lockLaunchSources, snapshotAuthorizedRepositorySource } from './workflowLaunch.js';

/** The device-approval handler reads the signed-in user from better-auth: the test names it. */
const signedIn = vi.hoisted(() => ({ userId: '' }));
vi.mock('./betterAuth.js', () => ({
  getAuth: () => ({ api: { getSession: async () => ({ user: { id: signedIn.userId } }) } }),
  MCP_RESOURCE: 'https://mcp.lock-sites.test/mcp',
}));
const { approveMcpDevice } = await import('./mcpDeviceApproval.js');

/**
 * The lock sites that `lockOrder.pg.test.ts` does not stage, against real Postgres: the bulk closes
 * of join requests, repository moves and share edits, a service principal's launch guard and its
 * edits, the wake of an orchestration, and the device approval. Each case STAGES the interleaving
 * (a blocker transaction holds one row, the real operations are started in a chosen order and each
 * is seen waiting behind it through `pg_blocking_pids`, then the blocker is released), so no sleep
 * decides the outcome and a case that never staged fails. A case settles one way or the other with
 * no `40P01` and no `P2034`.
 *
 * Opt in with `LOCK_SITES_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been run
 * against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.LOCK_SITES_PG_TEST === '1';
const ITERATIONS = 6;

describe.skipIf(!enabled)('the remaining lock sites against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `ls-${suffix}-${label}`;
  const fastify = { prisma } as unknown as FastifyInstance;
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const connectionIds: string[] = [];
  const principalIds: string[] = [];
  const orchestrationIds: string[] = [];
  let seq = 0;

  async function makeUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `${name(label)}-${seq++}@example.test` },
    });
    userIds.push(user.id);
    return user.id;
  }
  async function makeOrg(label: string) {
    const org = await prisma.organization.create({
      data: { name: name(`org-${label}-${seq}`), slug: name(`org-${label}-${seq++}`) },
    });
    orgIds.push(org.id);
    return org.id;
  }
  async function makeTeam(label: string, orgId: string) {
    const slug = name(`team-${label}-${seq++}`);
    const team = await prisma.team.create({ data: { name: slug, orgId, slug } });
    teamIds.push(team.id);
    return team.id;
  }
  async function makeConnection(teamId: string) {
    const connection = await prisma.connection.create({
      data: { organizationName: name('gh'), repoName: name(`repo-${seq++}`), teamId },
    });
    connectionIds.push(connection.id);
    return connection.id;
  }
  const inOrg = (userId: string, orgId: string) =>
    prisma.organizationMembership.create({ data: { orgId, role: 'MEMBER', userId } });
  const onTeam = (userId: string, teamId: string) =>
    prisma.teamMembership.create({ data: { role: 'MEMBER', teamId, userId } });

  let platformAdmin: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    platformAdmin = await makeUser('platform-admin');
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9_999_999_999,
        iat: 0,
        role: token === platformAdmin ? 'ADMIN' : 'USER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
    await app.ready();
  });

  afterAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      [
        'Connection',
        'ConnectionTeamShare',
        'OrganizationMembership',
        'Orchestration',
        'ServicePrincipal',
        'Team',
        'TeamJoinRequest',
        'TeamMembership',
      ],
      async () => {
        await prisma.orchestration.deleteMany({ where: { id: { in: orchestrationIds } } });
        await prisma.servicePrincipal.deleteMany({ where: { id: { in: principalIds } } });
        await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
        const owned = { OR: [{ orgId: { in: orgIds } }, { id: { in: teamIds } }] };
        await prisma.teamJoinRequest.deleteMany({ where: { team: owned } });
        await prisma.teamMembership.deleteMany({ where: { team: owned } });
        await prisma.team.deleteMany({ where: owned });
        await prisma.organizationMembership.deleteMany({ where: { orgId: { in: orgIds } } });
      }
    );
    await prisma.configAuditLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: [...orgIds, ...teamIds] } }] },
    });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
    invalidateSettingsCache();
  });

  /* ── Staging ─────────────────────────────────────────────────────────────── */

  async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
    // CLAUDE.md §7 exception: reads the server's own backend id, not application data.
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    return row?.pid ?? 0;
  }

  /** How many backends wait, directly or through another waiter, on a lock `holderPid` holds. */
  async function waitingBehind(holderPid: number): Promise<number> {
    // CLAUDE.md §7 exception: reads the server's own lock-wait state, not application data.
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      WITH RECURSIVE chain(pid) AS (
        SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
          AND ${holderPid}::int = ANY (pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY (pg_blocking_pids(a.pid))
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
      )
      SELECT count(*)::int AS n FROM chain`;
    return row?.n ?? 0;
  }

  /** Resolves when `ok()` holds; FAILS after the attempts, so a case that never staged cannot pass. */
  async function until(what: string, ok: () => Promise<boolean>, attempts = 200) {
    for (let i = 0; i < attempts; i += 1) {
      if (await ok()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const activity = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT pid::int, state, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blocked_by,
        left(query, 70) AS query
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    throw new Error(`never reached: ${what}\n${JSON.stringify(activity, null, 1)}`);
  }

  type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
  const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const })
    );

  function isDeadlock(error: unknown): boolean {
    const text = `${(error as { code?: string })?.code ?? ''} ${JSON.stringify(
      (error as { meta?: unknown })?.meta ?? ''
    )} ${(error as Error)?.message ?? ''}`;
    return /40P01|P2034|deadlock detected/i.test(text);
  }

  /** Every result finished or was refused, none by a deadlock; rethrows anything else. */
  function expectNoDeadlock(...results: Array<Settled<unknown>>) {
    for (const r of results) {
      if (!r.ok) {
        expect(isDeadlock(r.error), `a deadlock surfaced: ${String(r.error)}`).toBe(false);
        throw r.error;
      }
    }
  }

  type HeldTable =
    | 'connections'
    | 'device_codes'
    | 'orchestrations'
    | 'service_principals'
    | 'team_join_requests'
    | 'teams';

  /** A transaction holding one row lock until `release()`, then committing. */
  async function holdRow(table: HeldTable, id: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let pid = 0;
    const held = prisma.$transaction(
      async (tx) => {
        pid = await backendPid(tx);
        // CLAUDE.md §7 exception: the staging blocker, holding the row the race is queued on.
        await tx.$executeRawUnsafe(`SELECT 1 FROM ${table} WHERE id = '${id}'::uuid FOR UPDATE`);
        ready();
        await gate;
      },
      { maxWait: 30_000, timeout: 60_000 }
    );
    await isReady;
    return {
      pid,
      release: async () => {
        release();
        await held;
      },
    };
  }

  /** A transaction that runs `fn` and commits; its backend pid is known once it has started. */
  function staged<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    let pid = 0;
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = settle(
      prisma.$transaction(
        async (tx) => {
          pid = await backendPid(tx);
          started();
          return fn(tx);
        },
        { maxWait: 30_000, timeout: 60_000 }
      )
    );
    return { pid: () => pid, result, started: isStarted };
  }

  type Op = { result: Promise<Settled<unknown>>; started?: Promise<void> };

  /**
   * Starts each operation in order, each seen waiting behind `blocker` before the next starts, then
   * releases the blocker and settles them all. Returns what each did.
   */
  async function race(
    blocker: { pid: number; release: () => Promise<void> },
    ops: Array<() => Op>
  ) {
    const running: Op[] = [];
    try {
      for (const start of ops) {
        const op = start();
        running.push(op);
        await op.started;
        const expected = running.length;
        await until(
          `operation ${expected} waits behind the blocker`,
          async () => (await waitingBehind(blocker.pid)) >= expected
        );
      }
    } finally {
      await blocker.release();
    }
    const settled = await Promise.all(running.map((op) => op.result));
    expectNoDeadlock(...settled);
    return settled.map((s) => (s.ok ? s.value : undefined));
  }

  /** An operation that is not a `staged` one (a route call): it has no pid, it just queues. */
  const asOp = (promise: Promise<unknown>): Op => ({ result: settle(promise) });

  /* ── Fixtures ────────────────────────────────────────────────────────────── */

  /** An organization with two teams, a repository of the first and a member of both levels. */
  async function repoWorld(label: string) {
    const orgId = await makeOrg(label);
    const teamId = await makeTeam(`${label}-a`, orgId);
    const otherTeamId = await makeTeam(`${label}-b`, orgId);
    const repoId = await makeConnection(teamId);
    const member = await makeUser(`member-${label}`);
    await inOrg(member, orgId);
    await onTeam(member, teamId);
    return { member, orgId, otherTeamId, repo: { orgId, repoId, teamId }, repoId, teamId };
  }
  type RepoWorld = Awaited<ReturnType<typeof repoWorld>>;

  const launch = (w: RepoWorld, launcher = w.member) =>
    staged((tx) =>
      snapshotAuthorizedRepositorySource(tx, w.repo, { actor: { role: 'USER', sub: launcher } })
    );

  async function makePrincipal(w: RepoWorld) {
    const principal = await prisma.servicePrincipal.create({
      data: { connectionIds: [w.repoId], name: name(`sp-${seq++}`), teamId: w.teamId },
    });
    principalIds.push(principal.id);
    return principal.id;
  }

  /** What a principal's launch takes: the guard, then every source's locks, as a launch does. */
  const principalLaunch = (w: RepoWorld, principalId: string, actorId?: string) =>
    staged(async (tx) => {
      const refusal = await servicePrincipalLaunchGuard(principalId, {
        ...(actorId ? { actorId } : {}),
        connectionId: w.repoId,
      })(tx);
      await lockLaunchSources(
        tx,
        { repos: [w.repo] },
        actorId ? { actor: { role: 'USER', sub: actorId } } : {}
      );
      return refusal;
    });

  /* ── 1. Two bulk closes of overlapping join requests ──────────────────────── */

  /**
   * An organization of two teams; two people each asking to join both: four open requests. A
   * person's close covers two of them, a team's close covers two, the organization's close covers
   * all four, so each pair of closes overlaps on at least two rows.
   */
  async function closeWorld(label: string) {
    const orgId = await makeOrg(label);
    const t1 = await makeTeam(`${label}-1`, orgId);
    const t2 = await makeTeam(`${label}-2`, orgId);
    const u1 = await makeUser(`req1-${label}`);
    const u2 = await makeUser(`req2-${label}`);
    const requests: Array<{ id: string; teamId: string; userId: string }> = [];
    for (const userId of [u1, u2]) {
      for (const teamId of [t1, t2]) {
        const row = await prisma.teamJoinRequest.create({
          data: { status: 'PENDING_TEAM', teamId, userId },
        });
        requests.push({ id: row.id, teamId, userId });
      }
    }
    return { orgId, requests, t1, t2, u1, u2 };
  }
  type CloseWorld = Awaited<ReturnType<typeof closeWorld>>;

  type Scope = 'org' | 'team' | 'user';
  const scopeRows = (w: CloseWorld, scope: Scope) =>
    scope === 'org'
      ? w.requests
      : scope === 'team'
        ? w.requests.filter((r) => r.teamId === w.t1)
        : w.requests.filter((r) => r.userId === w.u1);

  /** The close a deactivation of `scope` runs, in a transaction of its own. */
  const closeOf = (w: CloseWorld, scope: Scope) =>
    staged((tx) =>
      closeOpenJoinRequests(fastify, tx, {
        actor: null,
        scope:
          scope === 'org'
            ? { orgId: w.orgId, reason: 'ORGANIZATION_DEACTIVATED' }
            : scope === 'team'
              ? { reason: 'TEAM_DEACTIVATED', teamId: w.t1 }
              : { reason: 'REQUESTER_DEACTIVATED', userId: w.u1 },
      })
    );

  for (const [first, second] of [
    ['org', 'user'],
    ['user', 'org'],
    ['org', 'team'],
    ['team', 'org'],
  ] as const) {
    it(`settles a ${first} close and a ${second} close of overlapping requests, no deadlock`, async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const w = await closeWorld(`bulk-${first}-${second}-${i}`);
        const overlap = scopeRows(w, first)
          .filter((r) => scopeRows(w, second).some((o) => o.id === r.id))
          .map((r) => r.id)
          .sort();
        expect(overlap.length).toBeGreaterThanOrEqual(2);
        // The blocker holds the LAST shared row. A close that locks in ascending id order takes
        // the first shared row and waits here holding it; the other close then waits at the first
        // row holding nothing. A close that locked in another order could take the last row
        // first, and the pair would cross.
        const blocker = await holdRow('team_join_requests', overlap[overlap.length - 1] as string);
        const [a, b] = await race(blocker, [() => closeOf(w, first), () => closeOf(w, second)]);
        const rows = await runUnscoped(
          'test fixture: the requests of one world',
          ['TeamJoinRequest'],
          () =>
            prisma.teamJoinRequest.findMany({ where: { id: { in: w.requests.map((r) => r.id) } } })
        );
        // Every request either close covers is closed once, and the two counts add up to the
        // requests of the union: a request is never closed twice and none is left open.
        const union = new Set([...scopeRows(w, first), ...scopeRows(w, second)].map((r) => r.id));
        const closed = rows.filter(
          (r) => !(OPEN_JOIN_REQUEST_STATUSES as readonly string[]).includes(r.status)
        );
        expect(new Set(closed.map((r) => r.id))).toEqual(union);
        expect((a as number) + (b as number)).toBe(union.size);
      }
    }, 120_000);
  }

  it('control: two statements that lock the same two rows in opposite orders do deadlock', async () => {
    // What an unordered `UPDATE … WHERE <scope>` does when two plans read the rows differently:
    // this is the failure the harness has to be able to see, or the cases above prove nothing.
    const w = await closeWorld('bulk-control');
    const [x, y] = scopeRows(w, 'user')
      .map((r) => r.id)
      .sort() as [string, string];
    const lockRow = (tx: Prisma.TransactionClient, id: string) =>
      // CLAUDE.md §7 exception: the control's row lock, written the way an unordered scan takes it.
      tx.$executeRawUnsafe(`SELECT 1 FROM team_join_requests WHERE id = '${id}'::uuid FOR UPDATE`);
    let aHoldsX!: () => void;
    let bHoldsY!: () => void;
    const aHas = new Promise<void>((resolve) => {
      aHoldsX = resolve;
    });
    const bHas = new Promise<void>((resolve) => {
      bHoldsY = resolve;
    });
    const a = settle(
      prisma.$transaction(async (tx) => {
        await lockRow(tx, x);
        aHoldsX();
        await bHas;
        await lockRow(tx, y);
      })
    );
    const b = settle(
      prisma.$transaction(async (tx) => {
        await aHas;
        await lockRow(tx, y);
        bHoldsY();
        await lockRow(tx, x);
      })
    );
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => !r.ok && isDeadlock(r.error)).length).toBe(1);
  }, 60_000);

  it('locks the matching rows in ascending id order and returns them', async () => {
    const w = await closeWorld('bulk-order');
    const ids = await prisma.$transaction((tx) =>
      lockOpenJoinRequests(tx, { orgId: w.orgId }, OPEN_JOIN_REQUEST_STATUSES)
    );
    expect(ids).toEqual(w.requests.map((r) => r.id).sort());
    expect(
      await prisma.$transaction((tx) => lockOpenJoinRequests(tx, { userId: w.u2 }, ['PENDING_ORG']))
    ).toEqual([]);
  });

  /* ── 2. Repository moves, share edits, the service principal and the device ── */

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** `PATCH /repositories/:id` moving the repository to `teamId`, as a platform administrator. */
  const move = (w: RepoWorld, teamId: string) =>
    asOp(
      app
        .inject({
          headers: bearer(platformAdmin),
          method: 'PATCH',
          payload: { teamId },
          url: `/api/v1/repositories/${w.repoId}`,
        })
        .then((res) => {
          if (res.statusCode >= 500) {
            throw new Error(`move failed ${res.statusCode}: ${res.body}`);
          }
          return res.statusCode;
        })
    );

  /** `PUT /repositories/:id/shares` replacing the shares with `teamIds`. */
  const share = (w: RepoWorld, teamIds: string[]) =>
    asOp(
      app
        .inject({
          headers: bearer(platformAdmin),
          method: 'PUT',
          payload: { teamIds },
          url: `/api/v1/repositories/${w.repoId}/shares`,
        })
        .then((res) => {
          if (res.statusCode >= 500) {
            throw new Error(`share failed ${res.statusCode}: ${res.body}`);
          }
          return res.statusCode;
        })
    );

  it('settles a launch and a repository move, in either order, no deadlock', async () => {
    for (const first of ['launch', 'move'] as const) {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const w = await repoWorld(`move-${first}-${i}`);
        // Move first: the blocker holds the destination team, so the move takes the connection and
        // waits for the foreign key check of the new owner, holding the connection, and the launch
        // queues for the connection. Launch first: the blocker holds the repository's own team,
        // so the launch holds the user and the connection while it waits, and the move queues.
        const blocker = await holdRow('teams', first === 'move' ? w.otherTeamId : w.teamId);
        const [a, b] = await race(
          blocker,
          first === 'move'
            ? [() => move(w, w.otherTeamId), () => launch(w)]
            : [() => launch(w), () => move(w, w.otherTeamId)]
        );
        const [moved, launched] = first === 'move' ? [a, b] : [b, a];
        expect(moved).toBe(200);
        // The launch ran before the move (the old owner) or after it (refused: the repository is
        // no longer where the launch was authorized).
        expect([w.teamId, undefined]).toContain((launched as { teamId?: string } | null)?.teamId);
        expect(
          (await prisma.connection.findUniqueOrThrow({ where: { id: w.repoId } })).teamId
        ).toBe(w.otherTeamId);
      }
    }
  }, 120_000);

  it('settles a launch and a share edit, in either order, no deadlock', async () => {
    for (const first of ['launch', 'share'] as const) {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const w = await repoWorld(`share-${first}-${i}`);
        const blocker = await holdRow('teams', first === 'share' ? w.otherTeamId : w.teamId);
        const [a, b] = await race(
          blocker,
          first === 'share'
            ? [() => share(w, [w.otherTeamId]), () => launch(w)]
            : [() => launch(w), () => share(w, [w.otherTeamId])]
        );
        const [shared, launched] = first === 'share' ? [a, b] : [b, a];
        expect(shared).toBe(200);
        expect(launched).toMatchObject({ teamId: w.teamId });
        expect(
          await runUnscoped('test fixture: shares of one repository', ['ConnectionTeamShare'], () =>
            prisma.connectionTeamShare.count({
              where: { connectionId: w.repoId, teamId: w.otherTeamId },
            })
          )
        ).toBe(1);
      }
    }
  }, 120_000);

  it('settles a principal’s launch, a person’s launch and a principal edit, in each order', async () => {
    const orders: Array<Array<'principal' | 'person' | 'edit'>> = [
      ['principal', 'person', 'edit'],
      ['person', 'principal', 'edit'],
      ['principal', 'edit', 'person'],
    ];
    for (const order of orders) {
      for (let i = 0; i < 3; i += 1) {
        const w = await repoWorld(`sp-${order.join('-')}-${i}`);
        const principalId = await makePrincipal(w);
        // Held team row: whoever gets the connection first is the one the others queue behind.
        const blocker = await holdRow('teams', w.teamId);
        const starts = {
          edit: () =>
            staged(async (tx) => {
              await lockServicePrincipal(tx, principalId);
              await tx.servicePrincipal.update({
                data: { maxInFlight: 7 },
                where: { id: principalId },
              });
            }),
          person: () => launch(w),
          principal: () => principalLaunch(w, principalId),
        };
        const results = await race(
          blocker,
          order.map((kind) => starts[kind])
        );
        const byKind = Object.fromEntries(order.map((kind, index) => [kind, results[index]]));
        expect(byKind.principal).toBeNull();
        expect(byKind.person).toMatchObject({ teamId: w.teamId });
        expect(
          (await prisma.servicePrincipal.findUniqueOrThrow({ where: { id: principalId } }))
            .maxInFlight
        ).toBe(7);
      }
    }
  }, 120_000);

  it('settles a principal’s launch that carries an acting user and that user’s own launch', async () => {
    for (const first of ['principal', 'person'] as const) {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const w = await repoWorld(`sp-actor-${first}-${i}`);
        const principalId = await makePrincipal(w);
        const blocker = await holdRow('teams', w.teamId);
        const ops = [() => principalLaunch(w, principalId, w.member), () => launch(w)];
        await race(blocker, first === 'principal' ? ops : [...ops].reverse());
      }
    }
  }, 120_000);

  it('settles a principal’s launch and a repository move, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await repoWorld(`sp-move-${i}`);
      const principalId = await makePrincipal(w);
      const blocker = await holdRow('teams', w.otherTeamId);
      const [moved] = await race(blocker, [
        () => move(w, w.otherTeamId),
        () => principalLaunch(w, principalId),
      ]);
      expect(moved).toBe(200);
    }
  }, 120_000);

  /* ── The orchestration wake and a spawn ───────────────────────────────────── */

  /** The row an orchestration's wake and a spawn both lock last (level 6). */
  const lockOrchestration = (tx: Prisma.TransactionClient, id: string) =>
    // CLAUDE.md §7 exception: the orchestration's row lock, as the wake and the spawn take it.
    tx.$executeRawUnsafe(`SELECT 1 FROM orchestrations WHERE id = '${id}'::uuid FOR UPDATE`);

  async function orchestrationWorld(label: string) {
    const w = await repoWorld(label);
    const principalId = await makePrincipal(w);
    const orchestration = await prisma.orchestration.create({
      data: {
        allowlist: ['implementer'],
        repoAttachedAt: new Date(),
        repoId: w.repoId,
        serviceId: principalId,
        teamId: w.teamId,
        title: name(label),
      },
    });
    orchestrationIds.push(orchestration.id);
    return { ...w, orchestrationId: orchestration.id, principalId };
  }

  /** A spawn: the launch's source locks, then the orchestration's row (the child's write). */
  const spawn = (w: Awaited<ReturnType<typeof orchestrationWorld>>) =>
    staged(async (tx) => {
      await lockLauncherRuns(tx, w.member);
      await lockLaunchSources(tx, { repos: [w.repo] }, { actor: { role: 'USER', sub: w.member } });
      await lockOrchestration(tx, w.orchestrationId);
    });

  /** The wake of a service principal's orchestration, in the order `prepareWake` takes its locks. */
  const wake = (w: Awaited<ReturnType<typeof orchestrationWorld>>) =>
    staged(async (tx) => {
      await lockServiceLaunch(tx, w.principalId, w.repoId);
      await lockOrchestration(tx, w.orchestrationId);
    });

  /** The wake as it was: the orchestration's row first, the guard's locks after it. */
  const wakeBackwards = (w: Awaited<ReturnType<typeof orchestrationWorld>>) =>
    staged(async (tx) => {
      await lockOrchestration(tx, w.orchestrationId);
      await lockServiceLaunch(tx, w.principalId, w.repoId);
    });

  it('settles a wake and a spawn of one orchestration, spawn first, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await orchestrationWorld(`wake-spawn-${i}`);
      // The spawn holds the connection while it waits for the team; the wake queues for it.
      await race(await holdRow('teams', w.teamId), [() => spawn(w), () => wake(w)]);
    }
  }, 120_000);

  it('settles a wake and a spawn of one orchestration, wake first, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await orchestrationWorld(`wake-wake-${i}`);
      // The wake holds the principal and the connection while it waits for the orchestration's
      // row; the spawn queues for the connection.
      await race(await holdRow('orchestrations', w.orchestrationId), [
        () => wake(w),
        () => spawn(w),
      ]);
    }
  }, 120_000);

  it('control: a wake that takes the orchestration before the guard’s locks deadlocks with a spawn', async () => {
    const w = await orchestrationWorld('wake-control');
    const blocker = await holdRow('teams', w.teamId);
    // The spawn holds the connection and waits for the team; the backwards wake holds the
    // orchestration and waits for the connection; when the team frees, the spawn needs the
    // orchestration. One of them is aborted by the database.
    const running: Array<ReturnType<typeof spawn>> = [];
    try {
      // One after the other, each seen waiting, so the spawn certainly holds the connection first.
      for (const start of [() => spawn(w), () => wakeBackwards(w)]) {
        const op = start();
        running.push(op);
        await op.started;
        await until(
          `control operation ${running.length} waits`,
          async () => (await waitingBehind(blocker.pid)) >= running.length
        );
      }
    } finally {
      await blocker.release();
    }
    const settled = await Promise.all(running.map((op) => op.result));
    expect(settled.filter((r) => !r.ok && isDeadlock(r.error)).length).toBe(1);
  }, 60_000);

  const settings = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: the global MCP switches', ['ConfigSetting'], fn);

  /* ── The device approval ──────────────────────────────────────────────────── */

  it('approves a device code under the user row without blocking a membership insert, and queues behind a launch', async () => {
    const w = await repoWorld('device');
    const MCP_RESOURCE = 'https://mcp.lock-sites.test/mcp';
    const saved = await settings(() =>
      prisma.configSetting.findMany({
        where: { key: { in: ['mcp.enabled', 'mcp.deviceFlowEnabled'] }, scope: 'GLOBAL' },
      })
    );
    const clientId = name('client');
    const userCode = `ls${suffix}`.toUpperCase();
    const code = await prisma.deviceCode.create({
      data: {
        deviceCode: name('device'),
        expiresAt: new Date(Date.now() + 600_000),
        oauthClientId: clientId,
        resources: [MCP_RESOURCE],
        scope: 'mcp:read',
        status: 'pending',
        userCode,
        userId: w.member,
      },
    });
    await prisma.oauthClient.create({
      data: {
        clientId,
        contacts: [],
        grantTypes: [],
        postLogoutRedirectUris: [],
        redirectUris: [],
        responseTypes: [],
        scopes: ['mcp:read'],
      },
    });
    for (const key of ['mcp.enabled', 'mcp.deviceFlowEnabled']) {
      const existing = saved.find((s) => s.key === key);
      if (existing) {
        await settings(() =>
          prisma.configSetting.update({ data: { value: true }, where: { id: existing.id } })
        );
      } else {
        await settings(() =>
          prisma.configSetting.create({ data: { key, scope: 'GLOBAL', value: true } })
        );
      }
    }
    invalidateSettingsCache();
    signedIn.userId = w.member;
    const approve = () => {
      const result = { body: undefined as unknown, status: 200 };
      const reply = {
        header: () => reply,
        send: (body: unknown) => {
          result.body = body;
          return reply;
        },
        status: (code2: number) => {
          result.status = code2;
          return reply;
        },
      };
      return approveMcpDevice(
        {
          body: { userCode },
          headers: {
            origin: process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:3000',
          },
          id: 'req-lock-sites',
          ip: '127.0.0.1',
          log: { error: () => undefined },
          method: 'POST',
        } as never,
        reply as never
      ).then(() => result);
    };
    // The approval holds the user row while it waits for the device code row (the blocker): a
    // membership insert for that user, whose foreign key check wants a share lock on the same row,
    // must still go through, which a `FOR UPDATE` on the user row would refuse.
    const blocker = await holdRow('device_codes', code.id);
    let approving: Promise<Settled<{ status: number }>> | undefined;
    try {
      approving = settle(approve());
      await until(
        'the approval waits for the device code',
        async () => (await waitingBehind(blocker.pid)) >= 1
      );
      await Promise.race([
        onTeam(w.member, w.otherTeamId),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('the membership insert waited for the approval')),
            10_000
          )
        ),
      ]);
      // A launch by the same user queues behind the approval (both take the row), and settles.
      const launching = launch(w);
      await launching.started;
      await until(
        'the launch waits behind the approval',
        async () => (await waitingBehind(blocker.pid)) >= 2
      );
      await blocker.release();
      const [approved, launched] = await Promise.all([approving, launching.result]);
      expectNoDeadlock(approved, launched);
      expect(approved.ok && approved.value.status).toBe(200);
      expect(launched.ok && launched.value).toMatchObject({ teamId: w.teamId });
      expect((await prisma.deviceCode.findUniqueOrThrow({ where: { id: code.id } })).status).toBe(
        'approved'
      );
    } finally {
      await blocker.release().catch(() => undefined);
      await approving;
      await prisma.deviceCode.deleteMany({ where: { id: code.id } });
      await prisma.oauthConsent.deleteMany({ where: { clientId } });
      await prisma.oauthClient.deleteMany({ where: { clientId } });
      for (const key of ['mcp.enabled', 'mcp.deviceFlowEnabled']) {
        const existing = saved.find((s) => s.key === key);
        if (existing) {
          await settings(() =>
            prisma.configSetting.update({
              data: { value: existing.value as never },
              where: { id: existing.id },
            })
          );
        } else {
          await settings(() =>
            prisma.configSetting.deleteMany({ where: { key, scope: 'GLOBAL' } })
          );
        }
      }
      invalidateSettingsCache();
    }
  }, 60_000);
});
