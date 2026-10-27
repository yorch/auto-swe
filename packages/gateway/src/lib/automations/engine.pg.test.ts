import crypto from 'node:crypto';
import {
  INBOUND_EVENT,
  ISSUE_LABELED,
  issueLabeledSource,
  JIRA_FILTER_NEW_ISSUE,
  WORKFLOW_RUN_FAILED,
  workflowRunFailedSource,
} from '@auto-swe/shared/automation';
import { prisma } from '@auto-swe/shared/db';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => true) }));

import { type AutomationResult, decideUnderLock, handleOccurrence } from './engine.js';

/**
 * Event-automation decisions against real Postgres, through the `github.workflow_run.failed`
 * source: the per-repository advisory lock, the unique dedupe key and the CHECK constraints are
 * the mechanism, so a mocked Prisma would prove nothing about concurrent deliveries.
 *
 * Opt in with `CI_TRIGGER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes rows, so use a throwaway one):
 *
 *   docker run -d --rm --name ci-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55453:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55453/t yarn workspace @auto-swe/shared db:deploy
 *   CI_TRIGGER_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/automations/engine.pg.test.ts
 */
const enabled = process.env.CI_TRIGGER_PG_TEST === '1';

describe.skipIf(!enabled)('event-automation decisions against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const org = `ci-${suffix}`;
  const ownerKey = `github.com/${org}/repo`;
  let automationId: string;
  let templateId: string;
  let repoId: string;
  let teamId: string;
  let orgId: string;
  const started: string[] = [];
  /** Executions Temporal reports as over. */
  const gone = new Set<string>();

  /** When set, every start throws (Temporal down). */
  let temporalDown = false;
  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma,
    temporal: {
      isWorkflowGone: async (id: string) => gone.has(id),
      startRunnableWorkflow: async (id: string) => {
        // Long enough that concurrent deliveries overlap in the decision.
        await new Promise((r) => setTimeout(r, 20));
        if (temporalDown) {
          throw new Error('temporal down');
        }
        started.push(id);
      },
    },
  };

  type Over = Partial<{
    branch: string;
    headSha: string;
    runId: string;
    workflowPath: string;
  }>;
  const deliver = (over: Over = {}) =>
    handleOccurrence(
      fastify as never,
      workflowRunFailedSource,
      {
        facts: {
          branch: over.branch ?? 'main',
          event: 'push',
          headSha: over.headSha ?? 'a'.repeat(40),
          pullRequestNumber: null,
          runAttempt: 1,
          runId: over.runId ?? '1',
          workflowPath: over.workflowPath ?? '.github/workflows/ci.yml',
        },
        org,
        repoFullName: `${org}/repo`,
        repoHtmlUrl: `https://github.com/${org}/repo`,
        repoName: 'repo',
      },
      null,
      new Date(),
      0
    );

  const filters = (over: Record<string, unknown> = {}) => ({
    branchPatterns: ['main'],
    events: ['push'],
    workflowPatterns: ['.github/workflows/**'],
    ...over,
  });

  beforeAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['Organization', 'Team', 'Connection', 'WorkflowTemplate'],
      async () => {
        const organization = await prisma.organization.create({
          data: { name: `ci-org-${suffix}`, slug: `ci-org-${suffix}` },
        });
        const team = await prisma.team.create({
          data: { name: `ci-team-${suffix}`, orgId: organization.id, slug: `ci-team-${suffix}` },
        });
        const repo = await prisma.connection.create({
          data: { organizationName: org, repoName: 'repo', teamId: team.id, type: 'git_repo' },
        });
        repoId = repo.id;
        teamId = team.id;
        orgId = organization.id;
        const tpl = await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            inputSchema: CI_TRIAGE_INPUT_SCHEMA as object,
            name: `ci-tpl-${suffix}`,
            status: 'ACTIVE',
            teamId: team.id,
          },
        });
        const automation = await prisma.automation.create({
          data: {
            connectionId: repo.id,
            cooldownMinutes: 0,
            filters: filters(),
            inputs: { mode: 'fix' },
            maxRunsPerDay: 3,
            name: 'main',
            source: WORKFLOW_RUN_FAILED,
            templateId: tpl.id,
          },
        });
        automationId = automation.id;
        templateId = tpl.id;
      }
    );
  });

  beforeEach(async () => {
    started.length = 0;
    gone.clear();
    temporalDown = false;
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
  });

  afterAll(async () => {
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await runUnscoped('test fixture', ['Automation'], () =>
      prisma.automation.deleteMany({ where: { connectionId: repoId } })
    );
  });

  const outcomes = (results: AutomationResult[]) =>
    results
      .map((r) => ('outcome' in r ? r.outcome : 'duplicate' in r ? 'DUPLICATE' : 'IGNORED'))
      .sort();

  it('starts one run for concurrent redeliveries of the same run attempt', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver()));
    expect(outcomes(results).filter((o) => o === 'STARTED')).toHaveLength(1);
    expect(outcomes(results).filter((o) => o === 'DUPLICATE')).toHaveLength(5);
    expect(started).toHaveLength(1);
  });

  it('starts one run for several workflows failing on the same commit at once', async () => {
    const results = await Promise.all(
      ['1', '2', '3', '4'].map((runId) =>
        deliver({ runId, workflowPath: `.github/workflows/${runId}.yml` })
      )
    );
    expect(outcomes(results)).toEqual([
      'STARTED',
      'SUPPRESSED_SAME_SUBJECT',
      'SUPPRESSED_SAME_SUBJECT',
      'SUPPRESSED_SAME_SUBJECT',
    ]);
    expect(started).toHaveLength(1);
  });

  it('holds the daily cap under concurrency', async () => {
    // Different branches and commits, so only the cap (3) and in-flight state decide.
    await prisma.automation.update({
      data: { filters: filters({ branchPatterns: ['*'] }) },
      where: { id: automationId },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          deliver({ branch: `b${i}`, headSha: String(i).repeat(40), runId: String(100 + i) })
        )
      );
      expect(outcomes(results).filter((o) => o === 'STARTED')).toHaveLength(3);
      expect(outcomes(results).filter((o) => o === 'SUPPRESSED_DAILY_CAP')).toHaveLength(3);
    } finally {
      await prisma.automation.update({ data: { filters: filters() }, where: { id: automationId } });
    }
  });

  it('suppresses while an earlier run is open, and not once Temporal says it is over', async () => {
    const first = await deliver({ runId: '200' });
    expect(first).toMatchObject({ outcome: 'STARTED' });
    const wfId = (first as { temporalWorkflowId: string }).temporalWorkflowId;
    await expect(deliver({ headSha: 'b'.repeat(40), runId: '201' })).resolves.toMatchObject({
      outcome: 'SUPPRESSED_IN_FLIGHT',
    });
    // Terminated before it finalized: the row says IMPLEMENTING, Temporal says it is over.
    gone.add(wfId);
    await expect(deliver({ headSha: 'c'.repeat(40), runId: '202' })).resolves.toMatchObject({
      outcome: 'STARTED',
    });
  });

  it('starts one run when two automations match two workflows failing on one commit at once', async () => {
    const second = await prisma.automation.create({
      data: {
        connectionId: repoId,
        cooldownMinutes: 0,
        filters: filters({ workflowPatterns: ['.github/workflows/lint.yml'] }),
        maxRunsPerDay: 3,
        name: 'lint',
        source: WORKFLOW_RUN_FAILED,
        templateId,
      },
    });
    await prisma.automation.update({
      data: { filters: filters({ workflowPatterns: ['.github/workflows/ci.yml'] }) },
      where: { id: automationId },
    });
    try {
      const results = await Promise.all([
        deliver({ runId: '300', workflowPath: '.github/workflows/ci.yml' }),
        deliver({ runId: '301', workflowPath: '.github/workflows/lint.yml' }),
      ]);
      expect(outcomes(results)).toEqual(['STARTED', 'SUPPRESSED_SAME_SUBJECT']);
      expect(started).toHaveLength(1);
    } finally {
      await prisma.automation.delete({ where: { id: second.id } });
      await prisma.automation.update({ data: { filters: filters() }, where: { id: automationId } });
    }
  });

  it('never starts a run for a failure of a commit the platform pushed as a fix', async () => {
    const first = await deliver({ headSha: 'd'.repeat(40), runId: '400' });
    expect(first).toMatchObject({ outcome: 'STARTED' });
    gone.add((first as { temporalWorkflowId: string }).temporalWorkflowId);
    await prisma.automationFire.updateMany({
      data: { producedKey: 'e'.repeat(40) },
      where: { dedupeKey: { endsWith: '#400/1' }, ownerKey },
    });
    await expect(deliver({ headSha: 'e'.repeat(40), runId: '401' })).resolves.toMatchObject({
      outcome: 'SUPPRESSED_OWN_OUTPUT',
    });
  });

  it('keeps its decisions when the automation is deleted and recreated', async () => {
    const temp = await prisma.automation.create({
      data: {
        connectionId: repoId,
        cooldownMinutes: 0,
        filters: filters({ branchPatterns: ['tmp'] }),
        name: 'temp',
        source: WORKFLOW_RUN_FAILED,
        templateId,
      },
    });
    await expect(deliver({ branch: 'tmp', runId: '500' })).resolves.toMatchObject({
      outcome: 'STARTED',
    });
    await prisma.automation.delete({ where: { id: temp.id } });
    const fire = await prisma.automationFire.findFirst({ where: { ownerKey, scopeKey: 'tmp' } });
    expect(fire).toMatchObject({ automationId: null, outcome: 'STARTED' });
    const again = await prisma.automation.create({
      data: {
        connectionId: repoId,
        cooldownMinutes: 0,
        filters: filters({ branchPatterns: ['tmp'] }),
        name: 'again',
        source: WORKFLOW_RUN_FAILED,
        templateId,
      },
    });
    try {
      // Another workflow failing on the same commit: still one run per commit.
      await expect(
        deliver({ branch: 'tmp', runId: '501', workflowPath: '.github/workflows/x.yml' })
      ).resolves.toMatchObject({ outcome: 'SUPPRESSED_SAME_SUBJECT' });
    } finally {
      await prisma.automation.delete({ where: { id: again.id } });
    }
  });

  it('records a failed start, and concurrent redeliveries take it again exactly once', async () => {
    temporalDown = true;
    await expect(deliver({ runId: '600' })).rejects.toMatchObject({
      name: 'AutomationStartError',
    });
    const failed = await prisma.automationFire.findMany({ where: { ownerKey } });
    expect(failed).toEqual([
      expect.objectContaining({ outcome: 'FAILED_TO_START', temporalWorkflowId: null }),
    ]);
    temporalDown = false;
    const results = await Promise.all(Array.from({ length: 4 }, () => deliver({ runId: '600' })));
    expect(outcomes(results)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'STARTED']);
    expect(started).toHaveLength(1);
    const rows = await prisma.automationFire.findMany({
      orderBy: { createdAt: 'asc' },
      where: { ownerKey },
    });
    expect(rows.map((r) => [r.outcome, r.retriedAt !== null])).toEqual([
      ['FAILED_TO_START', true],
      ['STARTED', false],
    ]);
  });

  it('accepts scheduled runs as an event', async () => {
    const row = await prisma.automation.create({
      data: {
        connectionId: repoId,
        filters: filters({ events: ['push', 'schedule'] }),
        name: 'nightly',
        source: WORKFLOW_RUN_FAILED,
      },
    });
    await prisma.automation.delete({ where: { id: row.id } });
  });

  it('starts an issue run only for an active platform member, as theirs', async () => {
    const accountId = String(Date.now()).slice(-9);
    const member = await prisma.user.create({
      data: {
        email: `issue-${suffix}@example.test`,
        githubLogin: `octo-${suffix}`,
        githubLoginAccountId: accountId,
      },
    });
    await prisma.teamMembership.create({ data: { teamId, userId: member.id } });
    const outsider = await prisma.user.create({
      data: {
        email: `issue-outsider-${suffix}@example.test`,
        githubLogin: `outsider-${suffix}`,
        githubLoginAccountId: `${accountId}7`,
      },
    });
    // On the team but not in the organization: the launch decision refuses them.
    await prisma.teamMembership.create({ data: { teamId, userId: outsider.id } });
    await runUnscoped('test fixture', ['OrganizationMembership'], () =>
      prisma.organizationMembership.create({ data: { orgId, userId: member.id } })
    );
    const swe = await runUnscoped('test fixture', ['WorkflowTemplate'], () =>
      prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          inputSchema: {
            properties: {
              connectionId: { type: 'string' },
              description: { type: 'string' },
              ticketId: { type: 'string' },
            },
            required: ['ticketId', 'connectionId', 'description'],
            type: 'object',
          },
          name: `issue-tpl-${suffix}`,
          status: 'ACTIVE',
          teamId,
        },
      })
    );
    const automation = await prisma.automation.create({
      data: {
        connectionId: repoId,
        filters: { labels: ['auto-swe'] },
        name: 'issues',
        source: ISSUE_LABELED,
        templateId: swe.id,
      },
    });
    const label = (senderId: string, updatedAt: string) =>
      handleOccurrence(
        fastify as never,
        issueLabeledSource,
        {
          facts: {
            body: 'It should return 200.',
            htmlUrl: `https://github.com/${org}/repo/issues/3`,
            issueNumber: 3,
            label: 'auto-swe',
            senderId,
            senderLogin: 'someone',
            title: 'Add a health check',
            updatedAt,
          },
          org,
          repoFullName: `${org}/repo`,
          repoHtmlUrl: `https://github.com/${org}/repo`,
          repoName: 'repo',
        },
        null,
        new Date(),
        0
      );
    try {
      await expect(label('999999999999', '2026-10-01T00:00:00Z')).resolves.toMatchObject({
        outcome: 'SUPPRESSED_PRECONDITION',
        reason: expect.stringMatching(/not an active platform user/),
      });
      await expect(label(`${accountId}7`, '2026-10-01T12:00:00Z')).resolves.toMatchObject({
        outcome: 'SUPPRESSED_PRECONDITION',
        reason: expect.stringMatching(/may not start work here/),
      });
      const ok = await label(accountId, '2026-10-02T00:00:00Z');
      expect(ok).toMatchObject({ outcome: 'STARTED' });
      const runInput = await prisma.runInput.findUnique({
        where: { id: (ok as { workRequestId: string }).workRequestId },
      });
      expect(runInput).toMatchObject({ requestedById: member.id, templateId: swe.id });
      // Deactivated: no longer anyone who may ask.
      await prisma.user.update({ data: { isActive: false }, where: { id: member.id } });
      gone.add((ok as { temporalWorkflowId: string }).temporalWorkflowId);
      await expect(label(accountId, '2026-10-03T00:00:00Z')).resolves.toMatchObject({
        outcome: 'SUPPRESSED_PRECONDITION',
      });
    } finally {
      await prisma.automationFire.deleteMany({ where: { ownerKey } });
      await prisma.automation.delete({ where: { id: automation.id } });
      await prisma.user.deleteMany({ where: { id: { in: [member.id, outsider.id] } } });
    }
  });

  it('refuses an automation row with filters its source does not accept, or unknown sources', async () => {
    const base = { connectionId: repoId, name: 'bad', source: WORKFLOW_RUN_FAILED };
    for (const bad of [
      { ...base, filters: filters({ branchPatterns: [] }) },
      { ...base, filters: filters({ events: ['pull_request_target'] }) },
      { ...base, filters: filters({ events: ['workflow_dispatch'] }) },
      { ...base, filters: filters({ events: [] }) },
      { ...base, filters: ['main'] },
      { ...base, filters: {} },
      { ...base, filters: { branchPatterns: ['main'], events: ['push'] } },
      { ...base, filters: filters({ events: 'push' }) },
      { ...base, filters: filters(), source: 'github.issue.labeled' },
      { ...base, filters: { labels: [] }, source: ISSUE_LABELED },
      { ...base, filters: {}, source: ISSUE_LABELED },
      { ...base, filters: filters(), maxRunsPerDay: 0 },
      { ...base, filters: filters(), inputs: ['fix'] },
    ]) {
      await expect(prisma.automation.create({ data: bad })).rejects.toThrow();
    }
  });

  it('keeps every automation owned: a repository or a team, never neither', async () => {
    const base = { filters: filters(), name: 'owned', source: WORKFLOW_RUN_FAILED };
    await expect(prisma.automation.create({ data: base })).rejects.toThrow();
    const onTeam = await prisma.automation.create({ data: { ...base, teamId } });
    try {
      expect(onTeam.connectionId).toBeNull();
      // A team's decisions are taken under their own lock, on their own ledger.
      const decided = await prisma.$transaction((tx) =>
        decideUnderLock(
          tx,
          {
            automation: { cooldownMinutes: 0, id: onTeam.id, maxRunsPerDay: 1 },
            ownerKey: `@team/${teamId}`,
          },
          workflowRunFailedSource,
          { scope: 'main', subject: 'a'.repeat(40) },
          new Date(),
          async () => true
        )
      );
      expect(decided).toBeNull();
    } finally {
      await prisma.automation.delete({ where: { id: onTeam.id } });
    }
  });
  it('keeps inbound-event automations on a team, with well-formed filters and target', async () => {
    const good = {
      endpointId: crypto.randomUUID(),
      eventTypes: ['alert.*'],
      fields: {},
      match: [],
    };
    const base = { filters: good, name: 'events', source: INBOUND_EVENT };
    for (const bad of [
      { ...base, connectionId: repoId },
      { ...base, filters: { ...good, eventTypes: [] }, teamId },
      { ...base, filters: { endpointId: good.endpointId, eventTypes: ['*'] }, teamId },
      { ...base, filters: { ...good, fields: [] }, teamId },
      // Only a team automation names a repository to act on.
      {
        connectionId: repoId,
        filters: filters(),
        name: 'x',
        source: WORKFLOW_RUN_FAILED,
        targetConnectionId: repoId,
      },
    ]) {
      await expect(prisma.automation.create({ data: bad })).rejects.toThrow();
    }
    const ok = await prisma.automation.create({
      data: { ...base, targetConnectionId: repoId, teamId },
    });
    await prisma.automation.delete({ where: { id: ok.id } });
  });

  it('keeps Jira filter automations on a repository, with a non-empty JQL', async () => {
    const base = { connectionId: repoId, name: 'jira', source: JIRA_FILTER_NEW_ISSUE };
    for (const bad of [
      { ...base, filters: {} },
      { ...base, filters: { jql: '' } },
      { ...base, filters: { jql: '   ' } },
      { ...base, filters: { jql: ['project = PAY'] } },
      { ...base, filters: { jql: 5 } },
      { ...base, filters: ['project = PAY'] },
      // A source that targets a repository never lives on a team alone.
      {
        connectionId: undefined,
        filters: { jql: 'project = PAY' },
        name: 'jira',
        source: JIRA_FILTER_NEW_ISSUE,
        teamId,
      },
    ]) {
      await expect(prisma.automation.create({ data: bad })).rejects.toThrow();
    }
    const ok = await prisma.automation.create({
      data: { ...base, filters: { jql: 'project = PAY' } },
    });
    await prisma.automation.delete({ where: { id: ok.id } });
  });

  it('deletes a Jira automation’s poll state and seen issues with it, and keeps seen keys lower-case', async () => {
    const automation = await prisma.automation.create({
      data: {
        connectionId: repoId,
        filters: { jql: 'project = PAY' },
        name: 'jira',
        source: JIRA_FILTER_NEW_ISSUE,
      },
    });
    const automationId = automation.id;
    try {
      await prisma.automationPollState.create({ data: { automationId } });
      await prisma.automationSeenIssue.createMany({
        data: [
          { automationId, issueKey: 'pay-1' },
          { automationId, issueKey: 'pay-2' },
        ],
      });
      // A key is stored in one spelling, so the same issue is never seen twice.
      await expect(
        prisma.automationSeenIssue.create({ data: { automationId, issueKey: 'PAY-3' } })
      ).rejects.toThrow();
      await expect(
        prisma.automationSeenIssue.create({ data: { automationId, issueKey: 'pay-1' } })
      ).rejects.toThrow();
      await expect(prisma.automationPollState.create({ data: { automationId } })).rejects.toThrow();
    } finally {
      await prisma.automation.delete({ where: { id: automationId } });
    }
    expect(await prisma.automationPollState.count({ where: { automationId } })).toBe(0);
    expect(await prisma.automationSeenIssue.count({ where: { automationId } })).toBe(0);
  });
});
