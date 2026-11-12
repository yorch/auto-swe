export const WORKFLOW_GROUPS = [
  {
    id: 'engineering',
    label: 'Ship code changes',
  },
  {
    id: 'people',
    label: 'Put people in the loop',
  },
  {
    id: 'release',
    label: 'Gate a release',
  },
  {
    id: 'product',
    label: 'Product',
  },
  {
    id: 'support',
    label: 'Support',
  },
  {
    id: 'content',
    label: 'Content and comms',
  },
] as const;

export type WorkflowGroup = (typeof WORKFLOW_GROUPS)[number]['id'];

const entries: [string, { title: string; group: WorkflowGroup }][] = [
  ['code-review', { group: 'engineering', title: 'Review a finished run' }],
  ['code-review-qodo', { group: 'engineering', title: 'Review a finished run with Qodo' }],
  ['human-review-of-run', { group: 'people', title: 'Human review of a finished run' }],
  ['ticket-to-merge', { group: 'engineering', title: 'Ticket to reviewed pull request' }],
  ['ticket-to-merge-qodo', { group: 'engineering', title: 'Ticket to merge with a Qodo review' }],
  ['hotfix', { group: 'engineering', title: 'Production hotfix' }],
  ['dependency-update', { group: 'engineering', title: 'Dependency update' }],
  ['docs-refresh', { group: 'engineering', title: 'Documentation refresh' }],
  ['vulnerability-remediation', { group: 'engineering', title: 'Vulnerability remediation' }],
  ['model-catalog-refresh', { group: 'engineering', title: 'Model catalog refresh' }],
  ['code-and-ci', { group: 'engineering', title: 'Code and CI only' }],
  ['ci-triage-and-fix', { group: 'engineering', title: 'CI failure triage and fix' }],
  ['address-pr-feedback', { group: 'engineering', title: 'Pull-request feedback' }],
  ['agent-reviewed-pr', { group: 'engineering', title: 'Agent-reviewed pull request' }],
  ['consensus-review', { group: 'engineering', title: 'Two-reviewer consensus' }],
  ['parallel-fan-out', { group: 'engineering', title: 'Parallel implementation' }],
  ['approve-before-pr', { group: 'people', title: 'Approve before the pull request opens' }],
  ['scope-clarification', { group: 'people', title: 'Clarify scope first' }],
  ['security-triage', { group: 'people', title: 'Security triage' }],
  ['human-code-review', { group: 'people', title: 'Human review of the diff' }],
  ['tiered-escalation', { group: 'people', title: 'Risk-tiered approval' }],
  ['four-eyes', { group: 'people', title: 'Four-eyes change' }],
  ['db-migration-dry-run', { group: 'people', title: 'Database migration with a dry run' }],
  ['fully-supervised', { group: 'people', title: 'Fully supervised' }],
  ['external-approval-gate', { group: 'release', title: 'External approval gate' }],
  ['staged-deploy-signals', { group: 'release', title: 'Staged deploy confirmation' }],
  ['prd-decomposition', { group: 'product', title: 'PRD to implementation' }],
  ['product-prd-draft', { group: 'product', title: 'Draft a PRD' }],
  ['create-issue-from-brief', { group: 'product', title: 'Brief to tracker issue' }],
  ['create-issue', { group: 'product', title: 'File a tracker issue' }],
  ['zendesk-ticket-reply', { group: 'support', title: 'Support ticket reply' }],
  ['notion-content-draft', { group: 'content', title: 'Draft an update in Notion' }],
  ['notion-content-brand-review', { group: 'content', title: 'Draft with a brand review' }],
  ['send-slack-update', { group: 'content', title: 'Post a Slack update' }],
  [
    'confluence-review-to-tickets',
    { group: 'content', title: 'Confluence review to Jira tickets' },
  ],
  ['issue-to-confluence-page', { group: 'content', title: 'Tracker issue to Confluence page' }],
  ['Agent Run', { group: 'engineering', title: 'Run an agent' }],
  ['Channel Assistant', { group: 'content', title: 'Channel assistant' }],
  ['Channel Task', { group: 'content', title: 'Task from a channel mention' }],
];

export const WORKFLOW_CATALOG = Object.fromEntries(entries);

export function workflowPresentation(template: { name: string; team: unknown | null }) {
  const entry = Object.hasOwn(WORKFLOW_CATALOG, template.name)
    ? WORKFLOW_CATALOG[template.name]
    : undefined;
  return entry ?? { group: template.team == null ? 'other' : 'team', title: template.name };
}
