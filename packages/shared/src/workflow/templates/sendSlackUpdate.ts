import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { policyGatedWrite, terminate } from './authoring/index.js';

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
    ...policyGatedWrite({
      action: 'external_communication',
      approval: {
        contextFrom: 'request.payload.message',
        description: 'A Slack message is ready to be posted. Approve to send, reject to discard.',
        title: 'Approve Slack update',
      },
      describeFrom: 'request.payload.message',
      rejectedResult: {
        approved: { literal: false },
        channelId: { from: 'request.payload.channelId' },
        posted: { literal: false },
        text: { from: 'request.payload.message' },
      },
      write: {
        inputs: {
          channelId: { from: 'request.payload.channelId' },
          connectionId: { from: 'request.payload.connectionId' },
          text: { from: 'request.payload.message' },
        },
      },
      writes: 'split',
    }),
    done: terminate('SUCCESS', {
      result: {
        channelId: { from: 'request.payload.channelId' },
        posted: { literal: true },
        text: { from: 'request.payload.message' },
      },
      title: 'Posted',
    }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
