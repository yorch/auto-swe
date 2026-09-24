import { describe, expect, it } from 'vitest';
import {
  buildWorkflowHumanStepVisibilityFilter,
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
}

interface RunShape {
  template: { teamId: string | null; members: string[] };
  /** The Slack channel's owning team, for a channel-assistant run. */
  channel: { teamId: string; members: string[] } | null;
  /** The run's own repository — set on an epic child. */
  connection: Repo | null;
  workRequest: {
    requestedById: string | null;
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
  const { team, ...rest } = where as { team?: Record<string, unknown> };
  if (Object.keys(rest).length > 0 || !team) {
    throw new Error(`unrecognised repository predicate: ${JSON.stringify(where)}`);
  }
  return matchesTeam(team, repo.members);
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
        const { team, ...rest } = v as { team?: Record<string, unknown> };
        if (Object.keys(rest).length > 0 || !team) {
          throw new Error(`unrecognised channel predicate: ${JSON.stringify(v)}`);
        }
        return run.channel !== null && matchesTeam(team, run.channel.members);
      }
      case 'connection':
        return matchesRepo(v, run.connection);
      case 'workRequest': {
        const wr = run.workRequest;
        if (!wr) {
          return false;
        }
        return Object.entries(v).every(([wk, wv]) => {
          if (wk === 'requestedById') {
            return wr.requestedById === wv;
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
