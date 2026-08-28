import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Send a Slack update workflow.
 *
 * Takes a message and a target channel, evaluates the autonomy policy for an
 * external-communication action, and either posts immediately or pauses for
 * human approval first.
 */
export const SEND_SLACK_UPDATE_SPEC: WorkflowSpec = {
  description:
    'Send a Slack message to a channel. Public/external Slack posts require human approval under the default autonomy policy.',
  entry: 'publishOutcome',
  name: 'send-slack-update',
  nodes: {
    autoWrite: {
      inputs: {
        channelId: { from: 'request.payload.channelId' },
        connectionId: { from: 'request.payload.connectionId' },
        text: { from: 'request.payload.message' },
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
        channelId: { from: 'request.payload.channelId' },
        posted: { literal: true },
        text: { from: 'request.payload.message' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    doneRejected: {
      result: {
        approved: { literal: false },
        channelId: { from: 'request.payload.channelId' },
        posted: { literal: false },
        text: { from: 'request.payload.message' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    humanApproval: {
      contextFrom: 'request.payload.message',
      description: 'A Slack message is ready to be posted. Approve to send, reject to discard.',
      onApprove: 'manualWrite',
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      timeout: '24h',
      title: 'Approve Slack update',
      type: 'humanApproval',
    },
    manualWrite: {
      inputs: {
        channelId: { from: 'request.payload.channelId' },
        connectionId: { from: 'request.payload.connectionId' },
        text: { from: 'request.payload.message' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
    publishOutcome: {
      config: { action: 'external_communication' },
      inputs: {
        description: { from: 'request.payload.message' },
      },
      next: 'checkAuto',
      step: 'publishOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
