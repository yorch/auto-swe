import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn() },
    connection: { findMany: vi.fn(), findUnique: vi.fn() },
    runInput: { create: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
    workflowTemplate: { findFirst: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

// Phase B: stub the default-SWE-template resolver so the code-task tests don't drag
// in the templates activity's whole dependency chain (slackNotify, trackerSync, …).
const resolveGate = vi.fn(
  async (): Promise<{ mode: string; staleAfterHours: number } | null> => ({
    mode: 'off',
    staleAfterHours: 72,
  })
);
const decide = vi.fn(async () => ({ allowed: true, reason: 'permitted' }));

// Mocked at the gate + decision boundary, NOT at `decideSlackRepoAccess` — so
// these tests run the real shared helper and would notice it being wired up
// wrongly. The rest of the module comes through: `repoAccessDecision` builds its
// refusal messages from `LAUNCH_REFUSAL_MESSAGE` at load time, and a fake there
// would be the same drifting second copy.
//
// The raw resolver is replaced with a throw rather than left alone. Reading the
// gate through the unwrapped one is the bug this file guards against, and a
// working stub would let it pass silently.
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGate: () => {
    throw new Error('read the gate through resolveRepoAccessGateOrLastKnown, not the raw resolver');
  },
  resolveRepoAccessGateOrLastKnown: () => resolveGate(),
}));

// Only the decision is stubbed. The refusal messages come through unchanged,
// because a hand-copied map is a second definition that drifts: a new
// `RepoAccessRefusal` reason would reach the thread as `undefined` while the
// suite stayed green against the copy.
vi.mock('@auto-swe/shared/lib/repoAccessDecision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessDecision')>()),
  decideRepoAccess: (...a: unknown[]) => decide(...(a as [])),
}));

vi.mock('./templates.js', () => ({
  resolveTemplateForRepo: vi.fn(),
}));

// Temporal's `log` reads `Context.current()`, which throws outside a running
// activity — so it has to be stubbed for the process to survive, and stubbing it
// is also what lets the advisory adapter's argument order be asserted.
const warn = vi.fn();
vi.mock('@temporalio/activity', () => ({
  // `activityInfo` is stubbed even though nothing here calls it. This module is
  // mocked WHOLESALE, and `channelTask` reaches `lib/activityContext.ts` through
  // `./channelAssistant.js`, which imports it — so omitting it leaves a trap:
  // the first traced call added anywhere in that graph fails with something that
  // reads as a Temporal problem rather than a gap in this factory.
  activityInfo: () => ({
    activityType: 'createChannelCodeTaskRun',
    attempt: 1,
    workflowExecution: { runId: 'run-test', workflowId: 'wf-test' },
  }),
  log: { warn: (...a: unknown[]) => warn(...a) },
}));

import { prisma } from '@auto-swe/shared/db';
import {
  createChannelCodeTaskRun,
  createChannelTaskRun,
  isChannelOverBudgetForTask,
  isChannelTaskRefusal,
  resolveChannelRepo,
} from './channelTask.js';
import { resolveTemplateForRepo } from './templates.js';

const findTemplate = vi.mocked(prisma.workflowTemplate.findFirst);
const createRunInput = vi.mocked(prisma.runInput.create);
const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);
const findConnections = vi.mocked(prisma.connection.findMany);
const findUser = vi.mocked(prisma.user.findFirst);
const findConnection = vi.mocked(prisma.connection.findUnique);
const resolveTemplate = vi.mocked(resolveTemplateForRepo);

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls, not implementations — so a test that made the
  // logger throw would leave it throwing for every test after it.
  warn.mockReset();
  findTemplate.mockResolvedValue({ activeVersion: 1, id: 'tmpl-channel-task' } as never);
  createRunInput.mockResolvedValue({ id: 'runinput-1' } as never);
  resolveTemplate.mockResolvedValue({ templateId: 'tmpl-swe', templateVersion: 3 });
});

/** Build a `git_repo` connection row as `prisma.connection.findMany` returns it. */
function gitRepo(id: string, org: string, repo: string) {
  return { id, organizationName: org, repoName: repo, type: 'git_repo' };
}

describe('createChannelTaskRun', () => {
  const INPUT = {
    channelId: 'chan-1',
    description: 'Investigate the flaky test and summarise the root cause.',
    requesterSlackId: 'U123',
    slackChannelId: 'C123',
    threadTs: '111.222',
    title: 'Investigate flaky test',
  };

  it('builds a deterministic per-thread workflowId (sanitized)', async () => {
    const result = await createChannelTaskRun(INPUT);

    // chantask-<channelId>-<threadTs> with `.` sanitized to `-`.
    expect(result.workflowId).toBe('chantask-chan-1-111-222');
  });

  it('creates a RunInput threading the Slack channel + thread for result reporting', async () => {
    await createChannelTaskRun(INPUT);

    expect(createRunInput).toHaveBeenCalledTimes(1);
    const data = createRunInput.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      slackChannelId: 'C123',
      slackMessageTs: '111.222',
      templateId: 'tmpl-channel-task',
      templateVersion: 1,
    });
    // payload carries the channel context used by finalize to accrue + report.
    expect(data.payload).toMatchObject({
      channelId: 'chan-1',
      kind: 'channel-task',
      slackChannelId: 'C123',
      threadTs: '111.222',
    });
  });

  it('returns a repo-less request carrying channelId + the RunInput id', async () => {
    const { request, templateId, templateVersion } = await createChannelTaskRun(INPUT);

    expect(templateId).toBe('tmpl-channel-task');
    expect(templateVersion).toBe(1);
    expect(request).toMatchObject({
      channelId: 'chan-1',
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      // Sentinel: Channel Task spec is repo-less.
      repoId: '',
      slackChannel: '111.222',
      workRequestId: 'runinput-1',
    });
  });

  it('throws when the Channel Task template is not seeded', async () => {
    findTemplate.mockResolvedValue(null);

    await expect(createChannelTaskRun(INPUT)).rejects.toThrow(/Channel Task/);
  });

  describe('runAt (Gap D deferral) validation', () => {
    it('carries runAt when it is a valid FUTURE ISO timestamp', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const result = await createChannelTaskRun({ ...INPUT, runAt: future });

      expect(result.runAt).toBe(future);
    });

    it('drops a PAST runAt so the task runs immediately', async () => {
      const past = new Date(Date.now() - 60 * 1000).toISOString();

      const result = await createChannelTaskRun({ ...INPUT, runAt: past });

      expect(result.runAt).toBeUndefined();
    });

    it('drops a garbled (non-ISO) runAt rather than mis-scheduling', async () => {
      const result = await createChannelTaskRun({ ...INPUT, runAt: 'tomorrow at 9am' });

      expect(result.runAt).toBeUndefined();
    });

    it('leaves runAt unset when none is provided (immediate)', async () => {
      const result = await createChannelTaskRun(INPUT);

      expect(result.runAt).toBeUndefined();
    });
  });
});

describe('resolveChannelRepo', () => {
  beforeEach(() => {
    findChannel.mockResolvedValue({ teamId: 'team-1' } as never);
  });

  it('matches a repoHint by bare repoName (case-insensitive)', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    expect(await resolveChannelRepo('chan-1', 'Payments-API')).toEqual({ repoId: 'c-1' });
  });

  it('matches a repoHint by organizationName/repoName', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'other', 'payments-api'),
    ] as never);

    expect(await resolveChannelRepo('chan-1', 'other/payments-api')).toEqual({ repoId: 'c-2' });
  });

  it('auto-resolves the sole repo when the team has exactly one and NO hint was given', async () => {
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);

    expect(await resolveChannelRepo('chan-1')).toEqual({ repoId: 'c-1' });
  });

  it('returns null when an explicit hint does NOT match (even with a sole repo)', async () => {
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);

    // A named-but-unmatched repo must NOT silently open a PR against an unrelated
    // repo — fall back to the general route instead.
    expect(await resolveChannelRepo('chan-1', 'nope')).toBeNull();
  });

  it('returns null when ambiguous: multiple repos and no matching hint', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    expect(await resolveChannelRepo('chan-1')).toBeNull();
    expect(await resolveChannelRepo('chan-1', 'unknown-repo')).toBeNull();
  });

  it('returns null when the team has no active git_repo connection', async () => {
    findConnections.mockResolvedValue([] as never);

    expect(await resolveChannelRepo('chan-1', 'payments-api')).toBeNull();
  });

  it('ignores git rows missing org/repo identity (guard)', async () => {
    findConnections.mockResolvedValue([
      { id: 'c-bad', organizationName: null, repoName: null, type: 'git_repo' },
      gitRepo('c-1', 'acme', 'payments-api'),
    ] as never);

    // Only the well-formed row counts → it's the sole repo → auto-resolved.
    expect(await resolveChannelRepo('chan-1')).toEqual({ repoId: 'c-1' });
  });

  it('returns null when the channel row is missing', async () => {
    findChannel.mockResolvedValue(null as never);

    expect(await resolveChannelRepo('chan-1', 'payments-api')).toBeNull();
  });
});

describe('createChannelCodeTaskRun', () => {
  const INPUT = {
    channelId: 'chan-1',
    description: 'Add a GET /health endpoint and open a PR.',
    repoHint: 'payments-api',
    requesterSlackId: 'U123',
    slackChannelId: 'C123',
    threadTs: '111.222',
    title: 'Add health endpoint',
  };

  beforeEach(() => {
    findChannel.mockResolvedValue({ teamId: 'team-1' } as never);
    findConnections.mockResolvedValue([gitRepo('c-1', 'acme', 'payments-api')] as never);
    findUser.mockResolvedValue({ id: 'user-1', role: 'ENGINEER' } as never);
    findConnection.mockResolvedValue({
      githubApiUrl: null,
      id: 'c-1',
      installation: null,
      organizationName: 'acme',
      repoName: 'payments-api',
      team: { memberships: [{ userId: 'user-1' }] },
      type: 'git_repo',
    } as never);
    resolveGate.mockResolvedValue({ mode: 'off', staleAfterHours: 72 });
    decide.mockResolvedValue({ allowed: true, reason: 'permitted' });
  });

  describe('access', () => {
    it('asks nothing about the requester while the gate is off', async () => {
      // The long-standing behaviour: an @mention needs no linked account. That
      // was a deliberate choice, and a deployment that has not asked for the
      // gate keeps it exactly.
      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(false);
      expect(decide).not.toHaveBeenCalled();
      // The load-bearing half. Without it this test passes just as well when the
      // check has been deleted outright, which is the one change it exists to
      // notice — "nothing happened" is what both look like from the outside.
      expect(resolveGate).toHaveBeenCalled();
    });

    it('refuses an unlinked Slack user once the gate is on', async () => {
      // `/auto-swe run` has always required a linked account. The conversational
      // route reaches the same outcome — a push and a pull request — so under
      // enforcement it stops being the easier way in.
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      findUser.mockResolvedValue(null as never);

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(true);
      expect((result as { message: string }).message).toContain('linked');
      expect(createRunInput).not.toHaveBeenCalled();
    });

    it('takes the full decision for a linked user, and refuses what it refuses', async () => {
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      decide.mockResolvedValue({ allowed: false, reason: 'insufficient-permission' });

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(true);
      // The real message, from the shared map — not a fixture's paraphrase.
      expect((result as { message: string }).message).toContain(
        'GitHub reports that you do not have write access'
      );
      expect(createRunInput).not.toHaveBeenCalled();
    });

    it('launches for a linked user the decision allows', async () => {
      // The discriminating case: if the refusals above passed because the gate
      // refuses everything once on, this would fail.
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(false);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(createRunInput).toHaveBeenCalled();
    });

    it('records who asked, even with the gate off', async () => {
      // Channel-originated runs recorded no requester at all, so a run started
      // from Slack was the one kind nothing could trace back to a person.
      await createChannelCodeTaskRun(INPUT);
      expect(createRunInput.mock.calls[0]?.[0]?.data).toMatchObject({
        requestedById: 'user-1',
      });
    });

    it('leaves the requester null when the Slack user has not linked', async () => {
      findUser.mockResolvedValue(null as never);
      await createChannelCodeTaskRun(INPUT);
      expect(createRunInput.mock.calls[0]?.[0]?.data).not.toHaveProperty('requestedById');
    });

    it('refuses when the gate has never been readable, rather than treating it as off', async () => {
      // The whole point of the last-known-good resolver: a config read that
      // fails must not silently turn enforcement off. Reading through the raw
      // resolver and catching would land here as "no gate → allowed", which is
      // the launch the deployment was refusing a second earlier.
      resolveGate.mockResolvedValue(null);

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(true);
      expect((result as { message: string }).message).toContain('Try again shortly');
      expect(createRunInput).not.toHaveBeenCalled();
    });

    it('refuses when the repository row cannot be read', async () => {
      // An unanswered question is not a yes. The row was read moments earlier by
      // `resolveChannelRepo`, so this is a delete racing the decision — but
      // answering "allowed" would assert something nothing checked.
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      findConnection.mockResolvedValue(null as never);

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(true);
      expect(createRunInput).not.toHaveBeenCalled();
    });

    it('flips the argument order for Temporal when the decision logs', async () => {
      // Advisory mode's whole output is this log line, and the two loggers take
      // their arguments in opposite orders — so an adapter that passes them
      // straight through logs the metadata as the message and loses the rest.
      resolveGate.mockResolvedValue({ mode: 'advisory', staleAfterHours: 72 });
      decide.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { warn: (obj: unknown, msg?: string) => void }).warn(
          { repoId: 'c-1' },
          'would refuse'
        );
        return { allowed: true, reason: 'advisory-would-refuse' };
      });

      await createChannelCodeTaskRun(INPUT);

      expect(warn).toHaveBeenCalledWith('would refuse', { repoId: 'c-1' });
    });

    it('launches anyway when the advisory log throws', async () => {
      // A line of telemetry must never be the reason a task does not run. The
      // rejection would surface as a failed launch and the assistant would post
      // its "on it" ack with nothing behind it — in advisory mode, which is the
      // mode an operator sits in while deciding whether to enforce.
      resolveGate.mockResolvedValue({ mode: 'advisory', staleAfterHours: 72 });
      warn.mockImplementation(() => {
        throw new Error('no activity context');
      });
      decide.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { warn: (obj: unknown, msg?: string) => void }).warn({}, 'would refuse');
        return { allowed: true, reason: 'advisory-would-refuse' };
      });

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(false);
      expect(createRunInput).toHaveBeenCalled();
    });

    it('refuses a retired installation, because starting a task IS new work', async () => {
      // The other half of the intent: retirement stops new work, and a code task
      // is new work however the run that follows is steered later.
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      decide.mockResolvedValue({ allowed: false, reason: 'installation-retired' });

      const result = await createChannelCodeTaskRun(INPUT);
      expect(isChannelTaskRefusal(result)).toBe(true);
      expect(createRunInput).not.toHaveBeenCalled();
    });

    it('says so on the console when the advisory log itself fails', async () => {
      // Swallowed, but never silently: an advisory rollout whose logger throws
      // on every call produces no output, and an operator reads an empty log as
      // "nothing would be refused" — the opposite of what happened.
      resolveGate.mockResolvedValue({ mode: 'advisory', staleAfterHours: 72 });
      warn.mockImplementation(() => {
        throw new Error('no activity context');
      });
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      decide.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { warn: (obj: unknown, msg?: string) => void }).warn({}, 'would refuse');
        return { allowed: true, reason: 'advisory-would-refuse' };
      });

      await createChannelCodeTaskRun(INPUT);

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('under-reporting'),
        expect.any(Error)
      );
      consoleWarn.mockRestore();
    });

    it('resolves the requester and the decision against the SAME set of users', async () => {
      // Both queries answer "who is this Slack id". A deactivated user filtered
      // out of one and not the other is refused by the gate as if they had never
      // linked, and then recorded as the requester of the run they were refused.
      resolveGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      await createChannelCodeTaskRun(INPUT);

      expect(findUser).toHaveBeenCalled();
      for (const [args] of findUser.mock.calls) {
        expect(args?.where).toMatchObject({ isActive: true, slackId: 'U123' });
      }
    });
  });

  it('builds a REAL RepoWorkRequest against the resolved repo + the default SWE template', async () => {
    const result = await createChannelCodeTaskRun(INPUT);

    expect(result).not.toBeNull();
    if (!result || isChannelTaskRefusal(result)) {
      throw new Error('expected a prepared run, got a refusal');
    }
    // Default SWE template resolved via resolveTemplateForRepo(resolvedRepoId).
    expect(resolveTemplate).toHaveBeenCalledWith('c-1');
    expect(result.templateId).toBe('tmpl-swe');
    expect(result.templateVersion).toBe(3);
    // Shares the deterministic per-thread workflowId with the general route.
    expect(result.workflowId).toBe('chantask-chan-1-111-222');
    expect(result.request).toMatchObject({
      channelId: 'chan-1',
      description: INPUT.description,
      externalTicketId: 'slack-C123-111.222',
      // Real repo (NOT the repo-less sentinel) — the SWE spec needs a workspace.
      repoId: 'c-1',
      slackChannel: '111.222',
      workRequestId: 'runinput-1',
    });
  });

  it("stamps payload.kind='channel-task' so finalize accrues to the channel + reports back", async () => {
    await createChannelCodeTaskRun(INPUT);

    const data = createRunInput.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      // Links the resolved git_repo Connection so finalize can derive the org and
      // bill OrgMonthlyUsage / enforce the org budget cap (like a normal request).
      connectionId: 'c-1',
      slackChannelId: 'C123',
      slackMessageTs: '111.222',
      templateId: 'tmpl-swe',
      templateVersion: 3,
    });
    expect(data.payload).toMatchObject({
      channelId: 'chan-1',
      kind: 'channel-task',
      repoId: 'c-1',
    });
  });

  it('returns null (fall back to general) when no repo resolves', async () => {
    findConnections.mockResolvedValue([
      gitRepo('c-1', 'acme', 'payments-api'),
      gitRepo('c-2', 'acme', 'web'),
    ] as never);

    // Ambiguous (two repos) + an unmatched hint → null.
    expect(await createChannelCodeTaskRun({ ...INPUT, repoHint: 'nope' })).toBeNull();
    // No template resolution / RunInput insert on the null path.
    expect(resolveTemplate).not.toHaveBeenCalled();
    expect(createRunInput).not.toHaveBeenCalled();
  });
});

describe('isChannelOverBudgetForTask', () => {
  it('returns false (fast path) when the channel has no cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(false);
    // No-cap fast path: never reads the usage row.
    expect(findUsage).not.toHaveBeenCalled();
  });

  it('returns true when month-to-date spend has reached the cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: 500 } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(true);
  });

  it('returns false when month-to-date spend is under the cap', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: 500 } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 4.99 } as never);

    expect(await isChannelOverBudgetForTask('chan-1')).toBe(false);
  });
});
