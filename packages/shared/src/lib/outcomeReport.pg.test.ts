import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import type { OutcomeReport } from '../workflow/outcomeMetrics.js';
import { buildOutcomeReport, OUTCOME_REPORT_LOOKBACK_DAYS } from './outcomeReport.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * `buildOutcomeReport` against real Postgres: its cohort and join behaviour (which runs are read,
 * which pull requests, steps, template versions and ledger rows attach to them) is a set of
 * relational selects that a fake Prisma client only echoes back.
 *
 * Opt in with `OUTCOME_REPORT_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 *
 * Every run starts in 2020, inside a fixed window, so rows other suites leave behind (they start
 * "now") fall outside the cohort. The report reads runs back to `OUTCOME_REPORT_LOOKBACK_DAYS`
 * before the window start, and the items are:
 *
 *   ENG  (a template with a pull-request step), repositories R1 and R2
 *     A  merged, one review-fix round and one CI-fix round that healed
 *     B  pull request closed unmerged (CI fix did not heal)
 *     C  run failed without a pull request
 *     F  pull request still open
 *     G  run still in flight; its cost is only on the legacy ledger row
 *     S  first run exactly at the window start (in)
 *     Z  retry whose first attempt predates the lookback (the item starts at the retry)
 *     I  PR-feedback run naming no originating run (unlinked follow-up)
 *     M  merged, on R2
 *     P  starts one millisecond before the window (out)
 *     Q  failed attempt inside the lookback, merged retry inside the window (out: item starts early)
 *     Y  failed attempt exactly at the read boundary, merged retry in the window (out, same reason)
 *     W  first run exactly at the window end (out: the end is exclusive)
 *     X  starts after the window (out)
 *   ENG2  D: a failed first attempt, then a merged retry for the same ticket
 *   ENG3  E: a merged run plus two review-findings follow-ups that must join it
 *   DOC   H: a template with no pull-request step, so its work is outside the merge rate
 */
const enabled = process.env.OUTCOME_REPORT_PG_TEST === '1';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WINDOW = { end: new Date('2020-04-01T00:00:00Z'), start: new Date('2020-03-01T00:00:00Z') };
const READ_FROM = new Date(WINDOW.start.getTime() - OUTCOME_REPORT_LOOKBACK_DAYS * DAY_MS);
const NOW = new Date('2020-04-02T09:00:00Z');

const at = (iso: string) => new Date(iso);

type RunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';
type PrStatus = 'OPEN' | 'MERGED' | 'CLOSED';

describe.skipIf(!enabled)('outcome report against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;
  const runIds: string[] = [];
  const workflowIds: string[] = [];
  let report: OutcomeReport;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'WorkflowTemplate', 'Organization'],
      fn
    );

  async function run(opts: {
    cost?: number;
    key: string;
    ledgerCost?: number;
    payload?: Record<string, unknown>;
    repo?: 'repo1' | 'repo2';
    startedAt: Date;
    status: RunStatus;
    synthetic?: boolean;
    template: 'eng' | 'eng2' | 'eng3' | 'doc';
    ticket: string;
  }): Promise<string> {
    const repo = ids[opts.repo ?? 'repo1'] as string;
    const workflowId = `wf-or-${opts.key}-${suffix}`;
    const request = await prisma.runInput.create({
      data: {
        connectionId: repo,
        description: `or ${opts.key} ${suffix}`,
        externalTicketId: `OR-${opts.ticket}-${suffix}`,
        ...(opts.payload ? { payload: opts.payload as never } : {}),
        requestPayload: '{}',
        ticketIsSynthetic: opts.synthetic ?? false,
      },
    });
    const created = await prisma.workflowRun.create({
      data: {
        attributedRepoId: repo,
        connectionId: repo,
        costUsdAccrued: opts.cost ?? 0,
        specSnapshot: {},
        startedAt: opts.startedAt,
        status: opts.status,
        templateId: ids[opts.template] as string,
        templateVersion: 1,
        workflowId,
        workRequestId: request.id,
      },
    });
    if (opts.ledgerCost !== undefined) {
      await prisma.activeWorkflow.create({
        data: {
          costUsdAccrued: opts.ledgerCost,
          currentStatus: 'IMPLEMENTING',
          repoId: repo,
          temporalWorkflowId: workflowId,
          workRequestId: request.id,
        },
      });
    }
    ids[`run${opts.key}`] = created.id;
    runIds.push(created.id);
    workflowIds.push(workflowId);
    return created.id;
  }

  const pullRequest = (
    key: string,
    status: PrStatus,
    extra: { ciStatus?: string; mergedAt?: Date; repo?: 'repo1' | 'repo2' } = {}
  ) =>
    prisma.pullRequest.create({
      data: {
        ciStatus: extra.ciStatus ?? 'PENDING',
        headSha: `sha-${key}`,
        mergedAt: extra.mergedAt ?? null,
        repoId: ids[extra.repo ?? 'repo1'] as string,
        runId: ids[`run${key}`] as string,
        status,
      },
    });

  const step = (
    key: string,
    nodeId: string,
    stepName: string,
    status: 'PASSED' | 'FAILED' | 'PENDING'
  ) =>
    prisma.workflowStep.create({
      data: { nodeId, runId: ids[`run${key}`] as string, status, stepName },
    });

  const REVIEW = 'executeReviewFixImplementation';
  const CI_FIX = 'executeCIFixImplementation';

  beforeAll(async () => {
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `or-org-${suffix}`, slug: `or-org-${suffix}` },
        })
      ).id;
      ids.team = (
        await prisma.team.create({
          data: { name: `or-team-${suffix}`, orgId: ids.org, slug: `or-team-${suffix}` },
        })
      ).id;
      for (const key of ['repo1', 'repo2']) {
        ids[key] = (
          await prisma.connection.create({
            data: {
              organizationName: `or-${suffix}`,
              repoName: key,
              teamId: ids.team as string,
              type: 'git_repo',
            },
          })
        ).id;
      }
      // GLOBAL templates (no team), each pinning version 1. `createOrUpdatePullRequest` is a step
      // that can open a pull request; `summarize` is not.
      const prSpec = { nodes: [{ id: 'pr', step: 'createOrUpdatePullRequest' }] };
      const noPrSpec = { nodes: [{ id: 'sum', step: 'summarize' }] };
      for (const [key, spec] of [
        ['eng', prSpec],
        ['eng2', prSpec],
        ['eng3', prSpec],
        ['doc', noPrSpec],
      ] as const) {
        ids[key] = (
          await prisma.workflowTemplate.create({
            data: {
              activeVersion: 1,
              name: `or-${key}-${suffix}`,
              status: 'ACTIVE',
              versions: { create: { spec, version: 1 } },
            },
          })
        ).id;
      }
    });

    // A: merged on the first run, one review round and one CI-fix round that healed.
    await run({
      cost: 2,
      key: 'A',
      startedAt: at('2020-03-02T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'A',
    });
    await pullRequest('A', 'MERGED', { ciStatus: 'PASSED', mergedAt: at('2020-03-02T06:00:00Z') });
    await step('A', 'review-1', REVIEW, 'PASSED');
    await step('A', 'review-2', REVIEW, 'PENDING'); // not finished: not a round
    await step('A', 'ci-1', CI_FIX, 'PASSED');
    await step('A', 'other-1', 'executeImplementation', 'PASSED'); // not a fix-loop step

    // B: closed unmerged; a CI fix ran and CI never passed.
    await run({
      cost: 3,
      key: 'B',
      startedAt: at('2020-03-02T01:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'B',
    });
    await pullRequest('B', 'CLOSED', { ciStatus: 'FAILED' });
    await step('B', 'ci-1', CI_FIX, 'FAILED');
    // B's fix was stopped by the test-integrity guard; a second event is a gate that could not
    // read the change and is not a trip.
    for (const outputJson of [
      { blocked: true, mode: 'block' },
      { blocked: true, degraded: true, mode: 'block' },
    ]) {
      await prisma.agentTrace.create({
        data: {
          agentKey: 'ciFixer',
          nodeId: 'implementerSession',
          outputJson,
          runId: ids.runB as string,
          seq: outputJson.degraded ? 1 : 0,
          toolName: 'ci_fix.test_integrity_guard',
          type: 'activity_event',
        },
      });
    }

    // C: failed, never opened a pull request.
    await run({
      cost: 1,
      key: 'C',
      startedAt: at('2020-03-02T02:00:00Z'),
      status: 'FAILED',
      template: 'eng',
      ticket: 'C',
    });

    // F: pull request still open.
    await run({
      cost: 1,
      key: 'F',
      startedAt: at('2020-03-02T03:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'F',
    });
    await pullRequest('F', 'OPEN');

    // G: in flight, cost only on the legacy ledger row (the run's own cost is 0).
    await run({
      key: 'G',
      ledgerCost: 0.5,
      startedAt: at('2020-03-02T04:00:00Z'),
      status: 'RUNNING',
      template: 'eng',
      ticket: 'G',
    });

    // S: first run exactly at the window start. Merged an hour later.
    await run({
      cost: 1,
      key: 'S',
      startedAt: WINDOW.start,
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'S',
    });
    await pullRequest('S', 'MERGED', { mergedAt: new Date(WINDOW.start.getTime() + HOUR_MS) });

    // Z: its first attempt is one millisecond before the read boundary, so it is never read and
    // the item starts at the retry.
    await run({
      cost: 9,
      key: 'Z1',
      startedAt: new Date(READ_FROM.getTime() - 1),
      status: 'FAILED',
      template: 'eng',
      ticket: 'Z',
    });
    await run({
      cost: 1,
      key: 'Z',
      startedAt: at('2020-03-10T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'Z',
    });
    await pullRequest('Z', 'MERGED', { mergedAt: at('2020-03-10T02:00:00Z') });

    // I: a PR-feedback run naming a pull request and a GitHub event, but no originating run.
    await run({
      cost: 0.25,
      key: 'I',
      payload: { feedbackEventId: '777', feedbackTrigger: 'pr_comment', pullRequestNumber: 9 },
      startedAt: at('2020-03-11T00:00:00Z'),
      status: 'SUCCESS',
      synthetic: true,
      template: 'eng',
      ticket: 'I',
    });

    // M: merged, on the second repository.
    await run({
      cost: 2,
      key: 'M',
      repo: 'repo2',
      startedAt: at('2020-03-06T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'M',
    });
    await pullRequest('M', 'MERGED', { mergedAt: at('2020-03-07T00:00:00Z'), repo: 'repo2' });

    // Items outside the cohort, each merged with a large cost so any leak moves a figure.
    await run({
      cost: 100,
      key: 'P',
      startedAt: new Date(WINDOW.start.getTime() - 1),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'P',
    });
    await pullRequest('P', 'MERGED', { mergedAt: at('2020-03-01T01:00:00Z') });
    await run({
      cost: 50,
      key: 'Q1',
      startedAt: new Date(READ_FROM.getTime() + 5 * DAY_MS),
      status: 'FAILED',
      template: 'eng',
      ticket: 'Q',
    });
    await run({
      cost: 50,
      key: 'Q',
      startedAt: at('2020-03-02T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'Q',
    });
    await pullRequest('Q', 'MERGED', { mergedAt: at('2020-03-02T05:00:00Z') });
    await run({
      cost: 9,
      key: 'Y1',
      startedAt: READ_FROM,
      status: 'FAILED',
      template: 'eng',
      ticket: 'Y',
    });
    await run({
      cost: 1,
      key: 'Y',
      startedAt: at('2020-03-05T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'Y',
    });
    await pullRequest('Y', 'MERGED', { mergedAt: at('2020-03-05T05:00:00Z') });
    await run({
      cost: 70,
      key: 'W',
      startedAt: WINDOW.end,
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'W',
    });
    await pullRequest('W', 'MERGED', { mergedAt: at('2020-04-01T05:00:00Z') });
    await run({
      cost: 70,
      key: 'X',
      startedAt: at('2020-05-01T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng',
      ticket: 'X',
    });
    await pullRequest('X', 'MERGED', { mergedAt: at('2020-05-01T05:00:00Z') });

    // D (ENG2): a failed first attempt, then a merged retry for the same ticket and repository.
    await run({
      cost: 4,
      key: 'D1',
      startedAt: at('2020-03-03T00:00:00Z'),
      status: 'FAILED',
      template: 'eng2',
      ticket: 'D',
    });
    await run({
      cost: 1,
      key: 'D',
      startedAt: at('2020-03-04T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng2',
      ticket: 'D',
    });
    await pullRequest('D', 'MERGED', { mergedAt: at('2020-03-04T12:00:00Z') });

    // E (ENG3): a merged run and two follow-ups that name it, by each recorded shape.
    await run({
      cost: 2,
      key: 'E',
      startedAt: at('2020-03-05T00:00:00Z'),
      status: 'SUCCESS',
      template: 'eng3',
      ticket: 'E',
    });
    await pullRequest('E', 'MERGED', { mergedAt: at('2020-03-05T06:00:00Z') });
    await run({
      cost: 1.5,
      key: 'E2',
      payload: {
        feedbackEventId: ids.runE as string,
        feedbackTrigger: 'review_findings',
        pullRequestNumber: 7,
      },
      startedAt: at('2020-03-05T08:00:00Z'),
      status: 'SUCCESS',
      synthetic: true,
      template: 'eng3',
      ticket: 'E2',
    });
    await step('E2', 'review-1', REVIEW, 'PASSED');
    await step('E2', 'review-2', REVIEW, 'FAILED');
    await step('E2', 'review-3', REVIEW, 'PENDING');
    await run({
      cost: 0.5,
      key: 'E3',
      payload: { reviewFixOfRunId: ids.runE as string },
      startedAt: at('2020-03-05T09:00:00Z'),
      status: 'SUCCESS',
      synthetic: true,
      template: 'eng3',
      ticket: 'E3',
    });
    await step('E3', 'review-1', REVIEW, 'PASSED');

    // H (DOC): no step of its pinned version can open a pull request.
    await run({
      cost: 0.75,
      key: 'H',
      repo: 'repo2',
      startedAt: at('2020-03-08T00:00:00Z'),
      status: 'SUCCESS',
      template: 'doc',
      ticket: 'H',
    });

    report = await buildOutcomeReport(prisma, { now: NOW, window: WINDOW });
  });

  afterAll(async () => {
    await prisma.pullRequest.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } }); // cascades steps
    await prisma.activeWorkflow.deleteMany({ where: { temporalWorkflowId: { in: workflowIds } } });
    await prisma.runInput.deleteMany({ where: { description: { endsWith: ` ${suffix}` } } });
    await unscoped(async () => {
      const templates = ['eng', 'eng2', 'eng3', 'doc']
        .map((k) => ids[k])
        .filter(Boolean) as string[];
      await prisma.workflowTemplate.deleteMany({ where: { id: { in: templates } } }); // cascades versions
      await prisma.connection.deleteMany({
        where: { id: { in: [ids.repo1, ids.repo2].filter(Boolean) as string[] } },
      });
      await prisma.team.deleteMany({ where: { id: ids.team } });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.$disconnect();
  });

  const template = (key: string) => {
    const row = report.byTemplate.find((t) => t.templateId === ids[key]);
    expect(row, `template ${key} in the report`).toBeDefined();
    return row as NonNullable<typeof row>;
  };
  const repo = (key: string) => {
    const row = report.byRepo.find((r) => r.repoId === ids[key]);
    expect(row, `repository ${key} in the report`).toBeDefined();
    return row as NonNullable<typeof row>;
  };

  it('reports the window it was given and only our four templates in it', () => {
    expect(report.window).toEqual({
      end: WINDOW.end.toISOString(),
      start: WINDOW.start.toISOString(),
    });
    expect(report.byTemplate.map((t) => t.templateId).sort()).toEqual(
      [ids.eng, ids.eng2, ids.eng3, ids.doc].sort()
    );
  });

  it('separates merged, closed-unmerged, no-PR, open and running items', () => {
    const eng = template('eng');
    expect(eng.states).toEqual({
      closed_unmerged: 1,
      merged: 4, // A, S, Z, M
      no_pr: 1,
      open: 1,
      running: 1,
    });
    expect(eng.workItems).toBe(9); // the eight merge-rate items plus the unlinked follow-up
    expect(eng.prWorkItems).toBe(8);
    expect(eng.settledItems).toBe(6);
    expect(eng.mergeRate).toBeCloseTo(4 / 6);
    expect(eng.decidedPrMergeRate).toBeCloseTo(4 / 5);
    expect(eng.prsOpened).toBe(6);
    expect(eng.prsMerged).toBe(4);
    expect(eng.prsClosedUnmerged).toBe(1);
    expect(eng.runs).toBe(9);
  });

  it('counts finished fix-loop steps and the CI-heal rate from real step rows', () => {
    const eng = template('eng');
    // Items with a pull request: A, B, F, S, Z, M. Only A had a finished review round.
    expect(eng.reviewRounds).toMatchObject({ itemsWithAnyRound: 1, itemsWithPr: 6, max: 1 });
    // A (PASSED CI) healed, B (CLOSED, CI FAILED) did not.
    expect(eng.ciHeal).toMatchObject({ itemsHealed: 1, itemsWithCiFix: 2 });
    expect(eng.ciHeal.rate).toBeCloseTo(0.5);
  });

  it('counts test-integrity guard trips from real trace rows, a degraded gate excluded', () => {
    const eng = template('eng');
    expect(eng.ciHeal.guard).toEqual({ blocked: 1, itemsTripped: 1, trips: 1 });
    expect(report.inputs.guardTrips).toBeGreaterThanOrEqual(1);
  });

  it('keeps a PR-less template in noPrWork, out of the merge-rate denominators', () => {
    const doc = template('doc');
    expect(doc.workItems).toBe(1);
    expect(doc.prWorkItems).toBe(0);
    expect(doc.settledItems).toBe(0);
    expect(doc.mergeRate).toBeNull();
    expect(doc.states).toEqual({ closed_unmerged: 0, merged: 0, no_pr: 0, open: 0, running: 0 });
    expect(doc.noPrWork).toEqual({ costUsd: 0.75, items: 1, runs: 1 });
    expect(doc.cost.totalUsd).toBeCloseTo(0.75);
    expect(doc.cost.perMergedPr).toBeNull();
    expect(report.overall.noPrWork).toEqual({ costUsd: 0.75, items: 1, runs: 1 });
  });

  it('reports a follow-up that names no originating run outside the merge rate', () => {
    expect(template('eng').unlinkedFollowUps).toEqual({ costUsd: 0.25, items: 1, runs: 1 });
    expect(report.overall.unlinkedFollowUps).toEqual({ costUsd: 0.25, items: 1, runs: 1 });
  });

  it('joins review-findings follow-ups to their originating item: cost and review rounds', () => {
    const eng3 = template('eng3');
    expect(eng3.workItems).toBe(1); // three runs, one item
    expect(eng3.runs).toBe(3);
    expect(eng3.states.merged).toBe(1);
    expect(eng3.unlinkedFollowUps.items).toBe(0);
    expect(eng3.cost.mergedItemsUsd).toBeCloseTo(4); // 2 + 1.5 + 0.5
    expect(eng3.cost.perMergedPr).toBeCloseTo(4);
    // E2: a PASSED and a FAILED round (the PENDING one is not a round); E3: one PASSED.
    expect(eng3.reviewRounds).toMatchObject({ itemsWithAnyRound: 1, itemsWithPr: 1, max: 3 });
    expect(eng3.reviewRounds.mean).toBeCloseTo(3);
  });

  it('includes a failed earlier attempt in the cost per merged PR', () => {
    const eng2 = template('eng2');
    expect(eng2.workItems).toBe(1);
    expect(eng2.runs).toBe(2);
    expect(eng2.runsByStatus).toEqual({ FAILED: 1, SUCCESS: 1 });
    expect(eng2.states.merged).toBe(1);
    expect(eng2.prsMerged).toBe(1);
    expect(eng2.cost.mergedItemsUsd).toBeCloseTo(5);
    expect(eng2.cost.perMergedPr).toBeCloseTo(5); // 4 (failed) + 1 (merged retry), not 1
    // The item starts at its first attempt, a day and a half before the merge.
    expect(eng2.timeToMergeMs).toMatchObject({ median: 36 * HOUR_MS, n: 1 });
  });

  it('prices a run with no cost of its own from its ledger row', () => {
    const eng = template('eng');
    // G is running with cost 0 on the run and 0.5 on its ledger row.
    expect(eng.cost.undecidedUsd).toBeCloseTo(1.5); // F 1 + G 0.5
    expect(eng.cost.mergedItemsUsd).toBeCloseTo(6); // A 2 + S 1 + Z 1 + M 2
    expect(eng.cost.unmergedSettledUsd).toBeCloseTo(4); // B 3 + C 1
    expect(eng.cost.totalUsd).toBeCloseTo(11.75);
    expect(eng.cost.perMergedPr).toBeCloseTo(11.5 / 4);
  });

  it('puts the window start inside the cohort and the window end outside it', () => {
    // S starts exactly at the start (in); W exactly at the end (out, the end is exclusive); P one
    // millisecond before the start (out). The merged cost would show any of them.
    const eng = template('eng');
    expect(eng.states.merged).toBe(4);
    expect(eng.prsMerged).toBe(4);
    expect(eng.cost.mergedItemsUsd).toBeCloseTo(6);
  });

  it('reads back exactly 30 days before the window, so older retries do not make new work', () => {
    const eng = template('eng');
    // Q: the failed attempt is inside the lookback, so the item starts before the window: out.
    // Y: the failed attempt sits exactly on the read boundary (inclusive), so it is read and the
    //    item starts before the window: out. If the boundary were exclusive, Y would be in.
    // Z: the failed attempt is one millisecond before the boundary, so it is never read; the item
    //    starts at its retry: in, carrying only the retry's cost.
    expect(eng.cost.mergedItemsUsd).toBeCloseTo(6); // Z contributes 1, not 10
    expect(eng.runs).toBe(9);
    expect(eng.workItems).toBe(9);
  });

  it('excludes runs outside the window from every total', () => {
    const o = report.overall;
    expect(o.workItems).toBe(12);
    expect(o.prWorkItems).toBe(10);
    expect(o.states).toEqual({ closed_unmerged: 1, merged: 6, no_pr: 1, open: 1, running: 1 });
    expect(o.settledItems).toBe(8);
    expect(o.mergeRate).toBeCloseTo(6 / 8);
    expect(o.decidedPrMergeRate).toBeCloseTo(6 / 7);
    expect(o.prsMerged).toBe(6);
    expect(o.runs).toBe(15);
    expect(o.cost.totalUsd).toBeCloseTo(21.5);
    expect(o.cost.mergedItemsUsd).toBeCloseTo(15);
    expect(o.cost.unmergedSettledUsd).toBeCloseTo(4);
    expect(o.cost.undecidedUsd).toBeCloseTo(1.5);
    expect(o.cost.perMergedPr).toBeCloseTo(20.5 / 6);
    expect(o.cost.perMergedPrSettled).toBeCloseTo(19 / 6);
    expect(report.inputs.truncated).toBe(false);
  });

  it('groups by the repository each item is attributed to', () => {
    const r1 = repo('repo1');
    const r2 = repo('repo2');
    expect(r1.repoName).toBe(`or-${suffix}/repo1`);
    expect(r2.repoName).toBe(`or-${suffix}/repo2`);
    // R2: M (merged, ENG) and H (no-PR template).
    expect(r2.workItems).toBe(2);
    expect(r2.prWorkItems).toBe(1);
    expect(r2.states.merged).toBe(1);
    expect(r2.noPrWork.items).toBe(1);
    expect(r1.workItems + r2.workItems).toBe(12);
  });
});
