import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  terminate,
  validatePhase,
} from './authoring/index.js';

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
  nodes: mergeNodes(
    validatePhase({ next: 'implement', successCriteria: false }),
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
    openPullRequest({ next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
