import type {
  HumanStepSummary,
  PullRequestListItem,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkspaceRequestSummary,
} from '@auto-swe/shared/types/api';
import { ago, ahead } from './common';

interface RequestSeed {
  n: number;
  title: string;
  ticket: string;
  template: string;
  status: WorkflowRunStatus;
  startedMinutesAgo: number;
  durationMinutes: number | null;
  cost: number;
  stage: string | null;
  target: string;
  attempts?: number;
  failed?: number;
  pendingSteps?: number;
  needsMerge?: boolean;
  reviewUrl?: string;
}

const SEEDS: RequestSeed[] = [
  {
    attempts: 2,
    cost: 4.82,
    durationMinutes: 38,
    failed: 1,
    n: 1,
    stage: 'Verify',
    startedMinutesAgo: 95,
    status: 'FAILED',
    target: 'acme/payments-api',
    template: 'Ticket to pull request',
    ticket: 'PAY-1423',
    title: 'Retry idempotent refunds when the card network times out',
  },
  {
    cost: 1.37,
    durationMinutes: null,
    n: 2,
    pendingSteps: 1,
    stage: 'Plan approval',
    startedMinutesAgo: 22,
    status: 'RUNNING',
    target: 'acme/ledger',
    template: 'Ticket to pull request',
    ticket: 'LED-88',
    title: 'Add a reconciliation report for end-of-day ledger balances',
  },
  {
    cost: 0.64,
    durationMinutes: null,
    n: 3,
    stage: 'Implement',
    startedMinutesAgo: 9,
    status: 'RUNNING',
    target: 'acme/deploy-tools',
    template: 'Bug fix',
    ticket: 'OPS-311',
    title: 'Deploy script ignores the --dry-run flag for canary stages',
  },
  {
    cost: 3.15,
    durationMinutes: 41,
    n: 4,
    needsMerge: true,
    reviewUrl: 'https://github.com/acme/payments-api/pull/912',
    stage: 'Awaiting merge',
    startedMinutesAgo: 240,
    status: 'SUCCESS',
    target: 'acme/payments-api',
    template: 'Ticket to pull request',
    ticket: 'PAY-1401',
    title: 'Expose settlement batch ids on the payouts endpoint',
  },
  {
    cost: 2.08,
    durationMinutes: 27,
    n: 5,
    reviewUrl: 'https://github.com/acme/ledger/pull/377',
    stage: null,
    startedMinutesAgo: 1440,
    status: 'SUCCESS',
    target: 'acme/ledger',
    template: 'Dependency upgrade',
    ticket: 'LED-80',
    title: 'Upgrade pgx to v6 and drop the deprecated pool options',
  },
  {
    cost: 0.21,
    durationMinutes: 4,
    n: 6,
    stage: null,
    startedMinutesAgo: 2900,
    status: 'CANCELLED',
    target: 'acme/deploy-tools',
    template: 'Bug fix',
    ticket: 'OPS-302',
    title: 'Flaky smoke test on the staging rollout job',
  },
];

const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

function runOf(seed: RequestSeed): WorkflowRunSummary {
  return {
    costUsdAccrued: seed.cost,
    domain: 'engineering',
    endedAt:
      seed.durationMinutes === null ? null : ago(seed.startedMinutesAgo - seed.durationMinutes),
    id: id('run', seed.n),
    outcomeDomain: seed.status === 'SUCCESS' ? 'engineering' : null,
    outcomeType: seed.status === 'SUCCESS' ? 'pull_request' : null,
    startedAt: ago(seed.startedMinutesAgo),
    status: seed.status,
    templateId: `tpl-${seed.template.toLowerCase().replace(/\W+/g, '-')}`,
    templateName: seed.template,
    templateVersion: 3,
    workflowId: `eng-acme-${seed.target.split('/')[1]}-${seed.ticket}`,
    workRequest: {
      description: seed.title,
      externalTicketId: seed.ticket,
      id: id('wr', seed.n),
      title: seed.title,
    },
  };
}

export const REQUESTS: WorkspaceRequestSummary[] = SEEDS.map((seed) => ({
  ...runOf(seed),
  attemptCount: seed.attempts ?? 1,
  failedExecutionCount: seed.failed ?? 0,
  isCrossRepo: false,
  needsMerge: seed.needsMerge ?? false,
  pendingStepCount: seed.pendingSteps ?? 0,
  pendingStepDeadline: seed.pendingSteps ? ahead(240) : null,
  reviewUrl: seed.reviewUrl ?? null,
  stage: seed.stage,
  target: seed.target,
  visibleExecutionCount: seed.attempts ?? 1,
}));

export const RUNS: WorkflowRunSummary[] = [
  ...SEEDS.map(runOf),
  {
    ...runOf(SEEDS[0]),
    costUsdAccrued: 2.4,
    endedAt: ago(170),
    id: 'run-0007',
    startedAt: ago(200),
    status: 'TIMED_OUT',
    templateVersion: 2,
  },
];

/** Which requests a `state` filter on `/workflow-runs/requests` returns. */
export function requestsInState(state: string | null): WorkspaceRequestSummary[] {
  switch (state) {
    case 'attention':
      return REQUESTS.filter(
        (r) => r.status === 'FAILED' || r.pendingStepCount > 0 || r.needsMerge
      );
    case 'active':
      return REQUESTS.filter((r) => r.status === 'RUNNING');
    case 'success':
      return REQUESTS.filter((r) => r.status === 'SUCCESS');
    case 'finished':
      return REQUESTS.filter((r) => r.status !== 'RUNNING');
    case 'failed':
      return REQUESTS.filter((r) => r.status === 'FAILED' || r.status === 'TIMED_OUT');
    default:
      return REQUESTS;
  }
}

export const PULL_REQUESTS: PullRequestListItem[] = [
  {
    ciStatus: 'SUCCESS',
    closedAt: null,
    costUsd: 3.15,
    id: 'pr-0001',
    isDraft: false,
    latestRun: { id: 'run-0004', status: 'SUCCESS' },
    mergedAt: null,
    openedAt: ago(200),
    prNumber: 912,
    repository: { id: 'repo-payments-api', name: 'payments-api', org: 'acme' },
    status: 'OPEN',
    ticketId: 'PAY-1401',
    title: 'Expose settlement batch ids on the payouts endpoint',
    url: 'https://github.com/acme/payments-api/pull/912',
    workRequestId: 'wr-0004',
  },
];

export const APPROVALS: HumanStepSummary[] = [
  {
    approvalsRemaining: 1,
    context: { plan: 'Add a nightly job that sums ledger entries per account and compares.' },
    currentApprovers: 0,
    description: 'Review the implementation plan before the agent writes code.',
    id: 'step-0001',
    kind: 'APPROVAL',
    myResponse: null,
    nodeId: 'approvePlan',
    requestedAt: ago(18),
    requiredApprovers: 1,
    responses: [],
    run: {
      id: 'run-0002',
      status: 'RUNNING',
      workflowId: 'eng-acme-ledger-LED-88',
      workRequest: {
        description: 'Add a reconciliation report for end-of-day ledger balances',
        externalTicketId: 'LED-88',
      },
      workRequestId: 'wr-0002',
    },
    runId: 'run-0002',
    status: 'PENDING',
    timeoutAt: ahead(240),
    title: 'Approve the plan for LED-88',
  },
  {
    approvalsRemaining: 2,
    currentApprovers: 0,
    description: 'Production deploys of the payments service need two approvers.',
    id: 'step-0002',
    kind: 'APPROVAL',
    myResponse: null,
    nodeId: 'approveDeploy',
    requestedAt: ago(65),
    requiredApprovers: 2,
    responses: [],
    run: {
      id: 'run-0004',
      status: 'RUNNING',
      workflowId: 'eng-acme-payments-api-PAY-1401',
      workRequest: {
        description: 'Expose settlement batch ids on the payouts endpoint',
        externalTicketId: 'PAY-1401',
      },
      workRequestId: 'wr-0004',
    },
    runId: 'run-0004',
    status: 'PENDING',
    timeoutAt: ago(5),
    title: 'Approve the production deploy of payments-api',
  },
  {
    description: 'Pick how to handle the breaking change in the client SDK.',
    id: 'step-0003',
    kind: 'DECISION',
    myResponse: null,
    nodeId: 'chooseStrategy',
    options: [
      { label: 'Ship a major version', value: 'major' },
      { label: 'Keep a compatibility shim', value: 'shim' },
    ],
    requestedAt: ago(130),
    responses: [],
    run: {
      id: 'run-0005',
      status: 'RUNNING',
      workflowId: 'eng-acme-ledger-LED-80',
      workRequest: { description: 'Upgrade pgx to v6', externalTicketId: 'LED-80' },
      workRequestId: 'wr-0005',
    },
    runId: 'run-0005',
    status: 'PENDING',
    timeoutAt: null,
    title: 'Choose an upgrade strategy for LED-80',
  },
];
