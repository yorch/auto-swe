/**
 * Curated starter specs for the "Start from…" gallery on /library.
 *
 * Each entry is a complete, valid WorkflowSpec the user can fork with one click, and each one is
 * built from node types only (no registered steps), so it runs on any deployment with the seeded
 * agents. Together they teach the node types a new author reaches for first; `teaches` names the
 * types a card exercises. `starterTemplates.test.ts` holds every spec to zero validation errors
 * and zero warnings, and checks that every agent it names is seeded.
 */

import {
  SPEC_SCHEMA_VERSION,
  type Node as SpecNode,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';

export interface StarterTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Node types this starter demonstrates (each distinct type once, in reading order). */
  teaches: SpecNode['type'][];
  /** Display tone for the card; maps to the existing palette. */
  tone: 'accent' | 'success' | 'warning' | 'info' | 'accent2' | 'paper';
  spec: WorkflowSpec;
}

const SCHEMA = SPEC_SCHEMA_VERSION;

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    description:
      'The smallest runnable workflow: write a value into the run context, then end with a result. Start here to see how a set node and a terminate node fit together.',
    id: 'blank',
    name: 'Blank canvas',
    spec: {
      description: 'Blank starter: set a value, then finish with it as the run result.',
      entry: 'start',
      name: 'blank-template',
      nodes: {
        done: {
          result: { greeting: { from: 'context.greeting' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        start: {
          next: 'done',
          type: 'set',
          values: { 'context.greeting': { literal: 'Hello from your first workflow' } },
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Set a value, finish · 2 nodes',
    teaches: ['set', 'terminate'],
    tone: 'paper',
  },
  {
    description:
      'An agent drafts text and an eval node checks it for personal data. If the check blocks, a counter allows up to three attempts before the run fails. Shows a bounded retry loop built from set, cond and eval.',
    id: 'draft-check-retry',
    name: 'Draft, check, retry',
    spec: {
      description:
        'Draft with an agent, score it, and retry up to three times if the check blocks.',
      entry: 'count',
      name: 'draft-check-retry',
      nodes: {
        check: {
          next: 'decide',
          onFail: 'warn',
          scorers: [{ kind: 'pii' }],
          target: { from: 'nodes.draft.output.text' },
          type: 'eval',
        },
        count: {
          next: 'draft',
          type: 'set',
          values: { 'context.attempts': { expr: '(context.attempts ?? 0) + 1' } },
        },
        decide: {
          expr: 'nodes.check.output.passed == true',
          onFalse: 'retry',
          onTrue: 'done',
          type: 'cond',
        },
        done: {
          result: { text: { from: 'nodes.draft.output.text' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        draft: {
          agentRef: 'contentWriter',
          inputs: {
            brief: {
              default: 'Write a two-line product update.',
              from: 'request.payload.brief',
            },
          },
          next: 'check',
          type: 'agent',
        },
        failed: { status: 'FAILED', type: 'terminate' },
        retry: {
          expr: '(context.attempts ?? 0) < 3',
          onFalse: 'failed',
          onTrue: 'count',
          type: 'cond',
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Agent + eval + bounded retry · 7 nodes',
    teaches: ['set', 'agent', 'eval', 'cond', 'terminate'],
    tone: 'success',
  },
  {
    description:
      'An agent drafts, a person reads the draft and leaves notes in a review step, and a second person approves or rejects the draft. A review returns a note, not an edited draft, so the run ends with both. Shows the two review-style human nodes and their timeout branches.',
    id: 'review-then-approve',
    name: 'Review, then approve',
    spec: {
      description: 'Draft with an agent, collect a reviewer’s notes, then ask for approval.',
      entry: 'draft',
      name: 'review-then-approve',
      nodes: {
        approve: {
          contextFrom: 'nodes.draft.output.text',
          description: 'Approve the draft to finish, or reject it to stop here.',
          onApprove: 'done',
          onReject: 'rejected',
          onTimeout: 'expired',
          timeout: '24h',
          title: 'Approve the draft',
          type: 'humanApproval',
        },
        done: {
          result: {
            notes: { default: '', from: 'context.notes.value' },
            text: { from: 'nodes.draft.output.text' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        draft: {
          agentRef: 'contentWriter',
          inputs: {
            brief: {
              default: 'Write a two-line product update.',
              from: 'request.payload.brief',
            },
          },
          next: 'review',
          type: 'agent',
        },
        expired: { status: 'TIMED_OUT', type: 'terminate' },
        rejected: { status: 'FAILED', type: 'terminate' },
        review: {
          contentFrom: 'nodes.draft.output.text',
          description: 'Leave notes on the draft for the approver, then submit.',
          onSubmit: 'approve',
          onTimeout: 'expired',
          storeAs: 'context.notes',
          timeout: '24h',
          title: 'Review the draft',
          type: 'humanReview',
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Agent + human review + approval · 6 nodes',
    teaches: ['agent', 'humanReview', 'humanApproval', 'terminate'],
    tone: 'warning',
  },
  {
    description:
      'Collect structured details from a person with a form, then ask them to pick the next step. Shows the input and decision nodes, with each option leading to its own branch.',
    id: 'ask-then-route',
    name: 'Ask, then route',
    spec: {
      description: 'Collect a short form, then route on the option a person picks.',
      entry: 'form',
      name: 'ask-then-route',
      nodes: {
        choose: {
          contextFrom: 'context.form.value.audience',
          description: 'Send the update now, or hold it for later.',
          onTimeout: 'expired',
          options: [
            { label: 'Send now', next: 'sent', value: 'send' },
            { label: 'Hold', next: 'held', value: 'hold' },
          ],
          timeout: '1h',
          title: 'What should happen next?',
          type: 'humanDecision',
        },
        expired: { status: 'TIMED_OUT', type: 'terminate' },
        form: {
          description: 'Tell us who the update is for.',
          fields: [
            {
              key: 'audience',
              label: 'Audience',
              options: ['internal', 'external'],
              required: true,
              type: 'select',
            },
            { key: 'notes', label: 'Notes', type: 'text' },
          ],
          onSubmit: 'choose',
          onTimeout: 'expired',
          storeAs: 'context.form',
          timeout: '1h',
          title: 'Describe the update',
          type: 'humanInput',
        },
        held: { status: 'SKIPPED', type: 'terminate' },
        sent: {
          result: { audience: { from: 'context.form.value.audience' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Form + decision routing · 5 nodes',
    teaches: ['humanInput', 'humanDecision', 'terminate'],
    tone: 'accent2',
  },
  {
    description:
      'Run an agent once per item in a list, up to three at a time, and collect every result into one list. Shows a fan-out with a per-item branch that ends on its own terminate node.',
    id: 'fan-out-and-collect',
    name: 'Fan out and collect',
    spec: {
      description: 'Summarise each topic in parallel, then collect the summaries.',
      entry: 'seed',
      name: 'fan-out-and-collect',
      nodes: {
        branchDone: {
          result: { text: { from: 'nodes.summarise.output.text' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        done: {
          result: { summaries: { from: 'nodes.split.output.plucked' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        seed: {
          next: 'split',
          type: 'set',
          values: {
            'context.topics': { literal: ['pricing', 'onboarding', 'reliability'] },
          },
        },
        split: {
          concurrency: 3,
          itemKey: 'topic',
          join: 'done',
          onBranchFail: 'block',
          over: { from: 'context.topics' },
          pluck: 'result.text',
          subgraph: 'summarise',
          type: 'fanOut',
        },
        summarise: {
          agentRef: 'contentWriter',
          inputs: {
            brief: { literal: 'Write a two-sentence customer update about this topic.' },
            topic: { from: 'topic' },
          },
          next: 'branchDone',
          type: 'agent',
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'Parallel agent per item · 5 nodes',
    teaches: ['set', 'fanOut', 'agent', 'terminate'],
    tone: 'accent',
  },
  {
    description:
      'Pause until something outside the workflow sends the run a signal named "go", or give up after an hour. Nothing in the dashboard sends it: deliver it to the run’s Temporal workflow with Temporal tooling, such as temporal workflow signal --name go. Shows a signal node and its timeout branch.',
    id: 'wait-for-event',
    name: 'Wait for an event',
    spec: {
      description: 'Pause until the "go" signal arrives, or time out after an hour.',
      entry: 'wait',
      name: 'wait-for-event',
      nodes: {
        done: {
          result: { received: { from: 'context.go' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        expired: { status: 'TIMED_OUT', type: 'terminate' },
        wait: {
          name: 'go',
          onReceive: 'done',
          onTimeout: 'expired',
          storeAs: 'context.go',
          timeout: '1h',
          type: 'signal',
        },
      },
      schemaVersion: SCHEMA,
    },
    tagline: 'External signal with timeout · 3 nodes',
    teaches: ['signal', 'terminate'],
    tone: 'info',
  },
];
