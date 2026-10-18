import { describe, expect, it } from 'vitest';
import {
  buildWorkflowHumanStepVisibilityFilter,
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from './runVisibility.js';

/**
 * The predicate is the whole authorization check for viewing, cancelling and
 * resolving the gates of a run, so it is evaluated here against run shapes
 * rather than only compared as a literal: a structural snapshot would pass a
 * term that matches far more than it looks like it does, which is exactly how
 * the "any run of a GLOBAL template" term got in.
 */

const ME = 'user-me';
const OTHER = 'user-other';
const MY_TEAM = 'team-mine';
const OTHER_TEAM = 'team-other';

interface Repo {
  teamId: string;
  members: string[];
  /** Members of each team the repository is shared with (`ConnectionTeamShare`). */
  sharedWith?: string[][];
  /** Users with a current GitHub read permission, for an enforcing access gate. Git repos only. */
  access?: string[];
}

interface RunShape {
  /** Who launched this execution — decides whose saved GitHub token it may use. */
  launchedById?: string | null;
  template: { teamId: string | null; members: string[] };
  /** The Slack channel's owning team, for a channel-assistant run. */
  channel: {
    teamId: string;
    members: string[];
    isPrivate?: boolean;
    /** Slack user ids in the channel's synced member list, and when it was synced. */
    slackMembers?: string[];
    membersSyncedAt?: Date | null;
  } | null;
  /** The run's own repository — set on an epic child. */
  connection: Repo | null;
  workRequest: {
    requestedById: string | null;
    /** Members of the team whose service principal requested it, when a machine did. */
    requestedByService?: { members: string[] } | null;
    repos: Repo[];
    connection: Repo | null;
    /** Epics and PRD runs; defaults to false. */
    isCrossRepo?: boolean;
  } | null;
}

// A deliberately small evaluator for the subset of Prisma's where-language the
// predicate uses. Anything it does not recognise throws, so a new term cannot
// silently evaluate to "match".
function matchesTeam(where: Record<string, unknown>, members: string[]): boolean {
  const { memberships, ...rest } = where as {
    memberships?: { some?: { userId?: string } };
  };
  if (Object.keys(rest).length > 0 || !memberships?.some?.userId) {
    throw new Error(`unrecognised team predicate: ${JSON.stringify(where)}`);
  }
  return members.includes(memberships.some.userId);
}

function matchesRepo(where: Record<string, unknown>, repo: Repo | null): boolean {
  if (!repo) {
    return false;
  }
  const keys = Object.keys(where);
  if (keys.length === 0) {
    // `permissionRequirement` with the gate off.
    return true;
  }
  const [key] = keys;
  const value = where[key as string];
  if (keys.length > 1) {
    throw new Error(`unrecognised repository predicate: ${JSON.stringify(where)}`);
  }
  switch (key) {
    case 'AND':
      return (value as Record<string, unknown>[]).every((w) => matchesRepo(w, repo));
    case 'OR':
      return (value as Record<string, unknown>[]).some((w) => matchesRepo(w, repo));
    case 'team':
      return matchesTeam(value as Record<string, unknown>, repo.members);
    case 'type':
      // Every repository here is a git repository.
      if (JSON.stringify(value) !== JSON.stringify({ not: 'git_repo' })) {
        throw new Error(`unrecognised repository predicate: ${JSON.stringify(where)}`);
      }
      return false;
    case 'repoAccess': {
      const { userId } = (value as { some: { userId: string } }).some;
      return (repo.access ?? []).includes(userId);
    }
    case 'shares': {
      const { team } = (value as { some: { team: Record<string, unknown> } }).some;
      return (repo.sharedWith ?? []).some((members) => matchesTeam(team, members));
    }
    default:
      throw new Error(`unrecognised repository predicate: ${JSON.stringify(where)}`);
  }
}

function matchesRun(where: Record<string, unknown>, run: RunShape): boolean {
  return Object.entries(where).every(([key, value]) => {
    const v = value as Record<string, unknown>;
    switch (key) {
      case 'OR':
        return (value as Record<string, unknown>[]).some((w) => matchesRun(w, run));
      case 'template': {
        const { team, ...rest } = v as { team?: Record<string, unknown> };
        if (Object.keys(rest).length > 0 || !team) {
          throw new Error(`unrecognised template predicate: ${JSON.stringify(v)}`);
        }
        return run.template.teamId !== null && matchesTeam(team, run.template.members);
      }
      case 'channel': {
        const { isPrivate, team, members, membersSyncedAt, ...rest } = v as {
          isPrivate?: boolean;
          team?: Record<string, unknown>;
          members?: { some?: { slackUserId?: string } };
          membersSyncedAt?: { gte?: Date };
        };
        const memberTerm = members !== undefined || membersSyncedAt !== undefined;
        if (
          Object.keys(rest).length > 0 ||
          !team ||
          typeof isPrivate !== 'boolean' ||
          (memberTerm &&
            (isPrivate !== true || !members?.some?.slackUserId || !membersSyncedAt?.gte))
        ) {
          throw new Error(`unrecognised channel predicate: ${JSON.stringify(v)}`);
        }
        const c = run.channel;
        if (c === null || (c.isPrivate ?? false) !== isPrivate || !matchesTeam(team, c.members)) {
          return false;
        }
        if (!memberTerm) {
          return true;
        }
        return (
          (c.slackMembers ?? []).includes(members?.some?.slackUserId as string) &&
          !!c.membersSyncedAt &&
          c.membersSyncedAt >= (membersSyncedAt?.gte as Date)
        );
      }
      case 'connection':
        return matchesRepo(v, run.connection);
      case 'connectionId':
        if (value !== null) {
          throw new Error(`unrecognised connectionId predicate: ${JSON.stringify(value)}`);
        }
        return run.connection === null;
      case 'launchedById':
        return run.launchedById === value;
      case 'workRequest': {
        const wr = run.workRequest;
        if (!wr) {
          return false;
        }
        return Object.entries(v).every(([wk, wv]) => {
          if (wk === 'requestedById') {
            return wr.requestedById === wv;
          }
          if (wk === 'connectionId') {
            if (wv !== null) {
              throw new Error(`unrecognised connectionId predicate: ${JSON.stringify(wv)}`);
            }
            return wr.connection === null;
          }
          if (wk === 'requestedByService') {
            const { team, ...rest } = wv as { team?: Record<string, unknown> };
            if (Object.keys(rest).length > 0 || !team) {
              throw new Error(`unrecognised requestedByService predicate: ${JSON.stringify(wv)}`);
            }
            return !!wr.requestedByService && matchesTeam(team, wr.requestedByService.members);
          }
          if (wk === 'isCrossRepo') {
            return (wr.isCrossRepo ?? false) === wv;
          }
          if (wk === 'connection') {
            return matchesRepo(wv as Record<string, unknown>, wr.connection);
          }
          if (wk === 'activeWorkflows') {
            const repoWhere = (wv as { some: { repository: Record<string, unknown> } }).some
              .repository;
            return wr.repos.some((r) => matchesRepo(repoWhere, r));
          }
          throw new Error(`unrecognised workRequest key: ${wk}`);
        });
      }
      default:
        throw new Error(`unrecognised run key: ${key}`);
    }
  });
}

const myRepo: Repo = { members: [ME], teamId: MY_TEAM };
const otherRepo: Repo = { members: [OTHER], teamId: OTHER_TEAM };
const globalTemplate = { members: [], teamId: null };

function run(overrides: Partial<RunShape> = {}): RunShape {
  return {
    channel: null,
    connection: null,
    template: globalTemplate,
    workRequest: { connection: null, repos: [otherRepo], requestedById: OTHER },
    ...overrides,
  };
}

const engineer = { role: 'ENGINEER', sub: ME };
const visible = (r: RunShape) =>
  matchesRun(buildWorkflowRunVisibilityFilter(engineer, undefined), r);

describe('runs a service principal requested', () => {
  const controls = (r: RunShape, gate?: Parameters<typeof buildWorkflowRunControlFilter>[1]) =>
    matchesRun(buildWorkflowRunControlFilter(engineer, gate), r);
  const byPrincipal = (members: string[], repo: Repo | null) =>
    run({
      workRequest: {
        connection: repo,
        repos: repo ? [repo] : [],
        requestedById: null,
        requestedByService: { members },
      },
    });

  it("reach the principal's team when they name no repository", () => {
    expect(visible(byPrincipal([ME], null))).toBe(true);
    expect(controls(byPrincipal([ME], null))).toBe(true);
    expect(visible(byPrincipal([OTHER], null))).toBe(false);
    expect(controls(byPrincipal([OTHER], null))).toBe(false);
  });

  it("do not reach the principal's team on a repository the member cannot reach", () => {
    // The principal's team is mine, but the repository is another team's.
    expect(visible(byPrincipal([ME], otherRepo))).toBe(false);
    expect(controls(byPrincipal([ME], otherRepo))).toBe(false);
  });

  it('follow the repository terms on a repository: shared teams see, owners control', () => {
    const sharedWithMe: Repo = { members: [OTHER], sharedWith: [[ME]], teamId: OTHER_TEAM };
    expect(visible(byPrincipal([ME], sharedWithMe))).toBe(true);
    expect(controls(byPrincipal([ME], sharedWithMe))).toBe(false);
    expect(controls(byPrincipal([ME], myRepo))).toBe(true);
  });

  it('are hidden under an enforcing gate from a member without a GitHub permission', () => {
    const gate = { mode: 'enforce' as const, staleAfterHours: 24 };
    const visibleUnderGate = (r: RunShape) =>
      matchesRun(buildWorkflowRunVisibilityFilter(engineer, gate), r);
    expect(visibleUnderGate(byPrincipal([ME], myRepo))).toBe(false);
    expect(controls(byPrincipal([ME], myRepo), gate)).toBe(false);
    const withAccess: Repo = { ...myRepo, access: [ME] };
    expect(visibleUnderGate(byPrincipal([ME], withAccess))).toBe(true);
    expect(controls(byPrincipal([ME], withAccess), gate)).toBe(true);
  });
});

describe('buildWorkflowRunVisibilityFilter', () => {
  it('ADMIN sees everything', () => {
    expect(buildWorkflowRunVisibilityFilter({ role: 'ADMIN', sub: ME }, undefined)).toEqual({});
  });

  it('does NOT expose another team’s run just because its template is GLOBAL', () => {
    expect(visible(run())).toBe(false);
  });

  it('shows a run on a repository of one of my teams', () => {
    expect(
      visible(run({ workRequest: { connection: null, repos: [myRepo], requestedById: OTHER } }))
    ).toBe(true);
  });

  it('shows a run whose generic connection belongs to one of my teams', () => {
    expect(
      visible(run({ workRequest: { connection: myRepo, repos: [], requestedById: OTHER } }))
    ).toBe(true);
  });

  it('shows a run I requested', () => {
    expect(
      visible(run({ workRequest: { connection: null, repos: [otherRepo], requestedById: ME } }))
    ).toBe(true);
  });

  it('shows a run of a template owned by one of my teams', () => {
    expect(visible(run({ template: { members: [ME], teamId: MY_TEAM } }))).toBe(true);
  });

  it('hides a run with no work request, channel or team template from non-admins', () => {
    expect(visible(run({ workRequest: null }))).toBe(false);
  });

  it('shows a channel-assistant run in a channel owned by one of my teams', () => {
    expect(visible(run({ channel: { members: [ME], teamId: MY_TEAM }, workRequest: null }))).toBe(
      true
    );
  });

  it('hides a channel-assistant run in a private channel of my team', () => {
    expect(
      visible(
        run({
          channel: { isPrivate: true, members: [ME], teamId: MY_TEAM },
          workRequest: null,
        })
      )
    ).toBe(false);
  });

  describe('a private channel I am in', () => {
    const linked = { role: 'ENGINEER', slackId: 'U-ME', sub: ME };
    const seenBy = (actor: typeof linked | typeof engineer, r: RunShape) =>
      matchesRun(buildWorkflowRunVisibilityFilter(actor, undefined), r);
    const privateRun = (channel: Partial<NonNullable<RunShape['channel']>>) =>
      run({
        channel: {
          isPrivate: true,
          members: [ME],
          membersSyncedAt: new Date(),
          slackMembers: ['U-ME'],
          teamId: MY_TEAM,
          ...channel,
        },
        workRequest: null,
      });

    it('shows its runs to a team member whose linked Slack account is in its fresh list', () => {
      expect(seenBy(linked, privateRun({}))).toBe(true);
    });

    it('hides them from a caller with no linked Slack account', () => {
      expect(seenBy(engineer, privateRun({}))).toBe(false);
    });

    it('hides them when the caller is not in the list', () => {
      expect(seenBy(linked, privateRun({ slackMembers: ['U-SOMEONE'] }))).toBe(false);
    });

    it('hides them when the list was never synced, or is stale', () => {
      expect(seenBy(linked, privateRun({ membersSyncedAt: null }))).toBe(false);
      const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
      expect(seenBy(linked, privateRun({ membersSyncedAt: old }))).toBe(false);
    });

    it('hides them from a channel member who is not on the owning team', () => {
      expect(seenBy(linked, privateRun({ members: [OTHER] }))).toBe(false);
    });
  });

  it('hides a channel-assistant run in another team’s channel', () => {
    expect(
      visible(run({ channel: { members: [OTHER], teamId: OTHER_TEAM }, workRequest: null }))
    ).toBe(false);
  });

  // An epic's children all link the epic's work request, and each child puts
  // its repository on a ledger row under it. Deciding through the work request
  // would hand a member of any one of the epic's teams every child.
  const epicWorkRequest = {
    connection: null,
    isCrossRepo: true,
    repos: [otherRepo, myRepo],
    requestedById: OTHER,
  };

  it('shows my team’s child of a shared epic', () => {
    expect(visible(run({ connection: myRepo, workRequest: epicWorkRequest }))).toBe(true);
  });

  it('hides another team’s child of the same epic, though my team has a child in it', () => {
    expect(visible(run({ connection: otherRepo, workRequest: epicWorkRequest }))).toBe(false);
  });

  it('hides every child of an epic whose repositories are all other teams’', () => {
    expect(
      visible(
        run({
          connection: otherRepo,
          workRequest: { ...epicWorkRequest, repos: [otherRepo] },
        })
      )
    ).toBe(false);
  });

  it('still shows a single-repository run through its ledger row', () => {
    expect(
      visible(
        run({
          workRequest: {
            connection: null,
            isCrossRepo: false,
            repos: [myRepo],
            requestedById: OTHER,
          },
        })
      )
    ).toBe(true);
  });

  // A PRD run records its primary repository as the work request's connection.
  it('shows a PRD run whose primary repository belongs to one of my teams', () => {
    expect(
      visible(run({ workRequest: { connection: myRepo, repos: [], requestedById: OTHER } }))
    ).toBe(true);
  });

  it('keeps showing a run I requested after I leave the team that owns its repository', () => {
    const formerRepo: Repo = { members: [], teamId: MY_TEAM };
    expect(
      visible(run({ workRequest: { connection: formerRepo, repos: [], requestedById: ME } }))
    ).toBe(true);
  });

  it('hides every shape from a user who is in none of the teams involved', () => {
    const stranger = { role: 'LEAD', sub: 'user-stranger' };
    const where = buildWorkflowRunVisibilityFilter(stranger, undefined);
    const shapes: RunShape[] = [
      run(),
      run({ channel: { members: [ME], teamId: MY_TEAM }, workRequest: null }),
      run({ template: { members: [ME], teamId: MY_TEAM } }),
      run({ workRequest: { connection: myRepo, repos: [myRepo], requestedById: ME } }),
      run({ connection: myRepo, workRequest: { ...epicWorkRequest, repos: [myRepo] } }),
    ];
    for (const shape of shapes) {
      expect(matchesRun(where, shape)).toBe(false);
    }
  });

  it('threads the permission gate into every repository term under enforce', () => {
    const where = buildWorkflowRunVisibilityFilter(engineer, {
      mode: 'enforce',
      staleAfterHours: 72,
    });
    const text = JSON.stringify(where);
    expect(text.match(/repoAccess/g)).toHaveLength(3);
  });
});

describe('buildWorkflowHumanStepVisibilityFilter', () => {
  it('nests the run predicate under `run`', () => {
    expect(buildWorkflowHumanStepVisibilityFilter(engineer, undefined)).toEqual({
      run: buildWorkflowRunVisibilityFilter(engineer, undefined),
    });
  });

  it('ADMIN sees every step', () => {
    expect(buildWorkflowHumanStepVisibilityFilter({ role: 'ADMIN', sub: ME }, undefined)).toEqual(
      {}
    );
  });
});

describe('run visibility versus run control', () => {
  it('lets a shared team see the owning team’s runs', () => {
    const filter = JSON.stringify(buildWorkflowRunVisibilityFilter(engineer, undefined));
    expect(filter).toContain('shares');
  });

  it('does not let a shared team cancel or answer the owning team’s runs', () => {
    // Control reaches repositories through the owning team only — plus the
    // runs the actor launched, so a shared-team member keeps control of theirs.
    const control = buildWorkflowRunControlFilter(engineer, undefined);
    expect(JSON.stringify(control)).not.toContain('shares');
    expect(control.OR).toContainEqual({ launchedById: ME });
    // Every engineering run uses a global built-in template; that alone must
    // not hand control of the run to every signed-in user.
    expect(control.OR).not.toContainEqual({ template: { teamId: null } });
  });

  it('leaves a platform admin unrestricted', () => {
    expect(buildWorkflowRunControlFilter({ role: 'ADMIN', sub: 'a' }, undefined)).toEqual({});
  });
});

describe('buildWorkflowRunControlFilter — evaluated against run shapes', () => {
  const controls = (r: RunShape) =>
    matchesRun(buildWorkflowRunControlFilter(engineer, undefined), r);
  const sharedWithMe: Repo = { members: [OTHER], sharedWith: [[ME]], teamId: OTHER_TEAM };
  const epicWorkRequest = {
    connection: null,
    isCrossRepo: true,
    repos: [otherRepo, myRepo],
    requestedById: OTHER,
  };

  it('does not hand control of another team’s run over because its template is GLOBAL', () => {
    expect(controls(run())).toBe(false);
  });

  it('lets the owning team control a run on its repository', () => {
    expect(
      controls(
        run({
          workRequest: {
            connection: null,
            isCrossRepo: false,
            repos: [myRepo],
            requestedById: OTHER,
          },
        })
      )
    ).toBe(true);
  });

  it('lets a team the repository is shared with SEE the run but not control it', () => {
    const onShared = run({
      workRequest: {
        connection: null,
        isCrossRepo: false,
        repos: [sharedWithMe],
        requestedById: OTHER,
      },
    });
    expect(visible(onShared)).toBe(true);
    expect(controls(onShared)).toBe(false);
  });

  it('keeps a shared-team member in control of the run they launched', () => {
    expect(
      controls(
        run({
          launchedById: ME,
          workRequest: {
            connection: null,
            isCrossRepo: false,
            repos: [sharedWithMe],
            requestedById: OTHER,
          },
        })
      )
    ).toBe(true);
  });

  it('lets a team control a run of a template it owns', () => {
    expect(controls(run({ template: { members: [ME], teamId: MY_TEAM } }))).toBe(true);
  });

  // The same shape that matters for visibility. Every child of an epic links
  // the epic's work request and puts its own repository on a ledger row under
  // it, so deciding through the work request hands control of every child to a
  // member of any one of the epic's teams.
  it('controls my team’s child of a shared epic', () => {
    expect(controls(run({ connection: myRepo, workRequest: epicWorkRequest }))).toBe(true);
  });

  it('does not control another team’s child of the same epic, though my team has a child in it', () => {
    expect(controls(run({ connection: otherRepo, workRequest: epicWorkRequest }))).toBe(false);
  });

  it('lets the primary repository’s team control a PRD run', () => {
    expect(
      controls(run({ workRequest: { connection: myRepo, repos: [], requestedById: OTHER } }))
    ).toBe(true);
  });

  it('gives a stranger control of nothing', () => {
    const stranger = { role: 'LEAD', sub: 'user-stranger' };
    const where = buildWorkflowRunControlFilter(stranger, undefined);
    for (const shape of [
      run(),
      run({ template: { members: [ME], teamId: MY_TEAM } }),
      run({ connection: myRepo, workRequest: epicWorkRequest }),
      run({ workRequest: { connection: myRepo, repos: [myRepo], requestedById: ME } }),
    ]) {
      expect(matchesRun(where, shape)).toBe(false);
    }
  });
});
