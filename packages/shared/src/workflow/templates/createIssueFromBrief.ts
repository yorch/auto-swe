import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Draft an issue from a brief, then create it in Linear or Jira.
 *
 * The agent turns the brief into a focused description; governance decides
 * whether the external write proceeds automatically or waits for approval.
 */
export const CREATE_ISSUE_FROM_BRIEF_SPEC: WorkflowSpec = {
  description:
    'Draft a Linear or Jira issue from a brief and create it after policy/approval gating.',
  entry: 'draftIssue',
  name: 'create-issue-from-brief',
  nodes: {
    autoWrite: {
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        description: { from: 'nodes.draftIssue.output.text' },
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
        brief: { from: 'request.payload.brief' },
        description: { from: 'nodes.draftIssue.output.text' },
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
        brief: { from: 'request.payload.brief' },
        created: { literal: false },
        description: { from: 'nodes.draftIssue.output.text' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    draftIssue: {
      agentRef: 'issueDrafter',
      inputs: {
        brief: { from: 'request.payload.brief' },
        instructions: { default: '', from: 'request.payload.instructions' },
        title: { from: 'request.payload.title' },
      },
      next: 'publishOutcome',
      spanName: 'llm.issue_draft',
      type: 'agent',
    },
    humanApproval: {
      contextFrom: 'nodes.draftIssue.output.text',
      description: 'An issue draft is ready. Approve to create it, reject to discard.',
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
        description: { from: 'nodes.draftIssue.output.text' },
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
