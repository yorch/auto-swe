import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
  mergeNodes,
  openPullRequest,
  prResult,
  reviewLoop,
  signalGate,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Standard review + CI loop, then waits for an explicit deployment-gate signal
 * before declaring success. Models a release-train or change-management process
 * where a separate system (CD pipeline, change board) must send a go/no-go.
 */
export const SIGNAL_GATED_ROLLOUT_SPEC: WorkflowSpec = {
  description:
    'Implement, have the review agents check it, open a pull request and wait for CI. Then ' +
    'pause until an external system (a deploy pipeline or change-management board) sends ' +
    'its decision. An approval lets the run finish; a rejection or a timeout ends it.',
  entry: 'setValidating',
  name: 'signal-gated-rollout',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing' }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'initCounters',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      initCounters: initCounters('setReviewing', { group: 'implement' }),
    },
    reviewLoop({ approved: 'setAwaitingCi' }),
    {
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    openPullRequest({ next: ciWaitEntry() }),
    ciLoop({
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'waitForDeployGate',
    }),
    signalGate({
      expr: 'context.deployPayload.approved == true',
      ids: {
        check: 'checkDeployGate',
        rejected: 'terminateDeployRejected',
        timedOut: 'terminateDeployTimedOut',
        wait: 'waitForDeployGate',
      },
      label: 'deploy gate',
      passed: 'done',
      signal: 'deploymentGateSignal',
      storeAs: 'context.deployPayload',
      timeout: '48h',
    }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
