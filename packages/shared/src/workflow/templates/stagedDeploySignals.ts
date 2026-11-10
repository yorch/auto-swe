import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { ciWaitEntry, prResult, signalGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Standard review + CI, then two additional signal gates: staging deploy result
 * and production monitoring result. Models a release-train / canary pipeline
 * where external systems send go/no-go signals at each stage. The run deploys
 * nothing itself: it waits for the systems that do.
 *
 * Expected signals:
 *   stagingDeploySignal   — payload: { deployed: boolean }
 *   productionMonitorSignal — payload: { healthy: boolean }
 */
export const STAGED_DEPLOY_SIGNALS_SPEC: WorkflowSpec = {
  description:
    'Implement, have the review agents check it (up to 3 attempts), open a pull request and ' +
    'wait for CI. Then pause until an external system confirms the staging deploy, and ' +
    'again until it confirms production monitoring is healthy. Models a canary or ' +
    'release-train pipeline where each promotion stage must be confirmed before the next ' +
    'one starts.',
  entry: 'validate',
  name: 'staged-deploy-signals',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement' }),
    {
      implement: {
        group: 'implement',
        next: 'review',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
    },
    macro('review', 'reviewLoop@1', { approved: 'openPR' }),
    macro('pr', 'openPullRequest@1', { next: ciWaitEntry(), status: 'AWAITING_CI' }),
    macro('ci', 'ciLoop@1', {
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'waitForStaging',
    }),
    signalGate({
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
    signalGate({
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
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
