import { describe, expect, it, vi } from 'vitest';
import { MAX_LAUNCHER_RUNS, resolveLauncherSet } from './prLauncher.js';

type UserRow = { githubLogin: string | null; githubLoginAccountId: string | null };

const REPO = 'repo-1';
const WORK = 'work-1';
const WF = 'eng-acme-widgets-JIRA-1';

type Setup = {
  runs?: { launchedById: string | null }[];
  requester?: { requestedById: string | null; requestedByServiceId: string | null } | null;
  users?: Record<string, UserRow>;
};

/**
 * A stand-in for the three reads. Each asserts the `where` it is called with, so a lookup that
 * resolves the wrong person (the pull request's author, say) cannot pass by being handed a row.
 */
function dbWith(setup: Setup) {
  const findRuns = vi.fn(
    async (args: { take: number; where: { OR: Record<string, unknown>[] } }) => {
      expect(args.where.OR).toEqual([
        { id: 'run-stamped' },
        { workflowId: WF },
        { OR: [{ connectionId: null }, { connectionId: REPO }], workRequestId: WORK },
      ]);
      return (setup.runs ?? []).slice(0, args.take);
    }
  );
  const findRequest = vi.fn(async (args: { where: { id: string } }) => {
    expect(args.where).toEqual({ id: WORK });
    return setup.requester ?? null;
  });
  const findUsers = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.flatMap((id) => {
      const row = setup.users?.[id];
      return row ? [{ id, ...row }] : [];
    })
  );
  return {
    db: {
      runInput: { findUnique: findRequest },
      user: { findMany: findUsers },
      workflowRun: { findMany: findRuns },
    } as never,
    findRequest,
    findRuns,
    findUsers,
  };
}

const ARGS = {
  repoHost: 'github.com',
  repoId: REPO,
  runId: 'run-stamped',
  temporalWorkflowId: WF,
  workRequestId: WORK,
};

const X: UserRow = { githubLogin: 'Octo-Cat', githubLoginAccountId: '583231' };
const Y: UserRow = { githubLogin: 'Bee-Hive', githubLoginAccountId: '777' };

describe('resolveLauncherSet', () => {
  it('resolves a human launcher who is also the requester (one member)', async () => {
    const { db, findUsers } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: X },
    });
    expect(await resolveLauncherSet(db, ARGS)).toEqual({
      ids: new Set(['583231']),
      logins: new Set(['octo-cat']),
      members: 1,
      requesterId: 'x',
      resolved: true,
    });
    expect(findUsers.mock.calls[0]?.[0].where.id.in).toEqual(['x']);
  });

  it('excludes the launchers of every run of the work, and the requester, once a re-run took the stamp', async () => {
    // The stamped run (Y's re-run) is the newest; X launched the original; Z asked for the work.
    const { db, findUsers } = dbWith({
      requester: { requestedById: 'z', requestedByServiceId: null },
      runs: [{ launchedById: 'y' }, { launchedById: 'x' }],
      users: { x: X, y: Y, z: { githubLogin: 'zed', githubLoginAccountId: '9' } },
    });
    const set = await resolveLauncherSet(db, ARGS);
    expect(set).toEqual({
      ids: new Set(['583231', '777', '9']),
      logins: new Set(['octo-cat', 'bee-hive', 'zed']),
      members: 3,
      requesterId: 'z',
      resolved: true,
    });
    expect([...(findUsers.mock.calls[0]?.[0].where.id.in ?? [])].sort()).toEqual(['x', 'y', 'z']);
  });

  it('is unresolved when any run has no launcher, but keeps excluding the ones that resolved', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: null }, { launchedById: 'x' }],
      users: { x: X },
    });
    expect(await resolveLauncherSet(db, ARGS)).toEqual({
      ids: new Set(['583231']),
      logins: new Set(['octo-cat']),
      members: 2,
      requesterId: 'x',
      resolved: false,
    });
  });

  it.each([
    ['a service-principal requester', { requestedById: null, requestedByServiceId: 'svc' }],
    ['a request with no requester at all', { requestedById: null, requestedByServiceId: null }],
  ])('is unresolved for %s', async (_name, requester) => {
    const { db } = dbWith({ requester, runs: [{ launchedById: 'x' }], users: { x: X } });
    const set = await resolveLauncherSet(db, ARGS);
    expect(set.resolved).toBe(false);
    expect(set.ids).toEqual(new Set(['583231']));
  });

  it('is unresolved for an empty union', async () => {
    const { db } = dbWith({ requester: null, runs: [] });
    expect(await resolveLauncherSet(db, ARGS)).toEqual({
      ids: new Set(),
      logins: new Set(),
      members: 0,
      requesterId: null,
      resolved: false,
    });
  });

  it('is unresolved for a user row that does not exist', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'gone', requestedByServiceId: null },
      runs: [{ launchedById: 'gone' }],
      users: {},
    });
    expect(await resolveLauncherSet(db, ARGS)).toMatchObject({ members: 1, resolved: false });
  });

  it('is unresolved for a user who never linked GitHub', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: null, githubLoginAccountId: null } },
    });
    expect(await resolveLauncherSet(db, ARGS)).toMatchObject({ resolved: false });
  });

  it('excludes a login-only identity by login but never resolves it (no numeric id)', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: 'old-row', githubLoginAccountId: null } },
    });
    expect(await resolveLauncherSet(db, ARGS)).toEqual({
      ids: new Set(),
      logins: new Set(['old-row']),
      members: 1,
      requesterId: 'x',
      resolved: false,
    });
  });

  it('does not resolve an account id that is not numeric', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: 'x', githubLoginAccountId: 'github.com:not-a-number' } },
    });
    const set = await resolveLauncherSet(db, ARGS);
    expect(set.ids.size).toBe(0);
    expect(set.resolved).toBe(false);
  });

  it('treats a bare account id as github.com: it does not match an Enterprise Server repository', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: X },
    });
    expect(await resolveLauncherSet(db, { ...ARGS, repoHost: 'ghe.example.com' })).toEqual({
      ids: new Set(),
      logins: new Set(['octo-cat']),
      members: 1,
      requesterId: 'x',
      resolved: false,
    });
  });

  it('does not compare a github.com id against an Enterprise Server account of another host', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: 'ghes-user', githubLoginAccountId: 'other.example.com:991' } },
    });
    const set = await resolveLauncherSet(db, { ...ARGS, repoHost: 'ghe.example.com' });
    expect(set.ids.size).toBe(0);
    expect(set.logins).toEqual(new Set(['ghes-user']));
    expect(set.resolved).toBe(false);
  });

  it('matches by id when the account host is the repository host', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: 'ghes-user', githubLoginAccountId: 'ghe.example.com:991' } },
    });
    expect(await resolveLauncherSet(db, { ...ARGS, repoHost: 'ghe.example.com' })).toEqual({
      ids: new Set(['991']),
      logins: new Set(['ghes-user']),
      members: 1,
      requesterId: 'x',
      resolved: true,
    });
  });

  it('accepts an explicit github.com: prefix on github.com', async () => {
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: { githubLogin: 'a', githubLoginAccountId: 'github.com:5' } },
    });
    expect(await resolveLauncherSet(db, ARGS)).toMatchObject({
      ids: new Set(['5']),
      resolved: true,
    });
  });

  it('caps the set: more runs than the cap is unresolved', async () => {
    const runs = Array.from({ length: MAX_LAUNCHER_RUNS + 1 }, () => ({ launchedById: 'x' }));
    const { db, findRuns } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs,
      users: { x: X },
    });
    const set = await resolveLauncherSet(db, ARGS);
    expect(findRuns.mock.calls[0]?.[0].take).toBe(MAX_LAUNCHER_RUNS + 1);
    expect(set.resolved).toBe(false);
    expect(set.ids).toEqual(new Set(['583231']));
  });

  it('allows exactly the cap', async () => {
    const runs = Array.from({ length: MAX_LAUNCHER_RUNS }, () => ({ launchedById: 'x' }));
    const { db } = dbWith({
      requester: { requestedById: 'x', requestedByServiceId: null },
      runs,
      users: { x: X },
    });
    expect((await resolveLauncherSet(db, ARGS)).resolved).toBe(true);
  });

  it('with no run, workflow or work request to follow, reads nothing and is unresolved', async () => {
    const { db, findRuns, findRequest, findUsers } = dbWith({});
    const set = await resolveLauncherSet(db, {
      repoHost: 'github.com',
      repoId: REPO,
      runId: null,
      temporalWorkflowId: null,
      workRequestId: null,
    });
    expect(set).toMatchObject({ members: 0, resolved: false });
    expect(findRuns).not.toHaveBeenCalled();
    expect(findRequest).not.toHaveBeenCalled();
    expect(findUsers).not.toHaveBeenCalled();
  });

  it('exposes the work request requester, and null when the requester is not a user', async () => {
    const human = dbWith({
      requester: { requestedById: 'y', requestedByServiceId: null },
      runs: [{ launchedById: 'x' }],
      users: { x: X, y: Y },
    });
    expect((await resolveLauncherSet(human.db, ARGS)).requesterId).toBe('y');
    const service = dbWith({
      requester: { requestedById: null, requestedByServiceId: 'svc' },
      runs: [{ launchedById: 'x' }],
      users: { x: X },
    });
    expect((await resolveLauncherSet(service.db, ARGS)).requesterId).toBeNull();
    const none = dbWith({ runs: [{ launchedById: 'x' }], users: { x: X } });
    expect((await resolveLauncherSet(none.db, ARGS)).requesterId).toBeNull();
  });
});
