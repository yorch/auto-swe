import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * After a vuln scan, a human decides: fix now, accept risk, or abandon.
 */
export const SECURITY_TRIAGE_SPEC: WorkflowSpec = {
  description:
    'Implement, run a vulnerability scan, then ask a human how to proceed. ' +
    'Three paths: fix the issues immediately, accept the risk and open the PR anyway, ' +
    'or abandon the change entirely.',
  entry: 'setValidating',
  name: 'security-triage',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing', successCriteria: false }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'storeCodeResult',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      storeCodeResult: storeCodeResult('vulnScan', { group: 'implement' }),
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
        next: 'updateCodeAfterFix',
        step: 'executeGateFixImplementation',
        title: 'Fix the vulnerabilities',
        type: 'step',
      },
      updateCodeAfterFix: {
        group: 'security triage',
        next: 'openPR',
        title: 'Keep the fixed code',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.fixVulns.output' } },
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
