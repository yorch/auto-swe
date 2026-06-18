import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

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
  nodes: {
    analyzePrd: {
      next: 'storePrdAnalysis',
      step: 'analyzePrd',
      type: 'step',
    },
    createTrackerItems: {
      inputs: {
        decomposition: { from: 'context.decomposition' },
      },
      next: 'storeTrackerItems',
      onFail: 'warn',
      step: 'createTrackerItems',
      type: 'step',
    },
    decomposePrd: {
      inputs: {
        analysis: { from: 'context.analysis' },
        pmFeedback: { default: null, from: 'context.pmReviewPayload.value' },
      },
      next: 'storeDecomposition',
      step: 'decomposePrd',
      type: 'step',
    },
    done: {
      result: {
        workRequestIds: { from: 'nodes.submitPrdWorkRequests.output.workRequestIds' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    engReview: {
      contentFrom: 'context.decomposition',
      description:
        'Review the proposed epic and story breakdown. Submit to approve and trigger ' +
        'automatic ticket creation and implementation queue submission. Timeout abandons the PRD run.',
      onSubmit: 'storeEngReview',
      onTimeout: 'terminateTimeout',
      storeAs: 'context.engReviewPayload',
      timeout: '7d',
      title: 'Engineering Review: Approve Decomposition',
      type: 'humanReview',
    },
    pmReview: {
      contentFrom: 'context.analysis',
      description:
        'Review the readiness analysis. You may add feedback (stored as the signal value) ' +
        'before the system decomposes the PRD into stories. Timeout skips PM feedback.',
      onSubmit: 'setPmFeedbackReceived',
      onTimeout: 'setDecomposing',
      storeAs: 'context.pmReviewPayload',
      timeout: '7d',
      title: 'PM Review: PRD Readiness Analysis',
      type: 'humanReview',
    },
    setAnalyzing: {
      config: { status: 'ANALYZING' },
      next: 'analyzePrd',
      step: 'updateDomainState',
      type: 'step',
    },
    setCreatingTickets: {
      config: { status: 'CREATING_TICKETS' },
      next: 'createTrackerItems',
      step: 'updateDomainState',
      type: 'step',
    },
    setDecomposing: {
      config: { status: 'DECOMPOSING' },
      next: 'decomposePrd',
      step: 'updateDomainState',
      type: 'step',
    },
    setPmFeedbackReceived: {
      next: 'setDecomposing',
      type: 'set',
      values: {
        'context.pmFeedbackReceived': { literal: true },
      },
    },
    setSubmitting: {
      config: { status: 'SUBMITTING' },
      next: 'submitPrdWorkRequests',
      step: 'updateDomainState',
      type: 'step',
    },
    storeDecomposition: {
      next: 'engReview',
      type: 'set',
      values: {
        'context.decomposition': { from: 'nodes.decomposePrd.output' },
      },
    },
    storeEngReview: {
      next: 'setCreatingTickets',
      type: 'set',
      values: {
        'context.engReviewPayload': { from: 'nodes.engReview.output' },
      },
    },
    storePrdAnalysis: {
      next: 'pmReview',
      type: 'set',
      values: {
        'context.analysis': { from: 'nodes.analyzePrd.output' },
      },
    },
    storeTrackerItems: {
      next: 'setSubmitting',
      type: 'set',
      values: {
        'context.trackerItems': { from: 'nodes.createTrackerItems.output' },
      },
    },
    submitPrdWorkRequests: {
      inputs: {
        decomposition: { from: 'context.decomposition' },
        trackerItems: { default: null, from: 'context.trackerItems' },
      },
      next: 'done',
      step: 'submitPrdWorkRequests',
      type: 'step',
    },
    terminateTimeout: {
      status: 'TIMED_OUT',
      type: 'terminate',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
