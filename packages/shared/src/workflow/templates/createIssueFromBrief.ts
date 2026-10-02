import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { policyGatedWrite, terminate } from './authoring/index.js';

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
    draftIssue: {
      agentRef: 'issueDrafter',
      group: 'draft',
      inputs: {
        brief: { from: 'request.payload.brief' },
        instructions: { default: '', from: 'request.payload.instructions' },
        title: { from: 'request.payload.title' },
      },
      next: 'publishOutcome',
      spanName: 'llm.issue_draft',
      title: 'Draft the issue',
      type: 'agent',
    },
    ...policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'nodes.draftIssue.output.text',
        description: 'An issue draft is ready. Approve to create it, reject to discard.',
        title: 'Approve issue creation',
      },
      describeFrom: 'request.payload.title',
      rejectedResult: {
        approved: { literal: false },
        brief: { from: 'request.payload.brief' },
        created: { literal: false },
        description: { from: 'nodes.draftIssue.output.text' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      write: {
        inputs: {
          connectionId: { from: 'request.payload.connectionId' },
          description: { from: 'nodes.draftIssue.output.text' },
          projectKey: { from: 'request.payload.projectKey' },
          title: { from: 'request.payload.title' },
        },
      },
      writes: 'split',
    }),
    done: terminate('SUCCESS', {
      result: {
        brief: { from: 'request.payload.brief' },
        description: { from: 'nodes.draftIssue.output.text' },
        issueUrl: { from: 'nodes.writeOutcome.output.reference' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      title: 'Issue created',
    }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
