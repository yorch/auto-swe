/**
 * The use-case catalogue: one entry per built-in workflow template.
 *
 * The template specs are the source of truth for what a use case *does* — its steps,
 * its gates, the agents it runs — and the generated pages read those straight from
 * `BUILTIN_TEMPLATES`. This file holds only what a spec cannot say: who the workflow
 * is for, the problem it solves in a reader's words, and how far it is proven.
 *
 * The sync script fails when a built-in template has no entry here, or an entry here
 * names a template that no longer exists. A template added to the platform therefore
 * cannot ship without a public page, and a removed one cannot leave a page behind.
 *
 * Plain data with no TypeScript imports, because `astro.config.mjs` reads it to build
 * the sidebar and runs outside the sync script's loader.
 */

/** Where the use-case pages live, both on disk under the content dir and in URLs. */
export const USE_CASE_ROUTE_PREFIX = 'use-cases';

/**
 * How far a template is proven, stated per page because it differs per page.
 *
 * Mirrors `docs/product-overview.md` §8: the engineering flow is the one with a
 * complete, exercised end-to-end path, and the non-engineering verticals are seeded
 * content. Overstating this on a public page is the failure the docs conventions
 * exist to prevent, so the wording lives in one place.
 */
export const MATURITY = {
  composed: {
    label: 'Built from the flagship steps',
    text:
      'Ships as a built-in template and reuses the engineering steps the flagship flow ' +
      'runs. This particular arrangement of them is not separately exercised end to end ' +
      'against a real repository.',
  },
  flagship: {
    label: 'Flagship flow',
    text:
      'This is the default template and the flow the platform is built around: the ' +
      'engineering path is the one with a complete, exercised end-to-end route.',
  },
  seeded: {
    label: 'Seeded, not yet proven',
    text:
      'Seeded content rather than a proven flow. The connector, the agents, and the ' +
      'governance it relies on exist, but only the engineering flow has a complete, ' +
      'exercised end-to-end path today.',
  },
};

/** Reading order of the groups, on the index page and in the sidebar. */
export const USE_CASE_GROUPS = [
  {
    id: 'engineering',
    intro:
      'A ticket goes in and a pull request comes out. These differ in how much checking ' +
      'happens between the two, and none of them merges.',
    label: 'Ship code changes',
  },
  {
    id: 'people',
    intro:
      'The same engineering steps with people placed in the run: an approval, a decision ' +
      'between paths, a form to fill in, or a diff to review.',
    label: 'Put people in the loop',
  },
  {
    id: 'release',
    intro:
      'Runs that wait on systems outside auto-swe — a deploy pipeline, a monitoring check ' +
      '— before they continue.',
    label: 'Gate a release',
  },
  {
    id: 'product',
    intro: 'From a brief to a PRD, from a PRD to tickets, from tickets to implementation.',
    label: 'Product',
  },
  {
    id: 'support',
    intro: 'Customer replies drafted by an agent and published under your autonomy policy.',
    label: 'Support',
  },
  {
    id: 'content',
    intro: 'Drafts and announcements written into the tools your team already reads.',
    label: 'Content and comms',
  },
];

/**
 * Keyed by template `name`. `source` is the file that defines the spec, so "Edit this
 * page" and the source link land on the real definition.
 *
 * Insertion order is the reading order within each sidebar group — the flagship flow
 * first, then by how much each variant departs from it — so it is not alphabetical.
 */
// biome-ignore assist/source/useSortedKeys: the order is the sidebar's reading order.
export const USE_CASES = {
  'default-engineering': {
    group: 'engineering',
    maturity: 'flagship',
    source: 'packages/shared/src/workflow/defaultEngineeringSpec.ts',
    summary:
      'Implements a ticket in an isolated sandbox until the tests pass, has three ' +
      'reviewer agents inspect the change, opens a pull request, fixes CI failures from ' +
      'the logs, and then waits for a person to merge. What it learned is stored for the ' +
      'next run on the same repository.',
    title: 'Ticket to reviewed pull request',
  },
  hotfix: {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/hotfix.ts',
    summary:
      'The shortest path from an incident ticket to an open pull request. Lint and ' +
      'typecheck run but cannot block, and there is no review network and no CI wait — ' +
      'speed is the point, and the merge still belongs to a person.',
    title: 'Production hotfix',
  },
  'dependency-update': {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/dependencyUpdate.ts',
    summary:
      'For mechanical version bumps. Skips the review network, because the diff is rarely ' +
      'interesting, and lets the full test suite and CI be the gate — retrying CI fixes up ' +
      'to three times.',
    title: 'Dependency update',
  },
  'code-and-ci': {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/codeAndCi.ts',
    summary:
      'Lint, typecheck, and tests locally, then a pull request and a CI repair loop. No ' +
      'review agents and no people inside the run: for low-risk, well-tested codebases.',
    title: 'Code and CI only',
  },
  'review-and-merge': {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/reviewAndMerge.ts',
    summary:
      'The agent review loop, up to three attempts, then a pull request and a CI wait. ' +
      'Despite the template name it merges nothing: the run ends when CI is green, and the ' +
      'pull request waits for a person like every other.',
    title: 'Agent-reviewed pull request',
  },
  'consensus-review': {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/consensusReview.ts',
    summary:
      'Two independent review-network passes run in parallel, and both must approve before ' +
      'the pull request opens. Either one rejecting sends the combined feedback back to the ' +
      'implementer.',
    title: 'Two-reviewer consensus',
  },
  'parallel-fan-out': {
    group: 'engineering',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/parallelFanOut.ts',
    summary:
      'Splits one change into the feature, its tests, and its documentation, implements the ' +
      'three in parallel sandboxes, and joins them into a single pull request.',
    title: 'Parallel implementation',
  },
  'pr-approval-gate': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/prApprovalGate.ts',
    summary:
      'Implements and tests the change, then holds it until a person approves. Nothing ' +
      'becomes visible to reviewers on GitHub until someone has signed off inside the run.',
    title: 'Approve before the pull request opens',
  },
  'scope-clarification': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/scopeClarification.ts',
    summary:
      'Asks a person to fill in what the ticket leaves out before any code is written. For ' +
      'tickets that are deliberately high-level.',
    title: 'Clarify scope first',
  },
  'security-triage': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/securityTriage.ts',
    summary:
      'Runs a vulnerability scan after implementing, then asks a person to choose: fix the ' +
      'findings now, accept the risk and open the pull request, or abandon the change.',
    title: 'Security triage',
  },
  'human-code-review': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/humanCodeReview.ts',
    summary:
      'Shows the diff to a person before the pull request exists. Their notes go back to ' +
      'the agent to address, or they approve it as it stands.',
    title: 'Human review of the diff',
  },
  'tiered-escalation': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/tieredEscalation.ts',
    summary:
      'A person rates the change as low, medium, or high risk. Low goes straight to a pull ' +
      'request, medium needs a senior sign-off, and high needs a team lead within 48 hours.',
    title: 'Risk-tiered approval',
  },
  'four-eyes': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/fourEyes.ts',
    summary:
      'Two sequential, independent approvals after the agent review loop — the two-person ' +
      'rule that change-management processes ask for.',
    title: 'Four-eyes change',
  },
  migration: {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/migration.ts',
    summary:
      'Writes the migration, dry-runs it in an ephemeral container, and puts the output in ' +
      'front of a person. The pull request opens only if they approve what it would do.',
    title: 'Database migration with a dry run',
  },
  'full-supervised': {
    group: 'people',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/fullSupervised.ts',
    summary:
      'Every kind of human step in one run: requirements up front, a diff review, a ' +
      'decision on the review notes, and a final approval before the pull request.',
    title: 'Fully supervised',
  },
  'signal-gated-rollout': {
    group: 'release',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/signalGatedRollout.ts',
    summary:
      'After review and CI, waits for a go/no-go from an external system such as a CD ' +
      'pipeline or a change board. A rejection or a timeout ends the run.',
    title: 'Deployment-gated change',
  },
  'canary-rollout': {
    group: 'release',
    maturity: 'composed',
    source: 'packages/shared/src/workflow/templates/canaryRollout.ts',
    summary:
      'After review and CI, waits for a staging deploy result and then a production ' +
      'monitoring result. Each promotion is confirmed by the system that can see it.',
    title: 'Canary rollout',
  },
  'prd-decomposition': {
    group: 'product',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/prdDecomposition.ts',
    summary:
      'Checks a PRD for engineering readiness with a PM review, breaks it into epics and ' +
      'stories, gets engineering sign-off, then files the tickets and submits each story ' +
      'as its own implementation request.',
    title: 'PRD to implementation',
  },
  'product-prd-draft': {
    group: 'product',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/productPrdDraft.ts',
    summary:
      'Analyses a product brief and drafts a focused PRD with acceptance criteria into a ' +
      'Notion page.',
    title: 'Draft a PRD',
  },
  'create-issue-from-brief': {
    group: 'product',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/createIssueFromBrief.ts',
    summary:
      'An agent turns a brief into a Linear or Jira issue, which is filed after the autonomy ' +
      'policy — and a person, where the policy asks for one — allows it.',
    title: 'Brief to tracker issue',
  },
  'create-issue': {
    group: 'product',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/createIssue.ts',
    summary:
      'Files a Linear or Jira issue from a title and description, with external writes ' +
      'held for approval under the default autonomy policy.',
    title: 'File a tracker issue',
  },
  'zendesk-ticket-reply': {
    group: 'support',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/zendeskTicketReply.ts',
    summary:
      'Reads a Zendesk ticket, drafts a reply with the support agent, and checks the team ' +
      'autonomy policy. Internal notes can post straight away; a public reply waits for a ' +
      'person under the default policy.',
    title: 'Support ticket reply',
  },
  'notion-content-draft': {
    group: 'content',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/notionContentDraft.ts',
    summary:
      'Reads a source page in Notion, drafts a short update from it, and appends the draft ' +
      'to a target page.',
    title: 'Draft an update in Notion',
  },
  'notion-content-brand-review': {
    group: 'content',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/notionContentBrandReview.ts',
    summary:
      'The Notion draft, followed by a second agent that reviews it for brand voice and ' +
      'clarity before it is written back.',
    title: 'Draft with a brand review',
  },
  'send-slack-update': {
    group: 'content',
    maturity: 'seeded',
    source: 'packages/shared/src/workflow/templates/sendSlackUpdate.ts',
    summary:
      'Posts a message to a Slack channel. Public or external posts are held for approval ' +
      'under the default autonomy policy.',
    title: 'Post a Slack update',
  },
};

/** Route slug for a template's page. */
export function useCaseSlug(name) {
  return `${USE_CASE_ROUTE_PREFIX}/${name}`;
}

/**
 * Sidebar groups for the use-case section, in reading order.
 *
 * Collapsed by default: twenty-odd entries open at once would push every other section
 * of the docs below the fold.
 */
export function useCaseSidebar() {
  return [
    { label: 'All use cases', slug: USE_CASE_ROUTE_PREFIX },
    ...USE_CASE_GROUPS.map((group) => ({
      collapsed: true,
      items: Object.entries(USE_CASES)
        .filter(([, useCase]) => useCase.group === group.id)
        .map(([name]) => ({ slug: useCaseSlug(name) })),
      label: group.label,
    })),
  ];
}
