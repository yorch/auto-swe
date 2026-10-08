import crypto from 'node:crypto';
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

import {
  type CiTriggerResult,
  handleWorkflowRunFailure,
  type WorkflowRunFailedEvent,
} from './ciFailureTriggers.js';

/**
 * CI-failure trigger decisions against real Postgres: the per-trigger advisory lock, the
 * unique dedupe key and the CHECK constraints are the mechanism, so a mocked Prisma would
 * prove nothing about concurrent deliveries.
 *
 * Opt in with `CI_TRIGGER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes rows, so use a throwaway one):
 *
 *   docker run -d --rm --name ci-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55453:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55453/t yarn workspace @auto-swe/shared db:deploy
 *   CI_TRIGGER_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/ciFailureTriggers.pg.test.ts
 */
const enabled = process.env.CI_TRIGGER_PG_TEST === '1';

describe.skipIf(!enabled)('CI-failure trigger decisions against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const org = `ci-${suffix}`;
  let triggerId: string;
  let templateId: string;
  let repoId: string;
  const started: string[] = [];
  /** Executions Temporal reports as over. */
  const gone = new Set<string>();

  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma,
    temporal: {
      isWorkflowGone: async (id: string) => gone.has(id),
      startRunnableWorkflow: async (id: string) => {
        // Long enough that concurrent deliveries overlap in the decision.
        await new Promise((r) => setTimeout(r, 20));
        started.push(id);
      },
    },
  };

  const event = (over: Partial<WorkflowRunFailedEvent> = {}): WorkflowRunFailedEvent => ({
    event: 'push',
    headBranch: 'main',
    headSha: 'a'.repeat(40),
    org,
    pullRequestNumber: null,
    repoFullName: `${org}/repo`,
    repoHtmlUrl: `https://github.com/${org}/repo`,
    repoName: 'repo',
    runAttempt: 1,
    runId: '1',
    type: 'failed',
    workflowPath: '.github/workflows/ci.yml',
    ...over,
  });

  const deliver = (e: WorkflowRunFailedEvent) =>
    handleWorkflowRunFailure(fastify as never, e, null, new Date(), 0);

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
        const trigger = await prisma.ciFailureTrigger.create({
          data: {
            branchPatterns: ['main'],
            connectionId: repo.id,
            cooldownMinutes: 0,
            events: ['push'],
            maxRunsPerDay: 3,
            mode: 'FIX',
            name: 'main',
            templateId: tpl.id,
            workflowPatterns: ['.github/workflows/**'],
          },
        });
        triggerId = trigger.id;
        templateId = tpl.id;
      }
    );
  });

  beforeEach(async () => {
    started.length = 0;
    gone.clear();
    await prisma.ciFailureTriggerFire.deleteMany({ where: { triggerId } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
  });

  afterAll(async () => {
    await prisma.ciFailureTrigger.deleteMany({ where: { id: triggerId } });
  });

  const outcomes = (results: CiTriggerResult[]) =>
    results
      .map((r) => ('outcome' in r ? r.outcome : 'duplicate' in r ? 'DUPLICATE' : 'IGNORED'))
      .sort();

  it('starts one run for concurrent redeliveries of the same run attempt', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(event())));
    expect(outcomes(results).filter((o) => o === 'STARTED')).toHaveLength(1);
    expect(outcomes(results).filter((o) => o === 'DUPLICATE')).toHaveLength(5);
    expect(started).toHaveLength(1);
  });

  it('starts one run for several workflows failing on the same commit at once', async () => {
    const results = await Promise.all(
      ['1', '2', '3', '4'].map((runId) =>
        deliver(event({ runId, workflowPath: `.github/workflows/${runId}.yml` }))
      )
    );
    expect(outcomes(results)).toEqual([
      'STARTED',
      'SUPPRESSED_SAME_COMMIT',
      'SUPPRESSED_SAME_COMMIT',
      'SUPPRESSED_SAME_COMMIT',
    ]);
    expect(started).toHaveLength(1);
  });

  it('holds the daily cap under concurrency', async () => {
    // Different branches and commits, so only the cap (3) and in-flight state decide.
    await prisma.ciFailureTrigger.update({
      data: { branchPatterns: ['*'] },
      where: { id: triggerId },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        deliver(
          event({ headBranch: `b${i}`, headSha: String(i).repeat(40), runId: String(100 + i) })
        )
      )
    );
    expect(outcomes(results).filter((o) => o === 'STARTED')).toHaveLength(3);
    expect(outcomes(results).filter((o) => o === 'SUPPRESSED_DAILY_CAP')).toHaveLength(3);
    await prisma.ciFailureTrigger.update({
      data: { branchPatterns: ['main'] },
      where: { id: triggerId },
    });
  });

  it('suppresses while an earlier run is open, and not once its row is closed or Temporal says it is over', async () => {
    await prisma.ciFailureTrigger.update({
      data: { cooldownMinutes: 0 },
      where: { id: triggerId },
    });
    const first = await deliver(event({ runId: '200' }));
    expect(first).toMatchObject({ outcome: 'STARTED' });
    const wfId = (first as { temporalWorkflowId: string }).temporalWorkflowId;
    await expect(deliver(event({ headSha: 'b'.repeat(40), runId: '201' }))).resolves.toMatchObject({
      outcome: 'SUPPRESSED_IN_FLIGHT',
    });
    // Terminated before it finalized: the row says IMPLEMENTING, Temporal says it is over.
    gone.add(wfId);
    await expect(deliver(event({ headSha: 'c'.repeat(40), runId: '202' }))).resolves.toMatchObject({
      outcome: 'STARTED',
    });
  });

  it('starts one run when two triggers match two workflows failing on one commit at once', async () => {
    const second = await prisma.ciFailureTrigger.create({
      data: {
        branchPatterns: ['main'],
        connectionId: repoId,
        cooldownMinutes: 0,
        events: ['push'],
        maxRunsPerDay: 3,
        mode: 'FIX',
        name: 'lint',
        templateId,
        workflowPatterns: ['.github/workflows/lint.yml'],
      },
    });
    await prisma.ciFailureTrigger.update({
      data: { workflowPatterns: ['.github/workflows/ci.yml'] },
      where: { id: triggerId },
    });
    try {
      const results = await Promise.all([
        deliver(event({ runId: '300', workflowPath: '.github/workflows/ci.yml' })),
        deliver(event({ runId: '301', workflowPath: '.github/workflows/lint.yml' })),
      ]);
      expect(outcomes(results)).toEqual(['STARTED', 'SUPPRESSED_SAME_COMMIT']);
      expect(started).toHaveLength(1);
    } finally {
      await prisma.ciFailureTrigger.delete({ where: { id: second.id } });
      await prisma.ciFailureTrigger.update({
        data: { workflowPatterns: ['.github/workflows/**'] },
        where: { id: triggerId },
      });
    }
  });

  it('refuses a trigger row with an empty list or an unknown event', async () => {
    const base = {
      branchPatterns: ['main'],
      connectionId: repoId,
      events: ['push'],
      name: 'bad',
      workflowPatterns: ['**'],
    };
    await expect(
      prisma.ciFailureTrigger.create({ data: { ...base, branchPatterns: [] } })
    ).rejects.toThrow();
    await expect(
      prisma.ciFailureTrigger.create({ data: { ...base, events: ['pull_request_target'] } })
    ).rejects.toThrow();
    await expect(
      prisma.ciFailureTrigger.create({ data: { ...base, maxRunsPerDay: 0 } })
    ).rejects.toThrow();
  });
});
