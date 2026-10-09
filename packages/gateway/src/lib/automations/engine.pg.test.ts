import crypto from 'node:crypto';
import { WORKFLOW_RUN_FAILED, workflowRunFailedSource } from '@auto-swe/shared/automation';
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

import { type AutomationResult, handleOccurrence } from './engine.js';

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
  const repoKey = `github.com/${org}/repo`;
  let automationId: string;
  let templateId: string;
  let repoId: string;
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
    await prisma.automationFire.deleteMany({ where: { repoKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
  });

  afterAll(async () => {
    await prisma.automationFire.deleteMany({ where: { repoKey } });
    await prisma.automation.deleteMany({ where: { connectionId: repoId } });
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
      where: { dedupeKey: { endsWith: '#400/1' }, repoKey },
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
    const fire = await prisma.automationFire.findFirst({ where: { repoKey, scopeKey: 'tmp' } });
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
    const failed = await prisma.automationFire.findMany({ where: { repoKey } });
    expect(failed).toEqual([
      expect.objectContaining({ outcome: 'FAILED_TO_START', temporalWorkflowId: null }),
    ]);
    temporalDown = false;
    const results = await Promise.all(Array.from({ length: 4 }, () => deliver({ runId: '600' })));
    expect(outcomes(results)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'STARTED']);
    expect(started).toHaveLength(1);
    const rows = await prisma.automationFire.findMany({
      orderBy: { createdAt: 'asc' },
      where: { repoKey },
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
      { ...base, filters: filters(), maxRunsPerDay: 0 },
      { ...base, filters: filters(), inputs: ['fix'] },
    ]) {
      await expect(prisma.automation.create({ data: bad })).rejects.toThrow();
    }
  });
});
