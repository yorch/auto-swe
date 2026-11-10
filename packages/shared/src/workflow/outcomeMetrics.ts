/**
 * Outcome metrics from run data: merge rate, review rounds, CI-heal rate, time to merge and cost per
 * merged pull request, per template and per repository. Pure — it takes rows and returns a report,
 * so the same rows always give the same numbers (docs/outcome-metrics.md is the method).
 *
 * The unit is the **work item**, not the run: every run for the same ticket in the same repository
 * (a retry, a re-run, a fix run launched after a failure) belongs to one item, so a failed first
 * attempt costs the item that eventually merged and an item that never merged still carries its cost.
 */
import { MIN_SAMPLES_FOR_SIGNIFICANCE, percentile, wilsonInterval } from './analytics.js';

export const OUTCOME_METRICS_METHOD_VERSION = 1;

/** Terminal fix-loop steps counted as one round each. */
export const REVIEW_ROUND_STEP = 'executeReviewFixImplementation';
export const CI_FIX_STEP = 'executeCIFixImplementation';

export interface OutcomeRun {
  id: string;
  /** Runs with the same key are attempts at the same piece of work (see `workItemKeyFor`). */
  workItemKey: string;
  templateId: string;
  templateName: string;
  repoId: string | null;
  repoName: string;
  /** `WorkflowRunStatus`. */
  status: string;
  startedAt: Date;
  costUsd: number;
}

export interface OutcomePullRequest {
  runId: string | null;
  /** `OPEN` | `MERGED` | `CLOSED`. */
  status: string;
  ciStatus: string;
  mergedAt: Date | null;
}

/** A finished (`PASSED` or `FAILED`) review-fix or CI-fix step. */
export interface OutcomeStep {
  runId: string;
  stepName: string;
}

export type WorkItemState = 'merged' | 'open' | 'running' | 'closed_unmerged' | 'no_pr';

export interface OutcomeGroupMetrics {
  /** Work items whose first run started in the window. */
  workItems: number;
  runs: number;
  runsByStatus: Record<string, number>;
  /** Items by where they stand now. `open` and `running` are undecided. */
  states: Record<WorkItemState, number>;
  /** Items with an outcome: merged, closed unmerged, or ended without a pull request. */
  settledItems: number;
  prsOpened: number;
  prsMerged: number;
  prsClosedUnmerged: number;
  /** merged items / settled items. Null when nothing has settled. */
  mergeRate: number | null;
  mergeRateInterval: [number, number] | null;
  /** merged items / (merged + closed unmerged): of the pull requests a human decided, the share merged. */
  decidedPrMergeRate: number | null;
  lowSample: boolean;
  reviewRounds: {
    /** Items with at least one pull request: the denominator. */
    itemsWithPr: number;
    itemsWithAnyRound: number;
    mean: number | null;
    median: number | null;
    max: number | null;
  };
  ciHeal: {
    itemsWithCiFix: number;
    itemsHealed: number;
    rate: number | null;
    rateInterval: [number, number] | null;
  };
  timeToMergeMs: { n: number; median: number | null; p90: number | null };
  cost: {
    totalUsd: number;
    mergedItemsUsd: number;
    /** Items that settled without a merge: the spend a merge rate below 1 leaves behind. */
    unmergedSettledUsd: number;
    /** Items still open or running: outcome unknown. */
    undecidedUsd: number;
    /** All cohort spend / merged pull requests. Null when none merged. */
    perMergedPr: number | null;
    /** Settled-item spend / merged pull requests: leaves out work whose outcome is not yet known. */
    perMergedPrSettled: number | null;
  };
}

export interface OutcomeTemplateRow extends OutcomeGroupMetrics {
  templateId: string;
  templateName: string;
}

export interface OutcomeRepoRow extends OutcomeGroupMetrics {
  repoId: string | null;
  repoName: string;
}

export interface OutcomeReport {
  methodVersion: number;
  /** Items are in the cohort when their first run started in `[start, end)`. */
  window: { start: string; end: string };
  generatedAt: string;
  /** Rows the report was built from, and whether a source was cut at its cap. */
  inputs: { runs: number; pullRequests: number; steps: number; truncated: boolean };
  /** Minimum settled items for a rate to stop being marked low-sample. */
  lowSampleBelow: number;
  overall: OutcomeGroupMetrics;
  byTemplate: OutcomeTemplateRow[];
  byRepo: OutcomeRepoRow[];
}

/**
 * Which attempts belong together. A real ticket id groups every run for it in one repository; a
 * platform-generated id (`ticketIsSynthetic`) is a correlation key, so the work request groups
 * instead; a run with no request stands alone.
 */
export function workItemKeyFor(run: {
  id: string;
  repoId: string | null;
  ticketId: string | null;
  ticketIsSynthetic: boolean;
  workRequestId: string | null;
}): string {
  if (run.ticketId && !run.ticketIsSynthetic) {
    return `ticket:${run.repoId ?? 'none'}:${run.ticketId.trim().toLowerCase()}`;
  }
  if (run.workRequestId) {
    return `request:${run.workRequestId}`;
  }
  return `run:${run.id}`;
}

interface WorkItem {
  runs: OutcomeRun[];
  prs: OutcomePullRequest[];
  reviewRounds: number;
  ciFixes: number;
  startedAt: number;
  costUsd: number;
  state: WorkItemState;
  /** The run the item is attributed to: the one that merged, else the latest. */
  anchor: OutcomeRun;
  mergedAt: number | null;
}

function buildItems(
  runs: readonly OutcomeRun[],
  pullRequests: readonly OutcomePullRequest[],
  steps: readonly OutcomeStep[]
): WorkItem[] {
  const byKey = new Map<string, OutcomeRun[]>();
  for (const run of runs) {
    const group = byKey.get(run.workItemKey) ?? [];
    group.push(run);
    byKey.set(run.workItemKey, group);
  }
  const prsByRun = new Map<string, OutcomePullRequest[]>();
  for (const pr of pullRequests) {
    if (pr.runId) {
      const group = prsByRun.get(pr.runId) ?? [];
      group.push(pr);
      prsByRun.set(pr.runId, group);
    }
  }
  const roundsByRun = new Map<string, { review: number; ci: number }>();
  for (const step of steps) {
    const entry = roundsByRun.get(step.runId) ?? { ci: 0, review: 0 };
    if (step.stepName === REVIEW_ROUND_STEP) {
      entry.review += 1;
    } else if (step.stepName === CI_FIX_STEP) {
      entry.ci += 1;
    }
    roundsByRun.set(step.runId, entry);
  }

  const items: WorkItem[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id)
    );
    const prs = sorted.flatMap((run) => prsByRun.get(run.id) ?? []);
    const merged = prs.filter((pr) => pr.status === 'MERGED');
    const mergedTimes = merged.flatMap((pr) => (pr.mergedAt ? [pr.mergedAt.getTime()] : []));
    let state: WorkItemState;
    if (merged.length > 0) {
      state = 'merged';
    } else if (prs.some((pr) => pr.status === 'OPEN')) {
      state = 'open';
    } else if (sorted.some((run) => run.status === 'RUNNING')) {
      state = 'running';
    } else if (prs.length > 0) {
      state = 'closed_unmerged';
    } else {
      state = 'no_pr';
    }
    const mergedRun =
      state === 'merged'
        ? sorted.find((run) => (prsByRun.get(run.id) ?? []).some((pr) => pr.status === 'MERGED'))
        : undefined;
    const anchor = mergedRun ?? (sorted[sorted.length - 1] as OutcomeRun);
    items.push({
      anchor,
      ciFixes: sorted.reduce((sum, run) => sum + (roundsByRun.get(run.id)?.ci ?? 0), 0),
      costUsd: sorted.reduce((sum, run) => sum + run.costUsd, 0),
      mergedAt: mergedTimes.length > 0 ? Math.min(...mergedTimes) : null,
      prs,
      reviewRounds: sorted.reduce((sum, run) => sum + (roundsByRun.get(run.id)?.review ?? 0), 0),
      runs: sorted,
      startedAt: (sorted[0] as OutcomeRun).startedAt.getTime(),
      state,
    });
  }
  return items;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function groupMetrics(items: readonly WorkItem[]): OutcomeGroupMetrics {
  const states: Record<WorkItemState, number> = {
    closed_unmerged: 0,
    merged: 0,
    no_pr: 0,
    open: 0,
    running: 0,
  };
  const runsByStatus: Record<string, number> = {};
  let runs = 0;
  let prsOpened = 0;
  let prsMerged = 0;
  let prsClosedUnmerged = 0;
  const cost = { merged: 0, total: 0, undecided: 0, unmerged: 0 };
  for (const item of items) {
    states[item.state] += 1;
    runs += item.runs.length;
    for (const run of item.runs) {
      runsByStatus[run.status] = (runsByStatus[run.status] ?? 0) + 1;
    }
    prsOpened += item.prs.length;
    prsMerged += item.prs.filter((pr) => pr.status === 'MERGED').length;
    prsClosedUnmerged += item.prs.filter((pr) => pr.status === 'CLOSED').length;
    cost.total += item.costUsd;
    if (item.state === 'merged') {
      cost.merged += item.costUsd;
    } else if (item.state === 'open' || item.state === 'running') {
      cost.undecided += item.costUsd;
    } else {
      cost.unmerged += item.costUsd;
    }
  }
  const settledItems = states.merged + states.closed_unmerged + states.no_pr;

  const withPr = items.filter((item) => item.prs.length > 0);
  const rounds = withPr.map((item) => item.reviewRounds).sort((a, b) => a - b);
  const withCiFix = items.filter((item) => item.ciFixes > 0 && item.prs.length > 0);
  const healed = withCiFix.filter((item) =>
    item.prs.some((pr) => pr.ciStatus === 'PASSED' || pr.status === 'MERGED')
  ).length;
  const mergeDurations = items
    .flatMap((item) =>
      item.state === 'merged' && item.mergedAt !== null
        ? [Math.max(0, item.mergedAt - item.startedAt)]
        : []
    )
    .sort((a, b) => a - b);

  return {
    ciHeal: {
      itemsHealed: healed,
      itemsWithCiFix: withCiFix.length,
      rate: ratio(healed, withCiFix.length),
      rateInterval: wilsonInterval(healed, withCiFix.length),
    },
    cost: {
      mergedItemsUsd: cost.merged,
      perMergedPr: prsMerged > 0 ? cost.total / prsMerged : null,
      perMergedPrSettled: prsMerged > 0 ? (cost.merged + cost.unmerged) / prsMerged : null,
      totalUsd: cost.total,
      undecidedUsd: cost.undecided,
      unmergedSettledUsd: cost.unmerged,
    },
    decidedPrMergeRate: ratio(states.merged, states.merged + states.closed_unmerged),
    lowSample: settledItems < MIN_SAMPLES_FOR_SIGNIFICANCE,
    mergeRate: ratio(states.merged, settledItems),
    mergeRateInterval: wilsonInterval(states.merged, settledItems),
    prsClosedUnmerged,
    prsMerged,
    prsOpened,
    reviewRounds: {
      itemsWithAnyRound: rounds.filter((n) => n > 0).length,
      itemsWithPr: withPr.length,
      max: rounds.length > 0 ? (rounds[rounds.length - 1] as number) : null,
      mean: rounds.length > 0 ? rounds.reduce((sum, n) => sum + n, 0) / rounds.length : null,
      median: percentile(rounds, 0.5),
    },
    runs,
    runsByStatus,
    settledItems,
    states,
    timeToMergeMs: {
      median: percentile(mergeDurations, 0.5),
      n: mergeDurations.length,
      p90: percentile(mergeDurations, 0.9),
    },
    workItems: items.length,
  };
}

export interface ComputeOutcomeReportInput {
  runs: readonly OutcomeRun[];
  pullRequests: readonly OutcomePullRequest[];
  steps: readonly OutcomeStep[];
  window: { start: Date; end: Date };
  generatedAt: Date;
  truncated?: boolean;
}

/**
 * Cohort: work items whose earliest run started inside the window. The caller supplies every run of
 * the cohort's work items (including attempts that started before the window), their pull requests
 * and their finished fix-loop steps.
 */
export function computeOutcomeReport(input: ComputeOutcomeReportInput): OutcomeReport {
  const items = buildItems(input.runs, input.pullRequests, input.steps).filter(
    (item) =>
      item.startedAt >= input.window.start.getTime() && item.startedAt < input.window.end.getTime()
  );
  const templateGroups = new Map<string, WorkItem[]>();
  const repoGroups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const templateGroup = templateGroups.get(item.anchor.templateId) ?? [];
    templateGroup.push(item);
    templateGroups.set(item.anchor.templateId, templateGroup);
    const repoKey = item.anchor.repoId ?? '';
    const repoGroup = repoGroups.get(repoKey) ?? [];
    repoGroup.push(item);
    repoGroups.set(repoKey, repoGroup);
  }
  const order = <T extends OutcomeGroupMetrics>(a: T, b: T) => b.workItems - a.workItems;
  const byTemplate = [...templateGroups.entries()]
    .map(([templateId, group]) => ({
      ...groupMetrics(group),
      templateId,
      templateName: (group[0] as WorkItem).anchor.templateName,
    }))
    .sort((a, b) => order(a, b) || a.templateName.localeCompare(b.templateName));
  const byRepo = [...repoGroups.entries()]
    .map(([repoId, group]) => ({
      ...groupMetrics(group),
      repoId: repoId === '' ? null : repoId,
      repoName: repoId === '' ? 'Unattributed' : (group[0] as WorkItem).anchor.repoName,
    }))
    .sort((a, b) => order(a, b) || a.repoName.localeCompare(b.repoName));
  return {
    byRepo,
    byTemplate,
    generatedAt: input.generatedAt.toISOString(),
    inputs: {
      pullRequests: input.pullRequests.length,
      runs: input.runs.length,
      steps: input.steps.length,
      truncated: input.truncated ?? false,
    },
    lowSampleBelow: MIN_SAMPLES_FOR_SIGNIFICANCE,
    methodVersion: OUTCOME_METRICS_METHOD_VERSION,
    overall: groupMetrics(items),
    window: { end: input.window.end.toISOString(), start: input.window.start.toISOString() },
  };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const interval = (value: [number, number] | null) =>
  value ? ` (${(value[0] * 100).toFixed(0)}-${(value[1] * 100).toFixed(0)}%)` : '';
const usd = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(2)}`);
const num = (value: number | null) => (value === null ? 'n/a' : value.toFixed(2));

export function formatDurationMs(ms: number | null): string {
  if (ms === null) {
    return 'n/a';
  }
  const hours = ms / 3_600_000;
  return hours >= 48 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`;
}

function cell(text: string): string {
  return text.replace(/\s*[|\r\n]+\s*/g, ' ').trim();
}

function row(label: string, m: OutcomeGroupMetrics): string {
  return `| ${[
    cell(label) + (m.lowSample ? ' (low sample)' : ''),
    m.workItems,
    m.settledItems,
    `${pct(m.mergeRate)}${interval(m.mergeRateInterval)}`,
    num(m.reviewRounds.mean),
    pct(m.ciHeal.rate),
    formatDurationMs(m.timeToMergeMs.median),
    usd(m.cost.perMergedPr),
    usd(m.cost.unmergedSettledUsd),
  ].join(' | ')} |`;
}

const TABLE_HEAD = [
  '| | Items | Settled | Merge rate (95% CI) | Review rounds (mean) | CI-heal rate | Median time to merge | Cost per merged PR | Spend on unmerged |',
  '|---|---|---|---|---|---|---|---|---|',
];

/** The report as Markdown. Every figure is read from `report`; nothing is recomputed. */
export function renderOutcomeReportMarkdown(report: OutcomeReport): string {
  const o = report.overall;
  const lines: string[] = [
    '# Outcome metrics',
    '',
    `Work items whose first run started from ${report.window.start} to ${report.window.end}. ` +
      `Generated ${report.generatedAt} from this deployment's run data (method version ${report.methodVersion}; ` +
      'definitions in docs/outcome-metrics.md).',
    '',
    `Runs read: ${report.inputs.runs}; pull requests: ${report.inputs.pullRequests}; ` +
      `fix-loop steps: ${report.inputs.steps}.` +
      (report.inputs.truncated
        ? ' **A source hit its row cap: the figures below cover a subset.**'
        : ''),
    '',
    '## Overall',
    '',
    ...TABLE_HEAD,
    row('All work', o),
    '',
    '## Outcomes, failures included',
    '',
    '| State | Work items |',
    '|---|---|',
    `| Merged | ${o.states.merged} |`,
    `| Pull request closed unmerged | ${o.states.closed_unmerged} |`,
    `| Ended without a pull request | ${o.states.no_pr} |`,
    `| Pull request still open (undecided) | ${o.states.open} |`,
    `| Run still in flight (undecided) | ${o.states.running} |`,
    '',
    `Runs by status: ${
      Object.entries(o.runsByStatus)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${status} ${count}`)
        .join(', ') || 'none'
    }.`,
    '',
    `Spend: ${usd(o.cost.totalUsd)} total, of which ${usd(o.cost.mergedItemsUsd)} on items that merged, ` +
      `${usd(o.cost.unmergedSettledUsd)} on items that settled without a merge and ` +
      `${usd(o.cost.undecidedUsd)} on items not yet decided. Cost per merged PR ${usd(o.cost.perMergedPr)} ` +
      `counts all of it; ${usd(o.cost.perMergedPrSettled)} leaves out the undecided share.`,
    '',
    `Time to merge: n=${o.timeToMergeMs.n}, median ${formatDurationMs(o.timeToMergeMs.median)}, ` +
      `p90 ${formatDurationMs(o.timeToMergeMs.p90)}. CI heal: ${o.ciHeal.itemsHealed} of ` +
      `${o.ciHeal.itemsWithCiFix} items that needed a CI fix ended with passing CI or a merge. ` +
      `Review rounds: ${o.reviewRounds.itemsWithAnyRound} of ${o.reviewRounds.itemsWithPr} items with a pull request needed at least one.`,
    '',
    '## By template',
    '',
    ...TABLE_HEAD,
    ...report.byTemplate.map((t) => row(t.templateName, t)),
    '',
    '## By repository',
    '',
    ...TABLE_HEAD,
    ...report.byRepo.map((r) => row(r.repoName, r)),
    '',
    '## Reading these figures',
    '',
    `- A group with fewer than ${report.lowSampleBelow} settled items is marked low sample; treat its rates as anecdote.`,
    '- Recent items are right-censored: an item still open or running is excluded from the merge rate, and time to merge counts only merges that have happened, so a young window reads fast.',
    '- Cost is what the platform recorded for model calls. It excludes human review time, CI minutes and infrastructure.',
    '- A work item is attributed to the template and repository of the run that merged it, else of its latest run, so retried work can carry spend recorded under another template.',
    '',
  ];
  return lines.join('\n');
}
