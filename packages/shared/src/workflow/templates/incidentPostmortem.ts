import type { InputSchema } from '../../lib/inputSchema.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, terminate } from './authoring/index.js';

/**
 * What an `incident-postmortem` run takes. An inbound-event automation on a PagerDuty endpoint
 * that selects `incident.resolved` maps `incidentId` from `/event/data/id` and sets the rest as
 * options. Naming a Confluence connection (`docConnectionId`) also publishes the draft as a page.
 */
export const INCIDENT_POSTMORTEM_INPUT_SCHEMA: InputSchema = {
  properties: {
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    docConnectionId: {
      connectionType: 'confluence',
      description:
        'A Confluence connection to also publish the draft to, as a new page. Leave it empty to post the draft as a PagerDuty note only.',
      title: 'Confluence connection',
      type: 'connection',
    },
    incidentId: {
      description:
        'The PagerDuty incident id, such as Q2ZH7Y2SD3X0RE. An inbound.event automation fills it from /event/data/id.',
      maxLength: 32,
      pattern: '^[A-Z0-9]{1,32}$',
      title: 'Incident id',
      type: 'string',
    },
    pagerdutyConnectionId: {
      connectionType: 'pagerduty',
      title: 'PagerDuty connection',
      type: 'connection',
    },
    parentPageId: {
      description: 'The Confluence page to create the page under. Default: the connection’s.',
      title: 'Confluence parent page id',
      type: 'string',
    },
    spaceKey: {
      description: 'The Confluence space to create the page in. Default: the connection’s.',
      title: 'Confluence space key',
      type: 'string',
    },
    ticketId: { type: 'string' },
  },
  required: ['connectionId', 'pagerdutyConnectionId'],
  type: 'object',
};

const PAGERDUTY = { from: 'request.payload.pagerdutyConnectionId' } as const;
const INCIDENT = { from: 'request.payload.incidentId' } as const;
const DRAFT = { from: 'nodes.parsePostmortem.output.markdown' } as const;

const RESULT = {
  incidentId: INCIDENT,
  summary: { from: 'nodes.parsePostmortem.output.summary' },
  text: DRAFT,
  title: { from: 'nodes.parsePostmortem.output.title' },
} as const;

/**
 * Draft a postmortem for a resolved PagerDuty incident from its timeline, alerts and notes (the
 * triage diagnosis among them) read against the repository, and post it on the incident as a
 * note: an `internal_write`, so the default autonomy policy posts it without waiting.
 *
 * When the run names a Confluence connection and the draft parsed, it is then published as a new
 * Confluence page: an `external_write`, which waits for approval under the default policy. A
 * rejected note ends the run before the page.
 */
export const INCIDENT_POSTMORTEM_SPEC: WorkflowSpec = {
  description:
    'Draft a postmortem for a resolved PagerDuty incident from its timeline, alerts and notes, ' +
    'read against the repository, and post it on the incident as a note. With a Confluence ' +
    'connection it is also published as a page, after approval under the default autonomy policy.',
  entry: 'readIncident',
  name: 'incident-postmortem',
  nodes: mergeNodes(
    {
      readIncident: {
        group: 'incident',
        inputs: { connectionId: PAGERDUTY, incidentId: INCIDENT },
        next: 'draft',
        step: 'readSource',
        title: 'Read the incident, its alerts, log entries and notes',
        type: 'step',
      },
      draft: {
        agentRef: 'incidentPostmortemWriter',
        group: 'draft',
        inputs: { incident: { from: 'nodes.readIncident.output.data' } },
        next: 'parsePostmortem',
        spanName: 'llm.incident_postmortem',
        title: 'Draft the postmortem',
        type: 'agent',
        workspace: true,
      },
      parsePostmortem: {
        config: { kind: 'incidentPostmortem' },
        group: 'draft',
        inputs: { text: { from: 'nodes.draft.output.text' } },
        next: 'publishOutcome',
        step: 'parseAgentOutput',
        title: 'Check the draft',
        type: 'step',
      },
    },
    policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.parsePostmortem.output.markdown',
        description:
          'A postmortem draft is ready to be added to the PagerDuty incident as a note. Approve to post it, reject to discard it.',
        title: 'Approve PagerDuty postmortem note',
      },
      describeFrom: 'nodes.parsePostmortem.output.summary',
      done: 'routePage',
      group: 'note',
      rejectedResult: { ...RESULT, noted: { literal: false }, published: { literal: false } },
      write: { inputs: { connectionId: PAGERDUTY, content: DRAFT, incidentId: INCIDENT } },
      writes: 'split',
    }),
    {
      routePage: {
        expr:
          'nodes.parsePostmortem.output.valid == true && ' +
          "request.payload.docConnectionId != null && request.payload.docConnectionId != ''",
        group: 'page',
        onFalse: 'done',
        onTrue: 'pagePublishOutcome',
        title: 'Publish to Confluence?',
        type: 'cond',
      },
    },
    policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'nodes.parsePostmortem.output.markdown',
        description:
          'A postmortem draft is ready to be published as a Confluence page. Approve to publish it, reject to leave it as the incident note only.',
        title: 'Approve Confluence postmortem page',
      },
      describeFrom: 'nodes.parsePostmortem.output.title',
      done: 'published',
      group: 'page',
      idPrefix: 'page',
      rejectedResult: { ...RESULT, noted: { literal: true }, published: { literal: false } },
      write: {
        inputs: {
          bodyText: DRAFT,
          connectionId: { from: 'request.payload.docConnectionId' },
          parentPageId: { from: 'request.payload.parentPageId' },
          spaceKey: { from: 'request.payload.spaceKey' },
          title: { from: 'nodes.parsePostmortem.output.title' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        group: 'page',
        result: { ...RESULT, noted: { literal: true }, published: { literal: false } },
        title: 'Postmortem posted',
      }),
      published: terminate('SUCCESS', {
        group: 'page',
        result: {
          ...RESULT,
          noted: { literal: true },
          // The split writes name their nodes pageAutoWrite/pageManualWrite; one of them ran.
          pageUrl: {
            expr: 'nodes.pageAutoWrite.output.reference ?? nodes.pageManualWrite.output.reference',
          },
          published: { literal: true },
        },
        title: 'Postmortem posted and published',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
