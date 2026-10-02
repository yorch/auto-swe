import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, terminate } from './authoring/index.js';

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
  nodes: mergeNodes(
    policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'request.payload.title',
        description: 'An issue is ready to be created. Approve to create it, reject to discard.',
        title: 'Approve issue creation',
      },
      describeFrom: 'request.payload.title',
      rejectedResult: {
        approved: { literal: false },
        created: { literal: false },
        description: { from: 'request.payload.description' },
        projectKey: { from: 'request.payload.projectKey' },
        title: { from: 'request.payload.title' },
      },
      write: {
        inputs: {
          connectionId: { from: 'request.payload.connectionId' },
          description: { from: 'request.payload.description' },
          projectKey: { from: 'request.payload.projectKey' },
          title: { from: 'request.payload.title' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        result: {
          description: { from: 'request.payload.description' },
          issueUrl: { from: 'nodes.writeOutcome.output.reference' },
          projectKey: { from: 'request.payload.projectKey' },
          title: { from: 'request.payload.title' },
        },
        title: 'Issue created',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
