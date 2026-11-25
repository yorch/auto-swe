import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import { orgMembersRoutes } from '../routes/orgMembers.js';
import { orgTeamRoutes, teamRoutes } from '../routes/teams.js';
import { userRoutes } from '../routes/users.js';
import { changeOrganizationActive } from './organizationDeactivation.js';
import { DefaultTeamOrganizationInactive, updateWorkflowDefaults } from './systemConfigService.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  createJoinRequest,
  type Outcome,
} from './teamJoinRequests.js';
import { launchTrackedWorkflow, snapshotAuthorizedRepositorySource } from './workflowLaunch.js';

/**
 * The global lock order against real Postgres. A workflow launch, a join approval, a join request's
 * creation and a membership write all take row locks on the same user, connection, organization and
 * team rows; two of them deadlock (Postgres aborts one with `40P01`) unless every one takes them in
 * the order `lockOrder.ts` states. A mocked Prisma cannot show that, and neither can a test that
 * only runs one side, so each case here STAGES the interleaving: a blocker transaction holds one
 * row, the two real operations are started in a chosen order and each is seen waiting behind it
 * through `pg_blocking_pids`, and only then is the blocker released. No sleep decides the outcome.
 *
 * Every case must settle one way or the other (both finish, or one is refused) with no `40P01` and
 * no `P2034`, and leave nothing half-done: a request is `APPROVED` exactly when the membership
 * exists. Each runs many iterations, because a lock-order bug is a race.
 *
 * Opt in with `LOCK_ORDER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been run
 * against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.LOCK_ORDER_PG_TEST === '1';
const ITERATIONS = 12;

describe.skipIf(!enabled)('the global lock order against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `lo-${suffix}-${label}`;
  const fastify = { prisma } as unknown as FastifyInstance;
  const ctx = {};
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const connectionIds: string[] = [];
  let seq = 0;

  const actorOf = (id: string): JwtPayload => ({ exp: 0, iat: 0, role: 'USER', sub: id });

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
  const inOrg = (userId: string, orgId: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') =>
    prisma.organizationMembership.create({ data: { orgId, role, userId } });
  const onTeam = (userId: string, teamId: string, role: 'ADMIN' | 'LEAD' | 'MEMBER') =>
    prisma.teamMembership.create({ data: { role, teamId, userId } });

  let platformAdmin: string;
  let app: FastifyInstance;
  /** The workflow-defaults singleton and the 'default' organization as the suite found them. */
  let savedDefaults: { defaultTeamSlug: string } | null = null;
  let savedDefaultOrg: { id: string; isActive: boolean } | null = null;

  beforeAll(async () => {
    savedDefaults = await prisma.workflowDefaults.findUnique({
      select: { defaultTeamSlug: true },
      where: { id: 'default' },
    });
    savedDefaultOrg = await prisma.organization.findUnique({
      select: { id: true, isActive: true },
      where: { slug: 'default' },
    });
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
    await app.register(userRoutes, { prefix: '/api/v1/users' });
    await app.register(teamRoutes, { prefix: '/api/v1/teams' });
    await app.register(orgMembersRoutes, { prefix: '/api/v1/platform/organizations' });
    await app.register(orgTeamRoutes, { prefix: '/api/v1/platform/organizations' });
    await app.ready();
  });

  afterAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['Connection', 'OrganizationMembership', 'Team', 'TeamJoinRequest', 'TeamMembership'],
      async () => {
        await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
        // A team may sit in an organization the suite does not own (the seeded 'default' one), so
        // the teams it made are also deleted by id.
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
    // What the edge cases touched in the shared rows goes back as it was.
    if (savedDefaults) {
      await prisma.workflowDefaults.update({ data: savedDefaults, where: { id: 'default' } });
    } else {
      await prisma.workflowDefaults.deleteMany({ where: { id: 'default' } });
    }
    if (savedDefaultOrg) {
      await prisma.organization.update({
        data: { isActive: savedDefaultOrg.isActive },
        where: { id: savedDefaultOrg.id },
      });
    }
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
    invalidateSettingsCache();
    // Nothing of the suite may outlive it in a database other suites share: not a team, and not a
    // changed flag on the organization it borrowed.
    expect(
      await runUnscoped('test fixture: nothing of this suite is left', ['Team'], () =>
        prisma.team.count({ where: { slug: { startsWith: name('') } } })
      )
    ).toBe(0);
    if (savedDefaultOrg) {
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: savedDefaultOrg.id } }))
          .isActive
      ).toBe(savedDefaultOrg.isActive);
    }
  });

  /* ── Staging ─────────────────────────────────────────────────────────────── */

  async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
    // CLAUDE.md §7 exception: reads the server's own backend id, not application data.
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    return row?.pid ?? 0;
  }

  /**
   * How many backends wait, directly or through another waiter, on a lock that `holderPid` holds.
   * A second waiter on one row queues behind the first (a tuple lock), so it is blocked by the first
   * waiter and only transitively by the holder.
   */
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

  /** A deadlock or serialization failure, however Prisma wraps it. */
  function isDeadlock(error: unknown): boolean {
    const text = `${(error as { code?: string })?.code ?? ''} ${JSON.stringify(
      (error as { meta?: unknown })?.meta ?? ''
    )} ${(error as Error)?.message ?? ''}`;
    return /40P01|P2034|deadlock detected/i.test(text);
  }

  /** A transaction holding one row lock until `release()`, then committing. */
  async function holdRow(table: 'connections' | 'organizations' | 'teams', id: string) {
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

  /**
   * A transaction that runs `fn` and commits, on a backend whose pid is known once it has started.
   * It stands for a launch: the real lock sites are called inside it.
   */
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

  /** A launch of `repo` by `launcher`: the real lock site, in a transaction of its own. */
  const launch = (
    launcher: string,
    repo: { orgId: string; repoId: string; teamId: string },
    role: 'ADMIN' | 'USER' = 'USER'
  ) =>
    staged((tx) =>
      snapshotAuthorizedRepositorySource(tx, repo, { actor: { role, sub: launcher } })
    );

  /* ── Fixtures ────────────────────────────────────────────────────────────── */

  /**
   * An organization with a team led by `lead` (a member of the organization), a repository of the
   * team, and a requester with an open request: a member of the organization (the team step alone
   * approves) or of another one (the organization step follows).
   */
  async function world(label: string, requesterInOrg = true) {
    const orgId = await makeOrg(label);
    const otherOrg = await makeOrg(`${label}-other`);
    const teamId = await makeTeam(label, orgId);
    const repoId = await makeConnection(teamId);
    const lead = await makeUser(`lead-${label}`);
    await inOrg(lead, orgId);
    await onTeam(lead, teamId, 'LEAD');
    const orgAdmin = await makeUser(`org-admin-${label}`);
    await inOrg(orgAdmin, orgId, 'ADMIN');
    const requester = await makeUser(`req-${label}`);
    await inOrg(requester, requesterInOrg ? orgId : otherOrg);
    const created = await createJoinRequest(fastify, {
      actor: actorOf(requester),
      context: ctx,
      message: 'hi',
      teamId,
    });
    if (!created.ok) {
      throw new Error(`setup failed: ${created.code}`);
    }
    return {
      lead,
      orgAdmin,
      orgId,
      repo: { orgId, repoId, teamId },
      requester,
      requestId: created.request.id,
      teamId,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const approveTeam = (w: World, approver: string) =>
    approveAtTeamStep(fastify, {
      actor: actorOf(approver),
      context: ctx,
      requestId: w.requestId,
      role: undefined,
      teamId: w.teamId,
    });

  /** The approval of a request that waits at the organization step. */
  async function atOrgStep(w: World) {
    const first = await approveTeam(w, w.lead);
    if (!first.ok) {
      throw new Error(`setup failed: ${first.code}`);
    }
  }
  const approveOrg = (w: World) =>
    approveAtOrgStep(fastify, {
      actor: actorOf(w.orgAdmin),
      context: ctx,
      orgId: w.orgId,
      requestId: w.requestId,
    });

  /** Nothing half-done: the request is `APPROVED` exactly when the membership exists. */
  async function expectConsistent(w: World, approved: boolean) {
    const row = await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: w.requestId } });
    const member = await prisma.teamMembership.count({
      where: { teamId: w.teamId, userId: w.requester },
    });
    expect(row.status === 'APPROVED').toBe(approved);
    expect(member).toBe(approved ? 1 : 0);
  }

  /** What an operation did: it finished, or it was refused (never a deadlock). */
  function expectNoDeadlock(...results: Array<Settled<unknown>>) {
    for (const r of results) {
      if (!r.ok) {
        expect(isDeadlock(r.error), `a deadlock surfaced: ${String(r.error)}`).toBe(false);
        throw r.error;
      }
    }
  }

  /* ── Organization before team: the approval and the launch ───────────────── */

  /**
   * The blocker holds the organization row; the two operations queue behind it in the given order
   * and the blocker is released. A launch that takes the team before the organization and an
   * approval that takes the organization before the team deadlock when the approval is queued first.
   */
  async function raceOrgTeam(step: 'org' | 'team', first: 'approval' | 'launch') {
    const w = await world(`ot-${step}-${first}`, step === 'team');
    if (step === 'org') {
      await atOrgStep(w);
    }
    // The launcher is a member of the team and the organization, so the launch succeeds.
    const launcher = await makeUser('launcher');
    await inOrg(launcher, w.orgId);
    await onTeam(launcher, w.teamId, 'MEMBER');
    const blocker = await holdRow('organizations', w.orgId);

    const approval = () =>
      settle(step === 'org' ? approveOrg(w) : approveTeam(w, w.lead)) as Promise<
        Settled<Outcome<unknown>>
      >;
    let approving: Promise<Settled<Outcome<unknown>>> | undefined;
    let launching: ReturnType<typeof launch> | undefined;
    const startApproval = async (expected: number) => {
      approving = approval();
      await until(
        'the approval waits behind the blocker',
        async () => (await waitingBehind(blocker.pid)) >= expected
      );
    };
    const startLaunch = async (expected: number) => {
      launching = launch(launcher, w.repo);
      await launching.started;
      await until(
        'the launch waits behind the blocker',
        async () => (await waitingBehind(blocker.pid)) >= expected
      );
    };
    try {
      if (first === 'approval') {
        await startApproval(1);
        await startLaunch(2);
      } else {
        await startLaunch(1);
        await startApproval(2);
      }
    } finally {
      // Always let go, so a case that failed to stage cannot leave a transaction holding the row.
      await blocker.release();
    }
    const approved = await approving;
    const launched = await launching?.result;
    if (!approved || !launched) {
      throw new Error('not started');
    }
    expectNoDeadlock(approved, launched);
    expect(approved.ok && approved.value.ok).toBe(true);
    expect(launched.ok && launched.value).toMatchObject({ teamId: w.teamId });
    await expectConsistent(w, true);
  }

  for (const step of ['team', 'org'] as const) {
    for (const first of ['approval', 'launch'] as const) {
      it(`settles a launch and the ${step}-step approval of one team with no deadlock (${first} queued first)`, async () => {
        for (let i = 0; i < ITERATIONS; i += 1) {
          await raceOrgTeam(step, first);
        }
      }, 180_000);
    }
  }

  /* ── The user row: a launch holds the launcher's row while it waits for the team ── */

  /**
   * The blocker holds the repository's connection row. The launch (by `launcher`) takes the user
   * row and then waits for the connection, holding the user row; `other` then runs. An operation
   * that holds the team and needs a share lock on the launcher's user row (a foreign key to it) and
   * a launch that holds that row and waits for the team deadlock when the user row lock excludes it.
   */
  async function raceUserRow(
    w: World,
    launcher: string,
    other: () => Promise<unknown>,
    launcherRole: 'ADMIN' | 'USER' = 'USER'
  ) {
    const blocker = await holdRow('connections', w.repo.repoId);
    const launching = launch(launcher, w.repo, launcherRole);
    let operating: Promise<Settled<unknown>> | undefined;
    try {
      await launching.started;
      await until(
        'the launch waits behind the blocker',
        async () => (await waitingBehind(blocker.pid)) >= 1
      );
      operating = settle(other());
      // Either the operation finished without needing the launcher's row, or it waits for it.
      let finished = false;
      void operating.then(() => {
        finished = true;
      });
      await until(
        'the operation finished or waits for the launch',
        async () => finished || (await waitingBehind(launching.pid())) >= 1
      );
    } finally {
      await blocker.release();
    }
    const launched = await launching.result;
    const operated = await (operating as Promise<Settled<unknown>>);
    expectNoDeadlock(launched, operated);
    return { launched, operated };
  }

  it('settles a launch by the requester and the approval of their own request, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`ur-req-${i}`);
      const { operated } = await raceUserRow(w, w.requester, () => approveTeam(w, w.lead));
      expect(operated.ok && (operated.value as Outcome<unknown>).ok).toBe(true);
      await expectConsistent(w, true);
    }
  }, 180_000);

  it('settles a launch by the approver and an approval by them, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`ur-dec-${i}`);
      const { launched, operated } = await raceUserRow(w, w.lead, () => approveTeam(w, w.lead));
      expect(operated.ok && (operated.value as Outcome<unknown>).ok).toBe(true);
      expect(launched.ok && launched.value).toMatchObject({ teamId: w.teamId });
      await expectConsistent(w, true);
    }
  }, 180_000);

  it('settles a launch by the requester and the organization-step approval, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`ur-org-${i}`, false);
      await atOrgStep(w);
      const { operated } = await raceUserRow(w, w.requester, () => approveOrg(w));
      expect(operated.ok && (operated.value as Outcome<unknown>).ok).toBe(true);
      await expectConsistent(w, true);
    }
  }, 180_000);

  it('settles a launch by a person and the creation of that person’s own join request', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`ur-create-${i}`);
      const other = await makeTeam(`ur-create-other-${i}`, w.orgId);
      const { operated } = await raceUserRow(w, w.requester, () =>
        createJoinRequest(fastify, {
          actor: actorOf(w.requester),
          context: ctx,
          message: 'again',
          teamId: other,
        })
      );
      expect(operated.ok && (operated.value as Outcome<unknown>).ok).toBe(true);
    }
  }, 180_000);

  it('settles a launch by a person and their being added to the team by an administrator', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`ur-add-${i}`);
      const { operated } = await raceUserRow(w, w.requester, async () => {
        const res = await app.inject({
          headers: { authorization: `Bearer ${platformAdmin}` },
          method: 'POST',
          payload: { role: 'MEMBER', userId: w.requester },
          url: `/api/v1/teams/${w.teamId}/members`,
        });
        expect(res.statusCode).toBe(201);
        return res;
      });
      expect(operated.ok).toBe(true);
      expect(
        await prisma.teamMembership.count({ where: { teamId: w.teamId, userId: w.requester } })
      ).toBe(1);
    }
  }, 180_000);

  /* ── The deactivation of the launcher ────────────────────────────────────── */

  /**
   * A launch by `U` holds U's row and waits for the team; an approval of U's open request holds the
   * team and waits for the request row; the deactivation of U has closed that request and waits for
   * U's row. Taking the row first, the deactivation waits holding nothing, and the approval is not
   * behind it.
   */
  it('settles a launch by a person, the approval of their request and their deactivation', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = await world(`deact-${i}`);
      const blocker = await holdRow('connections', w.repo.repoId);
      let launching: ReturnType<typeof launch> | undefined;
      let deactivating: Promise<Settled<{ statusCode: number }>> | undefined;
      let approving: Promise<Settled<Outcome<unknown>>> | undefined;
      try {
        launching = launch(w.requester, w.repo);
        await launching.started;
        await until(
          'the launch waits behind the blocker',
          async () => (await waitingBehind(blocker.pid)) >= 1
        );
        deactivating = settle(
          app.inject({
            headers: { authorization: `Bearer ${platformAdmin}` },
            method: 'PATCH',
            payload: { isActive: false },
            url: `/api/v1/users/${w.requester}`,
          })
        );
        const launchPid = launching.pid();
        await until(
          'the deactivation waits for the launcher',
          async () => (await waitingBehind(launchPid)) >= 1
        );
        approving = settle(approveTeam(w, w.lead));
        let finished = false;
        void approving.then(() => {
          finished = true;
        });
        await until(
          'the approval finished or waits behind the deactivation',
          async () => finished || (await waitingBehind(launchPid)) >= 2
        );
      } finally {
        await blocker.release();
      }
      const launched = await launching.result;
      const deactivated = await deactivating;
      const approved = await approving;
      if (!deactivated || !approved) {
        throw new Error('not started');
      }
      expectNoDeadlock(launched, deactivated, approved);
      expect(deactivated.ok && deactivated.value.statusCode).toBe(200);
      const row = await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: w.requestId } });
      const member = await prisma.teamMembership.count({
        where: { teamId: w.teamId, userId: w.requester },
      });
      // Decided by the approval, or closed by the deactivation: never both, never neither.
      expect(row.status === 'APPROVED').toBe(member === 1);
      expect(['APPROVED', 'REJECTED']).toContain(row.status);
    }
  }, 180_000);

  /* ── An inactive organization ────────────────────────────────────────────── */

  const setActive = (orgId: string, isActive: boolean) =>
    prisma.organization.update({ data: { isActive }, where: { id: orgId } });
  const postAs = (userId: string, url: string, payload: Record<string, unknown>) =>
    app.inject({
      headers: { authorization: `Bearer ${userId}` },
      method: 'POST',
      payload,
      url,
    });
  const teamCount = (orgId: string) => prisma.team.count({ where: { orgId } });

  it('refuses an administrator creating a team in an inactive organization, on both routes', async () => {
    const orgId = await makeOrg('inactive-create');
    await setActive(orgId, false);
    const direct = await postAs(platformAdmin, '/api/v1/teams', {
      name: name('direct-refused'),
      orgId,
      slug: name('direct-refused'),
    });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('ORGANIZATION_INACTIVE');
    const viaOrg = await postAs(platformAdmin, `/api/v1/platform/organizations/${orgId}/teams`, {
      name: name('org-refused'),
      slug: name('org-refused'),
    });
    expect(viaOrg.statusCode).toBe(409);
    expect(viaOrg.json().error.code).toBe('ORGANIZATION_INACTIVE');
    expect(await teamCount(orgId)).toBe(0);

    // Active again, the same requests create the teams.
    await setActive(orgId, true);
    const created = await postAs(platformAdmin, '/api/v1/teams', {
      name: name('direct-ok'),
      orgId,
      slug: name('direct-ok'),
    });
    expect(created.statusCode).toBe(201);
    const createdViaOrg = await postAs(
      platformAdmin,
      `/api/v1/platform/organizations/${orgId}/teams`,
      { name: name('org-ok'), slug: name('org-ok') }
    );
    expect(createdViaOrg.statusCode).toBe(201);
    expect(await teamCount(orgId)).toBe(2);
  });

  it('settles a team creation and the organization’s deactivation, in either order', async () => {
    for (const first of ['deactivation', 'creation'] as const) {
      for (let i = 0; i < 4; i += 1) {
        const orgId = await makeOrg(`create-race-${first}-${i}`);
        const blocker = await holdRow('organizations', orgId);
        const deactivate = () =>
          settle(
            changeOrganizationActive(fastify, {
              actor: actorOf(platformAdmin),
              context: {},
              isActive: false,
              orgId,
            })
          );
        const create = () =>
          settle(
            postAs(platformAdmin, `/api/v1/platform/organizations/${orgId}/teams`, {
              name: name(`race-${first}-${i}`),
              slug: name(`race-${first}-${i}`),
            })
          );
        let deactivating: ReturnType<typeof deactivate> | undefined;
        let creating: ReturnType<typeof create> | undefined;
        try {
          if (first === 'deactivation') {
            deactivating = deactivate();
            await until(
              'the deactivation waits',
              async () => (await waitingBehind(blocker.pid)) >= 1
            );
            creating = create();
            await until('the creation waits', async () => (await waitingBehind(blocker.pid)) >= 2);
          } else {
            creating = create();
            await until('the creation waits', async () => (await waitingBehind(blocker.pid)) >= 1);
            deactivating = deactivate();
            await until(
              'the deactivation waits',
              async () => (await waitingBehind(blocker.pid)) >= 2
            );
          }
        } finally {
          await blocker.release();
        }
        const created = await creating;
        const deactivated = await deactivating;
        expectNoDeadlock(created as Settled<unknown>, deactivated as Settled<unknown>);
        expect(deactivated?.ok && deactivated.value.ok).toBe(true);
        const status = created?.ok ? created.value.statusCode : 0;
        // The one that took the lock first won: a team made before the deactivation exists, and one
        // asked for after it is refused and leaves nothing.
        expect(status).toBe(first === 'creation' ? 201 : 409);
        expect(await teamCount(orgId)).toBe(first === 'creation' ? 1 : 0);
      }
    }
  }, 120_000);

  it('refuses the fallback organization of POST /teams when it is inactive', async () => {
    // The route falls back to the organization with the slug 'default' when no `orgId` is sent.
    const fallbackId =
      savedDefaultOrg?.id ??
      (await (async () => {
        const created = await prisma.organization.create({
          data: { name: name('default-org'), slug: 'default' },
        });
        orgIds.push(created.id);
        return created.id;
      })());
    // The organization is shared (the seeded one when there is one): it goes back as it was found,
    // and the team made in it is removed, even when an assertion fails.
    const wasActive = savedDefaultOrg?.isActive ?? true;
    try {
      await setActive(fallbackId, false);
      const refused = await postAs(platformAdmin, '/api/v1/teams', {
        name: name('fallback-refused'),
        slug: name('fallback-refused'),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('ORGANIZATION_INACTIVE');
      expect(
        await prisma.team.findUnique({ where: { slug: name('fallback-refused') } })
      ).toBeNull();
      await setActive(fallbackId, true);
      const created = await postAs(platformAdmin, '/api/v1/teams', {
        name: name('fallback-ok'),
        slug: name('fallback-ok'),
      });
      if (created.statusCode === 201) {
        teamIds.push(created.json().data.id);
      }
      expect(created.statusCode).toBe(201);
      expect(created.json().data.orgId).toBe(fallbackId);
    } finally {
      await setActive(fallbackId, wasActive);
    }
  });

  const defaultSlug = () =>
    prisma.workflowDefaults
      .findUnique({ select: { defaultTeamSlug: true }, where: { id: 'default' } })
      .then((row) => row?.defaultTeamSlug ?? null);
  const resetDefaultSlug = () =>
    prisma.workflowDefaults.upsert({
      create: { defaultTeamSlug: savedDefaults?.defaultTeamSlug ?? 'default', id: 'default' },
      update: { defaultTeamSlug: savedDefaults?.defaultTeamSlug ?? 'default' },
      where: { id: 'default' },
    });

  it('refuses a default team that belongs to an inactive organization, and writes nothing', async () => {
    const closed = await makeOrg('defaults-closed');
    const open = await makeOrg('defaults-open');
    const closedTeam = await makeTeam('defaults-closed', closed);
    const openTeam = await makeTeam('defaults-open', open);
    const slugOf = async (teamId: string) =>
      (await prisma.team.findUniqueOrThrow({ select: { slug: true }, where: { id: teamId } })).slug;
    await resetDefaultSlug();
    const before = await defaultSlug();
    await setActive(closed, false);

    await expect(
      updateWorkflowDefaults(prisma, { defaultTeamSlug: await slugOf(closedTeam) })
    ).rejects.toBeInstanceOf(DefaultTeamOrganizationInactive);
    expect(await defaultSlug()).toBe(before);

    await updateWorkflowDefaults(prisma, { defaultTeamSlug: await slugOf(openTeam) });
    expect(await defaultSlug()).toBe(await slugOf(openTeam));
    // A slug that names no team is still accepted: sign-up logs the missing team, as it always did.
    await updateWorkflowDefaults(prisma, { defaultTeamSlug: name('no-such-team') });
    expect(await defaultSlug()).toBe(name('no-such-team'));
    // Other fields save whatever the default team's organization is.
    await updateWorkflowDefaults(prisma, { maxTddIterations: 5 });

    await setActive(closed, true);
    await updateWorkflowDefaults(prisma, { defaultTeamSlug: await slugOf(closedTeam) });
    expect(await defaultSlug()).toBe(await slugOf(closedTeam));
    await resetDefaultSlug();
  });

  it('settles saving a default team and deactivating its organization, in either order', async () => {
    for (const first of ['save', 'deactivation'] as const) {
      for (let i = 0; i < 4; i += 1) {
        await resetDefaultSlug();
        const orgId = await makeOrg(`defaults-race-${first}-${i}`);
        const teamId = await makeTeam(`defaults-race-${first}-${i}`, orgId);
        const slug = (
          await prisma.team.findUniqueOrThrow({ select: { slug: true }, where: { id: teamId } })
        ).slug;
        const blocker = await holdRow('organizations', orgId);
        const save = () => settle(updateWorkflowDefaults(prisma, { defaultTeamSlug: slug }));
        const deactivate = () =>
          settle(
            changeOrganizationActive(fastify, {
              actor: actorOf(platformAdmin),
              context: {},
              isActive: false,
              orgId,
            })
          );
        let saving: ReturnType<typeof save> | undefined;
        let deactivating: ReturnType<typeof deactivate> | undefined;
        try {
          if (first === 'save') {
            saving = save();
            await until('the save waits', async () => (await waitingBehind(blocker.pid)) >= 1);
            deactivating = deactivate();
            await until(
              'the deactivation waits',
              async () => (await waitingBehind(blocker.pid)) >= 2
            );
          } else {
            deactivating = deactivate();
            await until(
              'the deactivation waits',
              async () => (await waitingBehind(blocker.pid)) >= 1
            );
            saving = save();
            await until('the save waits', async () => (await waitingBehind(blocker.pid)) >= 2);
          }
        } finally {
          await blocker.release();
        }
        const saved = await saving;
        const deactivated = await deactivating;
        const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
        if (first === 'save') {
          // The save committed first: the organization now owns the default team and stays active.
          expect(saved?.ok).toBe(true);
          expect(deactivated?.ok && deactivated.value).toMatchObject({
            code: 'DEFAULT_ORGANIZATION',
            ok: false,
          });
          expect(org.isActive).toBe(true);
          expect(await defaultSlug()).toBe(slug);
        } else {
          // The deactivation committed first: the save is refused and the default is untouched.
          expect(deactivated?.ok && deactivated.value.ok).toBe(true);
          expect(!saved?.ok && saved?.error).toBeInstanceOf(DefaultTeamOrganizationInactive);
          expect(org.isActive).toBe(false);
          expect(await defaultSlug()).toBe(savedDefaults?.defaultTeamSlug ?? 'default');
        }
      }
    }
    await resetDefaultSlug();
  }, 120_000);

  /* ── Several repositories in one launch ──────────────────────────────────── */

  /**
   * Two launches of several repositories each, overlapping on one. Checking the repositories one
   * after another takes the second one's connection after the first one's organization and teams,
   * so the launch that wins the shared connection then waits for a team the other holds through its
   * own first repository. The launch takes every connection, then every organization, then every
   * team across all of its repositories, so the second launch waits at the connections.
   */
  it('settles two launches of several repositories that overlap on one, no deadlock', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const orgOne = await makeOrg(`multi-${i}`);
      const orgTwo = await makeOrg(`multi-${i}-b`);
      const teamA = await makeTeam(`multi-a-${i}`, orgOne);
      const teamB = await makeTeam(`multi-b-${i}`, orgTwo);
      const launcherOne = await makeUser('multi-one');
      const launcherTwo = await makeUser('multi-two');
      for (const user of [launcherOne, launcherTwo]) {
        await inOrg(user, orgOne);
        await inOrg(user, orgTwo);
        await onTeam(user, teamA, 'MEMBER');
        await onTeam(user, teamB, 'MEMBER');
      }
      // Three repositories in connection-id order: the first of team A (organization one), the
      // other two of team B (organization two).
      const made = [
        await makeConnection(teamB),
        await makeConnection(teamB),
        await makeConnection(teamB),
      ].sort();
      const [first, second, shared] = made as [string, string, string];
      await prisma.connection.update({ data: { teamId: teamA }, where: { id: first } });
      const source = (repoId: string, teamId: string) => ({
        orgId: teamId === teamA ? orgOne : orgTwo,
        repoId,
        teamId,
      });
      const launchOf = (user: string, repos: Array<ReturnType<typeof source>>) =>
        settle(
          launchTrackedWorkflow(
            fastify.prisma,
            { knowledgeSourceRepos: repos, temporalWorkflowId: `lo-${suffix}-${seq++}` },
            async () => undefined,
            { sourceAuthorization: { actor: { role: 'USER', sub: user } } }
          )
        );
      const blocker = await holdRow('connections', shared);
      let one: ReturnType<typeof launchOf> | undefined;
      let two: ReturnType<typeof launchOf> | undefined;
      try {
        one = launchOf(launcherOne, [source(first, teamA), source(shared, teamB)]);
        await until(
          'the first launch waits for the shared repository',
          async () => (await waitingBehind(blocker.pid)) >= 1
        );
        two = launchOf(launcherTwo, [source(second, teamB), source(shared, teamB)]);
        await until(
          'the second launch waits for the shared repository',
          async () => (await waitingBehind(blocker.pid)) >= 2
        );
      } finally {
        await blocker.release();
      }
      const results = [await one, await two] as Array<Settled<{ ok: boolean }>>;
      expectNoDeadlock(...results);
      for (const r of results) {
        expect(r.ok && r.value.ok).toBe(true);
      }
    }
  }, 180_000);
});
