import { z } from 'zod';
import {
  CI_EVENT_INPUT_KEYS,
  CI_TRIAGE_DEFAULTS,
  CI_TRIAGE_TEMPLATE_NAME,
  CI_TRIGGER_EVENTS,
  CiTriagePayloadSchema,
  ciEventLabel,
  GlobListSchema,
  matchesPatterns,
} from '../../lib/ciTrigger.js';
import { isPlatformWorkBranch } from '../../lib/gitRef.js';
import { type InputSchema, validateInputPayload } from '../../lib/inputSchema.js';
import type { EventSource } from '../types.js';

/** The source key stored on an automation that reacts to failed GitHub Actions runs. */
export const WORKFLOW_RUN_FAILED = 'github.workflow_run.failed';

export const WorkflowRunFailedFiltersSchema = z.object({
  /** Globs over the failing branch. Required: no automation reacts to every branch by default. */
  branchPatterns: GlobListSchema,
  events: z
    .array(z.enum(CI_TRIGGER_EVENTS))
    .min(1)
    .max(CI_TRIGGER_EVENTS.length)
    .transform((events) => [...new Set(events)]),
  /** Globs over the workflow FILE path, never its display name, which a pull request can change. */
  workflowPatterns: GlobListSchema,
});
export type WorkflowRunFailedFilters = z.infer<typeof WorkflowRunFailedFiltersSchema>;

/** A failed workflow run, as a decision needs it. Built from the signed webhook alone. */
export const WorkflowRunFailedFactsSchema = z.object({
  branch: z.string().min(1).max(255),
  event: z.string().min(1).max(64),
  headSha: z.string().min(1).max(64),
  pullRequestNumber: z.number().int().positive().nullable(),
  runAttempt: z.number().int().min(1),
  runId: z.string().regex(/^\d{1,20}$/),
  workflowPath: z.string().min(1).max(500),
});
export type WorkflowRunFailedFacts = z.infer<typeof WorkflowRunFailedFactsSchema>;

/** A workflow path fit to quote in a run description, or a neutral stand-in. */
function quotablePath(path: string): string {
  return /^[\w./-]{1,200}$/.test(path) ? path : 'a GitHub Actions workflow';
}

/**
 * Failed GitHub Actions runs (`workflow_run`, completed with `failure` or `timed_out`) of
 * `push` and `pull_request` workflows: the CI triage source (docs/ci-failure-triggers.md).
 * A run's subject is its commit (one run per commit) and its scope its branch.
 */
export const workflowRunFailedSource: EventSource<
  WorkflowRunFailedFilters,
  WorkflowRunFailedFacts
> = {
  contract: CiTriagePayloadSchema,
  dedupeKey: (repoKey, x) => `${repoKey}#${x.runId}/${x.runAttempt}`.toLowerCase(),
  defaultFilters: {
    branchPatterns: ['main', 'release/*'],
    events: ['push'],
    workflowPatterns: ['.github/workflows/**'],
  },
  defaultTemplate: { name: CI_TRIAGE_TEMPLATE_NAME },
  describe: (f) =>
    `${f.events.map(ciEventLabel).join(' or ')} on ` +
    `${f.branchPatterns.join(', ')} · ${f.workflowPatterns.join(', ')}`,
  describeInputs(given) {
    // The built-in template's defaults under what is given: a summary of the default template.
    const v: Record<string, unknown> = { ...CI_TRIAGE_DEFAULTS, ...given };
    const parts: string[] = [];
    if (v.mode === 'fix') {
      parts.push(
        typeof v.minFixConfidence === 'number'
          ? `Diagnose and draft a fix at confidence ≥ ${v.minFixConfidence}`
          : 'Diagnose and draft a fix'
      );
      if (v.pullRequestDelivery === 'push') {
        parts.push('pushes pull request fixes where allowed');
      }
    } else if (v.mode === 'triage') {
      parts.push('Diagnose only');
    }
    if (v.commentOnPullRequest === true) {
      parts.push('comments on pull requests');
    }
    return parts.join(' · ');
  },
  describeOccurrence(f) {
    const text = (k: string) =>
      typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '?';
    const pr = typeof f.pullRequestNumber === 'number' ? ` (PR #${f.pullRequestNumber})` : '';
    return `${text('workflowPath')} on ${text('branch')}${pr} · ${text('event')} · run ${text('runId')}/${text('runAttempt')}`;
  },
  eventInputKeys: CI_EVENT_INPUT_KEYS,
  facts: WorkflowRunFailedFactsSchema,
  filterFields: [
    {
      key: 'events',
      kind: 'choices',
      label: 'Failures of',
      options: [
        { label: 'Pushes', value: 'push' },
        { label: 'Pull requests from this repository', value: 'pull_request' },
        { label: 'Scheduled runs', value: 'schedule' },
      ],
    },
    {
      hint: 'Globs over the failing branch. * stays within a path segment, ** crosses them, !pattern excludes; the last match wins.',
      key: 'branchPatterns',
      kind: 'globs',
      label: 'Branches',
    },
    {
      hint: 'Globs over the workflow file path, never its display name.',
      key: 'workflowPatterns',
      kind: 'globs',
      label: 'Workflow files',
    },
  ],
  filters: WorkflowRunFailedFiltersSchema,
  gatedOptions: [
    {
      defaultTemplateOnly: true,
      disabledMessage:
        "Pushing CI fixes to pull request branches is switched off (github.ciFixPushToPullRequestEnabled); choose 'draft_pr'",
      key: 'pullRequestDelivery',
      setting: 'github.ciFixPushToPullRequestEnabled',
      values: ['push'],
    },
  ],
  // The platform's own runs have their own CI loop, and a fix PR whose CI fails must not
  // start a fix of the fix.
  ignore: (x, ctx) =>
    isPlatformWorkBranch(x.branch, ctx.branchPrefix) ? 'a platform work branch' : null,
  // An implementation, then up to six CI waits of four hours (the first, and one after each
  // of at most five revisions).
  inFlightLookbackMs: 36 * 60 * 60 * 1000,
  key: WORKFLOW_RUN_FAILED,
  keys: (x) => ({ scope: x.branch, subject: x.headSha }),
  killSwitch: 'github.ciFailureTriggersEnabled',
  label: 'When CI fails',
  mismatch(f, x) {
    if (!(f.events as readonly string[]).includes(x.event)) {
      return `it does not react to ${ciEventLabel(x.event)}`;
    }
    if (!matchesPatterns(f.branchPatterns, x.branch)) {
      return `the branch '${x.branch}' is not selected by its branch patterns`;
    }
    if (!matchesPatterns(f.workflowPatterns, x.workflowPath)) {
      return `the workflow file '${x.workflowPath}' is not selected by its workflow patterns`;
    }
    return null;
  },
  precondition: (x) =>
    x.event === 'pull_request' && x.pullRequestNumber === null
      ? 'no open pull request from this branch'
      : null,
  run: (x) => ({
    description:
      `Fix the failing ${quotablePath(x.workflowPath)} on ${x.branch} ` +
      `(commit ${x.headSha.slice(0, 12)}).`,
    fields: {
      baseBranch: x.branch,
      githubRunId: x.runId,
      ...(x.pullRequestNumber !== null ? { pullRequestNumber: x.pullRequestNumber } : {}),
      runAttempt: x.runAttempt,
    },
    ticketId: `ci-${x.runId}-${x.runAttempt}`,
    ticketIsSynthetic: true,
  }),
  // One sample per event the filters react to: a pull-request failure carries a pull request
  // number and a push failure does not, so an option that needs one is caught at save time.
  samples: (f) =>
    f.events.map((event) => ({
      branch: 'main',
      event,
      headSha: 'a'.repeat(40),
      pullRequestNumber: event === 'pull_request' ? 1 : null,
      runAttempt: 1,
      runId: '1',
      workflowPath: '.github/workflows/ci.yml',
    })),
  summary:
    'A GitHub Actions run of a push, pull request or schedule fails: diagnose it, and optionally fix it.',
  templateCompatible(schema: InputSchema) {
    if (!('githubRunId' in schema.properties)) {
      return false;
    }
    // The run's own fields must fit; options the template requires are the automation's.
    const runFields: Record<string, unknown> = {
      baseBranch: 'main',
      connectionId: '00000000-0000-4000-8000-000000000000',
      description: 'Fix the failing workflow',
      githubRunId: '1',
      pullRequestNumber: 1,
      runAttempt: 1,
      ticketId: 'ci-1-1',
    };
    return validateInputPayload(
      { ...schema, required: (schema.required ?? []).filter((k) => k in runFields) },
      runFields
    ).ok;
  },
  tester: {
    facts: (v) => ({
      branch: (v.branch ?? '').trim(),
      event: v.event ?? 'push',
      headSha: 'a'.repeat(40),
      pullRequestNumber: v.event === 'pull_request' ? 1 : null,
      runAttempt: 1,
      runId: '1',
      workflowPath: (v.workflowPath ?? '').trim(),
    }),
    fields: [
      {
        initial: 'push',
        key: 'event',
        label: 'Event',
        options: [
          { label: 'Push', value: 'push' },
          { label: 'Pull request', value: 'pull_request' },
          { label: 'Scheduled run', value: 'schedule' },
        ],
      },
      { initial: 'main', key: 'branch', label: 'Branch' },
      { initial: '.github/workflows/ci.yml', key: 'workflowPath', label: 'Workflow file' },
    ],
  },
  workflowId: { part: (x) => `${x.runId.slice(-12)}-${x.runAttempt}`, prefix: 'ci' },
};
