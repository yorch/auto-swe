import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  openPullRequest,
  prResult,
  statusStamp,
  storeCodeResult,
  terminate,
  validatePhase,
} from './authoring/index.js';

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
    ...validatePhase({ next: 'setImplementing', successCriteria: false }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'storeCodeResult',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    storeCodeResult: storeCodeResult('riskDecision', { group: 'implement' }),

    riskDecision: {
      description: 'This helps route the change to the right approval chain.',
      group: 'approval',
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
    seniorApproval: {
      group: 'approval',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Senior developer sign-off required',
      type: 'humanApproval',
    },
    leadApproval: {
      description: 'High-risk change — this touches auth, payments, or data migration.',
      group: 'approval',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '48h',
      title: 'Team lead sign-off required',
      type: 'humanApproval',
    },
    terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
    terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),

    ...openPullRequest({ next: 'done' }),
    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
