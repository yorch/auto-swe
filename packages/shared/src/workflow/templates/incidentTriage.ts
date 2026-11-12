import type { InputSchema } from '../../lib/inputSchema.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { policyGatedWrite, prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/** The confidence a diagnosis needs before `mode: fix` attempts a change, unless the run sets one. */
export const INCIDENT_TRIAGE_DEFAULT_MIN_FIX_CONFIDENCE = 0.7;

/**
 * What an `incident-triage` run takes. An inbound-event automation on a PagerDuty endpoint maps
 * `incidentId` from `/event/data/id` and sets the rest as options: the repository, the PagerDuty
 * connection (checked against the automation's team at save and at every fire), and the mode.
 */
export const INCIDENT_TRIAGE_INPUT_SCHEMA: InputSchema = {
  properties: {
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    incidentId: {
      description: 'The PagerDuty incident id, such as Q2ZH7Y2SD3X0RE.',
      maxLength: 32,
      pattern: '^[A-Z0-9]{1,32}$',
      title: 'Incident id',
      type: 'string',
    },
    minFixConfidence: {
      description: `How sure the diagnosis must be (0 to 1) before fix mode changes code. Default ${INCIDENT_TRIAGE_DEFAULT_MIN_FIX_CONFIDENCE}.`,
      maximum: 1,
      minimum: 0,
      title: 'Minimum fix confidence',
      type: 'number',
    },
    mode: {
      description:
        '`triage` (the default) diagnoses and posts a note. `fix` also opens a draft pull request when the diagnosis is a code defect.',
      enum: ['triage', 'fix'],
      title: 'Mode',
      type: 'string',
    },
    pagerdutyConnectionId: {
      connectionType: 'pagerduty',
      title: 'PagerDuty connection',
      type: 'connection',
    },
    ticketId: { type: 'string' },
  },
  required: ['connectionId', 'pagerdutyConnectionId', 'incidentId'],
  type: 'object',
};

const PAGERDUTY = { from: 'request.payload.pagerdutyConnectionId' } as const;
const INCIDENT = { from: 'request.payload.incidentId' } as const;

/** What every outcome reports. */
const TRIAGE_RESULT = {
  confidence: { from: 'nodes.parseTriage.output.confidence' },
  fixable: { from: 'nodes.parseTriage.output.fixable' },
  incidentId: INCIDENT,
  summary: { from: 'nodes.parseTriage.output.summary' },
  text: { from: 'nodes.parseTriage.output.markdown' },
} as const;

/**
 * Diagnose a PagerDuty incident against the repository and post the diagnosis as an incident
 * note. The note is an `internal_write`, so the default autonomy policy posts it without waiting;
 * a team that wants a person to sign off requires approval for that class.
 *
 * `mode: fix` (off by default) also has the implementer attempt the change when the diagnosis
 * is a code defect at or above `minFixConfidence`, runs the quality gates and opens a DRAFT pull
 * request, which the note links. A fix that fails or changes nothing still posts the diagnosis.
 */
export const INCIDENT_TRIAGE_SPEC: WorkflowSpec = {
  description:
    'Diagnose a PagerDuty incident against the repository and post the diagnosis as an ' +
    'incident note. In fix mode, a code defect diagnosed with enough confidence also gets a ' +
    'draft pull request, linked from the note. The note is an internal write: it posts without ' +
    'approval under the default autonomy policy.',
  entry: 'readIncident',
  name: 'incident-triage',
  ...authored(
    {
      readIncident: {
        group: 'incident',
        inputs: { connectionId: PAGERDUTY, incidentId: INCIDENT },
        next: 'triage',
        step: 'readSource',
        title: 'Read the incident, its alerts and log entries',
        type: 'step',
      },
      triage: {
        agentRef: 'incidentTriager',
        group: 'triage',
        inputs: { incident: { from: 'nodes.readIncident.output.data' } },
        next: 'parseTriage',
        spanName: 'llm.incident_triage',
        title: 'Diagnose the incident',
        type: 'agent',
        workspace: true,
      },
      parseTriage: {
        config: { kind: 'incidentTriage' },
        group: 'triage',
        inputs: { text: { from: 'nodes.triage.output.text' } },
        next: 'routeFix',
        step: 'parseAgentOutput',
        title: 'Check the diagnosis',
        type: 'step',
      },
      routeFix: {
        expr:
          "request.payload.mode == 'fix' && nodes.parseTriage.output.valid == true && " +
          'nodes.parseTriage.output.fixable == true && nodes.parseTriage.output.confidence >= ' +
          `(request.payload.minFixConfidence ?? ${INCIDENT_TRIAGE_DEFAULT_MIN_FIX_CONFIDENCE})`,
        group: 'triage',
        onFalse: 'publishOutcome',
        onTrue: 'implement',
        title: 'Attempt a fix?',
        type: 'cond',
      },
      implement: {
        group: 'fix',
        // Fenced and labelled as untrusted data by the step, never as the requester's guidance.
        inputs: { incidentDiagnosis: { from: 'nodes.parseTriage.output.brief' } },
        next: 'checkChanged',
        onFailure: 'fixFailed',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Fix the cause',
        type: 'step',
      },
      fixFailed: {
        group: 'fix',
        next: 'publishOutcome',
        title: 'Record that the fix failed',
        type: 'set',
        values: {
          'context.fixOutcome': {
            literal: 'a fix was attempted but failed before a pull request was opened',
          },
        },
      },
      checkChanged: {
        expr: 'context.currentCodeResult.filesChanged.length == 0',
        group: 'fix',
        onFalse: 'runLint',
        onTrue: 'noChange',
        title: 'Did the fix change anything?',
        type: 'cond',
      },
      noChange: {
        group: 'fix',
        next: 'publishOutcome',
        title: 'Record that nothing changed',
        type: 'set',
        values: { 'context.fixOutcome': { literal: 'the fix attempt changed no files' } },
      },
      runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
      runTypecheck: qualityGate('runTypecheck', 'runTests', { group: 'verify' }),
      runTests: qualityGate('runTests', 'openPR', { group: 'verify' }),
    },
    macro('pr', 'openPullRequest@1', { draft: true, next: 'fixPublishOutcome' }),
    policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.parseTriage.output.markdown',
        description:
          'An incident diagnosis is ready to be added to the PagerDuty incident as a note. Approve to post it, reject to discard it.',
        title: 'Approve PagerDuty incident note',
      },
      describeFrom: 'nodes.parseTriage.output.summary',
      group: 'note',
      rejectedResult: { ...TRIAGE_RESULT, noted: { literal: false } },
      write: {
        inputs: {
          connectionId: PAGERDUTY,
          content: { from: 'nodes.parseTriage.output.markdown' },
          fixOutcome: { from: 'context.fixOutcome' },
          incidentId: INCIDENT,
        },
      },
      writes: 'split',
    }),
    policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.parseTriage.output.markdown',
        description:
          'An incident diagnosis and its draft fix are ready to be added to the PagerDuty incident as a note. Approve to post it, reject to discard it.',
        title: 'Approve PagerDuty incident note',
      },
      describeFrom: 'nodes.parseTriage.output.summary',
      done: 'fixed',
      group: 'fixNote',
      idPrefix: 'fix',
      rejectedResult: { ...TRIAGE_RESULT, ...prResult(), noted: { literal: false } },
      write: {
        inputs: {
          connectionId: PAGERDUTY,
          content: { from: 'nodes.parseTriage.output.markdown' },
          incidentId: INCIDENT,
          prUrl: { from: 'context.prUrl' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        group: 'note',
        result: {
          ...TRIAGE_RESULT,
          fixOutcome: { from: 'context.fixOutcome' },
          noted: { literal: true },
        },
        title: 'Diagnosis posted',
      }),
      fixed: terminate('SUCCESS', {
        group: 'fixNote',
        result: { ...TRIAGE_RESULT, ...prResult(), noted: { literal: true } },
        title: 'Diagnosis and draft fix posted',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
