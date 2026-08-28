import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Zendesk ticket reply workflow.
 *
 * Fetches a Zendesk ticket, drafts a response with the support responder, and
 * posts it back as an internal comment by default. The payload can set
 * `public: true` to post a public reply.
 */
export const ZENDESK_TICKET_REPLY_SPEC: WorkflowSpec = {
  description:
    'Fetch a Zendesk ticket, draft a response with the support responder, and post it as an internal comment or public reply.',
  entry: 'resolveWorkspace',
  name: 'zendesk-ticket-reply',
  nodes: {
    done: {
      result: {
        text: { from: 'nodes.draftResponse.output.text' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    draftResponse: {
      agentRef: 'supportResponder',
      inputs: {
        instructions: { default: '', from: 'request.payload.instructions' },
        ticket: { from: 'nodes.readSource.output.data' },
      },
      next: 'writeOutcome',
      spanName: 'llm.zendesk_response',
      type: 'agent',
    },
    readSource: {
      config: {},
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      next: 'draftResponse',
      step: 'readSource',
      type: 'step',
    },
    resolveWorkspace: {
      config: { workspaceProvider: 'record' },
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
      },
      next: 'readSource',
      step: 'resolveWorkspace',
      type: 'step',
    },
    writeOutcome: {
      config: {},
      inputs: {
        body: { from: 'nodes.draftResponse.output.text' },
        connectionId: { from: 'request.payload.connectionId' },
        public: { default: false, from: 'request.payload.public' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
