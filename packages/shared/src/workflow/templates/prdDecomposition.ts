import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, terminate } from './authoring/index.js';

/**
 * PRD Decomposition workflow: a PM submits a PRD document, the system
 * analyses it for engineering readiness, a PM reviews the analysis, then the
 * system decomposes the PRD into epics and stories, an engineer approves the
 * decomposition, and the approved stories are pushed to the tracker and
 * auto-submitted as implementation work requests.
 */
export const PRD_DECOMPOSITION_SPEC: WorkflowSpec = {
  description:
    'Analyse a PRD for engineering readiness, collect PM feedback, decompose it into epics ' +
    'and stories, get Engineering sign-off, then create tracker tickets and submit each story ' +
    'as an implementation work request automatically.',
  entry: 'analyzePrd',
  name: 'prd-decomposition',
  nodes: mergeNodes({
    // Each phase has its own status vocabulary, stamped on the phase's first node.
    analyzePrd: {
      group: 'analyze',
      next: 'pmReview',
      status: 'ANALYZING',
      step: 'analyzePrd',
      storeAs: 'context.analysis',
      title: 'Analyse the PRD',
      type: 'step',
    },
    pmReview: {
      contentFrom: 'context.analysis',
      description:
        'Review the readiness analysis. You may add feedback (stored as the signal value) ' +
        'before the system decomposes the PRD into stories. Timeout skips PM feedback.',
      group: 'PM review',
      onSubmit: 'setPmFeedbackReceived',
      onTimeout: 'decomposePrd',
      storeAs: 'context.pmReviewPayload',
      timeout: '7d',
      title: 'PM Review: PRD Readiness Analysis',
      type: 'humanReview',
    },
    setPmFeedbackReceived: {
      group: 'PM review',
      next: 'decomposePrd',
      title: 'Note that PM feedback arrived',
      type: 'set',
      values: {
        'context.pmFeedbackReceived': { literal: true },
      },
    },
    decomposePrd: {
      group: 'decompose',
      inputs: {
        analysis: { from: 'context.analysis' },
        pmFeedback: { default: null, from: 'context.pmReviewPayload.value' },
      },
      next: 'engReview',
      status: 'DECOMPOSING',
      step: 'decomposePrd',
      storeAs: 'context.decomposition',
      title: 'Decompose into epics and stories',
      type: 'step',
    },
    engReview: {
      contentFrom: 'context.decomposition',
      description:
        'Review the proposed epic and story breakdown. Submit to approve and trigger ' +
        'automatic ticket creation and implementation queue submission. Timeout abandons the PRD run.',
      group: 'engineering review',
      onSubmit: 'storeEngReview',
      onTimeout: 'terminateTimeout',
      storeAs: 'context.engReviewPayload',
      timeout: '7d',
      title: 'Engineering Review: Approve Decomposition',
      type: 'humanReview',
    },
    storeEngReview: {
      group: 'engineering review',
      next: 'createTrackerItems',
      title: 'Keep the sign-off',
      type: 'set',
      values: {
        'context.engReviewPayload': { from: 'nodes.engReview.output' },
      },
    },
    terminateTimeout: terminate('TIMED_OUT', {
      group: 'engineering review',
      title: 'Review timed out',
    }),
    createTrackerItems: {
      group: 'tickets',
      inputs: {
        decomposition: { from: 'context.decomposition' },
      },
      next: 'submitPrdWorkRequests',
      onFail: 'warn',
      status: 'CREATING_TICKETS',
      step: 'createTrackerItems',
      storeAs: 'context.trackerItems',
      title: 'Create the tracker tickets',
      type: 'step',
    },
    submitPrdWorkRequests: {
      group: 'submit',
      inputs: {
        decomposition: { from: 'context.decomposition' },
        trackerItems: { default: null, from: 'context.trackerItems' },
      },
      next: 'done',
      status: 'SUBMITTING',
      step: 'submitPrdWorkRequests',
      title: 'Submit the work requests',
      type: 'step',
    },
    done: terminate('SUCCESS', {
      group: 'submit',
      result: {
        workRequestIds: { from: 'nodes.submitPrdWorkRequests.output.workRequestIds' },
      },
      title: 'Done',
    }),
  }),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
