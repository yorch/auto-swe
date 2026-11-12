import type { InputSchema } from '../../lib/inputSchema.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const REPO_ONBOARDING_INPUT_SCHEMA: InputSchema = {
  type: 'object',
  properties: { connectionId: { type: 'connection', connectionType: 'git_repo' } },
  required: ['connectionId'],
};

export const REPO_ONBOARDING_SPEC: WorkflowSpec = {
  schemaVersion: SPEC_SCHEMA_VERSION,
  name: 'repo-onboarding',
  description:
    'Explore a repository, try its installation, checks and optional preview in a fresh checkout, then ask a person before proposing the configuration in a pull request.',
  entry: 'initialize',
  nodes: {
    initialize: {
      type: 'set',
      group: 'onboarding',
      values: {
        'context.onboardingReview.status': { literal: 'No valid draft.' },
        'context.onboardingReview.draftMarkdown': { literal: 'No valid draft.' },
        'context.onboardingReview.trialMarkdown': { literal: 'No trial has run.' },
      },
      next: 'draft',
    },
    draft: {
      type: 'agent',
      group: 'onboarding',
      agentRef: 'repo-onboarder',
      workspace: true,
      maxVisits: 3,
      onExhausted: 'review',
      next: 'parse',
      inputs: {
        task: {
          literal:
            'Explore this repository, try setup and checks, and return the complete onboarding draft as exactly one final fenced JSON block. Repair the previous proposal using the parse error, trial report and human feedback when supplied.',
        },
        connectionId: { from: 'request.payload.connectionId' },
        previousDraft: { from: 'nodes.parse.output.draft', default: null },
        parseError: { from: 'nodes.parse.output.error', default: '' },
        trialReport: { from: 'nodes.trial.output.markdown', default: '' },
        humanFeedback: { from: 'nodes.review.output', default: null },
      },
    },
    parse: {
      type: 'step',
      group: 'onboarding',
      step: 'parseAgentOutput',
      config: { kind: 'repoOnboardingDraft' },
      inputs: { text: { from: 'nodes.draft.output.text' } },
      next: 'validDraft',
    },
    validDraft: {
      type: 'cond',
      group: 'onboarding',
      expr: 'nodes.parse.output.valid == true',
      onTrue: 'trial',
      onFalse: 'invalidDraft',
    },
    invalidDraft: {
      type: 'set',
      group: 'onboarding',
      values: {
        'context.onboardingReview.status': {
          literal:
            'No valid draft. Approval cannot open a pull request. Any previous trial is not a trial of this invalid draft.',
        },
        'context.onboardingReview.draftMarkdown': { from: 'nodes.parse.output.markdown' },
        'context.onboardingReview.trialAppliesToCurrentDraft': { literal: false },
      },
      next: 'draft',
    },
    trial: {
      type: 'step',
      group: 'onboarding',
      step: 'repoOnboardingTrial',
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        draft: { from: 'nodes.parse.output.draft' },
      },
      next: 'trialReport',
    },
    trialReport: {
      type: 'set',
      group: 'onboarding',
      values: {
        'context.onboardingReview.status': {
          literal: 'Validated draft; review the trial results and blockers before approving.',
        },
        'context.onboardingReview.draftMarkdown': { from: 'nodes.parse.output.markdown' },
        'context.onboardingReview.trialMarkdown': { from: 'nodes.trial.output.markdown' },
        'context.onboardingReview.trialAppliesToCurrentDraft': { literal: true },
      },
      next: 'trialPassed',
    },
    trialPassed: {
      type: 'cond',
      group: 'onboarding',
      expr: 'nodes.trial.output.trialPassed == true',
      onTrue: 'review',
      onFalse: 'repairable',
    },
    repairable: {
      type: 'cond',
      group: 'onboarding',
      expr: 'nodes.trial.output.repairable == true',
      onTrue: 'draft',
      onFalse: 'review',
    },
    review: {
      type: 'humanApproval',
      group: 'onboarding',
      title: 'Review repository onboarding',
      description:
        'Review the draft and trial blockers. Approval proposes configuration even if its trial failed; merging the PR activates the files unless connection overrides win. No valid draft means no delivery.',
      contextFrom: 'context.onboardingReview',
      timeout: '7d',
      onApprove: 'canDeliver',
      onRequestChanges: 'draft',
      onReject: 'rejected',
      onTimeout: 'rejected',
    },
    canDeliver: {
      type: 'cond',
      group: 'onboarding',
      expr: 'nodes.parse.output.valid == true',
      onTrue: 'deliver',
      onFalse: 'rejected',
    },
    deliver: {
      type: 'step',
      group: 'onboarding',
      step: 'repoOnboardingPr',
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        draft: { from: 'nodes.parse.output.draft' },
        trialReport: { from: 'nodes.trial.output.markdown', default: '' },
      },
      next: 'done',
    },
    done: {
      type: 'terminate',
      status: 'SUCCESS',
      result: { delivery: { from: 'nodes.deliver.output' } },
    },
    rejected: { type: 'terminate', status: 'FAILED' },
  },
};
