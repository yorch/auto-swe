import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
  openPullRequest,
  prResult,
  reviewLoop,
  signalGate,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Standard review + CI, then two additional signal gates: staging deploy result
 * and production monitoring result. Models a release-train / canary pipeline
 * where external systems send go/no-go signals at each stage.
 *
 * Expected signals:
 *   stagingDeploySignal   — payload: { deployed: boolean }
 *   productionMonitorSignal — payload: { healthy: boolean }
 */
export const CANARY_ROLLOUT_SPEC: WorkflowSpec = {
  description:
    'Implement, review (up to 3 agent attempts), open PR, wait for CI, ' +
    'then pause for a staging-deploy signal and finally a production-monitoring signal. ' +
    'Models a canary/release-train pipeline where each promotion stage must be ' +
    'explicitly confirmed by an external system before proceeding.',
  entry: 'setValidating',
  name: 'canary-rollout',
  nodes: {
    ...validatePhase({ next: 'setImplementing' }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'initCounters',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    initCounters: initCounters('setReviewing', { group: 'implement' }),

    ...reviewLoop({ approved: 'setAwaitingCi' }),

    setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    ...openPullRequest({ next: ciWaitEntry() }),
    ...ciLoop({
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'waitForStaging',
    }),

    ...signalGate({
      expr: 'context.stagingPayload.deployed == true',
      ids: {
        check: 'checkStaging',
        rejected: 'terminateStagingFailed',
        timedOut: 'terminateStagingTimedOut',
        wait: 'waitForStaging',
      },
      label: 'staging deploy',
      passed: 'waitForMonitoring',
      signal: 'stagingDeploySignal',
      storeAs: 'context.stagingPayload',
      timeout: '1h',
    }),
    ...signalGate({
      expr: 'context.monitorPayload.healthy == true',
      ids: {
        check: 'checkMonitoring',
        rejected: 'terminateRollbackRequired',
        timedOut: 'terminateMonitorTimedOut',
        wait: 'waitForMonitoring',
      },
      label: 'production monitoring',
      passed: 'done',
      signal: 'productionMonitorSignal',
      storeAs: 'context.monitorPayload',
      timeout: '2h',
    }),

    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
