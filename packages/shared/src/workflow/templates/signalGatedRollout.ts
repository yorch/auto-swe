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
    'Implement, run the agent review loop, open a PR, wait for CI, then pause for a ' +
    'deployment-gate signal from an external system (CD pipeline, change-management board). ' +
    'The gate signal carries an approval flag; rejection or timeout terminates the run.',
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
