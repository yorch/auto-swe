import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * After a vuln scan, a human decides: fix now, accept risk, or abandon.
 */
export const SECURITY_TRIAGE_SPEC: WorkflowSpec = {
  description:
    'Implement, run a vulnerability scan, then ask a person how to proceed. Three choices: ' +
    'fix the issues now, accept the risk and open the pull request anyway, or abandon the ' +
    'change.',
  entry: 'validate',
  name: 'security-triage',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'vulnScan',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      vulnScan: qualityGate('runVulnScan', 'securityDecision', { group: 'security triage' }),
      securityDecision: {
        description: 'Vulnerability scan complete. Choose how to proceed.',
        group: 'security triage',
        onTimeout: 'openPR',
        options: [
          { label: 'Fix vulnerabilities now', next: 'fixVulns', value: 'fix' },
          { label: 'Accept risk — open PR as-is', next: 'openPR', value: 'accept' },
          { label: 'Abandon — too risky', next: 'terminateAbandoned', value: 'abandon' },
        ],
        storeAs: 'context.securityDecision',
        timeout: '4h',
        title: 'How should we handle the security scan results?',
        type: 'humanDecision',
      },
      fixVulns: {
        group: 'security triage',
        inputs: {
          gateName: { literal: 'runVulnScan' },
          gateOutput: { from: 'nodes.vulnScan.output' },
          previousCodeResult: { from: 'context.currentCodeResult' },
        },
        next: 'openPR',
        step: 'executeGateFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Fix the vulnerabilities',
        type: 'step',
      },
      terminateAbandoned: terminate('FAILED', { group: 'security triage', title: 'Abandoned' }),
    },
    macro('pr', 'openPullRequest@1', { next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
