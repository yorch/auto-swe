import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const temporal = vi.hoisted(() => ({ cancel: vi.fn(), getHandle: vi.fn(), signal: vi.fn() }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { getHandle: temporal.getHandle } }),
}));
vi.mock('./shellStep.js', () => ({ runShellCheck: vi.fn() }));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

import { onCampaignRunFinalized } from '../lib/campaignAttempts.js';
import { discoverCampaignTargets, runCampaignCheck } from './campaignCheck.js';
import {
  cancelCampaignAttempts,
  finalizeCampaignReconciler,
  readCampaignPass,
  recordCampaignPass,
} from './campaignReconciler.js';

/**
 * The reconciler's activities and the campaign tables against real Postgres, with the real tenant
 * guard on every query: a mocked Prisma cannot show that a `where` carries a tenant predicate, that
 * a conditional write loses a race, that `repoMemberWhere` selects the right repositories, or what
 * the migration's backfill does to rows.
 *
 * Opt in with `CAMPAIGN_RECONCILER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.CAMPAIGN_RECONCILER_PG_TEST === '1';

const PREFIX = `camprec-${crypto.randomBytes(4).toString('hex')}-`;
const uuid = () => crypto.randomUUID();

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped(
    'test fixture rows in a throwaway database',
    [
      'Campaign',
      'CampaignTarget',
      'ConfigSetting',
      'Connection',
      'OrganizationMembership',
      'Team',
      'TeamMembership',
      'WorkflowTemplate',
    ],
    fn
  );

describe.skipIf(!enabled)('campaign reconciler against Postgres', () => {
  const ids = {
    campaign: uuid(),
    leader: uuid(),
    org: uuid(),
    otherRepo: uuid(),
    otherTeam: uuid(),
    repoA: uuid(),
    repoB: uuid(),
    runInput: uuid(),
    stranger: uuid(),
    team: uuid(),
    template: uuid(),
  };
  const workflowId = `campaign-${ids.campaign}`;
  let seq = 0;

  /** A target of the fixture campaign. */
  async function makeTarget(
    state: string,
    over: Record<string, unknown> = {}
  ): Promise<{ id: string; connectionId: string }> {
    seq += 1;
    const connection = await prisma.connection.create({
      data: {
        organizationName: 'acme',
        repoName: `${PREFIX}repo-${seq}`,
        teamId: ids.team,
      },
    });
    const row = await prisma.campaignTarget.create({
      data: {
        campaignId: ids.campaign,
        connectionId: connection.id,
        position: seq,
        repoLabel: `acme/${PREFIX}repo-${seq}`,
        state: state as never,
        teamId: ids.team,
        ...over,
      },
    });
    return { connectionId: connection.id, id: row.id };
  }

  /** A run of the fixture template, with the request it needs. */
  async function makeRun(over: Record<string, unknown> = {}) {
    seq += 1;
    const request = await prisma.runInput.create({
      data: { externalTicketId: `${PREFIX}t${seq}`, requestPayload: '{}' },
    });
    return prisma.workflowRun.create({
      data: {
        specSnapshot: {},
        templateId: ids.template,
        templateVersion: 1,
        workflowId: `${PREFIX}wf-${seq}`,
        workRequestId: request.id,
        ...over,
      },
    });
  }

  async function cleanup() {
    await unscoped(async () => {
      await prisma.campaign.deleteMany({ where: { orgId: ids.org } });
      await prisma.connection.deleteMany({ where: { team: { orgId: ids.org } } });
    });
    await prisma.activeWorkflow.deleteMany({
      where: { temporalWorkflowId: { startsWith: PREFIX } },
    });
    await prisma.pullRequest.deleteMany({ where: { headSha: { startsWith: PREFIX } } });
    await prisma.workflowRun.deleteMany({ where: { workflowId: { startsWith: PREFIX } } });
    await prisma.runInput.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } });
    await unscoped(async () => {
      await prisma.configSetting.deleteMany({ where: { orgId: ids.org } });
      await prisma.teamMembership.deleteMany({ where: { team: { orgId: ids.org } } });
      await prisma.organizationMembership.deleteMany({ where: { orgId: ids.org } });
      await prisma.team.deleteMany({ where: { orgId: ids.org } });
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.template } });
    });
    await prisma.runInput.deleteMany({ where: { id: ids.runInput } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.organization.deleteMany({ where: { id: ids.org } });
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.organization.create({
      data: { id: ids.org, name: `${PREFIX}org`, slug: `${PREFIX}org` },
    });
    for (const [id, slug] of [
      [ids.team, `${PREFIX}team`],
      [ids.otherTeam, `${PREFIX}other`],
    ] as const) {
      await prisma.team.create({ data: { id, name: slug, orgId: ids.org, slug } });
    }
    await prisma.user.create({ data: { email: `${PREFIX}lead@example.test`, id: ids.leader } });
    await prisma.user.create({
      data: { email: `${PREFIX}stranger@example.test`, id: ids.stranger },
    });
    await prisma.organizationMembership.create({ data: { orgId: ids.org, userId: ids.leader } });
    await prisma.teamMembership.create({
      data: { role: 'LEAD', teamId: ids.team, userId: ids.leader },
    });
    // The kill switch is on for the owning team and off for the other one.
    await prisma.configSetting.createMany({
      data: [
        { key: 'workflow.campaignsEnabled', orgId: ids.org, scope: 'ORGANIZATION', value: true },
        {
          key: 'workflow.campaignsEnabled',
          scope: 'TEAM',
          teamId: ids.otherTeam,
          value: false,
        },
      ],
    });
    await unscoped(() =>
      prisma.workflowTemplate.create({ data: { id: ids.template, name: `${PREFIX}template` } })
    );
    await prisma.runInput.create({
      data: { externalTicketId: `${PREFIX}campaign`, id: ids.runInput, requestPayload: '{}' },
    });
    await prisma.campaign.create({
      data: {
        description: 'Raise lodash everywhere',
        gate: 'OPENED',
        id: ids.campaign,
        launchedById: ids.leader,
        maxOpenPullRequests: 5,
        maxParallel: 2,
        name: `${PREFIX}campaign`,
        orgId: ids.org,
        ownerTeamId: ids.team,
        recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
        recipeRef: 'npm-dependency@2',
        rescanIntervalHours: 24,
        staleAfterDays: 14,
        state: 'ACTIVE',
        templateId: ids.template,
        templateVersion: 1,
        temporalWorkflowId: workflowId,
        workflowKind: 'RECONCILER',
        workRequestId: ids.runInput,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('readCampaignPass', () => {
    it('reads the campaign, its targets and their delivery under the real tenant guard', async () => {
      const merged = await makeRun({ endedAt: new Date(), status: 'SUCCESS' });
      const target = await makeTarget('PR_OPENED');
      await prisma.campaignAttempt.create({
        data: {
          childWorkflowId: merged.workflowId,
          n: 1,
          outcome: 'PR_OPENED',
          runId: merged.id,
          targetId: target.id,
        },
      });
      await prisma.pullRequest.create({
        data: {
          headSha: `${PREFIX}sha1`,
          repoId: target.connectionId,
          runId: merged.id,
          status: 'MERGED',
        },
      });
      await prisma.campaignProposal.create({
        data: { campaignId: ids.campaign, connectionId: target.connectionId, reason: 'seen once' },
      });

      const snap = await readCampaignPass({ campaignId: ids.campaign });
      expect(snap?.campaign).toMatchObject({
        campaignsEnabled: true,
        gate: 'OPENED',
        hasCheck: true,
        hasScope: false,
        launcherAvailable: true,
        maxParallel: 2,
        state: 'ACTIVE',
      });
      const row = snap?.targets.find((t) => t.id === target.id);
      expect(row).toMatchObject({
        attemptN: 1,
        attemptOutcome: 'PR_OPENED',
        prStatus: 'MERGED',
        state: 'PR_OPENED',
      });
      expect(snap?.proposalConnectionIds).toContain(target.connectionId);
    });

    it('completes the attempt of a running target whose run ended with nobody recording it', async () => {
      const run = await makeRun({
        contextSnapshot: {
          result: {
            path: 'RECIPE',
            prUrl: 'https://github.com/acme/x/pull/3',
            verification: 'PASSED',
          },
        },
        endedAt: new Date(),
        status: 'SUCCESS',
      });
      const target = await makeTarget('RUNNING');
      // The gateway wrote the attempt with the child's workflow id; no worker hook ever ran.
      const attempt = await prisma.campaignAttempt.create({
        data: { childWorkflowId: run.workflowId, n: 1, targetId: target.id },
      });
      await prisma.pullRequest.create({
        data: {
          headSha: `${PREFIX}sha2`,
          repoId: target.connectionId,
          runId: run.id,
          status: 'OPEN',
        },
      });

      const snap = await readCampaignPass({ campaignId: ids.campaign });
      expect(snap?.targets.find((t) => t.id === target.id)).toMatchObject({
        attemptOutcome: 'PR_OPENED',
        prStatus: 'OPEN',
        state: 'RUNNING',
      });
      const row = await prisma.campaignAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row).toMatchObject({
        outcome: 'PR_OPENED',
        path: 'RECIPE',
        runId: run.id,
        verification: 'PASSED',
      });
      expect(row.finishedAt).toBeInstanceOf(Date);
    });

    it('leaves the attempt of a run that is still going', async () => {
      const run = await makeRun({ status: 'RUNNING' });
      const target = await makeTarget('RUNNING');
      await prisma.campaignAttempt.create({
        data: { childWorkflowId: run.workflowId, n: 1, targetId: target.id },
      });
      const snap = await readCampaignPass({ campaignId: ids.campaign });
      expect(snap?.targets.find((t) => t.id === target.id)).toMatchObject({
        attemptN: 1,
        attemptOutcome: null,
      });
      const attempt = await prisma.campaignAttempt.findFirstOrThrow({
        where: { targetId: target.id },
      });
      // Named, though: the run exists, so the attempt knows it.
      expect(attempt.runId).toBe(run.id);
      expect(attempt.outcome).toBeNull();
    });

    it('reports the kill switch off when a live target belongs to a team that has it off', async () => {
      const connection = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}other-repo`, teamId: ids.otherTeam },
      });
      const target = await prisma.campaignTarget.create({
        data: {
          campaignId: ids.campaign,
          connectionId: connection.id,
          position: 99,
          repoLabel: 'acme/other',
          teamId: ids.otherTeam,
        },
      });
      expect(
        (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.campaignsEnabled
      ).toBe(false);
      // Once that target is finished its team no longer gates the campaign.
      await prisma.campaignTarget.update({
        data: { state: 'SATISFIED' },
        where: { id: target.id },
      });
      expect(
        (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.campaignsEnabled
      ).toBe(true);
    });

    it('reports a spent budget from this month’s attempts of the campaign, and only those', async () => {
      const spent = await makeRun({ costUsdAccrued: 2, endedAt: new Date(), status: 'SUCCESS' });
      const stranger = await makeRun({
        costUsdAccrued: 500,
        endedAt: new Date(),
        status: 'SUCCESS',
      });
      const target = await makeTarget('PR_OPENED');
      await prisma.campaignAttempt.create({
        data: { n: 1, outcome: 'PR_OPENED', runId: spent.id, targetId: target.id },
      });
      void stranger; // a run that belongs to no attempt of this campaign
      try {
        await prisma.campaign.update({ data: { budgetUsd: 1 }, where: { id: ids.campaign } });
        expect(
          (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.budgetExceeded
        ).toBe(true);
        await prisma.campaign.update({ data: { budgetUsd: 100 }, where: { id: ids.campaign } });
        expect(
          (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.budgetExceeded
        ).toBe(false);
        // An attempt that started in an earlier month does not count against this month's budget.
        await prisma.campaignAttempt.updateMany({
          data: { startedAt: new Date(Date.UTC(2020, 0, 1)) },
          where: { targetId: target.id },
        });
        await prisma.campaign.update({ data: { budgetUsd: 1 }, where: { id: ids.campaign } });
        expect(
          (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.budgetExceeded
        ).toBe(false);
      } finally {
        await prisma.campaign.update({ data: { budgetUsd: null }, where: { id: ids.campaign } });
      }
    });

    it('counts an attempt in flight through its live ledger row and never counts one twice', async () => {
      seq += 1;
      const inflightWf = `${PREFIX}inflight-${seq}`;
      const doneWf = `${PREFIX}done-${seq}`;
      // In flight: cost on the live ledger, no run row linked to the attempt yet.
      await prisma.activeWorkflow.create({
        data: { costUsdAccrued: 3, currentStatus: 'RUNNING', temporalWorkflowId: inflightWf },
      });
      // Finished: the same spend sits on both ledgers; it must count once.
      await prisma.activeWorkflow.create({
        data: { costUsdAccrued: 4, currentStatus: 'COMPLETED', temporalWorkflowId: doneWf },
      });
      const done = await makeRun({
        costUsdAccrued: 4,
        endedAt: new Date(),
        status: 'SUCCESS',
        workflowId: doneWf,
      });
      const t1 = await makeTarget('RUNNING');
      const t2 = await makeTarget('PR_OPENED');
      const a1 = await prisma.campaignAttempt.create({
        data: { childWorkflowId: inflightWf, n: 1, targetId: t1.id },
      });
      await prisma.campaignAttempt.create({
        data: { childWorkflowId: doneWf, n: 1, runId: done.id, targetId: t2.id },
      });
      const exceeded = async (budget: number) => {
        await prisma.campaign.update({ data: { budgetUsd: budget }, where: { id: ids.campaign } });
        return (await readCampaignPass({ campaignId: ids.campaign }))?.campaign.budgetExceeded;
      };
      try {
        // 3 (in flight) + 4 (finished, once) = 7.
        expect(await exceeded(7)).toBe(true);
        expect(await exceeded(7.5)).toBe(false);
        expect(await exceeded(3.5)).toBe(true);
      } finally {
        await prisma.campaign.update({ data: { budgetUsd: null }, where: { id: ids.campaign } });
        await prisma.campaignAttempt.deleteMany({ where: { id: a1.id } });
        await prisma.activeWorkflow.deleteMany({
          where: { temporalWorkflowId: { in: [inflightWf, doneWf] } },
        });
      }
    });

    it('is null for a campaign that does not exist', async () => {
      await expect(readCampaignPass({ campaignId: uuid() })).resolves.toBeNull();
    });
  });

  describe('recordCampaignPass', () => {
    it('lets exactly one of two concurrent writers move a target', async () => {
      const target = await makeTarget('PENDING');
      const write = (reason: string) =>
        recordCampaignPass({
          addTargets: [],
          campaignId: ids.campaign,
          proposals: [],
          updates: [
            {
              expect: 'PENDING',
              failureReason: reason,
              state: 'BLOCKED',
              targetId: target.id,
              teamId: ids.team,
            },
          ],
        });
      const results = await Promise.all([write('first'), write('second')]);
      expect(results.map((r) => r.skipped).sort()).toEqual([0, 1]);
      const row = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.state).toBe('BLOCKED');
      expect(['first', 'second']).toContain(row.failureReason);
    });

    it('never writes a target that is in a final state', async () => {
      const done = await makeTarget('SATISFIED');
      const skipped = await makeTarget('SKIPPED');
      const r = await recordCampaignPass({
        addTargets: [],
        campaignId: ids.campaign,
        proposals: [],
        updates: [
          { expect: 'SATISFIED', state: 'PENDING', targetId: done.id, teamId: ids.team },
          { expect: 'PENDING', state: 'BLOCKED', targetId: skipped.id, teamId: ids.team },
        ],
      });
      // The first is refused outright; the second finds the row is not in the state it expected.
      expect(r.skipped).toBe(2);
      expect(
        (await prisma.campaignTarget.findUniqueOrThrow({ where: { id: done.id } })).state
      ).toBe('SATISFIED');
      expect(
        (await prisma.campaignTarget.findUniqueOrThrow({ where: { id: skipped.id } })).state
      ).toBe('SKIPPED');
    });

    it('stamps finishedAt when a target becomes final and records the stale flag', async () => {
      const target = await makeTarget('MERGED');
      const stale = Date.UTC(2026, 10, 1);
      await recordCampaignPass({
        addTargets: [],
        campaignId: ids.campaign,
        proposals: [],
        updates: [
          {
            expect: 'MERGED',
            staleSince: stale,
            state: 'SATISFIED',
            targetId: target.id,
            teamId: ids.team,
          },
        ],
      });
      const row = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.state).toBe('SATISFIED');
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(row.staleSince?.getTime()).toBe(stale);
    });

    it('appends discovered targets after the last position, once, and records proposals once', async () => {
      const a = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}new-a`, teamId: ids.team },
      });
      const b = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}new-b`, teamId: ids.team },
      });
      const input = {
        addTargets: [
          { connectionId: a.id, label: 'acme/new-a', teamId: ids.team },
          { connectionId: b.id, label: 'acme/new-b', teamId: ids.team },
        ],
        campaignId: ids.campaign,
        proposals: [{ connectionId: b.id, reason: 'the launcher does not lead the team' }],
        updates: [],
      };
      const first = await recordCampaignPass(input);
      expect(first.added.map((x) => x.connectionId)).toEqual([a.id, b.id]);
      const max = await prisma.campaignTarget.aggregate({
        _max: { position: true },
        where: { campaign: { orgId: ids.org }, campaignId: ids.campaign },
      });
      expect(first.added[1]?.position).toBe(max._max.position);
      expect(first.added[1]?.position).toBe((first.added[0]?.position ?? 0) + 1);

      // A repeat of the same call adds nothing and records nothing twice.
      const again = await recordCampaignPass(input);
      expect(again.added).toEqual([]);
      expect(
        await prisma.campaignProposal.count({
          where: { campaignId: ids.campaign, connectionId: b.id },
        })
      ).toBe(1);
      const row = await prisma.campaignTarget.findUniqueOrThrow({
        where: { id: first.added[0]?.targetId },
      });
      expect(row.evidence).toEqual({ kind: 'discovered' });
    });
  });

  describe('runCampaignCheck', () => {
    const satisfiedOut = {
      baseSha: 'c'.repeat(40),
      exitCode: 0,
      stdout:
        'CAMPAIGN_CHECK evidence=declared-at-target detail=at-target declared=4.17.21 resolved=-\n',
    };
    const belowOut = {
      baseSha: 'c'.repeat(40),
      exitCode: 1,
      stdout: 'CAMPAIGN_CHECK evidence=below-target detail=below declared=4.17.20 resolved=-\n',
    };

    it('finishes a merged target, and sends a regressed satisfied one back to PENDING', async () => {
      const merged = await makeTarget('MERGED');
      const r = await runCampaignCheck(
        { campaignId: ids.campaign, targetId: merged.id },
        { run: async () => satisfiedOut }
      );
      expect(r).toMatchObject({ changed: true, state: 'SATISFIED' });
      const row = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: merged.id } });
      expect(row).toMatchObject({ lastCheckedSha: 'c'.repeat(40), state: 'SATISFIED' });
      expect(row.evidence).toMatchObject({ declared: '4.17.21', kind: 'declared-at-target' });

      const regress = await runCampaignCheck(
        { campaignId: ids.campaign, targetId: merged.id },
        { run: async () => belowOut }
      );
      expect(regress).toMatchObject({ changed: true, regressions: 1, state: 'PENDING' });
      const after = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: merged.id } });
      expect(after).toMatchObject({ finishedAt: null, regressions: 1, state: 'PENDING' });
    });

    it('records that a check could not run without moving the target', async () => {
      const merged = await makeTarget('MERGED');
      const r = await runCampaignCheck(
        { campaignId: ids.campaign, targetId: merged.id },
        { run: async () => ({ baseSha: null, exitCode: 3, stdout: '' }) }
      );
      expect(r.status).toBe('could-not-run');
      const row = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: merged.id } });
      expect(row.state).toBe('MERGED');
      expect(row.lastCheckedAt).toBeInstanceOf(Date);
      expect(row.evidence).toMatchObject({ kind: 'cannot-check' });
    });
  });

  describe('discoverCampaignTargets', () => {
    it('walks the scope’s repositories the launcher may see, and reports what the check found', async () => {
      const scoped = await prisma.campaign.create({
        data: {
          description: 'Scoped',
          id: uuid(),
          launchedById: ids.leader,
          maxParallel: 1,
          name: `${PREFIX}scoped`,
          orgId: ids.org,
          ownerTeamId: ids.team,
          recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
          recipeRef: 'npm-dependency@2',
          rescanIntervalHours: 24,
          scopeId: ids.team,
          scopeKind: 'TEAM',
          state: 'ACTIVE',
          templateId: ids.template,
          templateVersion: 1,
          temporalWorkflowId: `campaign-${uuid()}`,
          workflowKind: 'RECONCILER',
          workRequestId: (
            await prisma.runInput.create({
              data: { externalTicketId: `${PREFIX}scoped`, requestPayload: '{}' },
            })
          ).id,
        },
      });
      const unsatisfied = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}scope-bad`, teamId: ids.team },
      });
      const fine = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}scope-fine`, teamId: ids.team },
      });
      // A repository of a team the launcher is not in: never checked, never named.
      await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}hidden`, teamId: ids.otherTeam },
      });
      const checked: string[] = [];
      const out = await discoverCampaignTargets(
        { campaignId: scoped.id, cursor: 0 },
        {
          run: async (input) => {
            checked.push(input.repoId);
            return input.repoId === fine.id
              ? {
                  baseSha: null,
                  exitCode: 0,
                  stdout:
                    'CAMPAIGN_CHECK evidence=not-declared detail=absent declared=- resolved=-\n',
                }
              : {
                  baseSha: null,
                  exitCode: 1,
                  stdout:
                    'CAMPAIGN_CHECK evidence=below-target detail=below declared=4.17.20 resolved=-\n',
                };
          },
        }
      );
      // The fixture campaign's own targets are skipped (known); the hidden repository is not seen.
      expect(checked).toContain(unsatisfied.id);
      expect(checked).toContain(fine.id);
      expect(checked.some((id) => id === ids.otherRepo)).toBe(false);
      const found = out.candidates.find((c) => c.connectionId === unsatisfied.id);
      expect(found).toMatchObject({ reachable: true, satisfied: false, teamId: ids.team });
      expect(out.candidates.some((c) => c.connectionId === fine.id)).toBe(false);
      expect(out.candidates.every((c) => c.teamId === ids.team)).toBe(true);
      expect(out.nextCursor).toBeNull();
    });

    it('skips an unchanged satisfied repository by its marker without cloning, and re-checks it when the base moved', async () => {
      const scoped = await prisma.campaign.create({
        data: {
          description: 'Marker',
          id: uuid(),
          launchedById: ids.leader,
          maxParallel: 1,
          name: `${PREFIX}marker`,
          orgId: ids.org,
          ownerTeamId: ids.team,
          recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
          recipeRef: 'npm-dependency@2',
          scopeId: ids.team,
          scopeKind: 'TEAM',
          state: 'ACTIVE',
          templateId: ids.template,
          templateVersion: 1,
          temporalWorkflowId: `campaign-${uuid()}`,
          workflowKind: 'RECONCILER',
          workRequestId: (
            await prisma.runInput.create({
              data: { externalTicketId: `${PREFIX}marker`, requestPayload: '{}' },
            })
          ).id,
        },
      });
      const repo = await prisma.connection.create({
        data: { organizationName: 'acme', repoName: `${PREFIX}marker-repo`, teamId: ids.team },
      });
      const sha1 = '1'.repeat(40);
      const sha2 = '2'.repeat(40);
      let tip = sha1;
      let verdict =
        'CAMPAIGN_CHECK evidence=declared-at-target detail=at declared=4.17.21 resolved=-\n';
      const clones: string[] = [];
      const deps = {
        resolveTip: async () => tip,
        run: async (input: { repoId: string }) => {
          clones.push(input.repoId);
          return { baseSha: tip, exitCode: verdict.includes('below') ? 1 : 0, stdout: verdict };
        },
      };
      const walk = async () => {
        clones.length = 0;
        return discoverCampaignTargets({ campaignId: scoped.id, cursor: 0 }, deps);
      };
      const marker = () =>
        prisma.campaignDiscoveryCheck.findFirst({
          where: { campaignId: scoped.id, connectionId: repo.id },
        });

      // First walk: checked (cloned), satisfied, marker written at sha1.
      await walk();
      expect(clones).toContain(repo.id);
      expect((await marker())?.baseSha).toBe(sha1);

      // Second walk, base unchanged: not cloned; the cursor still passes it.
      const again = await walk();
      expect(clones).not.toContain(repo.id);
      expect(again.candidates.some((c) => c.connectionId === repo.id)).toBe(false);

      // Base moved and the repository regressed: re-checked, reported, marker removed.
      tip = sha2;
      verdict = 'CAMPAIGN_CHECK evidence=below-target detail=below declared=4.17.20 resolved=-\n';
      const moved = await walk();
      expect(clones).toContain(repo.id);
      expect(moved.candidates.some((c) => c.connectionId === repo.id)).toBe(true);
      expect(await marker()).toBeNull();

      // Satisfied again at the new base: the marker is refreshed in place (one row, new sha).
      verdict =
        'CAMPAIGN_CHECK evidence=declared-at-target detail=at declared=4.17.21 resolved=-\n';
      await walk();
      expect(
        await prisma.campaignDiscoveryCheck.count({
          where: { campaignId: scoped.id, connectionId: repo.id },
        })
      ).toBe(1);
      expect((await marker())?.baseSha).toBe(sha2);

      // An unreadable tip is checked normally.
      deps.resolveTip = async () => null as never;
      await walk();
      expect(clones).toContain(repo.id);

      // Becoming a target drops the marker on the next walk.
      await prisma.campaignTarget.create({
        data: {
          campaignId: scoped.id,
          connectionId: repo.id,
          position: 0,
          repoLabel: 'acme/marker',
          state: 'PENDING',
          teamId: ids.team,
        },
      });
      await walk();
      expect(await marker()).toBeNull();
    });
  });

  describe('run finalization', () => {
    it('records the outcome on the attempt and signals the campaign’s workflow', async () => {
      const run = await makeRun({
        contextSnapshot: { result: { changed: false, path: 'NONE', verification: 'NOT_RUN' } },
        endedAt: new Date(),
        status: 'SUCCESS',
      });
      const target = await makeTarget('RUNNING');
      const attempt = await prisma.campaignAttempt.create({
        data: { childWorkflowId: run.workflowId, n: 1, targetId: target.id },
      });
      temporal.getHandle.mockReturnValue({ signal: temporal.signal });
      temporal.signal.mockResolvedValue(undefined);

      await onCampaignRunFinalized(run.id);
      const row = await prisma.campaignAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row).toMatchObject({ outcome: 'NO_CHANGE', path: 'NONE', runId: run.id });
      expect(temporal.getHandle).toHaveBeenCalledWith(workflowId);
      expect(temporal.signal).toHaveBeenCalledWith('campaignAttemptFinished', {
        attemptN: 1,
        runId: run.id,
        targetId: target.id,
      });

      // The same finish delivered twice records and signals once.
      temporal.signal.mockClear();
      await onCampaignRunFinalized(run.id);
      expect(temporal.signal).not.toHaveBeenCalled();
    });
  });

  describe('cancelling', () => {
    it('cancels the attempts in flight, then closes the targets that delivered nothing', async () => {
      const running = await makeTarget('RUNNING');
      const run = await makeRun({ status: 'RUNNING' });
      await prisma.campaignAttempt.create({
        data: { childWorkflowId: run.workflowId, n: 1, runId: run.id, targetId: running.id },
      });
      const pending = await makeTarget('PENDING');
      const draft = await makeTarget('PR_OPENED');
      const satisfied = await makeTarget('SATISFIED');
      temporal.getHandle.mockReturnValue({ cancel: temporal.cancel });
      temporal.cancel.mockResolvedValue(undefined);

      const cancelled = await cancelCampaignAttempts({ campaignId: ids.campaign });
      expect(cancelled.cancelled).toBeGreaterThanOrEqual(1);
      expect(temporal.getHandle).toHaveBeenCalledWith(run.workflowId);
      expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        'CANCELLED'
      );
      expect(
        (await prisma.campaignAttempt.findFirstOrThrow({ where: { targetId: running.id } })).outcome
      ).toBe('CANCELLED');

      await prisma.campaign.update({ data: { state: 'CANCELLING' }, where: { id: ids.campaign } });
      await finalizeCampaignReconciler({ campaignId: ids.campaign, outcome: 'CANCELLED' });
      const state = async (id: string) =>
        (await prisma.campaignTarget.findUniqueOrThrow({ where: { id } })).state;
      expect(await state(running.id)).toBe('CANCELLED');
      expect(await state(pending.id)).toBe('CANCELLED');
      // An open draft and a satisfied target keep their state: a cancel un-opens nothing.
      expect(await state(draft.id)).toBe('PR_OPENED');
      expect(await state(satisfied.id)).toBe('SATISFIED');
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: ids.campaign } });
      expect(campaign.state).toBe('CANCELLED');
      expect(campaign.completedAt).toBeInstanceOf(Date);
    });
  });

  describe('the migration backfill', () => {
    // The statements after the "-- Backfill." marker of the migration that added goal tracking, run
    // against temp tables that shadow the real ones (`pg_temp` is searched first), so the real SQL
    // is exercised over legacy-shaped rows without touching anything else in the database.
    const migration = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../shared/src/prisma/migrations/20261125200100_campaign_goal_tracking/migration.sql'
      ),
      'utf8'
    );
    const backfill = migration
      .slice(migration.indexOf('-- Backfill.'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      // The closing `ALTER … SET NOT NULL` is DDL after the backfill, not a data statement.
      .filter((s) => s.length > 0 && !s.startsWith('ALTER TABLE'));

    it('finds every statement of the backfill', () => {
      expect(backfill).toHaveLength(4);
      expect(backfill[0]).toMatch(/^UPDATE "campaigns" SET "launched_by_id"/);
      expect(backfill[1]).toMatch(/^INSERT INTO "campaign_attempts"/);
    });

    it('maps the states of campaigns that finished, and leaves a running legacy campaign alone', async () => {
      const done = uuid();
      const running = uuid();
      const tmpl = ids.template;
      const created = uuid();
      type Row = Record<string, unknown>;
      const rows = await prisma.$transaction(async (tx) => {
        // CLAUDE.md §7 exception: the migration's own SQL is the thing under test; temp tables
        // shadow the real ones for this transaction only.
        const sql = (q: string, ...p: unknown[]) => tx.$executeRawUnsafe(q, ...p);
        await sql(
          'CREATE TEMP TABLE campaigns (LIKE public.campaigns INCLUDING DEFAULTS) ON COMMIT DROP'
        );
        await sql(
          'CREATE TEMP TABLE campaign_targets (LIKE public.campaign_targets INCLUDING DEFAULTS) ON COMMIT DROP'
        );
        await sql(
          'CREATE TEMP TABLE campaign_attempts (LIKE public.campaign_attempts INCLUDING DEFAULTS) ON COMMIT DROP'
        );
        for (const [id, state] of [
          [done, 'COMPLETED_WITH_FAILURES'],
          [running, 'RUNNING'],
        ] as const) {
          await sql(
            `INSERT INTO campaigns (id, name, description, owner_team_id, org_id, template_id, template_version,
               max_parallel, state, temporal_workflow_id, work_request_id, created_by_id)
             VALUES ($1::uuid, 'c', 'd', $2::uuid, $3::uuid, $4::uuid, 1, 2, $5::"CampaignState", $6, gen_random_uuid(), $7::uuid)`,
            id,
            ids.team,
            ids.org,
            tmpl,
            state,
            `campaign-${id}`,
            ids.leader
          );
        }
        const target = (
          campaignId: string,
          state: string,
          child: string | null,
          position: number
        ) =>
          sql(
            `INSERT INTO campaign_targets (id, campaign_id, team_id, repo_label, position, state, child_workflow_id,
               path, verification, failure_reason, started_at, finished_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::"CampaignTargetState", $6,
               'RECIPE'::"CampaignTargetPath", 'PASSED'::"CampaignVerification",
               CASE WHEN $5 = 'FAILED' THEN 'tests failed' ELSE NULL END, now(), now())`,
            campaignId,
            ids.team,
            `acme/${state}-${position}`,
            position,
            state,
            child
          );
        await target(done, 'NOT_AFFECTED', `campaign-${done}-a`, 1);
        await target(done, 'FAILED', `campaign-${done}-b`, 2);
        await target(done, 'PR_OPENED', `campaign-${done}-c`, 3);
        await target(done, 'SKIPPED', null, 4);
        await target(running, 'NOT_AFFECTED', `campaign-${running}-a`, 1);
        await target(running, 'FAILED', `campaign-${running}-b`, 2);

        for (const statement of backfill) {
          await sql(statement);
        }
        const targets = (await tx.$queryRawUnsafe(
          `SELECT c.state AS campaign_state, t.state, t.evidence, t.failure_reason, t.last_checked_at IS NOT NULL AS checked
             FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
            ORDER BY t.campaign_id = '${done}' DESC, t.position`
        )) as Row[];
        const attempts = (await tx.$queryRawUnsafe(
          `SELECT t.state AS target_state, a.n, a.outcome, a.child_workflow_id, a.path, a.verification,
                  a.failure_reason
             FROM campaign_attempts a JOIN campaign_targets t ON t.id = a.target_id
            ORDER BY t.campaign_id = '${done}' DESC, t.position`
        )) as Row[];
        const launched = (await tx.$queryRawUnsafe(
          `SELECT id::text AS id, launched_by_id::text AS launched_by_id FROM campaigns`
        )) as Row[];
        return { attempts, launched, targets };
      });
      void created;

      // The finished campaign's targets are remapped; PR_OPENED and SKIPPED are untouched.
      expect(rows.targets.slice(0, 4).map((t) => t.state)).toEqual([
        'SATISFIED',
        'NEEDS_ATTENTION',
        'PR_OPENED',
        'SKIPPED',
      ]);
      expect(rows.targets[0]?.evidence).toEqual({ kind: 'initial' });
      expect(rows.targets[0]?.checked).toBe(true);
      expect(rows.targets[1]?.failure_reason).toBe('tests failed');
      // The campaign that is still running on the legacy workflow keeps the values it reads.
      expect(rows.targets.slice(4).map((t) => t.state)).toEqual(['NOT_AFFECTED', 'FAILED']);
      // Every target that started a child became attempt 1, with the outcome its state meant.
      expect(rows.attempts.map((a) => [a.target_state, a.n, a.outcome])).toEqual([
        ['SATISFIED', 1, 'NO_CHANGE'],
        ['NEEDS_ATTENTION', 1, 'FAILED'],
        ['PR_OPENED', 1, 'PR_OPENED'],
        ['NOT_AFFECTED', 1, 'NO_CHANGE'],
        ['FAILED', 1, 'FAILED'],
      ]);
      expect(rows.attempts[0]).toMatchObject({ path: 'RECIPE', verification: 'PASSED' });
      expect(rows.attempts[1]?.failure_reason).toBe('tests failed');
      // The acting identity was the creator.
      expect(rows.launched.every((c) => c.launched_by_id === ids.leader)).toBe(true);
      // Nothing of the real tables was touched.
      expect(
        await prisma.campaignTarget.count({
          where: { campaign: { orgId: ids.org }, campaignId: done },
        })
      ).toBe(0);
    });
  });

  describe('settling a campaign (COMPLETED or MONITORING)', () => {
    /** A campaign of its own, so its targets are exactly what the test makes. */
    async function makeCampaign(recipeRef: string | null) {
      seq += 1;
      const id = uuid();
      const runInput = await prisma.runInput.create({
        data: { externalTicketId: `${PREFIX}settle-${seq}`, requestPayload: '{}' },
      });
      await prisma.campaign.create({
        data: {
          description: 'Raise lodash everywhere',
          id,
          launchedById: ids.leader,
          maxParallel: 2,
          name: `${PREFIX}settle-${seq}`,
          orgId: ids.org,
          ownerTeamId: ids.team,
          recipeRef,
          state: 'ACTIVE',
          templateId: ids.template,
          templateVersion: 1,
          temporalWorkflowId: `campaign-${id}`,
          workflowKind: 'RECONCILER',
          workRequestId: runInput.id,
        },
      });
      return id;
    }
    async function addTarget(campaignId: string, state: string) {
      seq += 1;
      const connection = await prisma.connection.create({
        data: {
          organizationName: 'acme',
          repoName: `${PREFIX}settle-repo-${seq}`,
          teamId: ids.team,
        },
      });
      return prisma.campaignTarget.create({
        data: {
          campaignId,
          connectionId: connection.id,
          position: seq,
          repoLabel: `acme/${PREFIX}settle-repo-${seq}`,
          state: state as never,
          teamId: ids.team,
        },
      });
    }
    const settle = (campaignId: string, to: 'COMPLETED' | 'MONITORING') =>
      recordCampaignPass({
        addTargets: [],
        campaign: { from: 'ACTIVE', to },
        campaignId,
        proposals: [],
        updates: [],
      });

    it('refuses to complete over a target inserted after the pass read its targets, and settles once it is final', async () => {
      const campaignId = await makeCampaign('npm-dependency@2');
      await addTarget(campaignId, 'SATISFIED');
      // The pass reads: every target is final, so it decides COMPLETED...
      const snapshot = await readCampaignPass({ campaignId });
      expect(snapshot?.targets.every((t) => t.state === 'SATISFIED')).toBe(true);
      // ...a person adds a repository before the write...
      const added = await addTarget(campaignId, 'PENDING');
      const refused = await settle(campaignId, 'COMPLETED');
      expect(refused.campaignChanged).toBe(false);
      const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(after.state).toBe('ACTIVE');
      expect(after.completedAt).toBeNull();
      // ...and the next pass sees it.
      expect((await readCampaignPass({ campaignId }))?.targets.map((t) => t.state).sort()).toEqual([
        'PENDING',
        'SATISFIED',
      ]);
      await prisma.campaignTarget.update({ data: { state: 'SKIPPED' }, where: { id: added.id } });
      expect((await settle(campaignId, 'COMPLETED')).campaignChanged).toBe(true);
      const done = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(done.state).toBe('COMPLETED');
      expect(done.completedAt).toBeInstanceOf(Date);
    });

    it('refuses a MONITORING write over an open target too', async () => {
      const campaignId = await makeCampaign('npm-dependency@2');
      await addTarget(campaignId, 'SATISFIED');
      await addTarget(campaignId, 'RUNNING');
      expect((await settle(campaignId, 'MONITORING')).campaignChanged).toBe(false);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).state).toBe(
        'ACTIVE'
      );
    });

    it('treats a MERGED target as done for a campaign with no check, and as open for one with a check', async () => {
      const noCheck = await makeCampaign(null);
      await addTarget(noCheck, 'MERGED');
      expect((await settle(noCheck, 'COMPLETED')).campaignChanged).toBe(true);
      const withCheck = await makeCampaign('npm-dependency@2');
      await addTarget(withCheck, 'MERGED');
      expect((await settle(withCheck, 'COMPLETED')).campaignChanged).toBe(false);
    });

    const passUpdate = (campaignId: string, over: Record<string, unknown>) =>
      recordCampaignPass({
        addTargets: [],
        campaignId,
        proposals: [],
        updates: [{ teamId: ids.team, ...over } as never],
      });

    it('stamps finishedAt on a MERGED target of a campaign with no check, and not of one with a check', async () => {
      for (const [recipeRef, stamped] of [
        [null, true],
        ['npm-dependency@2', false],
      ] as const) {
        const campaignId = await makeCampaign(recipeRef);
        const target = await addTarget(campaignId, 'PR_OPENED');
        await passUpdate(campaignId, { expect: 'PR_OPENED', state: 'MERGED', targetId: target.id });
        const row = await prisma.campaignTarget.findUniqueOrThrow({ where: { id: target.id } });
        expect(row.state).toBe('MERGED');
        expect(row.finishedAt !== null).toBe(stamped);
      }
    });

    it('lets a MERGED target of a campaign with no check stop gating on its team’s kill switch', async () => {
      for (const [recipeRef, enabled] of [
        [null, true],
        ['npm-dependency@2', false],
      ] as const) {
        const campaignId = await makeCampaign(recipeRef);
        const connection = await prisma.connection.create({
          data: {
            organizationName: 'acme',
            repoName: `${PREFIX}ks-${uuid()}`,
            teamId: ids.otherTeam,
          },
        });
        await prisma.campaignTarget.create({
          data: {
            campaignId,
            connectionId: connection.id,
            position: 1,
            repoLabel: 'acme/ks',
            state: 'MERGED',
            teamId: ids.otherTeam,
          },
        });
        expect((await readCampaignPass({ campaignId }))?.campaign.campaignsEnabled).toBe(enabled);
      }
    });

    it('sets the stale flag once: a retry of the same write matches no row, and a new episode matches again', async () => {
      const campaignId = await makeCampaign('npm-dependency@2');
      const target = await addTarget(campaignId, 'PR_OPENED');
      const since = Date.UTC(2026, 10, 1);
      const set = {
        expect: 'PR_OPENED',
        staleSince: since,
        state: 'PR_OPENED',
        targetId: target.id,
      };
      expect((await passUpdate(campaignId, set)).skipped).toBe(0);
      expect((await passUpdate(campaignId, set)).skipped).toBe(1);
      expect(
        (
          await prisma.campaignTarget.findUniqueOrThrow({ where: { id: target.id } })
        ).staleSince?.getTime()
      ).toBe(since);
      // Not stale any more, then stale again: the write lands again.
      await passUpdate(campaignId, { ...set, staleSince: null });
      expect((await passUpdate(campaignId, { ...set, staleSince: since + 1000 })).skipped).toBe(0);
    });

    it('re-checks at the longer of the campaign’s interval and the organization’s rescan floor', async () => {
      const campaignId = await makeCampaign('npm-dependency@2');
      await prisma.campaign.update({ data: { rescanIntervalHours: 6 }, where: { id: campaignId } });
      _resetConfigCacheForTests();
      expect((await readCampaignPass({ campaignId }))?.campaign.rescanIntervalHours).toBe(6);
      await prisma.configSetting.create({
        data: {
          key: 'workflow.campaignRescanFloorHours',
          orgId: ids.org,
          scope: 'ORGANIZATION',
          value: 48,
        },
      });
      try {
        _resetConfigCacheForTests();
        expect((await readCampaignPass({ campaignId }))?.campaign.rescanIntervalHours).toBe(48);
      } finally {
        await prisma.configSetting.deleteMany({
          where: { key: 'workflow.campaignRescanFloorHours', orgId: ids.org },
        });
        _resetConfigCacheForTests();
      }
    });

    it('lets one of two concurrent settles through, and none over a campaign that already moved', async () => {
      const campaignId = await makeCampaign('npm-dependency@2');
      await addTarget(campaignId, 'SATISFIED');
      const results = await Promise.all([
        settle(campaignId, 'COMPLETED'),
        settle(campaignId, 'COMPLETED'),
      ]);
      expect(results.filter((r) => r.campaignChanged)).toHaveLength(1);
    });
  });
});
