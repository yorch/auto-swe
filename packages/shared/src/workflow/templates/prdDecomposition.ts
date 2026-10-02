import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, statusStamp, terminate } from './authoring/index.js';

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
  entry: 'setAnalyzing',
  name: 'prd-decomposition',
  nodes: mergeNodes({
    // Each phase has its own status vocabulary, so these stamps stay explicit.
    setAnalyzing: statusStamp('ANALYZING', 'analyzePrd', { group: 'analyze' }),
    analyzePrd: {
      group: 'analyze',
      next: 'storePrdAnalysis',
      step: 'analyzePrd',
      title: 'Analyse the PRD',
      type: 'step',
    },
    storePrdAnalysis: {
      group: 'analyze',
      next: 'pmReview',
      title: 'Keep the analysis',
      type: 'set',
      values: {
        'context.analysis': { from: 'nodes.analyzePrd.output' },
      },
    },
    pmReview: {
      contentFrom: 'context.analysis',
      description:
        'Review the readiness analysis. You may add feedback (stored as the signal value) ' +
        'before the system decomposes the PRD into stories. Timeout skips PM feedback.',
      group: 'PM review',
      onSubmit: 'setPmFeedbackReceived',
      onTimeout: 'setDecomposing',
      storeAs: 'context.pmReviewPayload',
      timeout: '7d',
      title: 'PM Review: PRD Readiness Analysis',
      type: 'humanReview',
    },
    setPmFeedbackReceived: {
      group: 'PM review',
      next: 'setDecomposing',
      title: 'Note that PM feedback arrived',
      type: 'set',
      values: {
        'context.pmFeedbackReceived': { literal: true },
      },
    },
    setDecomposing: statusStamp('DECOMPOSING', 'decomposePrd', { group: 'decompose' }),
    decomposePrd: {
      group: 'decompose',
      inputs: {
        analysis: { from: 'context.analysis' },
        pmFeedback: { default: null, from: 'context.pmReviewPayload.value' },
      },
      next: 'storeDecomposition',
      step: 'decomposePrd',
      title: 'Decompose into epics and stories',
      type: 'step',
    },
    storeDecomposition: {
      group: 'decompose',
      next: 'engReview',
      title: 'Keep the decomposition',
      type: 'set',
      values: {
        'context.decomposition': { from: 'nodes.decomposePrd.output' },
      },
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
      next: 'setCreatingTickets',
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
    setCreatingTickets: statusStamp('CREATING_TICKETS', 'createTrackerItems', {
      group: 'tickets',
    }),
    createTrackerItems: {
      group: 'tickets',
      inputs: {
        decomposition: { from: 'context.decomposition' },
      },
      next: 'storeTrackerItems',
      onFail: 'warn',
      step: 'createTrackerItems',
      title: 'Create the tracker tickets',
      type: 'step',
    },
    storeTrackerItems: {
      group: 'tickets',
      next: 'setSubmitting',
      title: 'Keep the tickets',
      type: 'set',
      values: {
        'context.trackerItems': { from: 'nodes.createTrackerItems.output' },
      },
    },
    setSubmitting: statusStamp('SUBMITTING', 'submitPrdWorkRequests', { group: 'submit' }),
    submitPrdWorkRequests: {
      group: 'submit',
      inputs: {
        decomposition: { from: 'context.decomposition' },
        trackerItems: { default: null, from: 'context.trackerItems' },
      },
      next: 'done',
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
