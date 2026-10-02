import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

/**
 * Zendesk ticket reply workflow with Phase 3 governance.
 *
 * Fetches a Zendesk ticket, drafts a response with the support responder, checks
 * the team's autonomy policy, and either posts the comment immediately (auto) or
 * pauses for human approval first. A `public: true` payload can flip the policy
 * to require approval under the default platform rules.
 */
export const ZENDESK_TICKET_REPLY_SPEC: WorkflowSpec = {
  description:
    'Fetch a Zendesk ticket, draft a response with the support responder, and post it back. Public replies and other external-communication actions pause for human approval under the default autonomy policy.',
  entry: 'resolveWorkspace',
  name: 'zendesk-ticket-reply',
  nodes: mergeNodes(
    sourceHead({
      next: 'draftResponse',
      provider: 'record',
      read: { ticketId: { from: 'request.payload.ticketId' } },
    }),
    {
      draftResponse: {
        agentRef: 'supportResponder',
        group: 'draft',
        inputs: {
          instructions: { default: '', from: 'request.payload.instructions' },
          ticket: { from: 'nodes.readSource.output.data' },
        },
        next: 'publishOutcome',
        spanName: 'llm.zendesk_response',
        title: 'Draft the reply',
        type: 'agent',
      },
    },
    policyGatedWrite({
      action: 'external_communication',
      approval: {
        contextFrom: 'nodes.draftResponse.output.text',
        description:
          'A support response is ready to be posted to Zendesk. Approve to publish, reject to discard.',
        title: 'Approve Zendesk ticket response',
      },
      describeFrom: 'request.payload.instructions',
      rejectedResult: {
        approved: { literal: false },
        published: { literal: false },
        text: { from: 'nodes.draftResponse.output.text' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      write: {
        inputs: {
          body: { from: 'nodes.draftResponse.output.text' },
          connectionId: { from: 'request.payload.connectionId' },
          public: { from: 'request.payload.public' },
          ticketId: { from: 'request.payload.ticketId' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        result: {
          published: { literal: true },
          text: { from: 'nodes.draftResponse.output.text' },
          ticketId: { from: 'request.payload.ticketId' },
        },
        title: 'Published',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
