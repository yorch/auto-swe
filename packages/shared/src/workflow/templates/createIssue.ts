import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Create an issue in Linear or Jira from a title and description.
 *
 * The workflow evaluates the autonomy policy for an external write and either
 * creates the issue immediately or pauses for human approval first.
 */
export const CREATE_ISSUE_SPEC: WorkflowSpec = {
  description:
    'Create a Linear or Jira issue from a title and description. External writes require human approval under the default autonomy policy.',
  entry: 'publishOutcome',
  name: 'create-issue',
  nodes: {
    autoWrite: {
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        description: { from: 'request.payload.description' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
    checkAuto: {
      expr: "nodes.publishOutcome.output.decision == 'require_approval'",
      onFalse: 'autoWrite',
      onTrue: 'humanApproval',
      type: 'cond',
    },
    done: {
      result: {
        description: { from: 'request.payload.description' },
        issueUrl: { from: 'nodes.writeOutcome.output.reference' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    doneRejected: {
      result: {
        approved: { literal: false },
        created: { literal: false },
        description: { from: 'request.payload.description' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    humanApproval: {
      contextFrom: 'request.payload.title',
      description: 'An issue is ready to be created. Approve to create it, reject to discard.',
      onApprove: 'manualWrite',
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      timeout: '24h',
      title: 'Approve issue creation',
      type: 'humanApproval',
    },
    manualWrite: {
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        description: { from: 'request.payload.description' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
    publishOutcome: {
      config: { action: 'external_write' },
      inputs: {
        description: { from: 'request.payload.title' },
      },
      next: 'checkAuto',
      step: 'publishOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
