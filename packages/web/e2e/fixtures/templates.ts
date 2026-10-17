import type {
  StepRegistryEntry,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow/spec';
import { ago, TEAMS } from './common';

/**
 * A small ticket-to-pull-request flow: plan, approve, implement, test, review,
 * open the PR. Hand-written rather than taken from the built-in templates, so
 * editing a built-in does not move these screenshots.
 */
export const TICKET_TO_PR_SPEC: WorkflowSpec = {
  description: 'Plan the change, get the plan approved, implement it, test it and open a PR.',
  entry: 'validate',
  name: 'ticket-to-pr',
  nodes: {
    approvePlan: {
      description: 'Review the implementation plan before any code is written.',
      group: 'plan',
      onApprove: 'implement',
      onReject: 'rejected',
      onTimeout: 'rejected',
      timeout: '24h',
      title: 'Approve the plan',
      type: 'humanApproval',
    },
    done: { group: 'finish', status: 'SUCCESS', title: 'Done', type: 'terminate' },
    implement: {
      group: 'implement',
      next: 'runTests',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    openPr: {
      group: 'pull request',
      next: 'done',
      step: 'createOrUpdatePullRequest',
      title: 'Open the pull request',
      type: 'step',
    },
    plan: {
      group: 'plan',
      next: 'approvePlan',
      step: 'gatherTicketContext',
      title: 'Read the ticket',
      type: 'step',
    },
    rejected: { group: 'finish', status: 'FAILED', title: 'Rejected', type: 'terminate' },
    review: {
      group: 'verify',
      next: 'openPr',
      step: 'runReviewNetwork',
      title: 'Review the change',
      type: 'step',
    },
    runTests: {
      group: 'verify',
      next: 'review',
      onFail: { retry: 2 },
      step: 'runTests',
      title: 'Run the tests',
      type: 'step',
    },
    validate: {
      group: 'plan',
      next: 'plan',
      step: 'validateContext',
      title: 'Validate the request',
      type: 'step',
    },
  },
  schemaVersion: 1,
};

const signing = {
  configured: false,
  lastFour: null,
  previousExpiresAt: null,
  requireSignature: false,
};

const template = (
  id: string,
  name: string,
  description: string,
  extra: Partial<WorkflowTemplateSummary> = {}
): WorkflowTemplateSummary => ({
  activeVersion: 3,
  createdAt: ago(60 * 24 * 40),
  description,
  estimatedHumanTimeSavedMinutes: 90,
  experimentSplit: null,
  experimentVersion: null,
  id,
  inputSchema: null,
  isDefault: false,
  lastRun: null,
  name,
  status: 'ACTIVE',
  team: { id: TEAMS[0].id, name: TEAMS[0].name, slug: TEAMS[0].slug },
  updatedAt: ago(60 * 24 * 3),
  versionCount: 3,
  webhookConfigured: false,
  webhookSigning: signing,
  workspaceProvider: null,
  ...extra,
});

export const TEMPLATES: WorkflowTemplateSummary[] = [
  template(
    'tpl-ticket-to-pull-request',
    'Ticket to pull request',
    'Plan, approve, implement, test and review a ticket, then open a pull request.',
    {
      isDefault: true,
      lastRun: {
        endedAt: ago(57),
        id: 'run-0001',
        startedAt: ago(95),
        status: 'FAILED',
        workRequestId: 'wr-0001',
      },
    }
  ),
  template('tpl-bug-fix', 'Bug fix', 'Reproduce the bug with a failing test, then fix it.', {
    lastRun: {
      endedAt: null,
      id: 'run-0003',
      startedAt: ago(9),
      status: 'RUNNING',
      workRequestId: 'wr-0003',
    },
    team: { id: TEAMS[1].id, name: TEAMS[1].name, slug: TEAMS[1].slug },
  }),
  template(
    'tpl-dependency-upgrade',
    'Dependency upgrade',
    'Bump one dependency, fix what breaks and summarise the changelog.',
    {
      activeVersion: 1,
      lastRun: {
        endedAt: ago(1413),
        id: 'run-0005',
        startedAt: ago(1440),
        status: 'SUCCESS',
        workRequestId: 'wr-0005',
      },
      versionCount: 1,
    }
  ),
  template(
    'tpl-release-notes',
    'Release notes draft',
    'Draft release notes from the merged pull requests since the last tag.',
    { activeVersion: null, status: 'DRAFT', team: null, versionCount: 1 }
  ),
];

export const TEMPLATE_DETAIL: WorkflowTemplateDetail = {
  ...TEMPLATES[0],
  activeVersionSpec: {
    createdAt: ago(60 * 24 * 3),
    createdBy: 'ada@example.com',
    generatedBy: null,
    id: 'tplv-0003',
    reviewedAt: null,
    reviewedBy: null,
    spec: TICKET_TO_PR_SPEC,
    version: 3,
  },
  versions: [3, 2, 1].map((version) => ({
    createdAt: ago(60 * 24 * (3 + (3 - version) * 10)),
    createdBy: 'ada@example.com',
    generatedBy: null,
    id: `tplv-000${version}`,
    reviewedAt: null,
    reviewedBy: null,
    version,
  })),
  webhookSignatureRequiredByPolicy: false,
};

export const STEP_REGISTRY: StepRegistryEntry[] = [
  {
    category: 'agent',
    configFields: [],
    description: 'Write the code for the ticket in the workspace, test-first.',
    label: 'Implement',
    name: 'executeImplementation',
  },
  {
    category: 'agent',
    configFields: [],
    description: 'Three reviewer personas read the change and vote.',
    label: 'Review network',
    name: 'runReviewNetwork',
  },
  {
    category: 'gate',
    configFields: [],
    description: "Run the repository's test command.",
    label: 'Run tests',
    name: 'runTests',
  },
  {
    category: 'vcs',
    configFields: [],
    description: 'Push the branch and open or update its pull request.',
    label: 'Open pull request',
    name: 'createOrUpdatePullRequest',
  },
  {
    category: 'agent',
    configFields: [],
    description: 'Read the tracker ticket into a typed digest.',
    label: 'Gather ticket context',
    name: 'gatherTicketContext',
  },
  {
    category: 'control',
    configFields: [],
    description: 'Check that the request names a repository and a ticket.',
    label: 'Validate context',
    name: 'validateContext',
  },
];
