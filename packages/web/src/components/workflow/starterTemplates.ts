/**
 * Curated starter specs for the "Start from…" gallery on /workflows/library.
 *
 * Each entry is a complete, valid WorkflowSpec the user can fork with one
 * click. Kept intentionally short (4-8 nodes) so the visual editor isn't
 * overwhelming on first load.
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '@auto-swe/shared/workflow';

export interface StarterTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Display tone for the card; maps to the existing palette. */
  tone: 'ember' | 'moss' | 'amber' | 'dust' | 'violet' | 'paper';
  spec: WorkflowSpec;
}

const SCHEMA = SPEC_SCHEMA_VERSION;

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    description:
      'A minimal skeleton — single step, no branching. Useful as a starting point for custom workflows.',
    id: 'blank',
    name: 'Blank canvas',
    spec: {
      description: 'Blank starter — replace this step with your first action.',
      entry: 'start',
      name: 'blank-template',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        start: { next: 'done', step: 'noop', type: 'step' },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Empty starter · 2 nodes',
    tone: 'paper',
  },
  {
    description:
      'Implement a change, run a review loop, gate on approval, then wait for human merge. Mirrors the default engineering workflow at smaller scale.',
    id: 'review-loop',
    name: 'Review-and-merge',
    spec: {
      description: 'Implement → review → gate on approval → wait for human merge.',
      entry: 'implement',
      name: 'review-and-merge',
      nodes: {
        awaitMerge: { next: 'done', step: 'wait-for-human-merge', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: {
          expr: 'nodes.review.output.approved == true',
          onFalse: 'implement',
          onTrue: 'awaitMerge',
          type: 'cond',
        },
        implement: { next: 'review', step: 'implement', type: 'step' },
        review: { next: 'gate', step: 'review', type: 'step' },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Implement → review → merge · 5 nodes',
    tone: 'ember',
  },
  {
    description:
      'Implement, then run tests in CI. Block the workflow on a green build before flagging for human merge.',
    id: 'code-and-test',
    name: 'Code + CI',
    spec: {
      description: 'Implement → CI → gate on green → human merge.',
      entry: 'implement',
      name: 'code-and-ci',
      nodes: {
        awaitCI: { next: 'gate', step: 'await-ci', type: 'step' },
        awaitMerge: { next: 'done', step: 'wait-for-human-merge', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
        failed: { status: 'FAILED', type: 'terminate' },
        gate: {
          expr: 'context.ciResultPayload.passed == true',
          onFalse: 'failed',
          onTrue: 'awaitMerge',
          type: 'cond',
        },
        implement: { next: 'awaitCI', step: 'implement', type: 'step' },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Implement → CI → merge · 6 nodes',
    tone: 'moss',
  },
  {
    description:
      'Wait for an external signal (e.g. a Slack approval) before proceeding. Falls through to a timeout branch if the signal never arrives.',
    id: 'signal-gated',
    name: 'Signal-gated rollout',
    spec: {
      description: 'Pause until an external approval signal arrives, or timeout.',
      entry: 'prep',
      name: 'signal-gated',
      nodes: {
        approval: {
          name: 'human.approval',
          onReceive: 'rollout',
          onTimeout: 'timedOut',
          timeout: '24h',
          type: 'signal',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        prep: { next: 'approval', step: 'prepare-change', type: 'step' },
        rollout: { next: 'done', step: 'apply-change', type: 'step' },
        timedOut: { status: 'TIMED_OUT', type: 'terminate' },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Approval signal with 24h timeout · 5 nodes',
    tone: 'dust',
  },
  {
    description:
      'Fan out the same action across N parallel subtasks (e.g. per file, per service) and join the results before continuing.',
    id: 'fan-out',
    name: 'Parallel fan-out',
    spec: {
      description: 'Fan a single intent into N parallel subtasks, then join.',
      entry: 'plan',
      name: 'parallel-fan-out',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        join: { next: 'done', step: 'join-results', type: 'step' },
        plan: { next: 'split', step: 'plan-targets', type: 'step' },
        split: {
          itemKey: 'subtask',
          join: 'join',
          onBranchFail: 'block',
          over: { from: 'ctx.targets' },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'split', step: 'apply-to-target', type: 'step' },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Per-target parallelism · 5 nodes',
    tone: 'violet',
  },
];
