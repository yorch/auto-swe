import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prResult, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Human categorises risk level; higher risk → stricter approval chain.
 */
export const TIERED_ESCALATION_SPEC: WorkflowSpec = {
  description:
    "After implementation, a person rates the change's risk (low, medium or high). Low-risk " +
    'changes go straight to a pull request, medium-risk ones need senior sign-off, and ' +
    'high-risk ones need team-lead approval within 48 hours.',
  entry: 'validate',
  name: 'tiered-escalation',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'riskDecision',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
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
    },
    macro('pr', 'openPullRequest@1', { next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
