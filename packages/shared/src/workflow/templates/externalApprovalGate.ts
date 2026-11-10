import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { ciWaitEntry, prResult, signalGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Standard review + CI loop, then waits for an explicit deployment-gate signal
 * before declaring success. Models a release-train or change-management process
 * where a separate system (CD pipeline, change board) must send a go/no-go.
 * The run deploys nothing itself: it waits for that system's decision.
 */
export const EXTERNAL_APPROVAL_GATE_SPEC: WorkflowSpec = {
  description:
    'Implement, have the review agents check it, open a pull request and wait for CI. Then ' +
    'pause until an external system (a deploy pipeline or change-management board) sends ' +
    'its decision. An approval lets the run finish; a rejection or a timeout ends it.',
  entry: 'validate',
  name: 'external-approval-gate',
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
