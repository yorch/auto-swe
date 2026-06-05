import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Human categorises risk level; higher risk → stricter approval chain.
 */
export const TIERED_ESCALATION_SPEC: WorkflowSpec = {
  description:
    'After implementation, a human categorises the change risk (low / medium / high). ' +
    'Low-risk changes go straight to PR; medium require senior sign-off; ' +
    'high-risk changes require team-lead approval with a 48-hour window.',
  entry: 'setValidating',
  name: 'tiered-escalation',
  nodes: {
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    leadApproval: {
      description: 'High-risk change — this touches auth, payments, or data migration.',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '48h',
      title: 'Team lead sign-off required',
      type: 'humanApproval',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    riskDecision: {
      description: 'This helps route the change to the right approval chain.',
      onTimeout: 'seniorApproval',
      options: [
        { label: 'Low risk (docs, config, typos)', next: 'openPR', value: 'low' },
        { label: 'Medium risk (logic, new APIs)', next: 'seniorApproval', value: 'medium' },
        { label: 'High risk (auth, payments, migrations)', next: 'leadApproval', value: 'high' },
      ],
      storeAs: 'context.riskLevel',
      timeout: '2h',
      title: 'What is the risk level of this change?',
      type: 'humanDecision',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    seniorApproval: {
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Senior developer sign-off required',
      type: 'humanApproval',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'riskDecision',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
