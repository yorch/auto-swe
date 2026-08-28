import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

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
  nodes: {
    autoWrite: {
      inputs: {
        body: { from: 'nodes.draftResponse.output.text' },
        connectionId: { from: 'request.payload.connectionId' },
        public: { from: 'request.payload.public' },
        ticketId: { from: 'request.payload.ticketId' },
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
        published: { literal: true },
        text: { from: 'nodes.draftResponse.output.text' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    doneRejected: {
      result: {
        approved: { literal: false },
        published: { literal: false },
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
      next: 'publishOutcome',
      spanName: 'llm.zendesk_response',
      type: 'agent',
    },
    humanApproval: {
      contextFrom: 'nodes.draftResponse.output.text',
      description:
        'A support response is ready to be posted to Zendesk. Approve to publish, reject to discard.',
      onApprove: 'manualWrite',
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      timeout: '24h',
      title: 'Approve Zendesk ticket response',
      type: 'humanApproval',
    },
    manualWrite: {
      inputs: {
        body: { from: 'nodes.draftResponse.output.text' },
        connectionId: { from: 'request.payload.connectionId' },
        public: { from: 'request.payload.public' },
        ticketId: { from: 'request.payload.ticketId' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
    publishOutcome: {
      config: { action: 'external_communication' },
      inputs: {
        description: { from: 'request.payload.instructions' },
      },
      next: 'checkAuto',
      step: 'publishOutcome',
      type: 'step',
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
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
